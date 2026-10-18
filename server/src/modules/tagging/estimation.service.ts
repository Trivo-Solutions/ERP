import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { nextDocumentNumber } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { Prisma } from '@prisma/client';
import { normalizePan } from '../../shared/compliance';
import { computeRowsPricing } from '../../shared/pricingEngine';
import { resolveLiveMetalRate } from '../../shared/metalRate';
import { isFixedPrice } from '../../shared/fixedPrice';
import { assertTagPriceable } from '../../shared/tagPriceability';
import { startOfLocalDay, endOfLocalDay, isEstimateExpired } from '../../shared/estimateExpiry';
import { createAuditEntry } from '../../middleware/audit';
import { DEFAULT_HSN_CODE } from '../../shared/constants';
import { resolveOfferForTag } from '../offers/offer.service';
import { estimateBelowOffer, requireApprovalReason, createEstimateApproval, auditEstimateApprovalRequested } from '../offers/offerApproval.service';

// Estimation is a sales/counter-staff feature — every read path below deliberately selects only
// the sale-side columns, never costRate/costAmount/costMcRate/costVaPercent/totalCostAmount, so
// cost data can't leak through this API even though the columns still exist for a possible later,
// more privileged view (CLAUDE.md's "controlled later with role setups").
const ESTIMATE_ITEM_SALE_SELECT = {
  id: true, code: true, materialType: true, name: true, weight: true, unit: true,
  saleRate: true, saleAmount: true, baseSaleRate: true, materialId: true,
} as const;

const ESTIMATE_SALE_SELECT = {
  id: true, tagId: true, estimateNumber: true,
  saleMcRate: true, saleVaPercent: true, totalSaleAmount: true,
  offerId: true, offerName: true, baseSaleMcRate: true, baseSaleVaPercent: true,
  taxRate: true, gstAmount: true, netPayableAmount: true,
  currency: true, validUntil: true, notes: true, createdAt: true,
  status: true, sentToBillingAt: true, invoiceId: true,
  customerName: true, customerPhone: true, customerDob: true, customerAddress: true, customerPan: true,
  salesPersonId: true, salesPerson: { select: { id: true, name: true } },
  items: { select: ESTIMATE_ITEM_SALE_SELECT },
} as const;

// ─── Estimation (per-tag, editable quote snapshot) ────────────────────────────
//
// A TagEstimate is a read-only-first, then editable, price quote worked up from a specific tag's
// materials. Saving one snapshots the (possibly edited) rates + making-charge/VA into TagEstimate/
// TagEstimateItem and never writes back to JewelryTag/JewelryTagMaterial — the same cost-price
// immutability principle CLAUDE.md already applies to JewelryTag.costPrice, extended here so a
// customer quote can diverge from the tag's own stored numbers without ever touching them.

// The "before you can edit, show what's really on the tag" data source — deliberately separate
// from tagging.service.ts's getTag() (used by the TagsPage drawer and the tag edit form), which
// includes materials too but via a plain `include` — fine for that screen since it already shows
// costPrice openly to anyone with tag:view, same privilege the edit form needs to prefill Cost
// Rate/Cost Amount. Estimation is a lighter-privilege, sales/counter-staff surface, so THIS
// function deliberately uses an explicit `select` instead, to leave costPrice/costRate/costAmount
// out of the response entirely rather than trusting the client to just not display them.
export async function getTagForEstimation(ctx: TenantContext, tagId: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({
    where: { id: tagId },
    select: {
      id: true, companyId: true, tagNumber: true, name: true, status: true,
      metalType: true, metalKarat: true, makeType: true, categoryId: true,
      grossWeight: true, netWeight: true, stoneWeight: true, huid: true,
      sellingPrice: true, pricingMode: true,
      // The MC rate/VA% actually decided for this piece at tagging time — preferred over a fresh
      // MakingCharge master lookup by the client (null only for tags that predate this column).
      saleMcRate: true, saleVaPercent: true,
      // The category's short master-data code (e.g. "NEC" for Necklace, "BNG" for Bangle) — what
      // the estimate template's Item Name field prints alongside the name, not the tag's own long
      // generated tagNumber (which happens to embed this same code as a substring, but isn't it).
      category: { select: { code: true, name: true } },
      branch: { select: { name: true } },
      materials: {
        select: {
          id: true, code: true, materialType: true, size: true, pieces: true,
          weight: true, unit: true, saleRate: true, saleAmount: true,
          materialCode: { select: { name: true, karat: true } },
          stoneGrade: { select: { shape: true, color: true, clarity: true, cut: true, quality: true } },
        },
      },
    },
  }));
  if (!tag || tag.companyId !== ctx.companyId) throw new AppError('Tag not found', 404);
  // Gold is live: a METAL row is shown at the day's metal rate for the piece's karat, not the rate it was tagged with. The
  // rate's own date rides along so the screen can say "today's rate not entered yet - using <date>'s".
  assertTagPriceable(tag); // 409 when the tag is missing MC / VA / a stone's sale rate - never quoted at 0
  // Fixed price per piece: no live metal rate is involved at all (the quote is the tag's own GST-exclusive price).
  const needsMetal = !isFixedPrice(tag) && tag.materials.some((m) => m.materialType === 'METAL');
  const goldRate = needsMetal && tag.metalKarat ? await resolveLiveMetalRate(ctx.companyId, tag.metalKarat) : null;
  if (needsMetal && !goldRate) throw new AppError(`No metal rate has been entered for ${tag.metalKarat ?? 'this piece'} - enter it under Metal Rates first`, 409);
  return {
    ...tag,
    materials: tag.materials.map((m) => (m.materialType === 'METAL' && goldRate ? { ...m, saleRate: goldRate.ratePerGram } : m)),
    goldRate: goldRate ? { karat: tag.metalKarat, ...goldRate } : null,
    defaultGstRate: await defaultGstRate(),
  };
}

