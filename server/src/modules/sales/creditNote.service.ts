import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { TenantContext, tenantQuery, tenantTransaction } from '../../shared/tenantContext';
import { nextDocumentNumber, gstFinancialYear } from '../../shared/numberSequence';
import { postAutoJournalEntry } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { splitGst } from '../../shared/gstSplit';
import { isValidCreditNoteReason } from '../../shared/gstDocumentReasons';
import { DEFAULT_HSN_CODE } from '../../shared/constants';
import { assertGstr1DocumentMutable, auditGstr1MutationBlocked } from '../finance/gst/gstr1FilingProtection';
import { assertGstr3bPeriodMutable, auditGstr3bMutationBlocked } from '../finance/gst/gstr3bFilingProtection';

// G2c — Credit Note lifecycle. See PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §3 for the full
// design this implements. Two creation paths, one shared line-builder and one shared over-credit
// guard so neither path can silently diverge from the other's math:
//   - createCreditNoteForReturn(): Path A — wraps a SalesReturn (called either inline, from
//     sales.service.ts's createSalesReturn when issueCreditNote is requested, or via
//     createCreditNoteForExistingReturn() for an already-existing return). Posts NO new journal —
//     journalEntryId points at the return's own entry.
//   - createStandaloneCreditNote(): Path B — a value-only correction against an invoice with no
//     physical return. Posts its own journal, mirroring createSalesReturn's Dr Revenue + Dr GST
//     shape minus the Inventory/COGS lines (nothing physical moved).
// Only a Path B (standalone) CreditNote can be cancelled (cancelCreditNote) — a Path A one is
// permanently linked to an append-only SalesReturn, same posture as SalesReturn itself.

const round2 = (n: number) => Math.round(n * 100) / 100;

type SourceInvoiceLine = {
  id: string; description: string; hsnCodeId: string | null; taxRate: unknown; uom: string | null;
  karat: string | null; grossWeight: unknown; netGoldWeight: unknown; stoneWeight: unknown;
  uqc: string | null;
};

