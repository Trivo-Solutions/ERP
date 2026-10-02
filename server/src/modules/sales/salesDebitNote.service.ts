import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany, assertBranchAccessible } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { nextDocumentNumber, gstFinancialYear } from '../../shared/numberSequence';
import { postAutoJournalEntry } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { splitGst } from '../../shared/gstSplit';
import { isValidSalesDebitNoteReason } from '../../shared/gstDocumentReasons';
import { DEFAULT_HSN_CODE } from '../../shared/constants';
import { assertGstr1DocumentMutable, auditGstr1MutationBlocked } from '../finance/gst/gstr1FilingProtection';
import { assertGstr3bPeriodMutable, auditGstr3bMutationBlocked } from '../finance/gst/gstr3bFilingProtection';

// G2g-4b.2 — Sales (outward) Debit Note. A wholly separate domain from the procurement-side
// DebitNote/debitNote.service.ts (that one stays purchase-side only — see CLAUDE.md). Mirrors
// creditNote.service.ts's own createStandaloneCreditNote()/cancelCreditNote() shape (validate ->
// snapshot -> number -> create -> journal -> balance -> audit), with every sign reversed: a Sales
// Debit Note INCREASES what a customer owes against an existing, already-issued SalesInvoice (an
// under-billed price/quantity/charge corrected upward after issuance) — it is never a reduction.
//
// Unlike CreditNote, there is no "Path A wraps a physical event" concept here — a debit note never
// wraps a SalesReturn (that is strictly a reduction concept). Every Sales Debit Note in this phase
// is the equivalent of CreditNote's Path B (standalone, value-only correction against an invoice),
// so there is exactly one creation path, not two.
//
// One SalesDebitNote -> one original SalesInvoice is THIS PHASE's own implementation-scope
// decision, not a statutory requirement — see the schema model's own comment. Nothing here
// prevents a future multi-invoice extension; it simply isn't built.

const round2 = (n: number) => Math.round(n * 100) / 100;

type SourceInvoiceLine = {
  id: string; description: string; hsnCodeId: string | null; taxRate: unknown; uom: string | null;
  karat: string | null; grossWeight: unknown; netGoldWeight: unknown; stoneWeight: unknown;
  uqc: string | null;
};

// Splits an already-fixed, tax-inclusive `amount` (the ADDITIONAL amount being charged) by a
// SOURCE LINE'S OWN snapshotted taxRate — never a fresh HSN lookup (same "a later HSN-rate change
// must not reprice a historical document" rule creditNote.service.ts's buildLineFromInvoiceItem
// already follows). No `quantity` parameter (unlike that function): a debit note against an
// existing line is, in every case this phase supports, a VALUE-only correction (price/charge
// corrected upward) — it never represents additional physical quantity delivered, so `quantity`
// always stays null here (see the SalesDebitNoteItem schema comment). uqc is still inherited from
// the source line — it is a property of the HSN/goods being debited, not of whether this debit
// carries its own physical quantity.
function buildLineFromInvoiceItem(line: SourceInvoiceLine, amount: number, isSameState: boolean) {
  const taxRate = Number(line.taxRate);
  const taxableValue = amount / (1 + taxRate);
  const lineTax = amount - taxableValue;
  const { cgst, sgst, igst } = splitGst(lineTax, isSameState);
  return {
    invoiceItemId: line.id,
    description: line.description,
    hsnCodeId: line.hsnCodeId,
    taxRate,
    uom: line.uom,
    uqc: line.uqc,
    quantity: null as number | null,
    taxableValue: round2(taxableValue),
    cgstAmount: round2(cgst),
    sgstAmount: round2(sgst),
    igstAmount: round2(igst),
    lineTotalTax: round2(lineTax),
    totalValue: round2(amount),
    grossWeight: line.grossWeight == null ? null : Number(line.grossWeight),
    netWeight: line.netGoldWeight == null ? null : Number(line.netGoldWeight),
    stoneWeight: line.stoneWeight == null ? null : Number(line.stoneWeight),
    karat: line.karat,
  };
}