interface EstimateItemInput {
  /** The tag's own material row this line came from — lets the server find its pre-offer rate. Optional. */
  materialId?: string;
  code: string;
  materialType: string;
  name?: string;
  weight: number;
  unit?: string;
  costRate?: number;
  saleRate?: number;
}

interface CreateTagEstimateInput {
  /** Work the estimate up with the offer that applies to this piece today (rates submitted are the offered rates). */
  applyOffer?: boolean;
  /** Hand the estimate straight to the billing counter as it is saved (same as calling sendEstimateToBilling). When it is
   *  priced below the offer it goes for a store manager's approval instead, and `approvalReason` is required. */
  sendToBilling?: boolean;
  approvalReason?: string;
  customerName?: string;
  customerPhone?: string;
  customerDob?: string | Date | null;
  customerAddress?: string;
  customerPan?: string;
  /** The staff member (User id) showing / attending this customer. */
  salesPersonId?: string;
  items: EstimateItemInput[];
  costMcRate?: number;
  costVaPercent?: number;
  saleMcRate?: number;
  saleVaPercent?: number;
  currency?: string;
  validUntil?: string | Date;
  notes?: string;
}

// Same two-sided (cost/sale) making-charge + VA formula as NewTagPage.tsx's MC & VA tab
// (client/src/pages/Tagging/NewTagPage.tsx:334-354): a flat ₹/gram labour rate applied to total
// metal weight, plus a %-of-metal-value wastage/VA charge, applied once against the materials
// totals rather than per line.
function computeTotals(items: Array<EstimateItemInput & { costAmount: number; saleAmount: number }>, input: CreateTagEstimateInput) {
  // The one shared formula (shared/pricingEngine.ts); each side prices the same rows at its own rates.
  const cost = computeRowsPricing(items.map((i) => ({ materialType: i.materialType, weight: i.weight, rate: i.costRate ?? 0 })), input.costMcRate ?? 0, input.costVaPercent ?? 0);
  const sale = computeRowsPricing(items.map((i) => ({ materialType: i.materialType, weight: i.weight, rate: i.saleRate ?? 0 })), input.saleMcRate ?? 0, input.saleVaPercent ?? 0);
  return { totalCostAmount: cost.total, totalSaleAmount: sale.total };
}

// ─── Customer details taken at the billing hand-off ───────────────────────────
//
// "Send to billing" asks for the whole customer, so the biller does not ask again: name, mobile, date of birth,
// address, PAN and the sales employee. Name, mobile and the sales employee are REQUIRED to send; DOB, address
// and PAN are optional (a walk-in may not give a PAN — Rule 114B only bites above ₹2,00,000, and billing
// enforces that). Whatever is given is validated either way.