// Splits an already-fixed, tax-inclusive `amount` by a SOURCE LINE'S OWN snapshotted taxRate —
// never a fresh HSN lookup (§3.5: "a later HSN-rate change must not reprice a historical credit
// note"). Same revenuePortion/taxPortion backing-out formula createSalesReturn already uses
// (sales.service.ts's resolvedItems map), reused here rather than re-derived.
//
// G2g-3a: `quantity` is deliberately a parameter, not something this function derives from `line`
// itself — a value-only price adjustment against an invoice line (Path B, even when linked to a
// real invoiceItemId) has no physical quantity to report, while a genuine physical return (Path A)
// does: the whole tagged line came back, so its own already-known InvoiceItem.quantity is exactly
// the credited quantity. Callers decide which case they're in; omitting it (Path B) snapshots
// null rather than fabricating a number. uqc is always inherited from the source line — it is a
// property of the HSN/goods being credited, not of whether this credit has a physical quantity.
function buildLineFromInvoiceItem(line: SourceInvoiceLine, amount: number, isSameState: boolean, quantity?: number | null) {
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
    quantity: quantity ?? null,
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

// §3.7 over-crediting guard: for every touched InvoiceItem, (prior un-CN'd SalesReturnItem amount)
// + (prior CreditNoteItem totalValue, any path) + (this request's own new amount) must not exceed
// the line's own tax-inclusive total. `excludeSalesReturnId` is the return a Path A call is ITSELF
// wrapping — its own SalesReturnItem rows are the value being credited right now, not prior debt,
// so they're excluded from "prior" rather than double-counted against themselves.
async function assertNotOverCredited(
  tx: Prisma.TransactionClient,
  companyId: string,
  requests: Array<{ invoiceItemId: string; amount: number }>,
  excludeSalesReturnId?: string,
) {
  const ids = [...new Set(requests.map((r) => r.invoiceItemId))];
  if (ids.length === 0) return;

  const items = await tx.invoiceItem.findMany({
    where: { id: { in: ids }, companyId },
    select: { id: true, productCode: true, totalPrice: true, taxRate: true },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  const [returnItems, creditNoteItems] = await Promise.all([
    tx.salesReturnItem.findMany({
      where: { companyId, invoiceItemId: { in: ids } },
      select: { invoiceItemId: true, amount: true, returnId: true, return: { select: { creditNote: { select: { id: true } } } } },
    }),
    tx.creditNoteItem.findMany({
      where: { companyId, invoiceItemId: { in: ids } },
      select: { invoiceItemId: true, totalValue: true },
    }),
  ]);

  const priorByLine = new Map<string, number>();
  const add = (id: string | null, amt: number) => { if (!id) return; priorByLine.set(id, (priorByLine.get(id) ?? 0) + amt); };
  for (const ri of returnItems) {
    if (ri.return.creditNote) continue; // already counted via its own CreditNoteItem below — avoid double counting
    if (excludeSalesReturnId && ri.returnId === excludeSalesReturnId) continue; // this operation's own return, not prior debt
    add(ri.invoiceItemId, Number(ri.amount));
  }
  for (const ci of creditNoteItems) add(ci.invoiceItemId, Number(ci.totalValue));

  const newByLine = new Map<string, number>();
  for (const r of requests) newByLine.set(r.invoiceItemId, (newByLine.get(r.invoiceItemId) ?? 0) + r.amount);

  for (const [invoiceItemId, newAmount] of newByLine) {
    const item = itemById.get(invoiceItemId);
    if (!item) throw new AppError(`Invoice item not found: ${invoiceItemId}`, 404);
    const maxCreditable = round2(Number(item.totalPrice) * (1 + Number(item.taxRate)));
    const already = round2(priorByLine.get(invoiceItemId) ?? 0);
    const total = round2(already + newAmount);
    if (total > maxCreditable + 0.005) {
      throw new AppError(
        `Over-credit on line ${item.productCode}: ₹${total} would be credited against a total of ₹${maxCreditable} (₹${already} already credited/returned)`,
        409,
      );
    }
  }
}

function auditSnapshot(cn: {
  creditNoteNumber: string; invoiceId: string; salesReturnId: string | null; reasonCode: string;
  taxableAmount: unknown; totalTax: unknown; totalAmount: unknown;
  items?: Array<{ id: string; description: string; totalValue: unknown }>;
}) {
  return {
    creditNoteNumber: cn.creditNoteNumber, invoiceId: cn.invoiceId, salesReturnId: cn.salesReturnId,
    reasonCode: cn.reasonCode, taxableAmount: Number(cn.taxableAmount), totalTax: Number(cn.totalTax),
    totalAmount: Number(cn.totalAmount),
    items: cn.items?.map((i) => ({ id: i.id, description: i.description, totalValue: Number(i.totalValue) })),
  };
}

type InvoiceForCreditNote = {
  id: string; invoiceNumber: string; invoiceDate: Date; clientId: string;
  taxDetails: {
    gstin: string; placeOfSupply: string;
    sellerRegistrationId: string | null; sellerLegalName: string | null; sellerTradeName: string | null;
    sellerStateCode: string | null; sellerAddress: string | null; sellerCity: string | null;
    sellerDistrict: string | null; sellerPincode: string | null; sellerCountry: string | null;
    buyerName: string | null; buyerGstin: string | null; buyerPan: string | null; buyerAddress: string | null;
    buyerCity: string | null; buyerState: string | null; buyerStateCode: string | null;
    buyerPincode: string | null; buyerCountry: string | null;
  } | null;
};

// Path A: called from WITHIN an already-open transaction — either sales.service.ts's
// createSalesReturn (inline, same transaction as the return + its journal) or
// createCreditNoteForExistingReturn below (its own transaction, wrapping an existing return).
// Posts NO journal — journalEntryId is whatever the caller's own return-journal already is.
export async function createCreditNoteForReturn(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  userId: string,
  params: {
    invoice: InvoiceForCreditNote;
    salesReturnId: string;
    returnItems: Array<{ invoiceItemId: string; amount: number }>;
    isSameState: boolean;
    journalEntryId: string | null;
    reasonNotes?: string | null;
    creditNoteDate?: Date;
  },
) {
  const { invoice, salesReturnId, returnItems, isSameState, journalEntryId, reasonNotes, creditNoteDate } = params;
  if (!invoice.taxDetails) {
    throw new AppError('Cannot issue a GST credit note: this invoice has no tax record (non-INR or non-taxable sale)', 400);
  }
  if (returnItems.length === 0) throw new AppError('A credit note needs at least one line', 400);

  // §3.7: excludes salesReturnId's own rows — this operation IS crediting exactly that return's
  // amount, not adding new debt against itself.
  await assertNotOverCredited(tx, ctx.companyId, returnItems, salesReturnId);

  const invoiceItemIds = returnItems.map((r) => r.invoiceItemId);
  const sourceLines = await tx.invoiceItem.findMany({ where: { id: { in: invoiceItemIds }, companyId: ctx.companyId } });
  const lineById = new Map(sourceLines.map((l) => [l.id, l]));

  const items = returnItems.map((r) => {
    const line = lineById.get(r.invoiceItemId);
    if (!line) throw new AppError(`Invoice item not found: ${r.invoiceItemId}`, 404);
    // Path A: a genuine physical return — the whole tagged line came back, so its own already-
    // known InvoiceItem.quantity IS the credited quantity (see buildLineFromInvoiceItem's comment).
    return buildLineFromInvoiceItem(line, r.amount, isSameState, line.quantity);
  });

  const taxableAmount = round2(items.reduce((s, i) => s + i.taxableValue, 0));
  const cgst = round2(items.reduce((s, i) => s + i.cgstAmount, 0));
  const sgst = round2(items.reduce((s, i) => s + i.sgstAmount, 0));
  const igst = round2(items.reduce((s, i) => s + i.igstAmount, 0));
  const totalTax = round2(items.reduce((s, i) => s + i.lineTotalTax, 0));
  const totalAmount = round2(items.reduce((s, i) => s + i.totalValue, 0));

  const date = creditNoteDate ?? new Date();
  const financialYear = gstFinancialYear(date);
  const td = invoice.taxDetails;
  // G2g-7g: a Credit Note is its own GSTR-3B outward source document (gstr3bReporting.service.ts's
  // loader reads it by its own creditNoteDate) — guarded against its own period before it is numbered.
  await assertGstr3bPeriodMutable(tx, ctx.companyId, {
    documentType: 'CREDIT_NOTE', documentId: salesReturnId,
    gstRegistrationId: td.sellerRegistrationId, documentDate: date, action: 'issued',
  });
  // §9: GST-registration-scoped numbering key — the statutory unit (Rule 46(b)) is per-GSTIN, not
  // company-wide. 'LEGACY' is the sentinel for a company with no CompanyGstRegistration row yet.
  const creditNoteNumber = await nextDocumentNumber(ctx.companyId, `CN:${td.sellerRegistrationId ?? 'LEGACY'}`, 'CN', tx, financialYear);

  const created = await tx.creditNote.create({
    data: {
      companyId: ctx.companyId, creditNoteNumber, financialYear, creditNoteDate: date,
      invoiceId: invoice.id, originalInvoiceNumber: invoice.invoiceNumber, originalInvoiceDate: invoice.invoiceDate,
      salesReturnId, clientId: invoice.clientId,
      reasonCode: 'SALES_RETURN', reasonNotes: reasonNotes ?? null,
      gstin: td.gstin, placeOfSupply: td.placeOfSupply,
      sellerRegistrationId: td.sellerRegistrationId, sellerLegalName: td.sellerLegalName, sellerTradeName: td.sellerTradeName,
      sellerStateCode: td.sellerStateCode, sellerAddress: td.sellerAddress, sellerCity: td.sellerCity,
      sellerDistrict: td.sellerDistrict, sellerPincode: td.sellerPincode, sellerCountry: td.sellerCountry,
      buyerName: td.buyerName, buyerGstin: td.buyerGstin, buyerPan: td.buyerPan, buyerAddress: td.buyerAddress,
      buyerCity: td.buyerCity, buyerState: td.buyerState, buyerStateCode: td.buyerStateCode,
      buyerPincode: td.buyerPincode, buyerCountry: td.buyerCountry,
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

// The dedicated Path A route: wraps an EXISTING SalesReturn that has no CreditNote yet (either a
// return created without issueCreditNote, or — per §3.4's documented, deferred backfill note — an
// older return that predates this feature entirely). Opens its own transaction, locates the
// return's own journal entry, and delegates the actual creation to createCreditNoteForReturn.
export async function createCreditNoteForExistingReturn(
  returnId: string,
  ctx: TenantContext,
  userId: string,
  opts: { reasonNotes?: string } = {},
) {
  await assertOwnedByCompany('salesReturn', returnId, ctx.companyId, 'Sales Return');

  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    const salesReturn = await tx.salesReturn.findUniqueOrThrow({
      where: { id: returnId },
      include: { items: true, invoice: { include: { taxDetails: true } } },
    });
    if (salesReturn.companyId !== ctx.companyId) throw new AppError('Sales Return not found', 404);

    const existing = await tx.creditNote.findFirst({ where: { salesReturnId: returnId, companyId: ctx.companyId } });
    if (existing) throw new AppError('This Sales Return already has a Credit Note', 409);

    const journalEntry = await tx.journalEntry.findFirst({
      where: { companyId: ctx.companyId, referenceType: 'SalesReturn', referenceId: returnId },
    });

    const isSameState = !!salesReturn.invoice.taxDetails && Number(salesReturn.invoice.taxDetails.cgst) > 0;
    const returnItems = salesReturn.items.map((i) => ({ invoiceItemId: i.invoiceItemId, amount: Number(i.amount) }));

    return createCreditNoteForReturn(tx, ctx, userId, {
      invoice: salesReturn.invoice,
      salesReturnId: returnId,
      returnItems,
      isSameState,
      journalEntryId: journalEntry?.id ?? null,
      reasonNotes: opts.reasonNotes ?? salesReturn.reason ?? null,
    });
  });

  await createAuditEntry('credit_notes', created.id, userId, 'CREATE', undefined, auditSnapshot(created), ctx.companyId);
  return created;
}

export interface StandaloneCreditNoteLineInput {
  invoiceItemId?: string;
  amount?: number; // tax-inclusive; only meaningful with invoiceItemId — defaults to the line's own full remaining value
  description?: string; // required when invoiceItemId is absent; overrides the line's own description otherwise
  hsnCode?: string; // value-only line only; defaults to DEFAULT_HSN_CODE
  taxableValue?: number; // value-only line only (net of tax) — required when invoiceItemId is absent
}

// Path B: a value-only correction against an invoice with NO physical return — post-sale discount,
// billing error, waived service charge. Posts its own journal (no stock/tag movement to mirror).
export async function createStandaloneCreditNote(
  data: {
    invoiceId: string;
    items: StandaloneCreditNoteLineInput[];
    reasonCode: string;
    reasonNotes?: string;
    creditNoteDate?: Date;
  },
  ctx: TenantContext,
  userId: string,
) {
  if (!Array.isArray(data.items) || data.items.length === 0) throw new AppError('At least one line is required', 400);
  if (!isValidCreditNoteReason(data.reasonCode)) throw new AppError(`Invalid reason code: ${data.reasonCode}`, 400);
  if (data.reasonCode === 'OTHER' && !data.reasonNotes?.trim()) {
    throw new AppError('reasonNotes is required when reasonCode is OTHER', 400);
  }

  await assertOwnedByCompany('salesInvoice', data.invoiceId, ctx.companyId, 'Invoice');

  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    const invoice = await tx.salesInvoice.findUniqueOrThrow({ where: { id: data.invoiceId }, include: { taxDetails: true } });
    if (invoice.companyId !== ctx.companyId) throw new AppError('Invoice not found', 404);
    // §5.3: blocked only if the invoice is VOID — not blocked by a payment, or a prior partial
    // return/credit (the over-credit guard below is the real limit on the latter). Deliberately
    // NOT gated on taxDetails.irn (§5.2) — a Credit Note is the intended post-IRN correction path.
    if (invoice.status === 'VOID') throw new AppError('This invoice has been voided and cannot be credited', 409);
    if (!invoice.taxDetails) {
      throw new AppError('Cannot issue a GST credit note: this invoice has no tax record (non-INR or non-taxable sale)', 400);
    }
    const td = invoice.taxDetails;
    const isSameState = Number(td.cgst) > 0;

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

    const overCreditRequests: Array<{ invoiceItemId: string; amount: number }> = [];
    const lines = data.items.map((i) => {
      if (i.invoiceItemId) {
        const line = lineById.get(i.invoiceItemId);
        if (!line) throw new AppError(`Invoice item not found on this invoice: ${i.invoiceItemId}`, 404);
        const taxRate = Number(line.taxRate);
        const fullAmount = round2(Number(line.totalPrice) * (1 + taxRate));
        const amount = i.amount ?? fullAmount;
        if (!(amount > 0)) throw new AppError('Credit amount must be more than zero', 400);
        overCreditRequests.push({ invoiceItemId: i.invoiceItemId, amount });
        // Path B, linked: still a value-only correction (§ the function comment) — quantity is
        // deliberately omitted here (stays null), even though invoiceItemId is known, because a
        // price/value adjustment on a line doesn't mean the physical quantity came back. uqc is
        // still inherited from the source line, unconditionally.
        return buildLineFromInvoiceItem(
          i.description ? { ...line, description: i.description } : line,
          amount, isSameState,
        );
      }
      // Value-only line — no InvoiceItem, no tag, a fresh (but still snapshotted) HSN lookup.
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
        // No physical quantity on a pure value-only line with no source InvoiceItem — stays null.
        // uqc: this HSN's own default, same resolution InvoiceItem lines use, since this line does
        // carry an HSN (just no physical item/tag) — never fabricated beyond that.
        uqc: hsn.defaultUqc ?? null, quantity: null,
        taxableValue, cgstAmount: round2(cgst), sgstAmount: round2(sgst), igstAmount: round2(igst),
        lineTotalTax: lineTax, totalValue: round2(taxableValue + lineTax),
        grossWeight: null, netWeight: null, stoneWeight: null, karat: null,
      };
    });

    if (overCreditRequests.length > 0) await assertNotOverCredited(tx, ctx.companyId, overCreditRequests);

    const taxableAmount = round2(lines.reduce((s, i) => s + i.taxableValue, 0));
    const cgst = round2(lines.reduce((s, i) => s + i.cgstAmount, 0));
    const sgst = round2(lines.reduce((s, i) => s + i.sgstAmount, 0));
    const igst = round2(lines.reduce((s, i) => s + i.igstAmount, 0));
    const totalTax = round2(lines.reduce((s, i) => s + i.lineTotalTax, 0));
    const totalAmount = round2(lines.reduce((s, i) => s + i.totalValue, 0));
    if (totalAmount <= 0) throw new AppError('This credit note has no value', 400);

    const date = data.creditNoteDate ?? new Date();
    const financialYear = gstFinancialYear(date);
    // G2g-7g: same guard as Path A's createCreditNoteForReturn, against this Path B note's own date.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'CREDIT_NOTE', documentId: invoice.invoiceNumber,
      gstRegistrationId: td.sellerRegistrationId, documentDate: date, action: 'issued',
    });
    const creditNoteNumber = await nextDocumentNumber(ctx.companyId, `CN:${td.sellerRegistrationId ?? 'LEGACY'}`, 'CN', tx, financialYear);

    const cn = await tx.creditNote.create({
      data: {
        companyId: ctx.companyId, creditNoteNumber, financialYear, creditNoteDate: date,
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
        items: { createMany: { data: lines } },
      },
      include: { items: true },
    });

    // Path B posts its own journal — mirrors createSalesReturn's Dr Revenue + Dr GST / Cr AR shape,
    // minus the Inventory/COGS lines (§8: "Stock effect: None" — nothing physical moved).
    const entry = await postAutoJournalEntry(tx, ctx.companyId, {
      date, description: `Credit Note ${creditNoteNumber} (Invoice ${invoice.invoiceNumber})`,
      referenceType: 'CreditNote', referenceId: cn.id, userId,
      lines: [
        { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, credit: totalAmount },
        { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, debit: taxableAmount },
        { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, debit: cgst },
        { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, debit: sgst },
        { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, debit: igst },
      ],
    });
    if (entry) await tx.creditNote.update({ where: { id: cn.id }, data: { journalEntryId: entry.id } });

    // Customer balance — identical mechanism to createSalesReturn's own decrement.
    await tx.client.update({ where: { id: invoice.clientId }, data: { currentBalance: { decrement: totalAmount } } });

    return entry ? { ...cn, journalEntryId: entry.id } : cn;
  });

  await createAuditEntry('credit_notes', created.id, userId, 'CREATE', undefined, auditSnapshot(created), ctx.companyId);
  return created;
}