function auditSnapshot(dn: {
  debitNoteNumber: string; invoiceId: string; reasonCode: string;
  taxableAmount: unknown; totalTax: unknown; totalAmount: unknown;
  items?: Array<{ id: string; description: string; totalValue: unknown }>;
}) {
  return {
    debitNoteNumber: dn.debitNoteNumber, invoiceId: dn.invoiceId,
    reasonCode: dn.reasonCode, taxableAmount: Number(dn.taxableAmount), totalTax: Number(dn.totalTax),
    totalAmount: Number(dn.totalAmount),
    items: dn.items?.map((i) => ({ id: i.id, description: i.description, totalValue: Number(i.totalValue) })),
  };
}

export interface SalesDebitNoteLineInput {
  invoiceItemId?: string;
  // Tax-inclusive ADDITIONAL amount being charged on this line. Required when invoiceItemId is
  // present — unlike CreditNote's own line input, there is no sensible default (a credit note can
  // default to "the whole line's remaining value"; a debit note has no natural ceiling to default
  // to, since it is adding new value, not giving back existing value).
  amount?: number;
  description?: string; // required when invoiceItemId is absent; overrides the line's own description otherwise
  hsnCode?: string; // value-only line only; defaults to DEFAULT_HSN_CODE
  taxableValue?: number; // value-only line only (net of tax) — required when invoiceItemId is absent
}

export interface CreateSalesDebitNoteInput {
  invoiceId: string;
  items: SalesDebitNoteLineInput[];
  reasonCode: string;
  reasonNotes?: string;
  debitNoteDate?: Date;
}

/**
 * createSalesDebitNote() — the one creation path this phase supports. Sequence (per the approved
 * G2g-4b.1 plan): company/ownership -> branch access -> invoice lifecycle -> line validation ->
 * GST calc -> snapshot -> atomic number -> create document/items -> balanced journal -> customer
 * balance -> audit -> commit. Authentication/permission are the router's job
 * (sales.router.ts: `requirePermission('salesDebitNote:create')`), same division of responsibility
 * as every other service function in this module.
 */