interface CustomerDetailsInput {
  /** Required when the estimate is priced below its offer (it is then sent for approval, not to billing). */
  approvalReason?: string;
  customerName?: string;
  customerPhone?: string;
  customerDob?: string | Date | null;
  customerAddress?: string;
  customerPan?: string;
  salesPersonId?: string;
}

const blank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';

/** 10-digit Indian mobile: spaces/dashes and a leading +91 / 91 / 0 are dropped. */
export function normalizeMobile(raw: string): string {
  let d = String(raw).replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (/^91\d{10}$/.test(d)) d = d.slice(2);
  else if (/^0\d{10}$/.test(d)) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) throw new AppError('Mobile number must be a 10-digit Indian mobile number', 400);
  return d;
}

function parseDob(raw: string | Date): Date {
  const d = raw instanceof Date ? raw : new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(d.getTime())) throw new AppError('Date of birth is not a valid date', 400);
  const now = Date.now();
  if (d.getTime() > now) throw new AppError('Date of birth cannot be in the future', 400);
  if (now - d.getTime() > 120 * 365.25 * 24 * 3600 * 1000) throw new AppError('Date of birth is not plausible', 400);
  return d;
}

/** Validates + normalises whichever customer fields were supplied (undefined = not supplied = leave as is). */
function cleanCustomerFields(input: CustomerDetailsInput) {
  const str = (v: unknown, what: string) => {
    if (typeof v !== 'string') throw new AppError(`${what} must be text`, 400);
    return v.trim() || null;
  };
  const out: {
    customerName?: string | null; customerPhone?: string | null; customerDob?: Date | null;
    customerAddress?: string | null; customerPan?: string | null; salesPersonId?: string | null;
  } = {};
  if (input.customerName !== undefined) out.customerName = str(input.customerName, 'Customer name');
  if (input.customerPhone !== undefined) out.customerPhone = blank(input.customerPhone) ? null : normalizeMobile(String(input.customerPhone));
  if (input.customerDob !== undefined) out.customerDob = blank(input.customerDob) ? null : parseDob(input.customerDob as string | Date);
  if (input.customerAddress !== undefined) out.customerAddress = str(input.customerAddress, 'Address');
  if (input.customerPan !== undefined) out.customerPan = normalizePan(input.customerPan);
  if (input.salesPersonId !== undefined) out.salesPersonId = str(input.salesPersonId, 'Sales employee');
  return out;
}

/** Active members of this company, for the sales-employee picker (scoped via CompanyUser — User has no companyId). */
export async function listSalesStaff(ctx: TenantContext) {
  const staff = await tenantQuery(ctx.companyId, (_tx) => _tx.companyUser.findMany({
    where: { companyId: ctx.companyId, isActive: true, user: { isActive: true } },
    select: { userId: true, employeeId: true, user: { select: { name: true } } },
    orderBy: { user: { name: 'asc' } },
  }));
  return staff.map((s) => ({ id: s.userId, name: s.user.name, employeeId: s.employeeId }));
}

/** The hand-off's required fields, checked against what the estimate will hold AFTER this send. */
async function assertReadyForBilling(
  ctx: TenantContext,
  final: { customerName?: string | null; customerPhone?: string | null; salesPersonId?: string | null },
) {
  if (!final.customerName) throw new AppError('Customer name is required to send to billing', 400);
  if (!final.customerPhone) throw new AppError('Customer mobile number is required to send to billing', 400);
  if (!final.salesPersonId) throw new AppError('Sales employee (who is attending this customer) is required to send to billing', 400);
  // A User is a global identity — it must be an active member of THIS company, or a forged id could name anyone.
  const member = await tenantQuery(ctx.companyId, (_tx) => _tx.companyUser.findFirst({
    where: { companyId: ctx.companyId, userId: final.salesPersonId!, isActive: true, user: { isActive: true } },
    select: { userId: true },
  }));
  if (!member) throw new AppError('Sales employee not found', 404);
}

/** The GST rate of the default HSN (jewellery) from the HSN master - the rate an estimate's indicative GST uses. */
export async function defaultGstRate(): Promise<number> {
  const hsn = await prisma.hsnCode.findFirst({ where: { code: DEFAULT_HSN_CODE, isActive: true } });
  if (!hsn) throw new AppError(`Default HSN ${DEFAULT_HSN_CODE} is missing from the HSN master`, 500);
  return Number(hsn.gstRate);
}