// §3.6: only a standalone (Path B) Credit Note may be cancelled — a Path A one is permanently
// linked to an append-only SalesReturn (unwinding it would have to also unwind the return, which
// this codebase already decided never to support — CLAUDE.md J3 Decision 5).
export async function cancelCreditNote(creditNoteId: string, ctx: TenantContext, userId: string, reason: string) {
  if (!reason?.trim()) throw new AppError('A reason is required to cancel a credit note', 400);
  await assertOwnedByCompany('creditNote', creditNoteId, ctx.companyId, 'Credit Note');

  let before: any, after: any;
  try {
    ({ before, after } = await tenantTransaction(ctx.companyId, async (tx) => {
    // Serialise, then read fresh — same lock voidInvoice/amendInvoice take on their own row.
    await tx.$queryRaw`SELECT "id" FROM "credit_notes" WHERE "id" = ${creditNoteId} FOR UPDATE`;
    const cn = await tx.creditNote.findUniqueOrThrow({ where: { id: creditNoteId } });
    if (cn.companyId !== ctx.companyId) throw new AppError('Credit Note not found', 404);
    if (cn.salesReturnId) {
      throw new AppError('A Credit Note linked to a Sales Return cannot be independently cancelled — the underlying return is append-only', 409);
    }
    if (cn.status === 'CANCELLED') throw new AppError('This credit note has already been cancelled', 409);
    // G2g-6d: a credit note represented in an accepted GSTR-1 filing is closed to cancellation —
    // same posture as voidInvoice's own guard on the sales-invoice side.
    await assertGstr1DocumentMutable(tx, ctx.companyId, {
      documentType: 'CREDIT_NOTE', documentId: creditNoteId,
      gstRegistrationId: cn.sellerRegistrationId, action: 'cancelled',
    });
    // G2g-7g: same cancel/reverse protection as voidInvoice's own — a credit note dated into an
    // already-FILED/LOCKED period cannot be cancelled either.
    await assertGstr3bPeriodMutable(tx, ctx.companyId, {
      documentType: 'CREDIT_NOTE', documentId: creditNoteId,
      gstRegistrationId: cn.sellerRegistrationId, documentDate: cn.creditNoteDate, action: 'cancelled',
    });

    const before = { status: cn.status, totalAmount: Number(cn.totalAmount) };
    const totalAmount = Number(cn.totalAmount);

    if (cn.journalEntryId) {
      // Exact inverse of Path B's own creation entry — never edits the original.
      await postAutoJournalEntry(tx, ctx.companyId, {
        date: new Date(), description: `Cancellation of Credit Note ${cn.creditNoteNumber}`,
        referenceType: 'CreditNoteCancellation', referenceId: cn.id, userId,
        lines: [
          { accountCode: LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE, debit: totalAmount },
          { accountCode: LEDGER_ACCOUNT.SALES_REVENUE, credit: Number(cn.taxableAmount) },
          { accountCode: LEDGER_ACCOUNT.CGST_PAYABLE, credit: Number(cn.cgst) },
          { accountCode: LEDGER_ACCOUNT.SGST_PAYABLE, credit: Number(cn.sgst) },
          { accountCode: LEDGER_ACCOUNT.IGST_PAYABLE, credit: Number(cn.igst) },
        ],
      });
    }
    // Restore the customer balance this credit note reduced at creation — unconditional on the
    // journal branch above, since the balance movement itself was always unconditional too.
    await tx.client.update({ where: { id: cn.clientId }, data: { currentBalance: { increment: totalAmount } } });

    const updated = await tx.creditNote.update({
      where: { id: creditNoteId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: userId, cancelReason: reason },
    });

    return { before, after: { status: updated.status, cancelledAt: updated.cancelledAt, cancelReason: updated.cancelReason } };
    }));
  } catch (err) {
    await auditGstr1MutationBlocked(err, 'credit_notes', userId, ctx.companyId);
    await auditGstr3bMutationBlocked(err, 'credit_notes', userId, ctx.companyId);
    throw err;
  }

  await createAuditEntry('credit_notes', creditNoteId, userId, 'CANCEL', before, { ...after, reason }, ctx.companyId);
  return { id: creditNoteId, status: 'CANCELLED' as const };
}

