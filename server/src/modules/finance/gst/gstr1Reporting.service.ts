// G2g-3e — GSTR-1 reporting integration layer. Connects the two FROZEN, pure aggregation engines
// (gstr1OutwardAggregation.ts / gstr1CreditNoteAggregation.ts) to the real tenant-scoped database.
// This file owns exactly what the G2g-3e brief assigns to the service layer — Prisma access,
// company scope, source-row loading, and shape-adaptation from Prisma rows into the aggregators'
// own pure input contracts — and nothing else. It performs NO classification, normalization,
// aggregation, diagnostics, or exclusion logic of its own; every one of those stays inside the two
// frozen modules, called here unmodified.
//
// Registration/branch/period SCOPE NARROWING (which rows actually end up in a bucket vs. silently
// out of scope vs. a diagnostic) is deliberately left to the frozen aggregators themselves — they
// already implement that exact behavior (see each module's own "Filtering order" doc comment).
// This service therefore loads broadly (company + a coarse date pre-filter for query efficiency
// only) and hands everything else to the aggregator unfiltered by registration/branch, so a
// present-but-different registration, an inaccessible branch, or a missing registration still
// reaches the aggregator and is diagnosed/excluded exactly the way its own frozen rules specify —
// duplicating that logic here (e.g. an exact-match DB-level registration filter) would silently
// drop the "missing registration → diagnostic" rows the aggregator is specifically designed to
// still see and report on.
//
// Ownership/authorization (does this gstRegistrationId/branchId belong to the caller's company,
// may the caller access this branch) is the ROUTER's job (finance.router.ts, via
// assertOwnedByCompany/assertBranchAccessible) — this file trusts its `gstRegistrationId` and
// `opts.branchId` arguments as already-verified, exactly like every other finance.service.ts GST
// reporting function (getGstSummary/getPurchaseGstSummary) already does.

import type { Prisma } from '@prisma/client';
import { tenantQuery } from '../../../shared/tenantContext';
import type { BranchAccess, TenantContext } from '../../../shared/tenantContext';
import { assertOwnedByCompany, assertBranchAccessible } from '../../../middleware/tenant';
import { AppError } from '../../../middleware/error';
import { parseIstRangeStart, parseIstRangeEnd } from '../../../shared/istDate';
import {
  aggregateGstr1OutwardSupplies,
  type Gstr1OutwardAggregation,
  type Gstr1OutwardSourceInvoice,
} from './gstr1OutwardAggregation';
import {
  aggregateGstr1CreditNotes,
  type Gstr1CreditNoteAggregation,
  type Gstr1CreditNoteAggregationSourceDocument,
} from './gstr1CreditNoteAggregation';
import {
  aggregateGstr1Table12,
  type Gstr1Table12Aggregation,
} from './gstr1Table12Aggregation';
import {
  aggregateGstr1Table13,
  type Table13Aggregation,
  type Table13Document,
} from './gstr1Table13Aggregation';
import type { InvoiceItemSourceRow, CreditNoteItemSourceRow } from './gstr1Normalizer';
import {
  aggregateGstr1SalesDebitNotes,
  applySalesDebitNotesToOutwardAggregation,
  applySalesDebitNotesToTable12,
  toTable13SalesDebitNoteDocument,
  type Gstr1SalesDebitNoteAggregation,
  type Gstr1SalesDebitNoteAggregationSourceDocument,
  type Gstr1SalesDebitNoteItemSourceRow,
  type Gstr1OutwardAggregationWithSalesDebitNotes,
  type Gstr1Table12AggregationWithSalesDebitNotes,
} from './gstr1SalesDebitNoteAdapter';

export interface Gstr1ReportScopeOptions {
  branchAccess?: BranchAccess;
  branchId?: string;
}

const HSN_SELECT = { select: { code: true, description: true, defaultUqc: true } } as const;

// ─────────────────────────────────────────────────────────────────────────────
// A. Outward supplies (B2B/B2CL/B2CS)
// ─────────────────────────────────────────────────────────────────────────────