export async function createTagEstimate(tagId: string, input: CreateTagEstimateInput, ctx: TenantContext, userId: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({
    where: { id: tagId },
    select: { id: true, companyId: true, status: true, tagNumber: true, pricingMode: true, sellingPrice: true, saleMcRate: true, saleVaPercent: true, materials: { select: { code: true, materialType: true, saleRate: true } } },
  }));
  if (!tag || tag.companyId !== ctx.companyId) throw new AppError('Tag not found', 404);
  assertTagPriceable(tag);
  const customer = cleanCustomerFields(input);
  if (input.sendToBilling) {
    assertBillable(tag);
    await assertReadyForBilling(ctx, customer);
  }
  if (!isFixedPrice(tag) && (!input.items || input.items.length === 0)) throw new AppError('At least one material item is required', 400);

  // "Apply offer": the offer is picked by the server from today's date, never named by the client. The submitted rates are
  // the offered ones; what we record is which offer it was and the tagged rates they were lowered from, so a later edit to
  // (or deletion of) the offer cannot reprice this quote. If nothing applies any more the save is refused rather than
  // silently saving an un-offered quote the customer was told was discounted.
  const offerApplied = input.applyOffer ? await resolveOfferForTag(ctx, tagId) : null;
  if (offerApplied && !offerApplied.resolution.offer) {
    throw new AppError('No offer applies to this piece today — remove "Apply offer" and try again', 409);
  }
  const baseRateOf = new Map((offerApplied?.base.rows ?? []).map((r) => [r.key, r.rate]));

  // Fixed price per piece: the quote is exactly the tag's saved GST-exclusive price, whatever rows / rates the client sent - one
  // 'FIXED' line, no MC / VA, no offer (offers lower weight-based component rates; there are none here).
  const fixed = isFixedPrice(tag);
  if (fixed && input.applyOffer) throw new AppError('Offers do not apply to a fixed-price piece', 409);
  const fixedPrice = fixed ? Number(tag.sellingPrice) : 0;
  const items = fixed
    ? [{ code: 'FIXED', materialType: 'FIXED', name: 'Fixed price per piece', weight: 1, unit: 'PC', costRate: 0, costAmount: 0, saleRate: fixedPrice, saleAmount: fixedPrice } as EstimateItemInput & { costAmount: number; saleAmount: number }]
    : input.items.map((i) => ({
        ...i,
        costAmount: i.weight * (i.costRate ?? 0),
        saleAmount: i.weight * (i.saleRate ?? 0),
      }));
  if (fixed) input = { ...input, saleMcRate: undefined, saleVaPercent: undefined, costMcRate: undefined, costVaPercent: undefined };

  const { totalCostAmount, totalSaleAmount } = fixed ? { totalCostAmount: 0, totalSaleAmount: fixedPrice } : computeTotals(items, input);

  // Priced below the offer in force today -> it does not go to billing; it goes to a store manager, who releases it.
  const gate = input.sendToBilling && !fixed
    ? await estimateBelowOffer(ctx, tagId, {
        mcRate: input.saleMcRate ?? Number.POSITIVE_INFINITY, vaPercent: input.saleVaPercent ?? Number.POSITIVE_INFINITY,
        rows: items.map((i) => ({ materialId: i.materialId, rate: i.saleRate ?? 0, code: i.code })),
      })
    : null;
  const approvalReason = gate ? requireApprovalReason(input.approvalReason) : null;

  // Indicative GST at the default HSN's rate from the HSN master (what a sale line without its own HSN is taxed at),
  // snapshotted onto the estimate so a later rate change never silently reprices a past quote (same principle as
  // InvoiceItem.taxRate). Never a hardcoded rate.
  const currency = input.currency ?? 'INR';
  const taxRate = currency === 'INR' ? await defaultGstRate() : 0;
  const gstAmount = Math.round(totalSaleAmount * taxRate * 100) / 100;
  const netPayableAmount = totalSaleAmount + gstAmount;

  return tenantTransaction(ctx.companyId, async (tx) => {
    const estimateNumber = await nextDocumentNumber(ctx.companyId, 'EST', 'EST', tx);
    const estimate = await tx.tagEstimate.create({
      data: {
        companyId: ctx.companyId,
        tagId,
        estimateNumber,
        costMcRate: input.costMcRate,
        costVaPercent: input.costVaPercent,
        saleMcRate: input.saleMcRate,
        saleVaPercent: input.saleVaPercent,
        ...(offerApplied && {
          offerId: offerApplied.resolution.offer!.id, offerName: offerApplied.resolution.offer!.name,
          baseSaleMcRate: offerApplied.base.mcRate, baseSaleVaPercent: offerApplied.base.vaPercent,
        }),
        totalCostAmount,
        totalSaleAmount,
        taxRate, gstAmount, netPayableAmount,
        currency,
        validUntil: endOfLocalDay(), // a quote is good for the day it was made - never longer, whatever the client sends
        notes: input.notes,
        createdById: userId,
        ...customer,
        ...(input.sendToBilling && (gate ? { status: 'AWAITING_APPROVAL' } : { status: 'SENT', sentToBillingAt: new Date(), sentById: userId })),
      },
    });

    await tx.tagEstimateItem.createMany({
      data: items.map((i) => ({
        companyId: ctx.companyId,
        estimateId: estimate.id,
        code: i.code,
        materialType: i.materialType,
        name: i.name,
        weight: i.weight,
        unit: i.unit ?? (i.materialType === 'METAL' ? 'GM' : 'CT'),
        costRate: i.costRate,
        costAmount: i.costAmount,
        saleRate: i.saleRate,
        saleAmount: i.saleAmount,
        baseSaleRate: offerApplied && i.materialId ? baseRateOf.get(i.materialId) : undefined,
        materialId: i.materialId ? String(i.materialId).slice(0, 40) : undefined,
      })),
    });

    const approval = gate ? await createEstimateApproval(tx, ctx, { estimateId: estimate.id, tagId, ...gate, reason: approvalReason!, userId }) : null;
    const saved = await tx.tagEstimate.findUniqueOrThrow({ where: { id: estimate.id }, select: ESTIMATE_SALE_SELECT });
    return { saved, approval };
  }).then(async ({ saved, approval }) => {
    if (approval && gate) await auditEstimateApprovalRequested(ctx, userId, approval.id, gate.below, tagId, saved.id);
    return saved;
  });
}

