import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { nextDocumentNumber, gstFinancialYear } from '../../shared/numberSequence';
import { postAutoJournalEntry } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { round2, resolveSupplierStateCode, splitInputGst, resolveBuyerRegistration } from '../../shared/inputGst';
import { isValidDebitNoteReason } from '../../shared/gstDocumentReasons';
import { DEFAULT_HSN_CODE } from '../../shared/constants';
import { assertGstr3bPeriodMutable, auditGstr3bMutationBlocked } from '../finance/gst/gstr3bFilingProtection';

// G2e — Debit Note lifecycle (the purchase-side mirror of creditNote.service.ts's G2c). Two
// creation paths, one shared over-debit guard so neither path can silently diverge from the
// other's math:
//   - createDebitNoteForPurchaseReturnTx(): Path A — wraps an existing PurchaseReturn (called
//     either inline, from procurement.service.ts's createPurchaseReturn when issueDebitNote is
//     requested, or via createDebitNoteForExistingReturn() for an already-existing return). Posts
//     NO new journal and never touches Supplier.currentDue independently — journalEntryId is
//     whatever the return's own entry already is; the return already moved the money.
//   - createStandaloneDebitNote(): Path B — a value-only adjustment against a GRN with no
//     physical return (price variance, short supply, quality deduction, GRN correction). Posts
//     its own journal: Dr Accounts Payable / Cr Inventory + Input CGST/SGST or IGST.
// Only a standalone (Path B) DebitNote can be cancelled — a Path A one is permanently linked to an
// append-only PurchaseReturn, same posture as PurchaseReturn itself (CLAUDE.md D3).
//
// GST document semantics (see the pasted task's §9): this is TRIVO's own procurement Debit Note —
// a document representing money owed back from (or reduced payable to) a supplier. It is not
// itself a statutory GST outward document (TRIVO is the buyer here, not the issuer of an e-invoice
// on this side) and carries no irn/ackNumber/qrCodeData columns. Nothing here should be read as a
// claim that every internal procurement adjustment is automatically a GSTR-1 CDNR-schedule entry.

const auditSnapshot = (dn: {
  debitNoteNumber: string; grnId: string; purchaseReturnId: string | null; reasonCode: string;
  taxableAmount: unknown; totalTax: unknown; totalAmount: unknown;
  items?: Array<{ id: string; description: string; totalValue: unknown }>;
}) => ({
  debitNoteNumber: dn.debitNoteNumber, grnId: dn.grnId, purchaseReturnId: dn.purchaseReturnId,
  reasonCode: dn.reasonCode, taxableAmount: Number(dn.taxableAmount), totalTax: Number(dn.totalTax),
  totalAmount: Number(dn.totalAmount),
  items: dn.items?.map((i) => ({ id: i.id, description: i.description, totalValue: Number(i.totalValue) })),
});

// The GRN's own authoritative gross value (taxable + tax), read from its PoItem lines — never from
// GrnItem.taxableValue (only populated once a piece is tagged/a lot opened — see the GrnItem model
// comment), so this is available and correct even before any tagging has happened.
async function grnGrossValue(tx: Prisma.TransactionClient, companyId: string, grnId: string): Promise<number> {
  const grnItems = await tx.grnItem.findMany({
    where: { companyId, grnId },
    select: { poItem: { select: { totalAmount: true, taxRate: true } } },
  });
  return round2(grnItems.reduce((s, g) => s + Number(g.poItem.totalAmount) * (1 + Number(g.poItem.taxRate)), 0));
}