function toOutwardSourceInvoice(inv: {
  id: string; invoiceNumber: string; invoiceDate: Date; status: string; branchId: string;
  totalAmount: unknown;
  taxDetails: {
    buyerGstin: string | null; placeOfSupply: string; sellerStateCode: string | null;
    sellerRegistrationId: string | null; reverseCharge: boolean;
  } | null;
  items: Array<{
    id: string; invoiceId: string; description: string; quantity: number; netGoldWeight: unknown;
    hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
    hsnCodeId: string | null; uqc: string | null; taxRate: unknown; taxableValue: unknown;
    cgstAmount: unknown; sgstAmount: unknown; igstAmount: unknown; lineTotalTax: unknown;
  }>;
}): Gstr1OutwardSourceInvoice {
  const items: InvoiceItemSourceRow[] = inv.items.map((item) => ({
    id: item.id, invoiceId: item.invoiceId, description: item.description, quantity: item.quantity,
    netGoldWeight: item.netGoldWeight, hsnCode: item.hsnCode, hsnCodeId: item.hsnCodeId, uqc: item.uqc,
    taxRate: item.taxRate, taxableValue: item.taxableValue, cgstAmount: item.cgstAmount,
    sgstAmount: item.sgstAmount, igstAmount: item.igstAmount, lineTotalTax: item.lineTotalTax,
  }));

  return {
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    status: inv.status,
    branchId: inv.branchId,
    totalAmount: Number(inv.totalAmount),
    buyerGstin: inv.taxDetails?.buyerGstin ?? null,
    placeOfSupply: inv.taxDetails?.placeOfSupply ?? null,
    sellerStateCode: inv.taxDetails?.sellerStateCode ?? null,
    sellerRegistrationId: inv.taxDetails?.sellerRegistrationId ?? null,
    reverseCharge: inv.taxDetails?.reverseCharge ?? null,
    items,
  };
}

/**
 * Loads this company's SalesInvoice + TaxInvoice + InvoiceItem rows for the period (a coarse
 * `invoiceDate` pre-filter only — see the module header for why registration/branch are NOT
 * pre-filtered at the DB level) and hands them, unmodified in substance, to the frozen
 * `aggregateGstr1OutwardSupplies()`. `gstRegistrationId`/`opts.branchId` are trusted as already
 * ownership-checked by the caller (finance.router.ts).
 */
async function loadOutwardSourceInvoices(companyId: string, from: Date, to: Date): Promise<Gstr1OutwardSourceInvoice[]> {
  const invoices = await tenantQuery(companyId, (tx) =>
    tx.salesInvoice.findMany({
      where: { companyId, invoiceDate: { gte: from, lte: to } },
      select: {
        id: true, invoiceNumber: true, invoiceDate: true, status: true, branchId: true, totalAmount: true,
        taxDetails: {
          select: { buyerGstin: true, placeOfSupply: true, sellerStateCode: true, sellerRegistrationId: true, reverseCharge: true },
        },
        items: {
          select: {
            id: true, invoiceId: true, description: true, quantity: true, netGoldWeight: true,
            hsnCode: HSN_SELECT, hsnCodeId: true, uqc: true, taxRate: true, taxableValue: true,
            cgstAmount: true, sgstAmount: true, igstAmount: true, lineTotalTax: true,
          },
        },
      },
    })
  );
  return invoices.map(toOutwardSourceInvoice);
}

/**
 * Phase A (GSTR-1 readiness): also loads this same period's CreditNote source documents (reusing
 * `loadCreditNoteSourceDocuments` below — no parallel query, no re-derived shape) and hands them to
 * `aggregateGstr1OutwardSupplies()`'s own optional third argument, so an eligible B2CS Credit Note
 * nets against Table 7's matching bucket ("Net B2CS = Gross B2CS - eligible B2CS Credit Notes")
 * instead of being reported as a fake "CDNUR B2CS" line (see gstr1CreditNoteAggregation.ts and
 * gstr1OutwardAggregation.ts's own headers). Both loads run concurrently — no N+1, no serial
 * round trip added over the pre-Phase-A single-query version.
 */