// ─── Estimate -> billing hand-off ─────────────────────────────────────────────
//
// An estimate is a quote for ONE piece. "Send to billing" hands it to the counter: it then shows up in the
// billing screen's estimate search, where it is converted into an invoice line (the biller can still change
// its rates and rows there) and, once billed, is marked INVOICED so it can never be billed twice.

function assertBillable(tag: { status: string; tagNumber: string }) {
  if (tag.status !== 'IN_STOCK') {
    throw new AppError(`${tag.tagNumber} is ${tag.status} — only a piece that is in stock can be sent to billing`, 409);
  }
}

export async function sendEstimateToBilling(
  ctx: TenantContext, estimateId: string, input: CustomerDetailsInput, userId: string,
) {
  const estimate = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findUnique({
    where: { id: estimateId },
    select: {
      id: true, companyId: true, status: true, estimateNumber: true, tag: { select: { status: true, tagNumber: true } },
      customerName: true, customerPhone: true, salesPersonId: true, tagId: true, saleMcRate: true, saleVaPercent: true, createdAt: true,
      items: { select: { materialId: true, saleRate: true, code: true } },
    },
  }));
  if (!estimate || estimate.companyId !== ctx.companyId) throw new AppError('Estimate not found', 404);
  if (estimate.status === 'AWAITING_APPROVAL') throw new AppError(`Estimate ${estimate.estimateNumber} is already waiting for a store manager's approval`, 409);
  if (estimate.status === 'INVOICED') throw new AppError(`Estimate ${estimate.estimateNumber} has already been billed`, 409);
  if (isEstimateExpired(estimate.createdAt)) throw new AppError(`Estimate ${estimate.estimateNumber} was made on an earlier day and has expired - make a new estimate at today's rate`, 409);
  assertBillable(estimate.tag);

  // Re-sending may correct the customer's details; a field left out keeps what the estimate already holds,
  // and the required ones must be present in the merge.
  const customer = cleanCustomerFields(input);
  const merged = {
    customerName: customer.customerName ?? estimate.customerName,
    customerPhone: customer.customerPhone ?? estimate.customerPhone,
    salesPersonId: customer.salesPersonId ?? estimate.salesPersonId,
  };
  await assertReadyForBilling(ctx, merged);

  // Priced below the offer in force today -> goes to a store manager instead of billing.
  const gate = await estimateBelowOffer(ctx, estimate.tagId, {
    mcRate: estimate.saleMcRate != null ? Number(estimate.saleMcRate) : Number.POSITIVE_INFINITY,
    vaPercent: estimate.saleVaPercent != null ? Number(estimate.saleVaPercent) : Number.POSITIVE_INFINITY,
    rows: estimate.items.map((i) => ({ materialId: i.materialId, rate: Number(i.saleRate ?? 0), code: i.code })),
  });
  const approvalReason = gate ? requireApprovalReason(input.approvalReason) : null;

  const { saved, approval } = await tenantTransaction(ctx.companyId, async (tx) => {
    const saved = await tx.tagEstimate.update({
      where: { id: estimateId },
      data: gate ? { ...customer, ...merged, status: 'AWAITING_APPROVAL' } : { ...customer, ...merged, status: 'SENT', sentToBillingAt: new Date(), sentById: userId },
      select: ESTIMATE_SALE_SELECT,
    });
    const approval = gate ? await createEstimateApproval(tx, ctx, { estimateId, tagId: estimate.tagId, ...gate, reason: approvalReason!, userId }) : null;
    return { saved, approval };
  });
  if (approval && gate) await auditEstimateApprovalRequested(ctx, userId, approval.id, gate.below, estimate.tagId, estimateId);
  return saved;
}