// §11 over-debit guard: a supplier must never be debited, across every Purchase Return AND every
// active standalone Debit Note against one GRN, beyond that GRN's own gross value. Path A Debit
// Notes are deliberately excluded from the "already debited" bucket below — their value is already
// present in the Purchase Return bucket (the return IS the accounting movement; the Path A note is
// only its document representation, §6/§13) — counting both would double-count the same rupee.
async function assertNotOverDebited(
  tx: Prisma.TransactionClient,
  companyId: string,
  grnId: string,
  newAmount: number,
) {
  const grossValue = await grnGrossValue(tx, companyId, grnId);

  // Purchase Returns whose tags trace back to this GRN — directly (a single finished-goods line),
  // or via the lot (bag) that GRN line opened (procurement.service.ts's own sourceOf() resolution).
  const returnItems = await tx.purchaseReturnItem.findMany({
    where: {
      companyId,
      tag: { OR: [{ grnItem: { grnId } }, { purchaseLot: { grnItem: { grnId } } }] },
    },
    select: { amount: true, cgst: true, sgst: true, igst: true },
  });
  const returnedGross = round2(returnItems.reduce((s, i) => s + Number(i.amount) + Number(i.cgst) + Number(i.sgst) + Number(i.igst), 0));

  const priorDebitNotes = await tx.debitNote.findMany({
    where: { companyId, grnId, purchaseReturnId: null, status: 'ISSUED' },
    select: { totalAmount: true },
  });
  const priorDebited = round2(priorDebitNotes.reduce((s, d) => s + Number(d.totalAmount), 0));

  const available = round2(grossValue - returnedGross - priorDebited);
  if (newAmount > available + 0.005) {
    throw new AppError(
      `This debit note would exceed the GRN's available value: ₹${newAmount.toFixed(2)} requested but only ` +
      `₹${available.toFixed(2)} remains (GRN gross ₹${grossValue.toFixed(2)}, already returned ₹${returnedGross.toFixed(2)}, ` +
      `already debited ₹${priorDebited.toFixed(2)})`,
      409,
    );
  }
}

export interface PathADebitNoteReturnItem {
  tagId: string; tagNumber: string; amount: number; cgst: number; sgst: number; igst: number;
  hsnCodeId: string | null; taxRate: number;
  grossWeight: number | null; netWeight: number | null; stoneWeight: number | null; karat: string | null;
}

// Path A: called from WITHIN an already-open transaction — either procurement.service.ts's
// createPurchaseReturn (inline, same transaction as the return + its journal) or
// createDebitNoteForExistingReturn below (its own transaction, wrapping an existing return). Posts
// NO journal and touches no Supplier balance — journalEntryId is whatever the caller's own
// return-journal already is; Supplier.currentDue was already moved by the return itself.
//
// Every line is a pure snapshot of numbers createPurchaseReturn already computed (PurchaseReturnItem's
// own amount/cgst/sgst/igst) and the underlying GRN line's own booked hsnCodeId/taxRate — never
// recomputed from today's rates (§8 of the task: "Do not re-derive historical tax values when the
// source transaction already contains authoritative values").
export async function createDebitNoteForPurchaseReturnTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  userId: string,
  params: {
    purchaseReturn: { id: string; returnNumber: string; supplierId: string; reason: string | null };
    returnItems: PathADebitNoteReturnItem[];
    grnId: string;
    journalEntryId: string | null;
    reasonNotes?: string | null;
    debitNoteDate?: Date;
  },
) {
  const { purchaseReturn, returnItems, grnId, journalEntryId, reasonNotes, debitNoteDate } = params;
  if (returnItems.length === 0) throw new AppError('A debit note needs at least one line', 400);

  const grn = await tx.goodsReceiptNote.findUniqueOrThrow({ where: { id: grnId } });
  if (grn.companyId !== ctx.companyId) throw new AppError('GRN not found', 404);

  const items = returnItems.map((r) => ({
    description: `Return of ${r.tagNumber}`,
    hsnCodeId: r.hsnCodeId, taxRate: r.taxRate, uom: null,
    taxableValue: round2(r.amount), cgstAmount: round2(r.cgst), sgstAmount: round2(r.sgst), igstAmount: round2(r.igst),
    lineTotalTax: round2(r.cgst + r.sgst + r.igst), totalValue: round2(r.amount + r.cgst + r.sgst + r.igst),
    grossWeight: r.grossWeight, netWeight: r.netWeight, stoneWeight: r.stoneWeight, karat: r.karat,
  }));

  const taxableAmount = round2(items.reduce((s, i) => s + i.taxableValue, 0));
  const cgst = round2(items.reduce((s, i) => s + i.cgstAmount, 0));
  const sgst = round2(items.reduce((s, i) => s + i.sgstAmount, 0));
  const igst = round2(items.reduce((s, i) => s + i.igstAmount, 0));
  const totalTax = round2(items.reduce((s, i) => s + i.lineTotalTax, 0));
  const totalAmount = round2(items.reduce((s, i) => s + i.totalValue, 0));

  const date = debitNoteDate ?? new Date();
  const financialYear = gstFinancialYear(date);
  const debitNoteNumber = await nextDocumentNumber(ctx.companyId, 'DN', 'DN', tx, financialYear);

  const created = await tx.debitNote.create({
    data: {
      companyId: ctx.companyId, debitNoteNumber, financialYear, debitNoteDate: date,
      grnId, supplierInvoiceNumber: grn.invoiceNumber, supplierInvoiceDate: grn.invoiceDate,
      purchaseReturnId: purchaseReturn.id, supplierId: purchaseReturn.supplierId,
      reasonCode: 'PURCHASE_RETURN', reasonNotes: reasonNotes ?? purchaseReturn.reason ?? null,
      taxableAmount, cgst, sgst, igst, totalTax, totalAmount,
      journalEntryId: journalEntryId ?? null,
      createdById: userId,
      // no companyId on each item: written through a composite relation, Prisma fills it from the parent.
      items: { createMany: { data: items } },
    },
    include: { items: true },
  });

  return created;
}

