import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { postAutoJournalEntry } from '../finance/finance.service';
import { LEDGER_ACCOUNT, cashOrBankAccount } from '../../shared/ledgerAccounts';
import { nextDocumentNumber, nextSimpleCode } from '../../shared/numberSequence';
import { TenantContext, tenantQuery, tenantBatch, tenantTransaction } from '../../shared/tenantContext';
import { assertOwnedByCompany, assertBranchAccessible, assertAllOwned } from '../../middleware/tenant';
import { isBlockedByForeignKey } from '../../shared/prismaErrors';
import { isValidKarat } from '../../shared/karatMaster';
import { resolvePoComponents, snapshotGrnComponentRates, PoComponentInput } from '../../shared/vendorRates';
import { FINISHED_GOODS_MATERIAL_TYPE, FINISHED_LOT_MATERIAL_TYPE, DEFAULT_HSN_CODE } from '../../shared/constants';
import { round2, resolveSupplierStateCode, splitInputGst, resolveBuyerRegistration } from '../../shared/inputGst';
import { isValidTaxCategory, DEFAULT_TAX_CATEGORY } from '../../shared/taxCategory';
import { isValidRcmCategory, DEFAULT_RCM_CATEGORY } from '../../shared/rcmCategory';
import { createDebitNoteForPurchaseReturnTx } from './debitNote.service';
import { bookRcmLiabilityIfApplicable } from '../finance/gst/gstr3bRcmBooking.service';
import { assertGstr3bPeriodMutable } from '../finance/gst/gstr3bFilingProtection';