export async function createSalesDebitNote(
  data: CreateSalesDebitNoteInput,
  ctx: TenantContext,
  userId: string,
) {
  if (!Array.isArray(data.items) || data.items.length === 0) throw new AppError('At least one line is required', 400);
  if (!isValidSalesDebitNoteReason(data.reasonCode)) throw new AppError(`Invalid reason code: ${data.reasonCode}`, 400);
  if (data.reasonCode === 'OTHER' && !data.reasonNotes?.trim()) {
    throw new AppError('reasonNotes is required when reasonCode is OTHER', 400);
  }

  // Step 3: SalesInvoice ownership — a forged cross-company invoiceId must 404, never reach the
  // transaction below.
  await assertOwnedByCompany('salesInvoice', data.invoiceId, ctx.companyId, 'Invoice');

  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    const invoice = await tx.salesInvoice.findUniqueOrThrow({
      where: { id: data.invoiceId },
      include: { taxDetails: true },
    });
    if (invoice.companyId !== ctx.companyId) throw new AppError('Invoice not found', 404);

    // Step 4: branch access. SalesDebitNote.branchId is ALWAYS the original invoice's own branch
    // (never an independently chosen value — see the schema model comment) — but the CALLER must
    // still be granted that branch, exactly like every other branch-scoped write in this codebase.
    await assertBranchAccessible(invoice.branchId, ctx, 'Invoice branch');

    // Step 6: invoice lifecycle. A VOID invoice has no live balance to add to (J3: void is a
    // whole-invoice reversal) — same gate createStandaloneCreditNote() applies for the symmetric
    // reason. Not blocked by a prior payment or a prior credit/debit note — there is no "ceiling"
    // concept on a debit note the way there is on a credit note's over-credit guard.
    if (invoice.status === 'VOID') throw new AppError('This invoice has been voided and cannot be debited', 409);
    if (!invoice.taxDetails) {
      throw new AppError('Cannot issue a GST debit note: this invoice has no tax record (non-INR or non-taxable sale)', 400);
    }
    const td = invoice.taxDetails;
    const isSameState = Number(td.cgst) > 0;

    // Step 7: validate requested lines.
    const invoiceItemIds = data.items.map((i) => i.invoiceItemId).filter((id): id is string => !!id);
    if (new Set(invoiceItemIds).size !== invoiceItemIds.length) {
      throw new AppError('The same invoice line appears twice', 400);
    }
    const sourceLines = invoiceItemIds.length > 0
      ? await tx.invoiceItem.findMany({ where: { id: { in: invoiceItemIds }, companyId: ctx.companyId, invoiceId: invoice.id } })
      : [];
    const lineById = new Map(sourceLines.map((l) => [l.id, l]));

    const hsnCodesNeeded = Array.from(new Set(
      data.items.filter((i) => !i.invoiceItemId).map((i) => i.hsnCode ?? DEFAULT_HSN_CODE)
    ));
    const hsnRows = hsnCodesNeeded.length > 0
      ? await prisma.hsnCode.findMany({ where: { code: { in: hsnCodesNeeded }, isActive: true } })
      : [];
    const hsnByCode = new Map(hsnRows.map((h) => [h.code, h]));
    const missingHsn = hsnCodesNeeded.filter((c) => !hsnByCode.has(c));
    if (missingHsn.length > 0) throw new AppError(`Unknown or inactive HSN code(s): ${missingHsn.join(', ')}`, 400);

    const lines = data.items.map((i) => {
      if (i.invoiceItemId) {
        const line = lineById.get(i.invoiceItemId);
        if (!line) throw new AppError(`Invoice item not found on this invoice: ${i.invoiceItemId}`, 404);
        if (i.amount == null || !(i.amount > 0)) {
          throw new AppError('amount is required and must be more than zero for a line with an invoiceItemId', 400);
        }
        // Step 5 (LINE CALCULATION): inherit the original line's own HSN/tax/UQC snapshot and
        // compute the additional taxable/tax amounts from it — never a fresh HSN lookup, never
        // today's rate.
        return buildLineFromInvoiceItem(
          i.description ? { ...line, description: i.description } : line,
          i.amount, isSameState,
        );
      }
      // Value-only line — explicit HSN/description/taxableValue, never fabricated (section 5: "Do
      // NOT fabricate HSN/SAC"; SalesInvoice.otherCharges is never implicitly reused as an HSN).
      if (!i.taxableValue || i.taxableValue <= 0) {
        throw new AppError('taxableValue is required and must be more than zero for a line with no invoiceItemId', 400);
      }
      if (!i.description?.trim()) throw new AppError('description is required for a line with no invoiceItemId', 400);
      const hsn = hsnByCode.get(i.hsnCode ?? DEFAULT_HSN_CODE)!;
      const taxRate = Number(hsn.gstRate);
      const taxableValue = round2(i.taxableValue);
      const lineTax = round2(taxableValue * taxRate);
      const { cgst, sgst, igst } = splitGst(lineTax, isSameState);
      return {
        invoiceItemId: null, description: i.description, hsnCodeId: hsn.id, taxRate, uom: null,
        uqc: hsn.defaultUqc ?? null, quantity: null as number | null,
        taxableValue, cgstAmount: round2(cgst), sgstAmount: round2(sgst), igstAmount: round2(igst),
        lineTotalTax: lineTax, totalValue: round2(taxableValue + lineTax),
        grossWeight: null, netWeight: null, stoneWeight: null, karat: null,
      };
    });

    const taxableAmount = round2(lines.reduce((s, i) => s + i.taxableValue, 0));
    const cgst = round2(lines.reduce((s, i) => s + i.cgstAmount, 0));
    const sgst = round2(lines.reduce((s, i) => s + i.sgstAmount, 0));
    const igst = round2(lines.reduce((s, i) => s + i.igstAmount, 0));
    const totalTax = round2(lines.reduce((s, i) => s + i.lineTotalTax, 0));
    const totalAmount = round2(lines.reduce((s, i) => s + i.totalValue, 0));
    if (totalAmount <= 0) throw new AppError('This debit note has no value', 400);

    // Steps 9-10: immutable snapshot + atomic, registration-scoped number.
    const date = data.debitNoteDate ?? new Date();
    const financialYear = gstFinancialYear(date);
    // G2g-7g: a Sales Debit Note is its own GSTR-3B outward source document
    // (gstr3bReporting.service.ts's loader reads it by its own debitNoteDate) — guarded against its
    // own period before it is numbered.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'SALES_DEBIT_NOTE', documentId: invoice.invoiceNumber,
      gstRegistrationId: td.sellerRegistrationId, documentDate: date, action: 'issued',
    });
    const debitNoteNumber = await nextDocumentNumber(ctx.companyId, `SDN:${td.sellerRegistrationId ?? 'LEGACY'}`, 'SDN', tx, financialYear);

    // Step 11: create document/items.
    const dn = await tx.salesDebitNote.create({
      data: {
        companyId: ctx.companyId, branchId: invoice.branchId,
        debitNoteNumber, financialYear, debitNoteDate: date,
        invoiceId: invoice.id, originalInvoiceNumber: invoice.invoiceNumber, originalInvoiceDate: invoice.invoiceDate,
        clientId: invoice.clientId,
        reasonCode: data.reasonCode, reasonNotes: data.reasonNotes ?? null,
        gstin: td.gstin, placeOfSupply: td.placeOfSupply,
        sellerRegistrationId: td.sellerRegistrationId, sellerLegalName: td.sellerLegalName, sellerTradeName: td.sellerTradeName,
        sellerStateCode: td.sellerStateCode, sellerAddress: td.sellerAddress, sellerCity: td.sellerCity,
        sellerDistrict: td.sellerDistrict, sellerPincode: td.sellerPincode, sellerCountry: td.sellerCountry,
        buyerName: td.buyerName, buyerGstin: td.buyerGstin, buyerPan: td.buyerPan, buyerAddress: td.buyerAddress,
        buyerCity: td.buyerCity, buyerState: td.buyerState, buyerStateCode: td.buyerStateCode,
        buyerPincode: td.buyerPincode, buyerCountry: td.buyerCountry,
        taxableAmount, cgst, sgst, igst, totalTax, totalAmount,
        createdById: userId,
        // no companyId on each item: written through a composite relation, Prisma fills it from the parent.
        items: { createMany: { data: lines } },
      },
      include: { items: true },
    });

    // Step 12: balanced journal — exact mirror of CreditNote's own Path B entry, every line
    // reversed (a debit note INCREASES receivable/revenue/tax payable, never decreases them).
    const entry = await postAutoJournalEntry(tx, ctx.companyId, {
      date, description: `Sales Debit Note ${debitNoteNumber} (Invoice ${invoice.invoiceNumber})`,
      referenceType: 'SalesDebitNote', referenceId: dn.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, credit: taxableAmount },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, credit: cgst },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, credit: sgst },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, credit: igst },
      ],
    });
    if (entry) await tx.salesDebitNote.update({ where: { id: dn.id }, data: { journalEntryId: entry.id } });

    // Step 13: customer balance — exactly once, the increase mirror of createStandaloneCreditNote's decrement.
    await tx.client.update({ where: { id: invoice.clientId }, data: { currentBalance: { increment: totalAmount } } });

    return entry ? { ...dn, journalEntryId: entry.id } : dn;
  });

  // Step 14: audit.
  await createAuditEntry('sales_debit_notes', created.id, userId, 'CREATE', undefined, auditSnapshot(created), ctx.companyId);
  return created;
}