// The dedicated Path A route: wraps an EXISTING PurchaseReturn that has no DebitNote yet. Opens its
// own transaction, locates the return's own journal entry, and delegates the actual creation to
// createDebitNoteForPurchaseReturnTx.
export async function createDebitNoteForExistingReturn(
  returnId: string,
  ctx: TenantContext,
  userId: string,
  opts: { reasonNotes?: string } = {},
) {
  await assertOwnedByCompany('purchaseReturn', returnId, ctx.companyId, 'Purchase Return');

  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    const purchaseReturn = await tx.purchaseReturn.findUniqueOrThrow({
      where: { id: returnId },
      include: {
        items: {
          include: {
            tag: {
              include: {
                grnItem: { include: { poItem: { select: { hsnCodeId: true, taxRate: true } } } },
                purchaseLot: { include: { grnItem: { include: { poItem: { select: { hsnCodeId: true, taxRate: true } } } } } },
              },
            },
          },
        },
      },
    });
    if (purchaseReturn.companyId !== ctx.companyId) throw new AppError('Purchase Return not found', 404);

    const existing = await tx.debitNote.findFirst({ where: { purchaseReturnId: returnId, companyId: ctx.companyId } });
    if (existing) throw new AppError('This Purchase Return already has a Debit Note', 409);

    const sourceOf = (t: (typeof purchaseReturn.items)[number]['tag']) => t.grnItem ?? t.purchaseLot?.grnItem ?? null;

    const missingLineage = purchaseReturn.items.filter((i) => !sourceOf(i.tag));
    if (missingLineage.length > 0) {
      throw new AppError('This purchase return has a line with no traceable GRN — cannot issue a debit note', 400);
    }
    const grnIds = new Set(purchaseReturn.items.map((i) => sourceOf(i.tag)!.grnId));
    if (grnIds.size > 1) {
      throw new AppError(
        'This purchase return spans more than one GRN — a debit note can only be issued per GRN. Submit separate returns per GRN to generate one.',
        400,
      );
    }
    const grnId = [...grnIds][0];

    const journalEntry = await tx.journalEntry.findFirst({
      where: { companyId: ctx.companyId, referenceType: 'PurchaseReturn', referenceId: returnId },
    });

    const returnItems: PathADebitNoteReturnItem[] = purchaseReturn.items.map((i) => {
      const src = sourceOf(i.tag)!;
      return {
        tagId: i.tagId, tagNumber: i.tag.tagNumber, amount: Number(i.amount), cgst: Number(i.cgst), sgst: Number(i.sgst), igst: Number(i.igst),
        hsnCodeId: src.poItem.hsnCodeId, taxRate: Number(src.poItem.taxRate),
        grossWeight: Number(i.tag.grossWeight), netWeight: Number(i.tag.netWeight), stoneWeight: Number(i.tag.stoneWeight),
        karat: i.tag.metalKarat,
      };
    });

    return createDebitNoteForPurchaseReturnTx(tx, ctx, userId, {
      purchaseReturn, returnItems, grnId, journalEntryId: journalEntry?.id ?? null,
      reasonNotes: opts.reasonNotes ?? purchaseReturn.reason ?? null,
    });
  });

  await createAuditEntry('debit_notes', created.id, userId, 'CREATE', undefined, auditSnapshot(created), ctx.companyId);
  return created;
}

export interface StandaloneDebitNoteLineInput {
  description: string;
  taxableValue: number; // net of tax
  hsnCode?: string; // defaults to DEFAULT_HSN_CODE — a fresh lookup, same as CreditNote's own value-only lines
}