export async function listPOs(ctx: TenantContext, filters: {
  status?: string; supplierId?: string; poType?: string;
  dateFrom?: Date; dateTo?: Date; page?: number; limit?: number;
}) {
  const { status, supplierId, poType, dateFrom, dateTo, page = 1, limit = 20 } = filters;
  const where: Prisma.PurchaseOrderWhereInput = {
    companyId: ctx.companyId,
    ...(status && { status }),
    ...(supplierId && { supplierId }),
    ...(poType && { poType }),
    ...(dateFrom || dateTo) && {
      orderDate: { ...(dateFrom && { gte: dateFrom }), ...(dateTo && { lte: dateTo }) },
    },
  };

  const [pos, total] = await tenantBatch(ctx.companyId, (tx) => [
    tx.purchaseOrder.findMany({
      where,
      include: { supplier: { select: { name: true, supplierCode: true } }, _count: { select: { grns: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    tx.purchaseOrder.count({ where }),
  ]);
  return { pos, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getPO(ctx: TenantContext, id: string) {
  const po = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.findUnique({
    where: { id },
    include: {
      ...PO_INCLUDE,
      grns: { include: { grnItems: true } },
      approvalHistory: { include: { performedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' as const } },
    },
  }));
  if (!po || po.companyId !== ctx.companyId) throw new AppError('Purchase Order not found', 404);
  return po;
}

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

// A PO with its lines — and, on a FINISHED_LOT line, the bag's category rows (named, for display).
const PO_INCLUDE = {
  supplier: true,
  poItems: { include: { categories: { include: { category: { select: { name: true, code: true } } } }, components: true } },
} as const;

// One category's row of a bag, as sent: the invoice's gross weight plus any one of stone / net (the other is
// worked out), the karat, and an optional piece count.
export interface LotCategoryInput {
  categoryId: string; karat: string; grossWeight: number; stoneWeight?: number | string | null; netWeight?: number | string | null;
  pieces?: number | string | null;
  // Optional cost rates, entered once here and pre-filled on every tag cut from this category (see PoItemCategory).
  costRate?: number | string | null; mcRate?: number | string | null; vaPercent?: number | string | null;
}
interface ResolvedLotCategory {
  categoryId: string; karat: string; grossWeight: number; stoneWeight: number; netWeight: number; pieces: number | null;
  costRate: number | null; mcRate: number | null; vaPercent: number | null;
}

// The bag's category rows are the invoice's own figures, so they are checked hard here — a wrong row would
// otherwise become a booked bill and a cap on what can be tagged. The category rows must add up to the bag's
// gross weight to within the same 0.5% a GRN allows for scale error.
async function resolveLotCategories(
  item: { materialName: string; weight: number; lotAmount?: number; categories?: LotCategoryInput[] },
  companyId: string,
): Promise<ResolvedLotCategory[]> {
  const name = item.materialName || 'Lot line';
  if (!(Number(item.lotAmount) > 0)) throw new AppError(`${name}: the lot amount (before GST) is required`, 400);
  const rows = item.categories;
  // The category breakup is optional: a supplier may bill the bag as one lump (weight + amount) with nothing broken down.
  if (rows === undefined || rows === null || (Array.isArray(rows) && rows.length === 0)) {
    if (!(Number(item.weight) > 0)) throw new AppError(`${name}: enter the lot's weight (or add its category breakup)`, 400);
    return [];
  }
  if (!Array.isArray(rows)) throw new AppError(`${name}: categories must be a list`, 400);

  await assertAllOwned('productCategory', rows.map((r) => r.categoryId), companyId, 'Category');
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  const seen = new Set<string>();
  const out: ResolvedLotCategory[] = [];
  for (const [n, r] of rows.entries()) {
    const at = `${name}, category row ${n + 1}`;
    if (typeof r.categoryId !== 'string' || !r.categoryId) throw new AppError(`${at}: choose a category`, 400);
    if (!r.karat || typeof r.karat !== 'string' || !(await isValidKarat(companyId, r.karat))) {
      throw new AppError(`${at}: choose a valid karat`, 400);
    }
    const key = `${r.categoryId}:${r.karat}`;
    if (seen.has(key)) throw new AppError(`${at}: this category and karat is already in the lot — combine them into one row`, 400);
    seen.add(key);

    const gross = Number(r.grossWeight);
    if (!(gross > 0)) throw new AppError(`${at}: gross weight is required`, 400);
    let net: number, stone: number;
    if (given(r.netWeight) && given(r.stoneWeight)) {
      net = Number(r.netWeight); stone = Number(r.stoneWeight);
      if (Math.abs(gross - stone - net) > 0.001) throw new AppError(`${at}: gross − stone must equal net`, 400);
    } else if (given(r.netWeight)) {
      net = Number(r.netWeight); stone = gross - net;
    } else if (given(r.stoneWeight)) {
      stone = Number(r.stoneWeight); net = gross - stone;
    } else {
      throw new AppError(`${at}: enter the net weight or the stone weight`, 400);
    }
    if (!(net > 0)) throw new AppError(`${at}: net weight must be more than zero`, 400);
    if (stone < -0.001) throw new AppError(`${at}: net weight cannot exceed gross weight`, 400);

    let pieces: number | null = null;
    if (given(r.pieces)) {
      pieces = Number(r.pieces);
      if (!Number.isInteger(pieces) || pieces < 1) throw new AppError(`${at}: pieces must be a whole number, at least 1 (or leave it blank)`, 400);
    }
    const rate = (v: unknown, what: string, max = Infinity): number | null => {
      if (!given(v)) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new AppError(`${at}: ${what} must be a number between 0 and ${max === Infinity ? 'any amount' : max}`, 400);
      return n;
    };
    out.push({
      categoryId: r.categoryId, karat: r.karat, grossWeight: round4(gross), stoneWeight: round4(Math.max(0, stone)), netWeight: round4(net), pieces,
      costRate: rate(r.costRate, 'the metal cost rate'), mcRate: rate(r.mcRate, 'the making charge'), vaPercent: rate(r.vaPercent, 'the value addition %', 100),
    });
  }

  const total = out.reduce((s, c) => s + c.grossWeight, 0);
  const bag = Number(item.weight);
  if (bag > 0 && Math.abs(total - bag) > bag * 0.005) {
    throw new AppError(`${name}: the categories add up to ${total.toFixed(3)} g but the bag's gross weight is ${bag.toFixed(3)} g`, 400);
  }
  return out;
}

export async function createPO(data: {
  supplierId: string; poType: string; orderDate: Date; expectedDate?: Date;
  currency?: string; exchangeRate?: number; notes?: string;
  items: Array<{ materialCode: string; materialName: string; materialType: string;
    quantity: number; weight: number; unit: string; karat?: string;
    ratePerUnit: number;
    /** FINISHED_LOT lines only (a bag): weight = the bag's gross, lotAmount = its ONE amount before GST, and
     *  categories = what is in it, one row per category+karat. quantity/ratePerUnit are ignored (a bag is one unit). */
    lotAmount?: number; categories?: LotCategoryInput[];
    /** Stone / pearl / bead components this line's pieces carry, each with the cost rate agreed for this PO. A rate left
     *  out defaults from the supplier's vendor rate (VendorComponentRate); one given is the PO's own and overrides it. */
    components?: PoComponentInput[];
    /** HSN code for the GST rate lookup — defaults to DEFAULT_HSN_CODE (jewellery, 3%). */
    hsnCode?: string;
    /** GST rate as a fraction (0.03 = 3%) exactly as charged on the supplier's bill. Omitted: the HSN
     *  master's rate if the supplier is GST-registered, else 0 (an unregistered supplier charges none). */
    taxRate?: number;
    /** G2g-7a: the statutory classification of this line's supply (shared/taxCategory.ts). Omitted:
     *  defaults to TAXABLE — never inferred from taxRate (a 0% rate is not the same fact as EXEMPT/
     *  NIL_RATED/NON_GST/ZERO_RATED). */
    taxCategory?: string;
    /** G2g-7d: an explicit, notified reverse-charge category for this line (shared/rcmCategory.ts).
     *  Omitted: defaults to NONE — never inferred from the supplier's registration status (CGST
     *  Act §9(4)'s blanket unregistered-supplier RCM has been suspended since Feb 2019). */
    rcmCategory?: string; }>;
}, ctx: TenantContext, userId: string) {
  // Layer 2: Supplier is company-owned (Phase 3) — a Company-B supplierId must 404, not let a PO
  // be raised against another company's supplier relationship.
  await assertOwnedByCompany('supplier', data.supplierId, ctx.companyId, 'Supplier');
  const supplier = await tenantQuery(ctx.companyId, (_tx) => _tx.supplier.findUniqueOrThrow({
    where: { id: data.supplierId }, select: { gstNumber: true, isActive: true },
  }));
  if (!supplier.isActive) throw new AppError('This supplier is inactive — reactivate it before raising a purchase order.', 409);

  // One FINISHED_GOODS line = one piece = one JewelryTag (see createTagFromGrnItem). A line with
  // quantity 3 would still only ever yield one tag, silently leaving two pieces off the books.
  const badFinishedLine = data.items.find((i) => i.materialType === FINISHED_GOODS_MATERIAL_TYPE && Number(i.quantity) !== 1);
  if (badFinishedLine) {
    throw new AppError(
      `${badFinishedLine.materialName}: a ${FINISHED_GOODS_MATERIAL_TYPE} line is one piece — enter one line per piece (quantity 1)`, 400);
  }

  // A FINISHED_LOT line is one invoice row for a whole bag: its gross weight, ONE amount, and — category by
  // category — what is inside it. Each category row is resolved here (any two of gross/stone/net give the third,
  // checked against the master and the company's karat list) and the bag's own totals are derived from them.
  const lotCategories = new Map<(typeof data.items)[number], ResolvedLotCategory[]>();
  for (const i of data.items.filter((x) => x.materialType === FINISHED_LOT_MATERIAL_TYPE)) {
    lotCategories.set(i, await resolveLotCategories(i, ctx.companyId));
  }

  // Input GST per line: HSN + a rate snapshot (see PoItem.taxRate). Only INR bills carry GST.
  const currency = data.currency ?? 'INR';
  const hsnCodes = Array.from(new Set(data.items.map((i) => i.hsnCode ?? DEFAULT_HSN_CODE)));
  const hsnRows = await prisma.hsnCode.findMany({ where: { code: { in: hsnCodes }, isActive: true } });
  const hsnByCode = new Map(hsnRows.map((h) => [h.code, h]));
  const missingHsn = hsnCodes.filter((c) => !hsnByCode.has(c));
  if (missingHsn.length > 0) throw new AppError(`Unknown HSN code(s): ${missingHsn.join(', ')}`, 400);

  // Component rates: the buyer's own, else the vendor's standing rate (see shared/vendorRates.ts).
  const componentsByLine = new Map<(typeof data.items)[number], Awaited<ReturnType<typeof resolvePoComponents>>>();
  for (const i of data.items) {
    componentsByLine.set(i, await resolvePoComponents(ctx.companyId, data.supplierId, data.orderDate, i.materialName || 'PO line', i.components));
  }

  const items = data.items.map((src) => {
    const { hsnCode, taxRate: explicitRate, materialCode, materialName, materialType, quantity, weight, unit, karat, ratePerUnit } = src;
    const hsn = hsnByCode.get(hsnCode ?? DEFAULT_HSN_CODE)!;
    if (explicitRate !== undefined && (explicitRate < 0 || explicitRate > 1)) {
      throw new AppError(`${materialName}: GST rate must be a fraction between 0 and 1 (0.03 = 3%)`, 400);
    }
    if (src.taxCategory !== undefined && !isValidTaxCategory(src.taxCategory)) {
      throw new AppError(`${materialName}: unknown tax category "${src.taxCategory}"`, 400);
    }
    if (src.rcmCategory !== undefined && !isValidRcmCategory(src.rcmCategory)) {
      throw new AppError(`${materialName}: unknown RCM category "${src.rcmCategory}"`, 400);
    }
    const taxRate = currency !== 'INR' ? 0 : (explicitRate ?? (supplier.gstNumber ? Number(hsn.gstRate) : 0));
    const taxCategory = src.taxCategory ?? DEFAULT_TAX_CATEGORY;
    const rcmCategory = src.rcmCategory ?? DEFAULT_RCM_CATEGORY;
    const base = { materialCode, materialName, materialType, hsnCodeId: hsn.id, taxRate, taxCategory, rcmCategory };
    const cats = lotCategories.get(src);
    const comps = componentsByLine.get(src)!;
    if (cats) {
      // One bag = one unit. The invoice states the bag's amount, not a rate; its weights are the category rows'.
      const amount = round2(Number(src.lotAmount));
      return {
        ...base, quantity: 1, unit: 'BAG', weight: round4(Number(weight) > 0 ? Number(weight) : cats.reduce((s, c) => s + c.grossWeight, 0)),
        // No breakup: the bag's gross weight stands in as its net, so its cost still splits by weight across the pieces.
        netWeight: round4(cats.length > 0 ? cats.reduce((s, c) => s + c.netWeight, 0) : Number(weight)), karat: undefined, ratePerUnit: amount, totalAmount: amount, cats, comps,
      };
    }
    return { ...base, quantity, weight, unit, karat, ratePerUnit, totalAmount: quantity * ratePerUnit, netWeight: undefined, cats: undefined, comps };
  });

  const subtotal = items.reduce((sum, i) => sum + i.totalAmount, 0);
  const taxAmount = round2(items.reduce((sum, i) => sum + i.totalAmount * i.taxRate, 0));

  const po = await tenantTransaction(ctx.companyId, async (tx) => {
    const poNumber = await nextDocumentNumber(ctx.companyId, 'PO', 'PO', tx, data.orderDate.getFullYear());
    const header = await tx.purchaseOrder.create({
      data: {
        companyId: ctx.companyId,
        poNumber,
        supplierId: data.supplierId,
        poType: data.poType,
        orderDate: data.orderDate,
        expectedDate: data.expectedDate,
        currency,
        exchangeRate: data.exchangeRate ?? 1,
        subtotal,
        taxAmount,
        totalAmount: subtotal + taxAmount,
        notes: data.notes,
      },
    });
    // Lines one by one (not createMany): a lot line's category rows need its id.
    for (const { cats, comps, ...line } of items) {
      const created = await tx.poItem.create({ data: { companyId: ctx.companyId, poId: header.id, ...line } });
      if (comps.length > 0) {
        await tx.poItemComponent.createMany({ data: comps.map((c) => ({ companyId: ctx.companyId, poItemId: created.id, ...c })) });
      }
      if (cats && cats.length > 0) {
        await tx.poItemCategory.createMany({ data: cats.map((c) => ({ companyId: ctx.companyId, poItemId: created.id, ...c })) });
      }
    }
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: header.id }, include: PO_INCLUDE });
  });

  await createAuditEntry('purchase_orders', po.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return po;
}

// A received FINISHED_LOT line opens a PurchaseLot (bag). The whole supplier bill is booked here, at
// receipt — Dr Inventory (taxable value) + Dr Input GST / Cr Accounts Payable, and the supplier's live
// payable goes up by goods + GST — not as each piece is tagged, because the bill is owed the moment the
// goods arrive. That leaves tagging a piece out of the lot money-free: it only allocates a share of
// PurchaseLot.totalCost to that tag (see shared/purchaseLot.ts). The GST is stamped on the GRN line, exactly
// where a single finished piece's is, so the purchase-GST register and a purchase return read it the same way.
async function openPurchaseLot(tx: Prisma.TransactionClient, a: {
  ctx: TenantContext; userId: string;
  grn: { id: string; grnNumber: string; receivedDate: Date; branchId: string | null };
  grnItem: { id: string; poItemId: string };
  poItem: { id: string; materialName: string; karat: string | null; quantity: Prisma.Decimal; weight: Prisma.Decimal;
    netWeight: Prisma.Decimal | null; totalAmount: Prisma.Decimal; taxRate: Prisma.Decimal;
    rcmCategory: string | null; taxCategory: string | null; hsnCodeId: string | null };
  supplierId: string; supplierGstNumber: string | null; supplierStateCode: string | null; companyStateCode: string | null;
}) {
  const { ctx, poItem } = a;
  // Lock the PO line first, so two GRNs received against it at once can't both open a lot for it.
  await tx.poItem.update({ where: { id: poItem.id }, data: { receivedQty: { increment: 0 } } });
  const already = await tx.purchaseLot.findFirst({ where: { companyId: ctx.companyId, grnItem: { poItemId: poItem.id } } });
  if (already) throw new AppError(`${poItem.materialName}: this lot line has already been received`, 409);
  if (poItem.netWeight == null) throw new AppError(`${poItem.materialName}: the PO line has no net weight — it is not a valid lot line`, 400);
  const categories = await tx.poItemCategory.findMany({ where: { companyId: ctx.companyId, poItemId: poItem.id } });
  // A total piece count exists only when there is a breakup and every category row states one.
  const pieces = categories.length > 0 && categories.every((c) => c.pieces != null) ? categories.reduce((s, c) => s + (c.pieces ?? 0), 0) : null;

  const taxable = round2(Number(poItem.totalAmount));
  const gst = splitInputGst(taxable, Number(poItem.taxRate), a.supplierStateCode, a.companyStateCode);
  // G2g-7a: which of the company's own GST registrations this inward supply is attributed to —
  // resolved from the GRN's own receiving branch, stamped alongside the tax amounts below.
  const buyerRegistrationId = await resolveBuyerRegistration(tx, ctx.companyId, a.grn.branchId);
  // G2g-7g: same checkpoint as createTagFromGrnItem's — this is the exact point this GRN line's
  // input GST is booked below (GrnItem.taxableValue/inputCgst/Sgst/Igst), read by
  // gstr3bItcReporting.service.ts's loader by GRN receivedDate. Runs before bookRcmLiabilityIfApplicable
  // too, which is called later in this same transaction.
  await assertGstr3bPeriodMutable(tx, ctx.companyId, {
    documentType: 'GRN_ITEM', documentId: a.grnItem.id,
    gstRegistrationId: buyerRegistrationId, documentDate: a.grn.receivedDate, action: 'received',
  });

  const lot = await tx.purchaseLot.create({
    data: {
      companyId: ctx.companyId, grnItemId: a.grnItem.id, label: poItem.materialName, pieces,
      grossWeight: poItem.weight, netWeight: poItem.netWeight, totalCost: taxable,
    },
  });

  await postAutoJournalEntry(tx, ctx.companyId, {
    date: a.grn.receivedDate, description: `Finished-lot intake ${a.grn.grnNumber} — ${poItem.materialName}`,
    referenceType: 'PurchaseLot', referenceId: lot.id, userId: a.userId,
    lines: [
      { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: taxable },
      { accountCode: LEDGER_ACCOUNT.INPUT_CGST, debit: gst.cgst },
      { accountCode: LEDGER_ACCOUNT.INPUT_SGST, debit: gst.sgst },
      { accountCode: LEDGER_ACCOUNT.INPUT_IGST, debit: gst.igst },
      { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, credit: round2(taxable + gst.total) },
    ],
  });
  await tx.grnItem.update({
    where: { id: a.grnItem.id },
    data: { taxableValue: taxable, inputCgst: gst.cgst, inputSgst: gst.sgst, inputIgst: gst.igst, buyerRegistrationId },
  });
  await tx.supplier.update({ where: { id: a.supplierId }, data: { currentDue: { increment: round2(taxable + gst.total) } } });

  // G2g-7d: a no-op for the overwhelming majority of lines (PoItem.rcmCategory NONE) — see
  // createTagFromGrnItem's identical hook and PHASE_G2G7D_AUDIT.md.
  await bookRcmLiabilityIfApplicable(tx, {
    ctx: a.ctx, userId: a.userId,
    grn: { grnNumber: a.grn.grnNumber, receivedDate: a.grn.receivedDate },
    grnItemId: a.grnItem.id,
    poItem: { rcmCategory: a.poItem.rcmCategory, taxCategory: a.poItem.taxCategory, hsnCodeId: a.poItem.hsnCodeId, totalAmount: a.poItem.totalAmount },
    supplier: { id: a.supplierId, gstNumber: a.supplierGstNumber },
    supplierStateCode: a.supplierStateCode, companyStateCode: a.companyStateCode, buyerRegistrationId,
  });

  return lot;
}

export async function createGRN(data: {
  poId: string; receivedDate: Date; invoiceNumber?: string; invoiceDate?: Date; notes?: string;
  // Receiving branch — required when the PO carries a FINISHED_GOODS line, since that line becomes
  // a JewelryTag at a specific branch (the tag-from-GRN step defaults to it).
  branchId?: string;
  items: Array<{ poItemId: string; invoiceQty: number; invoiceWeight: number; scaleWeight: number; }>;
}, ctx: TenantContext, userId: string) {
  // Layer 2: a Company-B poId must 404, not let a GRN be receipted against another company's
  // purchase order.
  const po = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.findUnique({
    where: { id: data.poId },
    include: { poItems: true, supplier: { select: { gstNumber: true, state: true } } },
  }));
  if (!po || po.companyId !== ctx.companyId) throw new AppError('Purchase Order not found', 404);

  if (data.branchId) await assertBranchAccessible(data.branchId, ctx);
  const isFinished = (t?: string) => t === FINISHED_GOODS_MATERIAL_TYPE || t === FINISHED_LOT_MATERIAL_TYPE;
  const receivesFinishedGoods = data.items.some((i) => isFinished(po.poItems.find((p) => p.id === i.poItemId)?.materialType));
  if (receivesFinishedGoods && !data.branchId) {
    throw new AppError('Receiving branch is required when receiving finished goods', 400);
  }

  const grnItems = data.items.map((item) => {
    const poItem = po.poItems.find((p) => p.id === item.poItemId);
    if (!poItem) throw new AppError(`PO item ${item.poItemId} not found`, 404);
    // A lot is received whole, against the invoice's piece count — its cost and GST are booked on receipt.
    if (poItem.materialType === FINISHED_LOT_MATERIAL_TYPE && Number(item.invoiceQty) !== Number(poItem.quantity)) {
      throw new AppError(`${poItem.materialName}: a lot is received whole — the PO line has ${Number(poItem.quantity)} pieces, not ${Number(item.invoiceQty)}`, 400);
    }

    const variance = item.scaleWeight - item.invoiceWeight;
    const variancePercent = (variance / item.invoiceWeight) * 100;
    const accepted = Math.min(item.scaleWeight, Number(poItem.weight));

    return {
      poItemId: item.poItemId,
      invoiceQty: item.invoiceQty,
      invoiceWeight: item.invoiceWeight,
      scaleWeight: item.scaleWeight,
      acceptedWeight: accepted,
      variance,
      variancePercent,
      isVerified: Math.abs(variancePercent) < 0.5,
    };
  });

  const hasDiscrepancy = grnItems.some((i) => !i.isVerified);

  const grn = await tenantTransaction(ctx.companyId, async (tx) => {
    const grnNumber = await nextDocumentNumber(ctx.companyId, 'GRN', 'GRN', tx, data.receivedDate.getFullYear());
    const grn = await tx.goodsReceiptNote.create({
      data: {
        companyId: ctx.companyId,
        grnNumber, poId: data.poId,
        receivedDate: data.receivedDate,
        invoiceNumber: data.invoiceNumber,
        invoiceDate: data.invoiceDate,
        branchId: data.branchId,
        status: hasDiscrepancy ? 'DISCREPANCY' : 'VERIFIED',
        notes: data.notes,
        grnItems: { createMany: { data: grnItems } },
      },
      include: { grnItems: true },
    });

    // Snapshot each line's agreed component rates (stone / pearl / bead) so tagging uses what THIS PO agreed, whatever
    // the PO or the vendor's rate list says later.
    for (const g of grn.grnItems) await snapshotGrnComponentRates(tx, ctx.companyId, g.id, g.poItemId);

    // FINISHED_LOT lines: open the lot and book the whole bill (goods + input GST) now — see openPurchaseLot.
    const lotLines = grn.grnItems.filter((g) => po.poItems.find((p) => p.id === g.poItemId)?.materialType === FINISHED_LOT_MATERIAL_TYPE);
    if (lotLines.length > 0) {
      const supplierStateCode = await resolveSupplierStateCode(po.supplier);
      const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } });
      for (const g of lotLines) {
        await openPurchaseLot(tx, {
          ctx, userId, grn, grnItem: g, poItem: po.poItems.find((p) => p.id === g.poItemId)!,
          supplierId: po.supplierId, supplierGstNumber: po.supplier.gstNumber, supplierStateCode, companyStateCode: company.stateCode,
        });
      }
    }

    // Update PO item received quantities
    for (const grnItem of grnItems) {
      await tx.poItem.update({
        where: { id: grnItem.poItemId },
        data: {
          receivedQty: { increment: grnItem.invoiceQty },
          receivedWt: { increment: grnItem.acceptedWeight },
        },
      });
    }

    // Check if PO is fully received
    const updatedPO = await tx.purchaseOrder.findUnique({
      where: { id: data.poId }, include: { poItems: true },
    });
    const allReceived = updatedPO!.poItems.every(
      (i) => Number(i.receivedWt) >= Number(i.weight) * 0.99
    );
    if (allReceived) {
      await tx.purchaseOrder.update({
        where: { id: data.poId }, data: { status: 'COMPLETED' },
      });
    }

    return grn;
  });

  await createAuditEntry('goods_receipt_notes', grn.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return grn;
}

export async function listSuppliers(companyId: string, includeInactive = false) {
  return tenantQuery(companyId, (_tx) => _tx.supplier.findMany({
    where: { companyId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: { name: 'asc' },
  }));
}

export async function createSupplier(data: {
  name: string; type: string; supplierCode?: string;
  gstNumber?: string; panNumber?: string; contactName?: string;
  phone?: string; email?: string; address?: string; city?: string; state?: string; pincode?: string;
  /** G2g-7a: whether this supplier is registered under the GST Composition Scheme. Omitted: false. */
  isComposition?: boolean;
}, companyId: string) {
  return tenantTransaction(companyId, async (tx) => {
    const supplierPrefix: Record<string, string> = {
      METAL_REFINER: 'MR', STONE_DEALER: 'SD', FINDINGS_VENDOR: 'FV', KARIGAR: 'KG', OTHER: 'OT',
    };
    const code = data.supplierCode
      ?? await nextSimpleCode(companyId, `SUPPLIER:${data.type}`, supplierPrefix[data.type] ?? 'SU', 4, tx);
    return tx.supplier.create({ data: { ...data, companyId, supplierCode: code } });
  });
}

// Fields an admin may correct on a supplier. supplierCode (identity), currentDue (ledger-driven live
// payable) and isActive (its own permission) are deliberately NOT here.
const SUPPLIER_WRITABLE_KEYS = [
  'name', 'type', 'gstNumber', 'panNumber', 'contactName', 'phone', 'email', 'address', 'city', 'state', 'pincode',
  'bankName', 'bankAccount', 'bankIfsc', 'creditLimit', 'isComposition',
] as const;

export async function updateSupplier(ctx: TenantContext, supplierId: string, body: Record<string, unknown>, userId: string) {
  await assertOwnedByCompany('supplier', supplierId, ctx.companyId, 'Supplier');
  const data: Record<string, unknown> = {};
  for (const k of SUPPLIER_WRITABLE_KEYS) if (body[k] !== undefined) data[k] = body[k];
  if (Object.keys(data).length === 0) throw new AppError('Nothing to update', 400);
  const before = await tenantQuery(ctx.companyId, (tx) => tx.supplier.findFirstOrThrow({ where: { id: supplierId, companyId: ctx.companyId } }));
  const after = await tenantQuery(ctx.companyId, (tx) => tx.supplier.update({ where: { id: supplierId }, data }));
  const pick = (o: any) => Object.fromEntries(Object.keys(data).map((k) => [k, o[k]]));
  await createAuditEntry('suppliers', supplierId, userId, 'EDIT', pick(before), pick(after), ctx.companyId);
  return after;
}

/** Deactivate / reactivate. An inactive supplier drops out of pickers and cannot receive new POs; history is untouched. */
export async function setSupplierActive(ctx: TenantContext, supplierId: string, isActive: boolean, userId: string) {
  await assertOwnedByCompany('supplier', supplierId, ctx.companyId, 'Supplier');
  const res = await tenantQuery(ctx.companyId, (tx) =>
    tx.supplier.updateMany({ where: { id: supplierId, companyId: ctx.companyId, isActive: !isActive }, data: { isActive } }));
  if (res.count === 0) throw new AppError(isActive ? 'Supplier is already active' : 'Supplier is already inactive', 409);
  await createAuditEntry('suppliers', supplierId, userId, isActive ? 'REACTIVATE' : 'DEACTIVATE', { isActive: !isActive }, { isActive }, ctx.companyId);
}

/** Permanent delete — only a supplier with no history at all. Anything else must be deactivated. Never cascades. */
export async function deleteSupplier(ctx: TenantContext, supplierId: string, userId: string) {
  await assertOwnedByCompany('supplier', supplierId, ctx.companyId, 'Supplier');
  const existing = await tenantQuery(ctx.companyId, (tx) => tx.supplier.findFirstOrThrow({
    where: { id: supplierId, companyId: ctx.companyId },
    include: { _count: { select: {
      purchaseOrders: true, artisans: true, returns: true, payments: true, componentRates: true,
      debitNotes: true, rcmLiabilities: true, selfInvoices: true,
    } } },
  }));
  const used = Object.entries(existing._count).filter(([, n]) => n > 0).map(([k]) => k);
  if (used.length > 0 || Number(existing.currentDue) !== 0) {
    throw new AppError('This supplier has transactions or a balance and cannot be deleted — deactivate it instead.', 409);
  }
  try {
    await tenantQuery(ctx.companyId, (tx) => tx.supplier.delete({ where: { id: supplierId } }));
  } catch (err) {
    if (isBlockedByForeignKey(err)) throw new AppError('This supplier is still referenced by other records — deactivate it instead.', 409);
    throw err;
  }
  await createAuditEntry('suppliers', supplierId, userId, 'DELETE', { name: existing.name, supplierCode: existing.supplierCode }, undefined, ctx.companyId);
}

// ─── Purchase Requisitions ────────────────────────────────────────────────────

export async function listPRs(ctx: TenantContext, filters: { status?: string; page?: number; limit?: number }) {
  const { status, page = 1, limit = 20 } = filters;
  const where: Prisma.PurchaseRequisitionWhereInput = { companyId: ctx.companyId, ...(status && { status }) };
  const [prs, total] = await tenantBatch(ctx.companyId, (tx) => [
    tx.purchaseRequisition.findMany({
      where,
      include: {
        requestedBy: { select: { name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    tx.purchaseRequisition.count({ where }),
  ]);
  return { prs, total, page, limit, pages: Math.ceil(total / limit) };
}

export async function getPR(ctx: TenantContext, id: string) {
  const pr = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.findUnique({
    where: { id },
    include: {
      // department used to come from the global User; it is a per-company fact now (and the PR
      // carries its own `department` field, which is what the UI shows).
      requestedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      items: true,
      approvalHistory: {
        include: { performedBy: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  }));
  if (!pr || pr.companyId !== ctx.companyId) throw new AppError('Purchase Requisition not found', 404);
  return pr;
}

export async function createPR(data: {
  department: string; notes?: string;
  items: Array<{
    materialCode: string; materialName: string; materialType: string;
    karat?: string; quantity: number; weight: number; unit: string; estimatedRate: number;
  }>;
}, ctx: TenantContext, userId: string) {
  const items = data.items.map((i) => ({
    ...i,
    companyId: ctx.companyId,
    totalEstimatedAmount: i.weight * i.estimatedRate,
  }));
  const totalEstimatedAmount = items.reduce((sum, i) => sum + i.totalEstimatedAmount, 0);

  const pr = await tenantTransaction(ctx.companyId, async (tx) => {
    const prNumber = await nextDocumentNumber(ctx.companyId, 'PR', 'PR', tx);
    return tx.purchaseRequisition.create({
      data: {
        companyId: ctx.companyId,
        prNumber,
        department: data.department,
        notes: data.notes,
        totalEstimatedAmount,
        requestedById: userId,
        items: { createMany: { data: items } },
      },
      include: { items: true, requestedBy: { select: { name: true } } },
    });
  });
  await createAuditEntry('purchase_requisitions', pr.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return pr;
}

/** Delete a requisition that was never submitted. Anything past DRAFT carries approval history and stays. */
export async function deletePR(ctx: TenantContext, id: string, userId: string) {
  await assertOwnedByCompany('purchaseRequisition', id, ctx.companyId, 'Purchase requisition');
  const pr = await tenantQuery(ctx.companyId, (tx) => tx.purchaseRequisition.findFirstOrThrow({
    where: { id, companyId: ctx.companyId }, include: { _count: { select: { purchaseOrders: true, approvalHistory: true } } },
  }));
  if (pr.status !== 'DRAFT' || pr._count.purchaseOrders > 0 || pr._count.approvalHistory > 0) {
    throw new AppError('Only a draft requisition that was never submitted can be deleted.', 409);
  }
  const res = await tenantTransaction(ctx.companyId, (tx) =>
    tx.purchaseRequisition.deleteMany({ where: { id, companyId: ctx.companyId, status: 'DRAFT' } }));
  if (res.count === 0) throw new AppError('Only a draft requisition that was never submitted can be deleted.', 409);
  await createAuditEntry('purchase_requisitions', id, userId, 'DELETE', { prNumber: pr.prNumber, status: pr.status }, undefined, ctx.companyId);
}

export async function submitPR(id: string, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('purchaseRequisition', id, ctx.companyId, 'Purchase Requisition');
  const pr = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.findUniqueOrThrow({ where: { id } }));
  if (pr.status !== 'DRAFT') throw new AppError('Only DRAFT requisitions can be submitted', 400);
  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.update({
    where: { id },
    data: { status: 'SUBMITTED' },
  }));
  await tenantQuery(ctx.companyId, (_tx) => _tx.approvalHistory.create({
    data: { companyId: ctx.companyId, referenceType: 'PR', referenceId: id, purchaseRequisitionId: id, action: 'SUBMITTED', performedById: userId },
  }));
  return updated;
}

export async function approvePR(id: string, ctx: TenantContext, userId: string, comments?: string) {
  await assertOwnedByCompany('purchaseRequisition', id, ctx.companyId, 'Purchase Requisition');
  const pr = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.findUniqueOrThrow({ where: { id } }));
  if (pr.status !== 'SUBMITTED') throw new AppError('Only SUBMITTED requisitions can be approved', 400);
  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.update({
    where: { id },
    data: { status: 'APPROVED', approvedById: userId, approvedAt: new Date() },
  }));
  await tenantQuery(ctx.companyId, (_tx) => _tx.approvalHistory.create({
    data: { companyId: ctx.companyId, referenceType: 'PR', referenceId: id, purchaseRequisitionId: id, action:'APPROVED', comments, performedById: userId },
  }));
  return updated;
}

export async function rejectPR(id: string, ctx: TenantContext, userId: string, comments: string) {
  await assertOwnedByCompany('purchaseRequisition', id, ctx.companyId, 'Purchase Requisition');
  const pr = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.findUniqueOrThrow({ where: { id } }));
  if (pr.status !== 'SUBMITTED') throw new AppError('Only SUBMITTED requisitions can be rejected', 400);
  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.update({
    where: { id },
    data: { status: 'REJECTED' },
  }));
  await tenantQuery(ctx.companyId, (_tx) => _tx.approvalHistory.create({
    data: { companyId: ctx.companyId, referenceType: 'PR', referenceId: id, purchaseRequisitionId: id, action:'REJECTED', comments, performedById: userId },
  }));
  return updated;
}

export async function convertToPO(id: string, ctx: TenantContext, userId: string) {
  const pr = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseRequisition.findUnique({
    where: { id },
    include: { items: true },
  }));
  if (!pr || pr.companyId !== ctx.companyId) throw new AppError('Purchase Requisition not found', 404);
  if (pr.status !== 'APPROVED') throw new AppError('Only APPROVED requisitions can be converted to PO', 400);

  const totalEstimated = Number(pr.totalEstimatedAmount);

  const po = await tenantTransaction(ctx.companyId, async (tx) => {
    const poNumber = await nextDocumentNumber(ctx.companyId, 'PO', 'PO', tx);
    const po = await tx.purchaseOrder.create({
      data: {
        companyId: ctx.companyId,
        poNumber,
        // Layer 2: scoped to this company's own suppliers — previously an unscoped
        // findFirstOrThrow, which (now that Supplier is company-owned, Phase 3) could otherwise
        // pick an arbitrary OTHER company's supplier.
        supplierId: (await tx.supplier.findFirstOrThrow({ where: { companyId: ctx.companyId, isActive: true } })).id,
        poType: 'OUTRIGHT',
        orderDate: new Date(),
        purchaseRequisitionId: id,
        subtotal: totalEstimated,
        totalAmount: totalEstimated,
        submittedById: userId,
        poItems: {
          createMany: {
            data: pr.items.map((i) => ({
              materialCode: i.materialCode,
              materialName: i.materialName,
              materialType: i.materialType,
              karat: i.karat,
              quantity: i.quantity,
              weight: i.weight,
              unit: i.unit,
              ratePerUnit: i.estimatedRate,
              totalAmount: Number(i.totalEstimatedAmount),
            })),
          },
        },
      },
      include: { poItems: true },
    });
    await tx.purchaseRequisition.update({
      where: { id },
      data: { status: 'CONVERTED', convertedPoId: po.id },
    });
    await tx.approvalHistory.create({
      data: { companyId: ctx.companyId, referenceType: 'PR', referenceId: id, purchaseRequisitionId: id, action:'CONVERTED', performedById: userId },
    });
    return po;
  });

  await createAuditEntry('purchase_orders', po.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return po;
}

// ─── PO Multi-Stage Approval ──────────────────────────────────────────────────

const PO_APPROVAL_THRESHOLD = 500000;

export async function submitPOForApproval(id: string, ctx: TenantContext, userId: string) {
  await assertOwnedByCompany('purchaseOrder', id, ctx.companyId, 'Purchase Order');
  const po = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.findUniqueOrThrow({ where: { id } }));
  if (po.status !== 'DRAFT') throw new AppError('Only DRAFT purchase orders can be submitted for approval', 400);
  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.update({
    where: { id },
    data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), submittedById: userId },
  }));
  await tenantQuery(ctx.companyId, (_tx) => _tx.approvalHistory.create({
    data: { companyId: ctx.companyId, referenceType: 'PO', referenceId: id, purchaseOrderId: id, action: 'SUBMITTED', performedById: userId },
  }));
  return updated;
}

// J4-D2: the ₹5,00,000+ threshold is now gated by the po:approve_high_value permission, not a
// hardcoded role name — any role (including a custom delegated one) can be granted it through the
// Role Editor. The router already requires po:approve for every caller of this function, so
// po:approve_high_value alone is never sufficient on its own — it only ever adds to po:approve.
export async function approvePO(id: string, ctx: TenantContext, userId: string, canApproveHighValue: boolean, comments?: string) {
  await assertOwnedByCompany('purchaseOrder', id, ctx.companyId, 'Purchase Order');
  const po = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.findUniqueOrThrow({ where: { id } }));
  if (po.status !== 'PENDING_APPROVAL') throw new AppError('Only PENDING_APPROVAL purchase orders can be approved', 400);

  // The approval limit is on the value of the goods ordered, as it always was — not on the input GST
  // now added into totalAmount, which would silently push borderline orders over the limit.
  const amount = Number(po.totalAmount) - Number(po.taxAmount);
  if (amount > PO_APPROVAL_THRESHOLD && !canApproveHighValue) {
    throw new AppError(
      `Purchase orders exceeding ₹${PO_APPROVAL_THRESHOLD.toLocaleString('en-IN')} require the po:approve_high_value permission`,
      403
    );
  }

  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.update({
    where: { id },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedById: userId },
  }));
  await tenantQuery(ctx.companyId, (_tx) => _tx.approvalHistory.create({
    data: { companyId: ctx.companyId, referenceType: 'PO', referenceId: id, purchaseOrderId: id, action: 'APPROVED', comments, performedById: userId },
  }));
  return updated;
}