/**
 * cancelSalesDebitNote() — controlled cancellation (section 8). An issued document is never
 * edited, never hard-deleted, and never cancelled twice. The original invoice is never touched.
 * `irn` is a dormant field in this phase (section 20: no live IRP integration) — createSalesDebitNote()
 * never sets it, so there is currently no real "IRN cancellation window" to enforce here; a blanket
 * `if (irn) reject` is deliberately NOT written, since that would hardcode an un-verified rule
 * against a field nothing in this phase ever populates. The moment a real IRP integration sets
 * `irn`, that phase must add the actual verified cancellation-window check here.
 */
export async function cancelSalesDebitNote(debitNoteId: string, ctx: TenantContext, userId: string, reason: string) {
  if (!reason?.trim()) throw new AppError('A reason is required to cancel a sales debit note', 400);
  await assertOwnedByCompany('salesDebitNote', debitNoteId, ctx.companyId, 'Sales Debit Note');

  let before: any, after: any;
  try {
    ({ before, after } = await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise, then read fresh — same lock cancelCreditNote/voidInvoice take on their own row.
    await tx.$queryRaw`SELECT "id" FROM "sales_debit_notes" WHERE "id" = ${debitNoteId} FOR UPDATE`;
    const dn = await tx.salesDebitNote.findUniqueOrThrow({ where: { id: debitNoteId } });
    if (dn.companyId !== ctx.companyId) throw new AppError('Sales Debit Note not found', 404);
    if (dn.status === 'CANCELLED') throw new AppError('This sales debit note has already been cancelled', 409);
    // G2g-6d: a sales debit note represented in an accepted GSTR-1 filing is closed to
    // cancellation — same posture as cancelCreditNote's own guard.
    await assertGstr1DocumentMutable(tx, ctx.companyId, {
      documentType: 'SALES_DEBIT_NOTE', documentId: debitNoteId,
      gstRegistrationId: dn.sellerRegistrationId, action: 'cancelled',
    });
    // G2g-7g: same cancel/reverse protection as cancelCreditNote's own.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'SALES_DEBIT_NOTE', documentId: debitNoteId,
      gstRegistrationId: dn.sellerRegistrationId, documentDate: dn.debitNoteDate, action: 'cancelled',
    });

    const before = { status: dn.status, totalAmount: Number(dn.totalAmount) };
    const totalAmount = Number(dn.totalAmount);

    if (dn.journalEntryId) {
      // Exact inverse of the creation entry — never edits the original.
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: new Date(), description: `Cancellation of Sales Debit Note ${dn.debitNoteNumber}`,
        referenceType: 'SalesDebitNoteCancellation', referenceId: dn.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: totalAmount },
          { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, debit: Number(dn.taxableAmount) },
          { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, debit: Number(dn.cgst) },
          { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, debit: Number(dn.sgst) },
          { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, debit: Number(dn.igst) },
        ],
      });
    }
    // Reverse the customer balance increase this debit note made at creation — unconditional on
    // the journal branch above, since the balance movement itself was always unconditional too.
    await tx.client.update({ where: { id: dn.clientId }, data: { currentBalance: { decrement: totalAmount } } });

    const updated = await tx.salesDebitNote.update({
      where: { id: debitNoteId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
    });

    return { before, after: { status: updated.status, cancelledAt: updated.cancelledAt, cancelReason: updated.cancelReason } };
    }));
  } catch (err) {
    await auditGstr1MutationBlocked(err, 'sales_debit_notes', userId, ctx.companyId);
    await auditGstr3bMutationBlocked(err, 'sales_debit_notes', userId, ctx.companyId);
    throw err;
  }

  await createAuditEntry('sales_debit_notes', debitNoteId, userId, 'CANCEL', before, { ...after, reason }, ctx.companyId);
  return { id: debitNoteId, status: 'CANCELLED' as const };
}

