import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { nextDocumentNumber } from '../../shared/numberSequence';
import {TenantContext, tenantTransaction, tenantQuery } from '../../shared/tenantContext';
import { Prisma } from '@prisma/client';
import { normalizePan } from '../../shared/compliance';

// Estimation is a sales/counter-staff feature — every read path below deliberately selects only
// the sale-side columns, never costRate/costAmount/costMcRate/costVaPercent/totalCostAmount, so
// cost data can't leak through this API even though the columns still exist for a possible later,
// more privileged view (CLAUDE.md's "controlled later with role setups").
const ESTIMATE_ITEM_SALE_SELECT = {
  id: true, code: true, materialType: true, name: true, weight: true, unit: true,
  saleRate: true, saleAmount: true,
} as const;

const ESTIMATE_SALE_SELECT = {
  id: true, tagId: true, estimateNumber: true,
  saleMcRate: true, saleVaPercent: true, totalSaleAmount: true,
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
      sellingPrice: true,
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
  return tag;
}

interface EstimateItemInput {
  code: string;
  materialType: string;
  name?: string;
  weight: number;
  unit?: string;
  costRate?: number;
  saleRate?: number;
}

interface CreateTagEstimateInput {
  /** Hand the estimate straight to the billing counter as it is saved (same as calling sendEstimateToBilling). */
  sendToBilling?: boolean;
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
  const metalWeight = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.weight, 0);
  const metalCostAmt = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.costAmount, 0);
  const metalSaleAmt = items.filter((i) => i.materialType === 'METAL').reduce((s, i) => s + i.saleAmount, 0);

  const costMcRate = input.costMcRate ?? 0;
  const costVaPercent = input.costVaPercent ?? 0;
  const saleMcRate = input.saleMcRate ?? 0;
  const saleVaPercent = input.saleVaPercent ?? 0;

  const makingCostAmount = metalWeight * costMcRate + (metalCostAmt * costVaPercent) / 100;
  const makingSaleAmount = metalWeight * saleMcRate + (metalSaleAmt * saleVaPercent) / 100;

  const materialsCostAmt = items.reduce((s, i) => s + i.costAmount, 0);
  const materialsSaleAmt = items.reduce((s, i) => s + i.saleAmount, 0);

  return {
    totalCostAmount: materialsCostAmt + makingCostAmount,
    totalSaleAmount: materialsSaleAmt + makingSaleAmount,
  };
}

// ─── Customer details taken at the billing hand-off ───────────────────────────
//
// "Send to billing" asks for the whole customer, so the biller does not ask again: name, mobile, date of birth,
// address, PAN and the sales employee. Name, mobile and the sales employee are REQUIRED to send; DOB, address
// and PAN are optional (a walk-in may not give a PAN — Rule 114B only bites above ₹2,00,000, and billing
// enforces that). Whatever is given is validated either way.

interface CustomerDetailsInput {
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

export async function createTagEstimate(tagId: string, input: CreateTagEstimateInput, ctx: TenantContext, userId: string) {
  const tag = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findUnique({ where: { id: tagId }, select: { id: true, companyId: true, status: true, tagNumber: true } }));
  if (!tag || tag.companyId !== ctx.companyId) throw new AppError('Tag not found', 404);
  const customer = cleanCustomerFields(input);
  if (input.sendToBilling) {
    assertBillable(tag);
    await assertReadyForBilling(ctx, customer);
  }
  if (!input.items || input.items.length === 0) throw new AppError('At least one material item is required', 400);

  const items = input.items.map((i) => ({
    ...i,
    costAmount: i.weight * (i.costRate ?? 0),
    saleAmount: i.weight * (i.saleRate ?? 0),
  }));

  const { totalCostAmount, totalSaleAmount } = computeTotals(items, input);

  // Indicative GST — same flat 3%-for-INR convention already hardcoded for actual sales
  // (NewSalePage.tsx: `currency === 'INR' ? 0.03 : 0`), snapshotted onto the estimate so a later
  // rate change never silently reprices a past quote (same principle as InvoiceItem.taxRate).
  const currency = input.currency ?? 'INR';
  const taxRate = currency === 'INR' ? 0.03 : 0;
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
        totalCostAmount,
        totalSaleAmount,
        taxRate, gstAmount, netPayableAmount,
        currency,
        validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
        notes: input.notes,
        createdById: userId,
        ...customer,
        ...(input.sendToBilling && { status: 'SENT', sentToBillingAt: new Date(), sentById: userId }),
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
      })),
    });

    return tx.tagEstimate.findUniqueOrThrow({ where: { id: estimate.id }, select: ESTIMATE_SALE_SELECT });
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
      customerName: true, customerPhone: true, salesPersonId: true,
    },
  }));
  if (!estimate || estimate.companyId !== ctx.companyId) throw new AppError('Estimate not found', 404);
  if (estimate.status === 'INVOICED') throw new AppError(`Estimate ${estimate.estimateNumber} has already been billed`, 409);
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

  return tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.update({
    where: { id: estimateId },
    data: { ...customer, ...merged, status: 'SENT', sentToBillingAt: new Date(), sentById: userId },
    select: ESTIMATE_SALE_SELECT,
  }));
}

// Everything the billing screen needs to turn an estimate into a line — sale-side data only, exactly like the
// rest of this module (no cost columns), so it is safe to hand to a role that only has invoice:create.
const BILLABLE_ESTIMATE_SELECT = {
  id: true, estimateNumber: true, status: true, customerName: true, customerPhone: true,
  customerDob: true, customerAddress: true, customerPan: true, salesPersonId: true,
  salesPerson: { select: { id: true, name: true } },
  saleMcRate: true, saleVaPercent: true, totalSaleAmount: true,
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
    // A piece that has since been sold or reserved can no longer be billed off this estimate.
    tag: { status: 'IN_STOCK' },
    ...(term && {
      OR: [
        { estimateNumber: { contains: term, mode: 'insensitive' } },
        { customerName: { contains: term, mode: 'insensitive' } },
        { customerPhone: { contains: term } },
        { tag: { name: { contains: term, mode: 'insensitive' } } },
        { tag: { tagNumber: { contains: term, mode: 'insensitive' } } },
        { tag: { huid: { contains: term, mode: 'insensitive' } } },
      ],
    }),
  };
  const rows = await tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findMany({
    where, orderBy: { sentToBillingAt: 'desc' }, take: 20, select: BILLABLE_ESTIMATE_SELECT,
  }));
  const now = Date.now();
  return rows.map((r) => ({ ...r, expired: !!r.validUntil && new Date(r.validUntil).getTime() < now }));
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
  return tenantQuery(ctx.companyId, (_tx) => _tx.tagEstimate.findMany({
    where: { tagId, companyId: ctx.companyId },
    orderBy: { createdAt: 'desc' },
    select: ESTIMATE_SALE_SELECT,
  }));
}