export async function rejectPO(id: string, ctx: TenantContext, userId: string, comments: string) {
  await assertOwnedByCompany('purchaseOrder', id, ctx.companyId, 'Purchase Order');
  const po = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.findUniqueOrThrow({ where: { id } }));
  if (po.status !== 'PENDING_APPROVAL') throw new AppError('Only PENDING_APPROVAL purchase orders can be rejected', 400);
  const updated = await tenantQuery(ctx.companyId, (_tx) => _tx.purchaseOrder.update({
    where: { id },
    data: { status: 'REJECTED' },
  }));
  await tenantQuery(ctx.companyId, (_tx) => _tx.approvalHistory.create({
    data: { companyId: ctx.companyId, referenceType: 'PO', referenceId: id, purchaseOrderId: id, action: 'REJECTED', comments, performedById: userId },
  }));
  return updated;
}

// A PO that has not received anything yet is only an intention — it books no stock and no journal — so it can
// be removed outright. The moment a GRN exists (goods received, tags/lot opened, payable booked) it is a
// record of something that happened and can no longer be deleted (the GRN's FK to the PO enforces this too).
// Deleting a PO that came from a requisition puts that requisition back to APPROVED so it can be converted again.
export async function deletePO(id: string, ctx: TenantContext, userId: string, canDeleteApproved: boolean) {
  await assertOwnedByCompany('purchaseOrder', id, ctx.companyId, 'Purchase Order');
  await tenantTransaction(ctx.companyId, async (tx) => {
    const po = await tx.purchaseOrder.findUniqueOrThrow({
      where: { id }, include: { _count: { select: { grns: true } } },
    });
    if (po._count.grns > 0) {
      throw new AppError('This purchase order already has goods receipts and cannot be deleted.', 409);
    }
    if (['APPROVED', 'PENDING_APPROVAL'].includes(po.status) && !canDeleteApproved) {
      throw new AppError('Deleting a submitted or approved purchase order needs the approve permission.', 403);
    }
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(po.status)) {
      throw new AppError(`A ${po.status} purchase order cannot be deleted.`, 409);
    }
    if (po.purchaseRequisitionId) {
      await tx.purchaseRequisition.updateMany({
        where: { id: po.purchaseRequisitionId, companyId: ctx.companyId, status: 'CONVERTED' },
        data: { status: 'APPROVED', convertedPoId: null },
      });
    }
    await tx.purchaseOrder.delete({ where: { id } });
  });
  await createAuditEntry('purchase_orders', id, userId, 'DELETE', undefined, undefined, ctx.companyId);
}