// Path B: a value-only adjustment against a GRN with NO physical stock return — price variance,
// short supply, a quality deduction, or a genuine GRN entry correction. Posts its own journal
// (§8/§4 of the design/task): Dr Accounts Payable / Cr Inventory (taxable) + Cr Input CGST/SGST or
// IGST — the exact reverse-shape of createTagFromGrnItem/openPurchaseLot's own intake entry.
export async function createStandaloneDebitNote(
  data: {
    grnId: string;
    items: StandaloneDebitNoteLineInput[];
    reasonCode: string;
    reasonNotes?: string;
    debitNoteDate?: Date;
  },
  ctx: TenantContext,
  userId: string,
) {
  if (!Array.isArray(data.items) || data.items.length === 0) throw new AppError('At least one line is required', 400);
  if (!isValidDebitNoteReason(data.reasonCode)) throw new AppError(`Invalid reason code: ${data.reasonCode}`, 400);
  // PURCHASE_RETURN is reserved for Path A — it is set automatically by
  // createDebitNoteForPurchaseReturnTx and must never be chosen for a standalone note.
  if (data.reasonCode === 'PURCHASE_RETURN') {
    throw new AppError('PURCHASE_RETURN is only valid for a Debit Note issued against an existing Purchase Return — use that flow instead', 400);
  }
  // §4/§10 of the task: OTHER has no defined accounting treatment for a standalone adjustment —
  // rejected outright rather than posting an undefined journal (never silently invented here).
  if (data.reasonCode === 'OTHER') {
    throw new AppError(
      'OTHER has no defined accounting treatment for a standalone debit note — choose PRICE_VARIANCE, SHORT_SUPPLY, QUALITY_DEDUCTION, or CORRECTION_IN_GRN, or issue the adjustment through a Purchase Return instead',
      400,
    );
  }

  await assertOwnedByCompany('goodsReceiptNote', data.grnId, ctx.companyId, 'GRN');

  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    // §12 concurrency: lock the GRN row first, so two simultaneous standalone Debit Notes against
    // the same GRN can't both pass the over-debit check and jointly exceed it.
    await tx.$queryRaw`SELECT "id" FROM "goods_receipt_notes" WHERE "id" = ${data.grnId} FOR UPDATE`;

    const grn = await tx.goodsReceiptNote.findUniqueOrThrow({
      where: { id: data.grnId },
      include: { po: { include: { supplier: true } } },
    });
    if (grn.companyId !== ctx.companyId) throw new AppError('GRN not found', 404);
    const supplier = grn.po.supplier;

    const supplierStateCode = await resolveSupplierStateCode(supplier);
    const company = await tx.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { stateCode: true } });
    // Same gate createPO already applies at intake (procurement.service.ts): an unregistered
    // supplier's bill carries no GST, and neither does a non-INR one. A standalone Debit Note's
    // fresh HSN lookup must respect that too — otherwise it would reverse Input GST that was never
    // actually claimed on this GRN in the first place (a phantom ITC reversal).
    const gstApplies = !!supplier.gstNumber && grn.po.currency === 'INR';

    const hsnCodesNeeded = Array.from(new Set(data.items.map((i) => i.hsnCode ?? DEFAULT_HSN_CODE)));
    const hsnRows = await prisma.hsnCode.findMany({ where: { code: { in: hsnCodesNeeded }, isActive: true } });
    const hsnByCode = new Map(hsnRows.map((h) => [h.code, h]));
    const missingHsn = hsnCodesNeeded.filter((c) => !hsnByCode.has(c));
    if (missingHsn.length > 0) throw new AppError(`Unknown or inactive HSN code(s): ${missingHsn.join(', ')}`, 400);

    const items = data.items.map((i, idx) => {
      if (!i.description?.trim()) throw new AppError(`Line ${idx + 1}: description is required`, 400);
      if (!(i.taxableValue > 0)) throw new AppError(`Line ${idx + 1}: taxableValue is required and must be more than zero`, 400);
      const hsn = hsnByCode.get(i.hsnCode ?? DEFAULT_HSN_CODE)!;
      const taxRate = gstApplies ? Number(hsn.gstRate) : 0;
      const taxableValue = round2(i.taxableValue);
      const gst = splitInputGst(taxableValue, taxRate, supplierStateCode, company.stateCode);
      return {
        description: i.description, hsnCodeId: hsn.id, taxRate, uom: null,
        taxableValue, cgstAmount: gst.cgst, sgstAmount: gst.sgst, igstAmount: gst.igst,
        lineTotalTax: gst.total, totalValue: round2(taxableValue + gst.total),
        grossWeight: null, netWeight: null, stoneWeight: null, karat: null,
      };
    });

    const taxableAmount = round2(items.reduce((s, i) => s + i.taxableValue, 0));
    const cgst = round2(items.reduce((s, i) => s + i.cgstAmount, 0));
    const sgst = round2(items.reduce((s, i) => s + i.sgstAmount, 0));
    const igst = round2(items.reduce((s, i) => s + i.igstAmount, 0));
    const totalTax = round2(items.reduce((s, i) => s + i.lineTotalTax, 0));
    const totalAmount = round2(items.reduce((s, i) => s + i.totalValue, 0));
    if (totalAmount <= 0) throw new AppError('This debit note has no value', 400);

    // §11 over-debit guard.
    await assertNotOverDebited(tx, ctx.companyId, grn.id, totalAmount);

    const date = data.debitNoteDate ?? new Date();
    const financialYear = gstFinancialYear(date);
    // G2g-7g: a standalone (Path B) Debit Note is its own GSTR-3B inward/ITC source document
    // (gstr3bItcReporting.service.ts's loadStandaloneDebitNoteLines reads it by its own
    // debitNoteDate) — guarded against its own period before it is numbered. Resolved the same way
    // G2g-7a resolves it at intake — from the GRN's own receiving branch.
    const buyerRegistrationId = await resolveBuyerRegistration(tx, ctx.companyId, grn.branchId);
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'DEBIT_NOTE', documentId: grn.grnNumber,
      gstRegistrationId: buyerRegistrationId, documentDate: date, action: 'issued',
    });
    const debitNoteNumber = await nextDocumentNumber(ctx.companyId, 'DN', 'DN', tx, financialYear);

    const dn = await tx.debitNote.create({
      data: {
        companyId: ctx.companyId, debitNoteNumber, financialYear, debitNoteDate: date,
        grnId: grn.id, supplierInvoiceNumber: grn.invoiceNumber, supplierInvoiceDate: grn.invoiceDate,
        supplierId: supplier.id,
        reasonCode: data.reasonCode, reasonNotes: data.reasonNotes ?? null,
        taxableAmount, cgst, sgst, igst, totalTax, totalAmount,
        createdById: userId,
        items: { createMany: { data: items } },
      },
      include: { items: true },
    });

    // Path B posts its own journal — the exact reverse-shape of intake's Dr Inventory + Dr Input
    // GST / Cr Accounts Payable (procurement.service.ts's createTagFromGrnItem/openPurchaseLot).
    const entry = await postAutoJournalEntry(tx, ctx.companyId, {
      date, description: `Debit Note ${debitNoteNumber} (GRN ${grn.grnNumber})`,
      referenceType: 'DebitNote', referenceId: dn.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, debit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.INVENTORY, credit: taxableAmount },
        { accountCode: LEDGER_ACCOUNT.INPUT_CGST, credit: cgst },
        { accountCode: LEDGER_ACCOUNT.INPUT_SGST, credit: sgst },
        { accountCode: LEDGER_ACCOUNT.INPUT_IGST, credit: igst },
      ],
    });
    if (entry) await tx.debitNote.update({ where: { id: dn.id }, data: { journalEntryId: entry.id } });

    await tx.supplier.update({ where: { id: supplier.id }, data: { currentDue: { decrement: totalAmount } } });

    return entry ? { ...dn, journalEntryId: entry.id } : dn;
  });

  await createAuditEntry('debit_notes', created.id, userId, 'CREATE', undefined, auditSnapshot(created), ctx.companyId);
  return created;
}