// Everything the billing screen needs to turn an estimate into a line — sale-side data only, exactly like the
// rest of this module (no cost columns), so it is safe to hand to a role that only has invoice:create.
const BILLABLE_ESTIMATE_SELECT = {
  id: true, estimateNumber: true, status: true, customerName: true, customerPhone: true,
  customerDob: true, customerAddress: true, customerPan: true, salesPersonId: true,
  salesPerson: { select: { id: true, name: true } },
  saleMcRate: true, saleVaPercent: true, totalSaleAmount: true,
  offerId: true, offerName: true, baseSaleMcRate: true, baseSaleVaPercent: true,
  taxRate: true, gstAmount: true, netPayableAmount: true,
  currency: true, validUntil: true, notes: true, createdAt: true, sentToBillingAt: true,
  createdBy: { select: { id: true, name: true } },
  items: { select: ESTIMATE_ITEM_SALE_SELECT },
  tag: {
    select: {
      id: true, tagNumber: true, name: true, status: true, metalType: true, metalKarat: true, makeType: true,
      grossWeight: true, netWeight: true, stoneWeight: true, huid: true,
      category: { select: { id: true, name: true } },
    },
  },
} as const;

/** Estimates waiting at the billing counter, newest first. Matches on estimate number, item name / tag number,
 *  or the customer's name / phone. Blank query lists the latest ones. */
export async function searchBillableEstimates(ctx: TenantContext, q?: string) {
  const term = q?.trim();
  const where: Prisma.TagEstimateWhereInput = {
    companyId: ctx.companyId,
    status: 'SENT',
    createdAt: { gte: startOfLocalDay() }, // yesterday's quotes are expired: not offered to billing
    // A piece that has since been sold or reserved can no longer be billed off this estimate.
    tag: { status: 'IN_STOCK' },
    ...(term && {
      OR: [
        { estimateNumber: { contains: term, mode: 'insensitive' } },
        { customerName: { contains: term, mode: 'insensitive' } },
        { customerPhone: { contains: term } },
        { tag: { name: { contains: term, mode: 'insensitive' } } },
        { tag: { category: { is: { name: { contains: term, mode: 'insensitive' } } } } },
        { tag: { subCategory: { is: { name: { contains: term, mode: 'insensitive' } } } } },
        { tag: { tagNumber: { contains: term, mode: 'insensitive' } } },
        { tag: { huid: { contains: term, mode: 'insensitive' } } },
      ],
    }),
  };
  const rows = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findMany({
    where, orderBy: { sentToBillingAt: 'desc' }, take: 20, select: BILLABLE_ESTIMATE_SELECT,
  }));
  return withEstimateFlags(ctx, rows);
}

export async function getTagEstimate(ctx: TenantContext, id: string) {
  const estimate = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findUnique({
    where: { id },
    select: { ...ESTIMATE_SALE_SELECT, companyId: true, tag: { select: { tagNumber: true, name: true } } },
  }));
  if (!estimate || estimate.companyId !== ctx.companyId) throw new AppError('Estimate not found', 404);
  return estimate;
}