// ─── Supplier Performance ─────────────────────────────────────────────────────

// Supplier is now company-owned (Phase 3 — reversed from the earlier "keep it global" call, see
// the schema's own comment) — both the supplier list and its purchaseOrders are scoped here.
export async function getSuppliersPerformance(ctx: TenantContext) {
  const suppliers = await tenantQuery(ctx.companyId, (_tx) => _tx.supplier.findMany({
    where: { companyId: ctx.companyId, isActive: true },
    include: {
      purchaseOrders: {
        where: { companyId: ctx.companyId },
        include: {
          grns: { include: { grnItems: true } },
        },
      },
    },
  }));

  return suppliers.map((supplier) => {
    const pos = supplier.purchaseOrders;

    // On-time delivery: GRNs received on or before expectedDate
    const posWithExpectedDate = pos.filter((po) => po.expectedDate);
    let onTimeDeliveryRate: number | null = null;
    if (posWithExpectedDate.length > 0) {
      const grnsWithDate = posWithExpectedDate.flatMap((po) =>
        po.grns.map((grn) => ({ receivedDate: grn.receivedDate, expectedDate: po.expectedDate! }))
      );
      if (grnsWithDate.length > 0) {
        const onTime = grnsWithDate.filter((g) => g.receivedDate <= g.expectedDate).length;
        onTimeDeliveryRate = Math.round((onTime / grnsWithDate.length) * 100);
      }
    }

    // Weight accuracy: items within 0.5% variance
    const allGrnItems = pos.flatMap((po) => po.grns.flatMap((g) => g.grnItems));
    let weightAccuracyRate: number | null = null;
    if (allGrnItems.length > 0) {
      const accurate = allGrnItems.filter((i) => Math.abs(Number(i.variancePercent)) < 0.5).length;
      weightAccuracyRate = Math.round((accurate / allGrnItems.length) * 100);
    }

    // Avg lead time: days from orderDate to GRN receivedDate
    const leadTimes = pos.flatMap((po) =>
      po.grns.map((grn) => {
        const ms = grn.receivedDate.getTime() - po.orderDate.getTime();
        return ms / (1000 * 60 * 60 * 24);
      })
    );
    const avgLeadTimeDays = leadTimes.length > 0
      ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length)
      : null;

    // Total spend
    const totalSpend = pos
      .filter((po) => ['COMPLETED', 'APPROVED', 'PARTIAL'].includes(po.status))
      .reduce((sum, po) => sum + Number(po.totalAmount), 0);

    return {
      supplierId: supplier.id,
      supplierCode: supplier.supplierCode,
      supplierName: supplier.name,
      supplierType: supplier.type,
      onTimeDeliveryRate,
      weightAccuracyRate,
      avgLeadTimeDays,
      totalSpend,
      totalPOs: pos.length,
    };
  });
}