export async function listCreditNotes(
  ctx: TenantContext,
  filters: { clientId?: string; invoiceId?: string; status?: string; from?: Date; to?: Date } = {},
) {
  return tenantQuery(ctx.companyId, (tx) => tx.creditNote.findMany({
    where: {
      companyId: ctx.companyId,
      ...(filters.clientId && { clientId: filters.clientId }),
      ...(filters.invoiceId && { invoiceId: filters.invoiceId }),
      ...(filters.status && { status: filters.status }),
      ...((filters.from || filters.to) && {
        creditNoteDate: { ...(filters.from && { gte: filters.from }), ...(filters.to && { lte: filters.to }) },
      }),
    },
    include: {
      client: { select: { name: true, clientCode: true } },
      items: true,
      salesReturn: { select: { id: true, returnNumber: true } },
      invoice: { select: { id: true, invoiceNumber: true } },
    },
    orderBy: { creditNoteDate: 'desc' },
  }));
}

export async function getCreditNoteById(ctx: TenantContext, id: string) {
  await assertOwnedByCompany('creditNote', id, ctx.companyId, 'Credit Note');
  return tenantQuery(ctx.companyId, (tx) => tx.creditNote.findUniqueOrThrow({
    where: { id },
    include: {
      client: { select: { name: true, clientCode: true, phone: true, address: true, city: true, state: true } },
      items: { include: { hsnCode: { select: { code: true, description: true } } } },
      salesReturn: { select: { id: true, returnNumber: true, returnDate: true, reason: true } },
      invoice: { select: { id: true, branchId: true, invoiceNumber: true, invoiceDate: true } },
      createdBy: { select: { name: true } },
      cancelledBy: { select: { name: true } },
    },
  }));
}