export async function listTagEstimatesForTag(ctx: TenantContext, tagId: string) {
  // A tag that is not this company's is a 404 (same as a nonexistent one) — not a 200 with an empty list,
  // which would let a caller probe whether another company's tag id exists.
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { id: tagId }, select: { companyId: true } }));
  if (!tag || tag.companyId !== ctx.companyId) throw new AppError('Tag not found', 404);
  const rows = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findMany({
    where: { tagId, companyId: ctx.companyId },
    orderBy: { createdAt: 'desc' },
    select: ESTIMATE_SALE_SELECT,
  }));
  const karat = (await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { id: tagId }, select: { metalKarat: true } })))?.metalKarat;
  return withEstimateFlags(ctx, rows, () => karat);
}

// ─── Recall / return to estimation ────────────────────────────────────────────

/**
 * Pulls an estimate that was sent to billing (or is waiting for a store manager's approval) back to OPEN, before it has been
 * billed. Two doors, same rule and no extra permission: the estimator recalls it from the estimation page, or the biller returns
 * it from the billing screen. Count-checked on the status, so a recall racing a bill cannot both win (the loser is told why);
 * a BILLED estimate can never be recalled. Any approval request tied to it is withdrawn in the same transaction, so a stale
 * approval can never ride a later bill.
 */
export async function recallEstimate(ctx: TenantContext, estimateId: string, userId: string, via: 'ESTIMATOR' | 'BILLING', reason?: unknown) {
  const note = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : undefined;
  const before = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findUnique({
    where: { id: estimateId }, select: { id: true, companyId: true, status: true, estimateNumber: true },
  }));
  if (!before || before.companyId !== ctx.companyId) throw new AppError('Estimate not found', 404);
  if (before.status === 'INVOICED') throw new AppError(`Estimate ${before.estimateNumber} has already been billed and cannot be recalled`, 409);
  if (before.status === 'OPEN') throw new AppError(`Estimate ${before.estimateNumber} is not with billing`, 409);

  const done = await tenantTransaction(ctx.companyId, async (tx) => {
    const r = await tx.tagEstimate.updateMany({
      where: { id: estimateId, companyId: ctx.companyId, status: { in: ['SENT', 'AWAITING_APPROVAL'] } },
      data: { status: 'OPEN', sentToBillingAt: null, sentById: null },
    });
    if (r.count === 1) {
      await tx.discountApproval.updateMany({
        where: { estimateId, companyId: ctx.companyId, status: { in: ['PENDING', 'APPROVED'] } },
        data: { status: 'CANCELLED' },
      });
    }
    return r;
  });
  if (done.count !== 1) {
    const now = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findUnique({ where: { id: estimateId }, select: { status: true } }));
    throw new AppError(`Estimate ${before.estimateNumber} can no longer be recalled (${now?.status ?? 'unknown'})`, 409);
  }
  await createAuditEntry('tag_estimates', estimateId, userId, 'RECALL', { status: before.status }, { status: 'OPEN', via, ...(note && { reason: note }) }, ctx.companyId);
  return tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findUniqueOrThrow({ where: { id: estimateId }, select: ESTIMATE_SALE_SELECT }));
}

/**
 * "The gold rate has moved since this estimate": compares the metal rate the estimate froze with the live one for the piece's
 * karat. An indicator only - nothing is repriced by it. `expired` is the same-day rule.
 */
async function withEstimateFlags<T extends { createdAt: Date; items: Array<{ materialType: string; saleRate: unknown }>; tag?: { metalKarat: string | null } | null }>(
  ctx: TenantContext, rows: T[], karatByRow?: (r: T) => string | null | undefined,
) {
  const liveByKarat = new Map<string, number | null>();
  const out = [];
  for (const r of rows) {
    const karat = karatByRow ? karatByRow(r) : r.tag?.metalKarat;
    let now: number | null = null;
    if (karat) {
      if (!liveByKarat.has(karat)) liveByKarat.set(karat, (await resolveLiveMetalRate(ctx.companyId, karat))?.ratePerGram ?? null);
      now = liveByKarat.get(karat) ?? null;
    }
    const metal = r.items.find((i) => i.materialType === 'METAL');
    const at = metal && metal.saleRate != null ? Number(metal.saleRate) : null;
    out.push({ ...r, expired: isEstimateExpired(r.createdAt), goldRateAtEstimate: at, goldRateNow: now, goldRateChanged: at != null && now != null && Math.abs(at - now) > 0.005 });
  }
  return out;
}