// ─── Purchase Returns (D3) ─────────────────────────────────────────────────────
// Sending received goods back to a supplier. Scoped to tagged finished-goods pieces only
// (JewelryTag.grnItemId set) — the live post-pivot business path; raw material only ever fed the
// now-dormant manufacturing modules. See CLAUDE.md/ROADMAP.md D3 for why this deliberately
// doesn't touch PoItem.receivedQty/receivedWt or the original GRN row. (Supplier.currentDue is now a
// live payable — intake adds to it, a return and a supplier payment reduce it.)

export async function listReturnableTags(ctx: TenantContext, supplierId: string) {
  return tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
    where: {
      companyId: ctx.companyId, status: 'IN_STOCK',
      OR: [
        { grnItemId: { not: null }, grnItem: { poItem: { po: { supplierId } } } },
        // a piece cut from one of this supplier's lots (bags)
        { purchaseLotId: { not: null }, purchaseLot: { grnItem: { poItem: { po: { supplierId } } } } },
      ],
    },
    include: { branch: { select: { name: true } } },
    orderBy: { tagNumber: 'asc' },
  }));
}

export async function listPurchaseReturns(ctx: TenantContext, supplierId?: string) {
  return tenantQuery(ctx.companyId, (_tx) => _tx.purchaseReturn.findMany({
    where: { companyId: ctx.companyId, ...(supplierId && { supplierId }) },
    include: { items: { include: { tag: { select: { tagNumber: true, name: true } } } }, supplier: { select: { name: true } } },
    orderBy: { returnDate: 'desc' },
  }));
}