// §13: only a standalone (Path B) Debit Note may be cancelled — a Path A one is permanently linked
// to an append-only PurchaseReturn (unwinding it would have to also unwind the return, which this
// codebase does not support, mirroring cancelCreditNote's identical posture on the sales side).
export async function cancelDebitNote(debitNoteId: string, ctx: TenantContext, userId: string, reason: string) {
  if (!reason?.trim()) throw new AppError('A reason is required to cancel a debit note', 400);
  await assertOwnedByCompany('debitNote', debitNoteId, ctx.companyId, 'Debit Note');

  let before: any, after: any;
  try {
    ({ before, after } = await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise, then read fresh — same lock cancelCreditNote/voidInvoice take on their own row.
    await tx.$queryRaw`SELECT "id" FROM "debit_notes" WHERE "id" = ${debitNoteId} FOR UPDATE`;
    const dn = await tx.debitNote.findUniqueOrThrow({ where: { id: debitNoteId } });
    if (dn.companyId !== ctx.companyId) throw new AppError('Debit Note not found', 404);
    if (dn.purchaseReturnId) {
      throw new AppError('A Debit Note linked to a Purchase Return cannot be independently cancelled — the underlying return is append-only', 409);
    }
    if (dn.status === 'CANCELLED') throw new AppError('This debit note has already been cancelled', 409);
    if (dn.status !== 'ISSUED') throw new AppError(`A ${dn.status} debit note cannot be cancelled`, 409);
    // G2g-7g: same cancel/reverse protection as cancelCreditNote's own — resolved the same way
    // createStandaloneDebitNote resolves it, from the GRN's own receiving branch.
    const grnForCancel = await tx.goodsReceiptNote.findUnique({ where: { id: dn.grnId }, select: { branchId: true } });
    const buyerRegistrationId = await resolveBuyerRegistration(tx, ctx.companyId, grnForCancel?.branchId ?? null);
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'DEBIT_NOTE', documentId: debitNoteId,
      gstRegistrationId: buyerRegistrationId, documentDate: dn.debitNoteDate, action: 'cancelled',
    });

    const before = { status: dn.status, totalAmount: Number(dn.totalAmount) };
    const totalAmount = Number(dn.totalAmount);

    if (dn.journalEntryId) {
      // Exact inverse of Path B's own creation entry — never edits the original.
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: new Date(), description: `Cancellation of Debit Note ${dn.debitNoteNumber}`,
        referenceType: 'DebitNoteCancellation', referenceId: dn.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_PAYABLE, credit: totalAmount },
          { accountCode: LEDGER_ACCOUNT.INVENTORY, debit: Number(dn.taxableAmount) },
          { accountCode: LEDGER_ACCOUNT.INPUT_CGST, debit: Number(dn.cgst) },
          { accountCode: LEDGER_ACCOUNT.INPUT_SGST, debit: Number(dn.sgst) },
          { accountCode: LEDGER_ACCOUNT.INPUT_IGST, debit: Number(dn.igst) },
        ],
      });
    }
    // Restore the supplier balance this debit note reduced at creation — unconditional on the
    // journal branch above, since the balance movement itself was always unconditional too.
    await tx.supplier.update({ where: { id: dn.supplierId }, data: { currentDue: { increment: totalAmount } } });

    const updated = await tx.debitNote.update({
      where: { id: debitNoteId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
    });

    return { before, after: { status: updated.status, cancelledAt: updated.cancelledAt, cancelReason: updated.cancelReason } };
    }));
  } catch (err) {
    await auditGstr3bMutationBlocked(err, 'debit_notes', userId, ctx.companyId);
    throw err;
  }

  await createAuditEntry('debit_notes', debitNoteId, userId, 'CANCEL', before, { ...after, reason }, ctx.companyId);
  return { id: debitNoteId, status: 'CANCELLED' as const };
}