export async function listSalesDebitNotes(
  ctx: TenantContext,
  filters: { clientId?: string; invoiceId?: string; status?: string; from?: Date; to?: Date } = {},
) {
  return tenantQuery(ctx.companyId, (tx) => tx.salesDebitNote.findMany({
    where: {
      companyId: ctx.companyId,
      ...(filters.clientId && { clientId: filters.clientId }),
      ...(filters.invoiceId && { invoiceId: filters.invoiceId }),
      ...(filters.status && { status: filters.status }),
      ...((filters.from || filters.to) && {
        debitNoteDate: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) },
      }),
      // Branch-restricted callers never see a sales debit note from a branch they aren't granted —
      // same rule every other branch-scoped list in this codebase applies.
      ...(!ctx.branchAccess.allBranches && { branchId: { in: ctx.branchAccess.branchIds } }),
    },
    include: {
      client: { select: { name: true, clientCode: true } },
      items: true,
      invoice: { select: { id: true, invoiceNumber: true } },
    },
    orderBy: { debitNoteDate: 'desc' },
  }));
}

export async function getSalesDebitNoteById(ctx: TenantContext, id: string) {
  await assertOwnedByCompany('salesDebitNote', id, ctx.companyId, 'Sales Debit Note');
  const dn = await tenantQuery(ctx.companyId, (tx) => tx.salesDebitNote.findUniqueOrThrow({
    where: { id },
    include: {
      client: { select: { name: true, clientCode: true, phone: true, address: true, city: true, state: true } },
      items: { include: { hsnCode: { select: { code: true, description: true } } } },
      invoice: { select: { id: true, branchId: true, invoiceNumber: true, invoiceDate: true } },
      createdBy: { select: { name: true } },
      cancelledBy: { select: { name: true } },
    },
  }));
  // A branch-restricted caller may not read a sales debit note belonging to a branch they aren't
  // granted, even by direct id — same 404-not-403 posture every other branch ownership check uses.
  if (!ctx.branchAccess.allBranches && !ctx.branchAccess.branchIds.includes(dn.branchId)) {
    throw new AppError('Sales Debit Note not found', 404);
  }
  return dn;
}