// Validate -> guarded/count-checked flip -> link, same shape createSalesReturn (D1) uses.
// PurchaseReturn is now company-owned (Phase 2b) — every tag is explicitly scoped to
// ctx.companyId first regardless, same defense-in-depth reasoning as every other Phase 2 write.
export async function createPurchaseReturn(data: {
  items: Array<{ tagId: string; amount?: number }>;
  reason?: string;
  notes?: string;
}, ctx: TenantContext, userId: string, opts: { issueDebitNote?: boolean } = {}) {
  if (data.items.length === 0) throw new AppError('At least one item is required', 400);

  const tagIds = data.items.map((i) => i.tagId);
  if (new Set(tagIds).size !== tagIds.length) {
    throw new AppError('The same tag cannot appear on more than one line of a return', 400);
  }

  const tags = await tenantQuery(ctx.companyId, (_tx) => _tx.jewelryTag.findMany({
    where: { id: { in: tagIds }, companyId: ctx.companyId },
    include: {
      grnItem: { include: { poItem: { include: { po: true } } } },
      purchaseLot: { include: { grnItem: { include: { poItem: { include: { po: true } } } } } },
    },
  }));

  // Where a piece was bought: its own GRN line (single finished piece) or its lot's (a piece cut from a bag).
  // Either way that GRN line carries the supplier and the input GST booked at receipt.
  const sourceOf = (t: (typeof tags)[number]) => t.grnItem ?? t.purchaseLot?.grnItem ?? null;

  const foundIds = new Set(tags.map((t) => t.id));
  const missing = tagIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) throw new AppError(`Tag(s) not found: ${missing.join(', ')}`, 404);

  const notPurchased = tags.filter((t) => !sourceOf(t));
  if (notPurchased.length > 0) {
    throw new AppError(
      `Tag(s) have no purchase lineage to return against: ${notPurchased.map((t) => t.tagNumber).join(', ')}`, 400
    );
  }

  const notInStock = tags.filter((t) => t.status !== 'IN_STOCK');
  if (notInStock.length > 0) {
    throw new AppError(`Tag(s) not IN_STOCK, cannot return: ${notInStock.map((t) => t.tagNumber).join(', ')}`, 409);
  }

  const supplierIds = new Set(tags.map((t) => sourceOf(t)!.poItem.po.supplierId));
  if (supplierIds.size > 1) {
    throw new AppError('All returned tags must belong to the same supplier — submit separate returns', 400);
  }
  const supplierId = sourceOf(tags[0])!.poItem.po.supplierId;

  const amountByTagId = new Map(data.items.map((i) => [i.tagId, i.amount]));
  const resolvedItems = tags.map((t) => {
    const amount = amountByTagId.get(t.id) ?? Number(t.costPrice);
    // Reverse the input GST exactly as intake booked it (GrnItem.inputCgst/Sgst/Igst), pro-rata if
    // the return amount is overridden — never re-derived from today's rates. A piece tagged before
    // input GST existed has no booked tax, so nothing is reversed for it.
    const g = sourceOf(t)!;
    const bookedTax = Number(g.inputCgst) + Number(g.inputSgst) + Number(g.inputIgst);
    const effRate = g.taxableValue && Number(g.taxableValue) > 0 ? bookedTax / Number(g.taxableValue) : 0;
    const tax = round2(amount * effRate);
    const igst = Number(g.inputIgst) > 0 ? tax : 0;
    const cgst = igst > 0 ? 0 : round2(tax / 2);
    const sgst = igst > 0 ? 0 : round2(tax - cgst);
    return { tagId: t.id, amount, cgst, sgst, igst };
  });
  const totalAmount = resolvedItems.reduce((s, i) => s + i.amount, 0);
  const taxAmount = round2(resolvedItems.reduce((s, i) => s + i.cgst + i.sgst + i.igst, 0));

  // G2g-7g: a Purchase Return is its own GSTR-3B inward/ITC source document
  // (gstr3bItcReporting.service.ts's loader reads it by its own returnDate, attributed to each
  // returned tag's own source GRN line's buyerRegistrationId) — computed once, outside the
  // transaction, and passed explicitly into the create below so the checked date and the persisted
  // date can never drift apart. Every DISTINCT registration among the returned tags' source GRN
  // lines is checked — a return is not restricted to a single GRN unless a debit note is requested.
  const returnDate = new Date();
  const distinctReturnRegistrationIds = Array.from(
    new Set(tags.map((t) => sourceOf(t)!.buyerRegistrationId).filter((id): id is string => !!id)),
  );

  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    const returnNumber = await nextDocumentNumber(ctx.companyId, 'PRET', 'PRET', tx);
    for (const regId of distinctReturnRegistrationIds) {
      await assertGstr3bPeriodMutable(tx, ctx.companyId, {
        documentType: 'PURCHASE_RETURN', documentId: returnNumber,
        gstRegistrationId: regId, documentDate: returnDate, action: 'returned',
      });
    }
    const flipped = await tx.jewelryTag.updateMany({
      where: { id: { in: tagIds }, companyId: ctx.companyId, status: 'IN_STOCK' },
      data: { status: 'RETIRED' },
    });
    if (flipped.count !== tagIds.length) {
      throw new AppError('One or more tags changed status just now — retry the return', 409);
    }

    const created = await tx.purchaseReturn.create({
      data: {
        companyId: ctx.companyId,
        returnNumber,
        returnDate,
        supplierId,
        reason: data.reason,
        notes: data.notes,
        totalAmount,
        taxAmount,
        items: { createMany: { data: resolvedItems } },
      },
      include: { items: { include: { tag: { select: { tagNumber: true } } } } },
    });

    // F1: reverse of createTagFromGrnItem's intake entry — the piece leaves Inventory, the input GST
    // claimed on it is given back, and what we owed the supplier for it goes down by both.
    const sumOf = (k: 'cgst' | 'sgst' | 'igst') => round2(resolvedItems.reduce((s, i) => s + i[k], 0));
    const returnJournalEntry = await postAutoJournalEntry(tx, ctx.companyId, {
      date: new Date(), description: `Purchase Return ${returnNumber}`,
      referenceType: 'PurchaseReturn', referenceId: created.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, debit: round2(totalAmount + taxAmount) },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, credit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.INPUT_CGST, credit: sumOf('cgst') },
        { accountCode: LEDGER_ACCOUNT.INPUT_SGST, credit: sumOf('sgst') },
        { accountCode: LEDGER_ACCOUNT.INPUT_IGST, credit: sumOf('igst') },
      ],
    });
    await tx.supplier.update({ where: { id: supplierId }, data: { currentDue: { decrement: round2(totalAmount + taxAmount) } } });

    // G2e Path A: the formal Debit Note document for this return, in the SAME transaction, when
    // requested. Posts no new journal — journalEntryId points at returnJournalEntry above; no
    // further supplier-balance movement (already done immediately above). A DebitNote carries
    // exactly one grnId, so every returned tag must trace back to the same GRN.
    let debitNote: Awaited<ReturnType<typeof createDebitNoteForPurchaseReturnTx>> | null = null;
    if (opts.issueDebitNote) {
      const grnIds = new Set(tags.map((t) => sourceOf(t)!.grnId));
      if (grnIds.size > 1) {
        throw new AppError(
          'This purchase return spans more than one GRN — a debit note can only be issued per GRN. Submit separate returns per GRN to generate one.',
          400,
        );
      }
      const grnId = [...grnIds][0];
      const returnItemsForDn = resolvedItems.map((r) => {
        const t = tags.find((x) => x.id === r.tagId)!;
        const src = sourceOf(t)!;
        return {
          tagId: r.tagId, tagNumber: t.tagNumber, amount: r.amount, cgst: r.cgst, sgst: r.sgst, igst: r.igst,
          hsnCodeId: src.poItem.hsnCodeId, taxRate: Number(src.poItem.taxRate),
          grossWeight: Number(t.grossWeight), netWeight: Number(t.netWeight), stoneWeight: Number(t.stoneWeight),
          karat: t.metalKarat,
        };
      });
      debitNote = await createDebitNoteForPurchaseReturnTx(tx, ctx, userId, {
        purchaseReturn: created, returnItems: returnItemsForDn, grnId,
        journalEntryId: returnJournalEntry?.id ?? null, reasonNotes: data.reason ?? null,
      });
    }

    return { created, debitNote };
  });

  await createAuditEntry('purchase_returns', result.created.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  if (result.debitNote) {
    await createAuditEntry(
      'debit_notes', result.debitNote.id, userId, 'CREATE', undefined,
      {
        debitNoteNumber: result.debitNote.debitNoteNumber, grnId: result.debitNote.grnId,
        purchaseReturnId: result.debitNote.purchaseReturnId, totalAmount: Number(result.debitNote.totalAmount),
      },
      ctx.companyId,
    );
  }
  return { ...result.created, debitNote: result.debitNote };
}