export async function getGstr1OutwardReport(
  companyId: string,
  gstRegistrationId: string,
  from: Date,
  to: Date,
  opts?: Gstr1ReportScopeOptions,
): Promise<Gstr1OutwardAggregation> {
  const [invoices, creditNotes] = await Promise.all([
    loadOutwardSourceInvoices(companyId, from, to),
    loadCreditNoteSourceDocuments(companyId, from, to),
  ]);

  return aggregateGstr1OutwardSupplies(
    invoices,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
    creditNotes,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Credit Notes (CDNR/CDNUR)
// ─────────────────────────────────────────────────────────────────────────────

function toCreditNoteSourceDocument(cn: {
  id: string; creditNoteNumber: string; creditNoteDate: Date; status: string;
  invoiceId: string; originalInvoiceNumber: string; originalInvoiceDate: Date;
  salesReturnId: string | null;
  sellerRegistrationId: string | null; sellerStateCode: string | null;
  buyerGstin: string | null; buyerCountry: string | null; placeOfSupply: string;
  reasonCode: string; reasonNotes: string | null;
  taxableAmount: unknown; cgst: unknown; sgst: unknown; igst: unknown; totalTax: unknown; totalAmount: unknown;
  invoice: { totalAmount: unknown; branchId: string };
  items: Array<{
    id: string; creditNoteId: string; description: string;
    hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
    hsnCodeId: string | null; uqc: string | null; quantity: unknown; taxRate: unknown;
    taxableValue: unknown; cgstAmount: unknown; sgstAmount: unknown; igstAmount: unknown;
    totalValue: unknown; netWeight: unknown;
  }>;
}): Gstr1CreditNoteAggregationSourceDocument {
  const items: CreditNoteItemSourceRow[] = cn.items.map((item) => ({
    id: item.id, creditNoteId: item.creditNoteId, description: item.description,
    hsnCode: item.hsnCode, hsnCodeId: item.hsnCodeId, uqc: item.uqc, quantity: item.quantity,
    taxRate: item.taxRate, taxableValue: item.taxableValue, cgstAmount: item.cgstAmount,
    sgstAmount: item.sgstAmount, igstAmount: item.igstAmount, totalValue: item.totalValue, netWeight: item.netWeight,
  }));

  return {
    id: cn.id,
    creditNoteNumber: cn.creditNoteNumber,
    creditNoteDate: cn.creditNoteDate,
    status: cn.status,
    invoiceId: cn.invoiceId,
    originalInvoiceNumber: cn.originalInvoiceNumber,
    originalInvoiceDate: cn.originalInvoiceDate,
    // The ORIGINAL SalesInvoice's own persisted totalAmount (rule 5 of the G2g-3d-2 brief, still
    // in force) — never this Credit Note's own value, never recomputed.
    originalInvoiceValue: Number(cn.invoice.totalAmount),
    salesReturnId: cn.salesReturnId,
    sellerRegistrationId: cn.sellerRegistrationId,
    sellerStateCode: cn.sellerStateCode,
    buyerGstin: cn.buyerGstin,
    buyerCountry: cn.buyerCountry,
    placeOfSupply: cn.placeOfSupply,
    reasonCode: cn.reasonCode,
    reasonNotes: cn.reasonNotes,
    taxableAmount: Number(cn.taxableAmount),
    cgst: Number(cn.cgst),
    sgst: Number(cn.sgst),
    igst: Number(cn.igst),
    totalTax: Number(cn.totalTax),
    totalAmount: Number(cn.totalAmount),
    items,
    // CreditNote carries no branchId column of its own — inherited from the originating
    // SalesInvoice, per Gstr1CreditNoteAggregationSourceDocument's own doc comment.
    branchId: cn.invoice.branchId,
  };
}

/**
 * Loads this company's CreditNote + CreditNoteItem rows for the period (a coarse `creditNoteDate`
 * pre-filter only), joined to their originating SalesInvoice for `originalInvoiceValue`/`branchId`,
 * and hands them, unmodified in substance, to the frozen `aggregateGstr1CreditNotes()`.
 * `gstRegistrationId`/`opts.branchId` are trusted as already ownership-checked by the caller.
 */
async function loadCreditNoteSourceDocuments(companyId: string, from: Date, to: Date): Promise<Gstr1CreditNoteAggregationSourceDocument[]> {
  const creditNotes = await tenantQuery(companyId, (tx) =>
    tx.creditNote.findMany({
      where: { companyId, creditNoteDate: { gte: from, lte: to } },
      select: {
        id: true, creditNoteNumber: true, creditNoteDate: true, status: true,
        invoiceId: true, originalInvoiceNumber: true, originalInvoiceDate: true, salesReturnId: true,
        sellerRegistrationId: true, sellerStateCode: true, buyerGstin: true, buyerCountry: true, placeOfSupply: true,
        reasonCode: true, reasonNotes: true,
        taxableAmount: true, cgst: true, sgst: true, igst: true, totalTax: true, totalAmount: true,
        invoice: { select: { totalAmount: true, branchId: true } },
        items: {
          select: {
            id: true, creditNoteId: true, description: true, hsnCode: HSN_SELECT, hsnCodeId: true, uqc: true,
            quantity: true, taxRate: true, taxableValue: true, cgstAmount: true, sgstAmount: true,
            igstAmount: true, totalValue: true, netWeight: true,
          },
        },
      },
    })
  );
  return creditNotes.map(toCreditNoteSourceDocument);
}

export async function getGstr1CreditNoteReport(
  companyId: string,
  gstRegistrationId: string,
  from: Date,
  to: Date,
  opts?: Gstr1ReportScopeOptions,
): Promise<Gstr1CreditNoteAggregation> {
  const creditNotes = await loadCreditNoteSourceDocuments(companyId, from, to);

  return aggregateGstr1CreditNotes(
    creditNotes,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B2 (G2g-4b). Sales (outward) Debit Notes — Table 9B (CDNR/CDNUR, positive direction) and the
// loader every other Sales-Debit-Note report function below reuses. A wholly separate domain from
// the procurement-side DebitNote (never loaded, never referenced, anywhere in this file).
// ─────────────────────────────────────────────────────────────────────────────

function toSalesDebitNoteSourceDocument(dn: {
  id: string; debitNoteNumber: string; debitNoteDate: Date; status: string; branchId: string;
  invoiceId: string; originalInvoiceNumber: string; originalInvoiceDate: Date;
  sellerRegistrationId: string | null; sellerStateCode: string | null;
  buyerGstin: string | null; buyerCountry: string | null; placeOfSupply: string;
  reasonCode: string; reasonNotes: string | null;
  taxableAmount: unknown; cgst: unknown; sgst: unknown; igst: unknown; totalTax: unknown; totalAmount: unknown;
  invoice: { totalAmount: unknown };
  items: Array<{
    id: string; description: string;
    hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
    hsnCodeId: string | null; uqc: string | null; quantity: unknown; taxRate: unknown;
    taxableValue: unknown; cgstAmount: unknown; sgstAmount: unknown; igstAmount: unknown;
    totalValue: unknown; netWeight: unknown;
  }>;
}): Gstr1SalesDebitNoteAggregationSourceDocument {
  const items: Gstr1SalesDebitNoteItemSourceRow[] = dn.items.map((item) => ({
    id: item.id, description: item.description,
    hsnCode: item.hsnCode, hsnCodeId: item.hsnCodeId, uqc: item.uqc, quantity: item.quantity,
    taxRate: item.taxRate, taxableValue: item.taxableValue, cgstAmount: item.cgstAmount,
    sgstAmount: item.sgstAmount, igstAmount: item.igstAmount, totalValue: item.totalValue, netWeight: item.netWeight,
  }));

  return {
    id: dn.id,
    debitNoteNumber: dn.debitNoteNumber,
    debitNoteDate: dn.debitNoteDate,
    status: dn.status,
    invoiceId: dn.invoiceId,
    originalInvoiceNumber: dn.originalInvoiceNumber,
    originalInvoiceDate: dn.originalInvoiceDate,
    // The ORIGINAL SalesInvoice's own persisted totalAmount — never this debit note's own value.
    originalInvoiceValue: Number(dn.invoice.totalAmount),
    sellerRegistrationId: dn.sellerRegistrationId,
    sellerStateCode: dn.sellerStateCode,
    buyerGstin: dn.buyerGstin,
    buyerCountry: dn.buyerCountry,
    placeOfSupply: dn.placeOfSupply,
    reasonCode: dn.reasonCode,
    reasonNotes: dn.reasonNotes,
    taxableAmount: Number(dn.taxableAmount),
    cgst: Number(dn.cgst),
    sgst: Number(dn.sgst),
    igst: Number(dn.igst),
    totalTax: Number(dn.totalTax),
    totalAmount: Number(dn.totalAmount),
    items,
    // Unlike CreditNote, SalesDebitNote carries its own branchId column directly.
    branchId: dn.branchId,
  };
}

/**
 * Loads this company's SalesDebitNote + SalesDebitNoteItem rows for the period (a coarse
 * `debitNoteDate` pre-filter only — registration/branch scope narrowing is left to the pure
 * adapter, same posture as every loader in this file), joined to the originating SalesInvoice for
 * `originalInvoiceValue`. Never loads the procurement-side DebitNote table.
 */
async function loadSalesDebitNoteSourceDocuments(companyId: string, from: Date, to: Date): Promise<Gstr1SalesDebitNoteAggregationSourceDocument[]> {
  const debitNotes = await tenantQuery(companyId, (tx) =>
    tx.salesDebitNote.findMany({
      where: { companyId, debitNoteDate: { gte: from, lte: to } },
      select: {
        id: true, debitNoteNumber: true, debitNoteDate: true, status: true, branchId: true,
        invoiceId: true, originalInvoiceNumber: true, originalInvoiceDate: true,
        sellerRegistrationId: true, sellerStateCode: true, buyerGstin: true, buyerCountry: true, placeOfSupply: true,
        reasonCode: true, reasonNotes: true,
        taxableAmount: true, cgst: true, sgst: true, igst: true, totalTax: true, totalAmount: true,
        invoice: { select: { totalAmount: true } },
        items: {
          select: {
            id: true, description: true, hsnCode: HSN_SELECT, hsnCodeId: true, uqc: true,
            quantity: true, taxRate: true, taxableValue: true, cgstAmount: true, sgstAmount: true,
            igstAmount: true, totalValue: true, netWeight: true,
          },
        },
      },
    })
  );
  return debitNotes.map(toSalesDebitNoteSourceDocument);
}

/** Table 9B equivalent for Sales Debit Notes (CDNR/CDNUR, positive direction) — the sell-side
 *  structural mirror of `getGstr1CreditNoteReport` above. */
export async function getGstr1SalesDebitNoteReport(
  companyId: string,
  gstRegistrationId: string,
  from: Date,
  to: Date,
  opts?: Gstr1ReportScopeOptions,
): Promise<Gstr1SalesDebitNoteAggregation> {
  const debitNotes = await loadSalesDebitNoteSourceDocuments(companyId, from, to);

  return aggregateGstr1SalesDebitNotes(
    debitNotes,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
  );
}

/**
 * Table 7 B2CS "Gross + Sales Debit Notes - Credit Notes" — a NEW, additive function (never
 * replacing `getGstr1OutwardReport`, whose existing behavior/callers stay exactly as they were).
 * Loads outward invoices, Credit Notes AND Sales Debit Notes concurrently, runs the frozen
 * aggregator first (gross - Credit Notes, Phase A's existing behavior), then applies the Sales
 * Debit Note adapter on top of that result.
 */
export async function getGstr1OutwardReportWithSalesDebitNotes(
  companyId: string,
  gstRegistrationId: string,
  from: Date,
  to: Date,
  opts?: Gstr1ReportScopeOptions,
): Promise<Gstr1OutwardAggregationWithSalesDebitNotes> {
  const [invoices, creditNotes, debitNotes] = await Promise.all([
    loadOutwardSourceInvoices(companyId, from, to),
    loadCreditNoteSourceDocuments(companyId, from, to),
    loadSalesDebitNoteSourceDocuments(companyId, from, to),
  ]);

  const base = aggregateGstr1OutwardSupplies(
    invoices,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
    creditNotes,
  );

  return applySalesDebitNotesToOutwardAggregation(
    base, debitNotes,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. Table 12 (HSN-wise Summary: B2B Supplies / B2C Supplies)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads this company's outward-supply invoices AND formal Credit Notes for the period (reusing the
 * exact same loaders as getGstr1OutwardReport/getGstr1CreditNoteReport above — no parallel query, no
 * re-derived shape) and hands them, unmodified in substance, to the frozen `aggregateGstr1Table12()`.
 * `gstRegistrationId`/`opts.branchId` are trusted as already ownership-checked by the caller
 * (finance.router.ts), identical posture to every other GSTR-1 reporting function in this file.
 */
export async function getGstr1Table12Report(
  companyId: string,
  gstRegistrationId: string,
  from: Date,
  to: Date,
  opts?: Gstr1ReportScopeOptions,
): Promise<Gstr1Table12Aggregation> {
  const [invoices, creditNotes] = await Promise.all([
    loadOutwardSourceInvoices(companyId, from, to),
    loadCreditNoteSourceDocuments(companyId, from, to),
  ]);

  return aggregateGstr1Table12(
    invoices, creditNotes,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
  );
}

/**
 * Table 12 with Sales Debit Notes represented as a positive addition (section 14) — a NEW,
 * additive function (never replacing `getGstr1Table12Report` above). Runs the frozen
 * `aggregateGstr1Table12()` first (gross - Credit Notes, unchanged), then applies the Sales Debit
 * Note adapter on top of that result.
 */
export async function getGstr1Table12ReportWithSalesDebitNotes(
  companyId: string,
  gstRegistrationId: string,
  from: Date,
  to: Date,
  opts?: Gstr1ReportScopeOptions,
): Promise<Gstr1Table12AggregationWithSalesDebitNotes> {
  const [invoices, creditNotes, debitNotes] = await Promise.all([
    loadOutwardSourceInvoices(companyId, from, to),
    loadCreditNoteSourceDocuments(companyId, from, to),
    loadSalesDebitNoteSourceDocuments(companyId, from, to),
  ]);

  const base = aggregateGstr1Table12(
    invoices, creditNotes,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
  );

  return applySalesDebitNotesToTable12(
    base, debitNotes,
    { gstRegistrationId, period: { from, to }, branchAccess: opts?.branchAccess, branchId: opts?.branchId },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Table 13 (Documents Issued)
// ─────────────────────────────────────────────────────────────────────────────

export interface GetGstr1Table13ReportParams {
  gstRegistrationId: string;
  from: Date | string;
  to: Date | string;
  branchId?: string | null;
}

export interface Gstr1Table13ReportMeta {
  gstRegistrationId: string;
  period: { from: Date; to: Date };
  branchId: string | null;
  isPartialBranchSeries: boolean;
  salesInvoicesConsidered: number;
  creditNotesConsidered: number;
  // G2g-4b: additive field — a company with zero Sales Debit Notes sees 0 here, every other field
  // unchanged.
  salesDebitNotesConsidered: number;
}

export interface Gstr1Table13Report extends Table13Aggregation {
  meta: Gstr1Table13ReportMeta;
}

/**
 * Loads this company's SalesInvoices for Table 13 (document-issued statutory filing).
 * Selects only document-level attributes and to-one taxDetails relation — never InvoiceItem or
 * payments — ensuring zero row multiplication. Excludes unissued DRAFT records; preserves VOID
 * as cancelled documents.
 */
async function loadTable13SalesDocuments(
  companyId: string,
  gstRegistrationId: string,
  fromDate: Date,
  toDate: Date,
  branchScope?: { branchId?: string | null; branchIds?: string[] },
): Promise<Table13Document[]> {
  const where: Prisma.SalesInvoiceWhereInput = {
    companyId,
    invoiceDate: { gte: fromDate, lte: toDate },
    status: { notIn: ['DRAFT', 'draft', 'Draft'] },
    taxDetails: {
      sellerRegistrationId: gstRegistrationId,
    },
  };

  if (branchScope?.branchId) {
    where.branchId = branchScope.branchId;
  } else if (branchScope?.branchIds !== undefined) {
    where.branchId = { in: branchScope.branchIds };
  }

  const invoices = await tenantQuery(companyId, (tx) =>
    tx.salesInvoice.findMany({
      where,
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        status: true,
        branchId: true,
        taxDetails: {
          select: {
            sellerRegistrationId: true,
          },
        },
      },
      orderBy: {
        invoiceDate: 'asc',
      },
    })
  );

  return invoices
    .filter((inv) => inv.status && inv.status.trim().toUpperCase() !== 'DRAFT')
    .map((inv) => ({
      id: inv.id,
      documentNumber: inv.invoiceNumber,
      documentDate: inv.invoiceDate,
      status: inv.status,
      documentType: 'SALES_INVOICE',
      sellerRegistrationId: inv.taxDetails?.sellerRegistrationId ?? null,
      branchId: inv.branchId,
    }));
}

/**
 * Loads this company's CreditNotes for Table 13 (both Path A return-linked and Path B standalone).
 * Selects only document-level attributes and to-one invoice relation for originating branchId —
 * never CreditNoteItem — ensuring zero row multiplication. Excludes bare SalesReturn (which is
 * not a CreditNote).
 */
async function loadTable13CreditNoteDocuments(
  companyId: string,
  gstRegistrationId: string,
  fromDate: Date,
  toDate: Date,
  branchScope?: { branchId?: string | null; branchIds?: string[] },
): Promise<Table13Document[]> {
  const where: Prisma.CreditNoteWhereInput = {
    companyId,
    creditNoteDate: { gte: fromDate, lte: toDate },
    sellerRegistrationId: gstRegistrationId,
    status: { notIn: ['DRAFT', 'draft', 'Draft'] },
  };

  if (branchScope?.branchId) {
    where.invoice = { branchId: branchScope.branchId };
  } else if (branchScope?.branchIds !== undefined) {
    where.invoice = { branchId: { in: branchScope.branchIds } };
  }

  const creditNotes = await tenantQuery(companyId, (tx) =>
    tx.creditNote.findMany({
      where,
      select: {
        id: true,
        creditNoteNumber: true,
        creditNoteDate: true,
        status: true,
        sellerRegistrationId: true,
        invoice: {
          select: {
            branchId: true,
          },
        },
      },
      orderBy: {
        creditNoteDate: 'asc',
      },
    })
  );

  return creditNotes
    .filter((cn) => cn.status && cn.status.trim().toUpperCase() !== 'DRAFT')
    .map((cn) => ({
      id: cn.id,
      documentNumber: cn.creditNoteNumber,
      documentDate: cn.creditNoteDate,
      status: cn.status,
      documentType: 'CREDIT_NOTE',
      sellerRegistrationId: cn.sellerRegistrationId ?? null,
      branchId: cn.invoice.branchId,
    }));
}

/**
 * G2g-4b — Loads this company's Sales (outward) Debit Notes for Table 13. Selects only
 * document-level attributes (own `branchId` directly — unlike CreditNote, no join needed) — never
 * SalesDebitNoteItem — ensuring zero row multiplication. Never loads the procurement-side
 * DebitNote table (section 15's explicit "exclude procurement DebitNotes" requirement — the
 * existing `debitNotes` property/table in this file's sibling functions is untouched by this
 * function, which only ever queries `salesDebitNote`). Excludes drafts defensively, even though
 * SalesDebitNote currently has no 'DRAFT' status value (createSalesDebitNote() always creates
 * 'ISSUED') — mirrors the other two Table 13 loaders' own defensive filter in case that ever changes.
 */
async function loadTable13SalesDebitNoteDocuments(
  companyId: string,
  gstRegistrationId: string,
  fromDate: Date,
  toDate: Date,
  branchScope?: { branchId?: string | null; branchIds?: string[] },
): Promise<Table13Document[]> {
  const where: Prisma.SalesDebitNoteWhereInput = {
    companyId,
    debitNoteDate: { gte: fromDate, lte: toDate },
    sellerRegistrationId: gstRegistrationId,
    status: { notIn: ['DRAFT', 'draft', 'Draft'] },
  };

  if (branchScope?.branchId) {
    where.branchId = branchScope.branchId;
  } else if (branchScope?.branchIds !== undefined) {
    where.branchId = { in: branchScope.branchIds };
  }

  const debitNotes = await tenantQuery(companyId, (tx) =>
    tx.salesDebitNote.findMany({
      where,
      select: {
        id: true,
        debitNoteNumber: true,
        debitNoteDate: true,
        status: true,
        sellerRegistrationId: true,
        branchId: true,
      },
      orderBy: {
        debitNoteDate: 'asc',
      },
    })
  );

  return debitNotes
    .filter((dn) => dn.status && dn.status.trim().toUpperCase() !== 'DRAFT')
    .map((dn) => toTable13SalesDebitNoteDocument(dn));
}

/**
 * G2g-3g-2 — GSTR-1 Table 13 (Documents Issued) Prisma reporting adapter.
 *
 * Sequence:
 * 1. Validate GST registration ownership (must belong to ctx.companyId)
 * 2. Validate branch accessibility (if branchId is specified, caller must have access)
 * 3. Resolve IST date range (Asia/Kolkata start-of-day / end-of-day)
 * 4. Load SalesInvoice and CreditNote records safely without row multiplication
 * 5. Aggregate documents via frozen pure engine (aggregateGstr1Table13)
 * 6. Return pure engine results plus adapter-level metadata
 */
export async function getGstr1Table13Report(
  ctx: TenantContext,
  params: GetGstr1Table13ReportParams,
): Promise<Gstr1Table13Report> {
  if (!params?.gstRegistrationId || typeof params.gstRegistrationId !== 'string') {
    throw new AppError('gstRegistrationId is required', 400);
  }
  if (!params.from || !params.to) {
    throw new AppError('Reporting period from and to dates are required', 400);
  }

  // 1. GST registration ownership check
  await assertOwnedByCompany('companyGstRegistration', params.gstRegistrationId, ctx.companyId, 'GST registration');

  // 2. Branch access check if an explicit branchId was requested
  if (params.branchId) {
    await assertBranchAccessible(params.branchId, ctx, 'Branch');
  }

  // 3. Resolve IST date boundaries
  const fromDate = typeof params.from === 'string' ? parseIstRangeStart(params.from) : params.from;
  const toDate = typeof params.to === 'string' ? parseIstRangeEnd(params.to) : params.to;

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    throw new AppError('Invalid date range provided', 400);
  }

  // 4. Resolve branch scoping
  let branchScope: { branchId?: string | null; branchIds?: string[] } | undefined;
  if (params.branchId) {
    branchScope = { branchId: params.branchId };
  } else if (ctx.branchAccess && !ctx.branchAccess.allBranches) {
    branchScope = { branchIds: ctx.branchAccess.branchIds };
  }

  // 5. Concurrently load documents
  const [salesDocuments, creditNoteDocuments, salesDebitNoteDocuments] = await Promise.all([
    loadTable13SalesDocuments(ctx.companyId, params.gstRegistrationId, fromDate, toDate, branchScope),
    loadTable13CreditNoteDocuments(ctx.companyId, params.gstRegistrationId, fromDate, toDate, branchScope),
    // G2g-4b: additive — a company with zero Sales Debit Notes gets an empty array here, and the
    // regression proving procurement DebitNotes stay excluded is unaffected (this loader only
    // ever queries the `salesDebitNote` table, never `debitNote`).
    loadTable13SalesDebitNoteDocuments(ctx.companyId, params.gstRegistrationId, fromDate, toDate, branchScope),
  ]);

  const allDocuments: Table13Document[] = [...salesDocuments, ...creditNoteDocuments, ...salesDebitNoteDocuments];

  // 6. Aggregate via frozen pure Table 13 engine
  const aggregation = aggregateGstr1Table13(allDocuments, {
    gstRegistrationId: params.gstRegistrationId,
    period: { from: fromDate, to: toDate },
    branchId: params.branchId ?? undefined,
  });

  // 7. Partial branch series metadata: true if branch-filtered or caller lacks full GSTIN-wide branch access
  const isPartialBranchSeries = Boolean(params.branchId) || (ctx.branchAccess ? !ctx.branchAccess.allBranches : false);

  const meta: Gstr1Table13ReportMeta = {
    gstRegistrationId: params.gstRegistrationId,
    period: { from: fromDate, to: toDate },
    branchId: params.branchId ?? null,
    isPartialBranchSeries,
    salesInvoicesConsidered: salesDocuments.length,
    creditNotesConsidered: creditNoteDocuments.length,
    salesDebitNotesConsidered: salesDebitNoteDocuments.length,
  };

  return {
    ...aggregation,
    meta,
  };
}