export async function listDebitNotes(
  ctx: TenantContext,
  filters: { supplierId?: string; grnId?: string; status?: string; from?: Date; to?: Date } = {},
) {
  return tenantQuery(ctx.companyId, (tx) => tx.debitNote.findMany({
    where: {
      companyId: ctx.companyId,
      ...(filters.supplierId && { supplierId: filters.supplierId }),
      ...(filters.grnId && { grnId: filters.grnId }),
      ...(filters.status && { status: filters.status }),
      ...((filters.from || filters.to) && {
        debitNoteDate: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) },
      }),
    },
    include: {
      supplier: { select: { name: true, supplierCode: true } },
      items: true,
      purchaseReturn: { select: { id: true, returnNumber: true } },
      grn: { select: { id: true, grnNumber: true } },
    },
    orderBy: { debitNoteDate: 'desc' },
  }));
}

export async function getDebitNoteById(ctx: TenantContext, id: string) {
  await assertOwnedByCompany('debitNote', id, ctx.companyId, 'Debit Note');
  return tenantQuery(ctx.companyId, (tx) => tx.debitNote.findUniqueOrThrow({
    where: { id },
    include: {
      supplier: { select: { name: true, supplierCode: true, gstNumber: true, panNumber: true, address: true, city: true, state: true, pincode: true, phone: true, email: true } },
      items: { include: { hsnCode: { select: { code: true, description: true } } } },
      purchaseReturn: { select: { id: true, returnNumber: true, returnDate: true, reason: true } },
      grn: { select: { id: true, grnNumber: true, receivedDate: true, invoiceNumber: true, invoiceDate: true } },
      createdBy: { select: { name: true } },
      cancelledBy: { select: { name: true } },
    },
  }));
}