// ─── Supplier payments ─────────────────────────────────────────────────────────
// Money paid OUT to a supplier — the buy-side mirror of recordClientPayment. Dr Accounts Payable /
// Cr Cash-or-Bank (same two-bucket split the receipts side uses: only CASH hits the till), and the
// supplier's live payable (Supplier.currentDue) goes down. It is a payment on the supplier's
// account, not tied to one bill; a payment larger than what is owed leaves currentDue negative,
// which is simply an advance paid to the supplier.

export async function recordSupplierPayment(data: {
  supplierId: string; amount: number; mode: string; paymentDate: Date; referenceNo?: string; notes?: string;
}, ctx: TenantContext, userId: string) {
  if (!(data.amount > 0)) throw new AppError('Payment amount must be positive', 400);
  if (!data.mode?.trim()) throw new AppError('Payment mode is required', 400);
  await assertOwnedByCompany('supplier', data.supplierId, ctx.companyId, 'Supplier');

  const payment = await tenantTransaction(ctx.companyId, async (tx) => {
    const paymentNumber = await nextDocumentNumber(ctx.companyId, 'SPMT', 'SPMT', tx, data.paymentDate.getFullYear());
    const created = await tx.supplierPayment.create({
      data: {
        companyId: ctx.companyId, paymentNumber, supplierId: data.supplierId,
        paymentDate: data.paymentDate, amount: data.amount, mode: data.mode.toUpperCase(),
        referenceNo: data.referenceNo, notes: data.notes, createdById: userId,
      },
    });

    await postAutoJournalEntry(tx, ctx.companyId, {
      date: data.paymentDate, description: `Supplier payment ${paymentNumber} (${created.mode})`,
      referenceType: 'SupplierPayment', referenceId: created.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, debit: data.amount },
        { accountCode: cashOrBankAccount(created.mode), credit: data.amount },
      ],
    });

    await tx.supplier.update({ where: { id: data.supplierId }, data: { currentDue: { decrement: data.amount } } });
    return created;
  });

  await createAuditEntry('supplier_payments', payment.id, userId, 'CREATE', undefined, undefined, ctx.companyId);
  return payment;
}

/**
 * Reverse a supplier payment (flag + inverse journal + payable restored). The original row is kept for the audit
 * trail; the claim is a count-checked update so two concurrent reversals can never both succeed.
 */
export async function reverseSupplierPayment(ctx: TenantContext, paymentId: string, reason: string, userId: string) {
  if (!reason?.trim()) throw new AppError('A reason is required to reverse a payment', 400);
  await assertOwnedByCompany('supplierPayment', paymentId, ctx.companyId, 'Supplier payment');
  await tenantTransaction(ctx.companyId, async (tx) => {
    const payment = await tx.supplierPayment.findFirstOrThrow({ where: { id: paymentId, companyId: ctx.companyId } });
    const claimed = await tx.supplierPayment.updateMany({
      where: { id: paymentId, companyId: ctx.companyId, reversedAt: null },
      data: { reversedAt: new Date(), reversedById: userId, reversalReason: reason.trim() },
    });
    if (claimed.count === 0) throw new AppError('This payment has already been reversed', 409);
    const amount = Number(payment.amount);
    await postAutoJournalEntry(tx, ctx.companyId, {
      date: new Date(), description: `Reversal of supplier payment ${payment.paymentNumber}: ${reason.trim()}`,
      referenceType: 'SupplierPaymentReversal', referenceId: payment.id, userId,
      lines: [
        { accountCode: cashOrBankAccount(payment.mode), debit: amount },
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, credit: amount },
      ],
    });
    await tx.supplier.update({ where: { id: payment.supplierId }, data: { currentDue: { increment: amount } } });
  });
  await createAuditEntry('supplier_payments', paymentId, userId, 'REVERSE', { reversed: false }, { reversed: true, reason: reason.trim() }, ctx.companyId);
}

// Layer 2: supplierId ownership validated first, same as listClientPayments().
export async function listSupplierPayments(ctx: TenantContext, supplierId: string) {
  await assertOwnedByCompany('supplier', supplierId, ctx.companyId, 'Supplier');
  return tenantQuery(ctx.companyId, (tx) => tx.supplierPayment.findMany({
    where: { companyId: ctx.companyId, supplierId },
    orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
  }));
}
