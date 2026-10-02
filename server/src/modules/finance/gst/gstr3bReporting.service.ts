// G2g-7b — GSTR-3B Outward Tax Liability Reporting Integration Service.
// Connects the pure aggregation engine (gstr3bOutwardAggregation.ts) to the real tenant-scoped
// database.
//
// Responsibilities:
// - Tenant scoping and registration identity resolution
// - Date and period resolution (from/to or financialYear/taxPeriod with Asia/Kolkata boundary semantics)
// - Branch access validation
// - Loading source documents: SalesInvoice + TaxInvoice, CreditNote, SalesDebitNote, SalesReturn
// - Shape-adaptation into pure input contracts
// - Invoking aggregateGstr3bOutwardSupplies()

import { tenantQuery, type BranchAccess } from '../../../shared/tenantContext';
import { AppError } from '../../../middleware/error';
import { IST_OFFSET_MS } from '../../../shared/compliance';
import { getFinancialYearForDate, parseFinancialYear, isValidFinancialYear } from '../../../shared/financialYear';
import { parseIstRangeStart, parseIstRangeEnd } from '../../../shared/istDate';
import {
  aggregateGstr3bOutwardSupplies,
} from './gstr3bOutwardAggregation';
import type {
  Gstr3bOutwardSourceInvoice,
  Gstr3bOutwardSourceCreditNote,
  Gstr3bOutwardSourceSalesDebitNote,
  Gstr3bOutwardSourceSalesReturn,
  Gstr3bOutwardAggregationOptions,
  Gstr3bOutwardAggregationResult,
} from './gstr3bOutward.types';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Gstr3bReportScopeOptions {
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

export interface Gstr3bReportDateQuery {
  from?: string | Date;
  to?: string | Date;
  financialYear?: string;
  taxPeriod?: string;
}

/**
 * Derives filing period MMYYYY string anchored on terminal date in IST.
 */
export function resolveFilingPeriodMmYYYY(date: Date): string {
  const istShifted = new Date(date.getTime() + IST_OFFSET_MS);
  const mm = String(istShifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = istShifted.getUTCFullYear();
  return `${mm}${yyyy}`;
}

/**
 * Resolves Date boundaries (from, to), financialYear, and taxPeriod from query parameters.
 * Supports:
 * 1. Explicit `from` and `to` (ISO timestamp or YYYY-MM-DD date-only)
 * 2. `financialYear` ("2026-27") and `taxPeriod` ("092026" or "09")
 */
export function resolveGstr3bPeriod(query: Gstr3bReportDateQuery): {
  from: Date;
  to: Date;
  financialYear: string;
  taxPeriod: string;
} {
  // Option A: financialYear + taxPeriod provided
  if (query.taxPeriod?.trim()) {
    const rawPeriod = query.taxPeriod.trim();
    let monthNum: number;
    let yearNum: number;
    let fyStr = query.financialYear?.trim() ?? '';

    if (/^\d{6}$/.test(rawPeriod)) {
      // MMYYYY format, e.g. "092026"
      monthNum = parseInt(rawPeriod.slice(0, 2), 10);
      yearNum = parseInt(rawPeriod.slice(2, 6), 10);
      if (monthNum < 1 || monthNum > 12) {
        throw new AppError(`Invalid month in taxPeriod "${rawPeriod}". Expected MM between 01 and 12.`, 400);
      }
    } else if (/^\d{2}$/.test(rawPeriod) || /^\d{1}$/.test(rawPeriod)) {
      // MM format, e.g. "09" or "9"
      monthNum = parseInt(rawPeriod, 10);
      if (monthNum < 1 || monthNum > 12) {
        throw new AppError(`Invalid month in taxPeriod "${rawPeriod}". Expected MM between 01 and 12.`, 400);
      }
      if (!fyStr || !isValidFinancialYear(fyStr)) {
        throw new AppError(`financialYear in "YYYY-YY" format (e.g. "2026-27") is required when taxPeriod is month-only "${rawPeriod}".`, 400);
      }
      const { startYear, endYear } = parseFinancialYear(fyStr);
      yearNum = monthNum >= 4 ? startYear : endYear;
    } else {
      throw new AppError(`Invalid taxPeriod "${rawPeriod}". Expected "MMYYYY" (e.g. "092026") or "MM" (e.g. "09").`, 400);
    }

    // Month start in IST: 1st of month 00:00:00.000 IST
    const fromMs = Date.UTC(yearNum, monthNum - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS;
    // Month end in IST: last day of month 23:59:59.999 IST
    const lastDayOfMonth = new Date(Date.UTC(yearNum, monthNum, 0)).getUTCDate();
    const toMs = Date.UTC(yearNum, monthNum - 1, lastDayOfMonth, 23, 59, 59, 999) - IST_OFFSET_MS;

    const from = new Date(fromMs);
    const to = new Date(toMs);

    if (!fyStr) {
      fyStr = getFinancialYearForDate(to);
    }
    const mmStr = String(monthNum).padStart(2, '0');
    const taxPeriod = `${mmStr}${yearNum}`;

    return { from, to, financialYear: fyStr, taxPeriod };
  }

  // Option B: from and to provided
  if (query.from && query.to) {
    const from = query.from instanceof Date ? query.from : parseIstRangeStart(query.from);
    const to = query.to instanceof Date ? query.to : parseIstRangeEnd(query.to);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new AppError('Invalid date format for "from" or "to".', 400);
    }
    if (from > to) {
      throw new AppError('"from" date cannot be after "to" date.', 400);
    }

    const financialYear = query.financialYear && isValidFinancialYear(query.financialYear)
      ? query.financialYear
      : getFinancialYearForDate(to);
    const taxPeriod = resolveFilingPeriodMmYYYY(to);

    return { from, to, financialYear, taxPeriod };
  }

  throw new AppError('Either ("financialYear" + "taxPeriod") or ("from" + "to") parameters are required.', 400);
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Loaders
// ─────────────────────────────────────────────────────────────────────────────

async function loadInvoices(companyId: string, from: Date, to: Date): Promise<Gstr3bOutwardSourceInvoice[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.salesInvoice.findMany({
      where: { companyId, invoiceDate: { gte: from, lte: to } },
      select: {
        id: true,
        invoiceNumber: true,
        invoiceDate: true,
        status: true,
        branchId: true,
        totalAmount: true,
        otherCharges: true,
        taxDetails: {
          select: {
            buyerGstin: true,
            placeOfSupply: true,
            sellerStateCode: true,
            sellerRegistrationId: true,
            taxableAmount: true,
            cgst: true,
            sgst: true,
            igst: true,
            cess: true,
            totalTax: true,
            reverseCharge: true,
          },
        },
        _count: { select: { items: true } },
      },
    })
  );

  return rows.map((inv) => ({
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    status: inv.status,
    branchId: inv.branchId,
    totalAmount: Number(inv.totalAmount),
    otherCharges: Number(inv.otherCharges),
    taxDetails: inv.taxDetails
      ? {
          buyerGstin: inv.taxDetails.buyerGstin,
          placeOfSupply: inv.taxDetails.placeOfSupply,
          sellerStateCode: inv.taxDetails.sellerStateCode,
          sellerRegistrationId: inv.taxDetails.sellerRegistrationId,
          taxableAmount: Number(inv.taxDetails.taxableAmount),
          cgst: Number(inv.taxDetails.cgst),
          sgst: Number(inv.taxDetails.sgst),
          igst: Number(inv.taxDetails.igst),
          cess: Number(inv.taxDetails.cess),
          totalTax: Number(inv.taxDetails.totalTax),
          reverseCharge: inv.taxDetails.reverseCharge,
        }
      : null,
    itemsCount: inv._count.items,
  }));
}

async function loadCreditNotes(companyId: string, from: Date, to: Date): Promise<Gstr3bOutwardSourceCreditNote[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.creditNote.findMany({
      where: { companyId, creditNoteDate: { gte: from, lte: to } },
      select: {
        id: true,
        creditNoteNumber: true,
        creditNoteDate: true,
        status: true,
        invoiceId: true,
        salesReturnId: true,
        sellerRegistrationId: true,
        sellerStateCode: true,
        buyerGstin: true,
        placeOfSupply: true,
        taxableAmount: true,
        cgst: true,
        sgst: true,
        igst: true,
        totalTax: true,
        totalAmount: true,
        invoice: { select: { branchId: true } },
      },
    })
  );

  return rows.map((cn) => ({
    id: cn.id,
    creditNoteNumber: cn.creditNoteNumber,
    creditNoteDate: cn.creditNoteDate,
    status: cn.status,
    branchId: cn.invoice.branchId,
    invoiceId: cn.invoiceId,
    salesReturnId: cn.salesReturnId,
    sellerRegistrationId: cn.sellerRegistrationId,
    sellerStateCode: cn.sellerStateCode,
    buyerGstin: cn.buyerGstin,
    placeOfSupply: cn.placeOfSupply,
    taxableAmount: Number(cn.taxableAmount),
    cgst: Number(cn.cgst),
    sgst: Number(cn.sgst),
    igst: Number(cn.igst),
    cess: 0,
    totalTax: Number(cn.totalTax),
    totalAmount: Number(cn.totalAmount),
  }));
}

async function loadSalesDebitNotes(companyId: string, from: Date, to: Date): Promise<Gstr3bOutwardSourceSalesDebitNote[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.salesDebitNote.findMany({
      where: { companyId, debitNoteDate: { gte: from, lte: to } },
      select: {
        id: true,
        debitNoteNumber: true,
        debitNoteDate: true,
        status: true,
        branchId: true,
        invoiceId: true,
        sellerRegistrationId: true,
        sellerStateCode: true,
        buyerGstin: true,
        placeOfSupply: true,
        taxableAmount: true,
        cgst: true,
        sgst: true,
        igst: true,
        cess: true,
        totalTax: true,
        totalAmount: true,
      },
    })
  );

  return rows.map((dn) => ({
    id: dn.id,
    debitNoteNumber: dn.debitNoteNumber,
    debitNoteDate: dn.debitNoteDate,
    status: dn.status,
    branchId: dn.branchId,
    invoiceId: dn.invoiceId,
    sellerRegistrationId: dn.sellerRegistrationId,
    sellerStateCode: dn.sellerStateCode,
    buyerGstin: dn.buyerGstin,
    placeOfSupply: dn.placeOfSupply,
    taxableAmount: Number(dn.taxableAmount),
    cgst: Number(dn.cgst),
    sgst: Number(dn.sgst),
    igst: Number(dn.igst),
    cess: Number(dn.cess),
    totalTax: Number(dn.totalTax),
    totalAmount: Number(dn.totalAmount),
  }));
}

async function loadSalesReturns(companyId: string, from: Date, to: Date): Promise<Gstr3bOutwardSourceSalesReturn[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.salesReturn.findMany({
      where: { companyId, returnDate: { gte: from, lte: to } },
      select: {
        id: true,
        returnNumber: true,
        returnDate: true,
        totalAmount: true,
        invoiceId: true,
        creditNote: { select: { id: true } },
        invoice: {
          select: {
            branchId: true,
            taxDetails: {
              select: {
                sellerRegistrationId: true,
                sellerStateCode: true,
                buyerGstin: true,
                placeOfSupply: true,
                cgst: true,
              },
            },
            items: {
              select: {
                id: true,
                taxRate: true,
              },
            },
          },
        },
        items: {
          select: {
            invoiceItemId: true,
            amount: true,
          },
        },
      },
    })
  );

  return rows.map((ret) => {
    const taxDetails = ret.invoice.taxDetails;
    const isSameState = !!taxDetails && Number(taxDetails.cgst) > 0;
    const lineRateMap = new Map(ret.invoice.items.map((i) => [i.id, Number(i.taxRate)]));

    let retTaxable = 0;
    let retTax = 0;

    for (const item of ret.items) {
      const lineTaxRate = taxDetails ? (lineRateMap.get(item.invoiceItemId) ?? 0) : 0;
      const amt = Number(item.amount);
      const rev = lineTaxRate > 0 ? amt / (1 + lineTaxRate) : amt;
      const tax = amt - rev;
      retTaxable = round2(retTaxable + rev);
      retTax = round2(retTax + tax);
    }

    const cgst = isSameState ? round2(retTax / 2) : 0;
    const sgst = isSameState ? round2(retTax / 2) : 0;
    const igst = isSameState ? 0 : retTax;

    return {
      id: ret.id,
      returnNumber: ret.returnNumber,
      returnDate: ret.returnDate,
      branchId: ret.invoice.branchId,
      invoiceId: ret.invoiceId,
      sellerRegistrationId: taxDetails?.sellerRegistrationId ?? null,
      sellerStateCode: taxDetails?.sellerStateCode ?? null,
      buyerGstin: taxDetails?.buyerGstin ?? null,
      placeOfSupply: taxDetails?.placeOfSupply ?? null,
      totalAmount: Number(ret.totalAmount),
      taxableAmount: retTaxable,
      cgst,
      sgst,
      igst,
      cess: 0,
      creditNoteId: ret.creditNote?.id ?? null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Service API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the GSTR-3B Outward Tax Liability Report.
 * Loads this company's invoices, credit notes, sales debit notes, and sales returns for the period
 * and aggregates them using the pure aggregateGstr3bOutwardSupplies engine.
 */
export async function getGstr3bOutwardReport(
  companyId: string,
  gstRegistrationId: string,
  dateQuery: Gstr3bReportDateQuery,
  opts?: Gstr3bReportScopeOptions,
): Promise<Gstr3bOutwardAggregationResult> {
  // 1. Validate registration ownership
  const registration = await tenantQuery(companyId, (tx) =>
    tx.companyGstRegistration.findFirst({
      where: { id: gstRegistrationId, companyId, isActive: true },
      select: { id: true, gstin: true, stateCode: true, legalName: true },
    })
  );

  if (!registration) {
    throw new AppError('GST registration not found or does not belong to this company.', 404);
  }

  // 2. Resolve Period
  const period = resolveGstr3bPeriod(dateQuery);

  // 3. Load all candidate source rows concurrently
  const [invoices, creditNotes, salesDebitNotes, salesReturns] = await Promise.all([
    loadInvoices(companyId, period.from, period.to),
    loadCreditNotes(companyId, period.from, period.to),
    loadSalesDebitNotes(companyId, period.from, period.to),
    loadSalesReturns(companyId, period.from, period.to),
  ]);

  // 4. Construct Aggregation Options
  const aggregationOptions: Gstr3bOutwardAggregationOptions = {
    companyId,
    gstRegistrationId,
    sellerGstin: registration.gstin,
    sellerStateCode: registration.stateCode,
    period,
    branchAccess: opts?.branchAccess,
    branchId: opts?.branchId,
  };

  // 5. Run Pure Aggregation Engine
  return aggregateGstr3bOutwardSupplies(
    invoices,
    creditNotes,
    salesDebitNotes,
    salesReturns,
    aggregationOptions,
  );
}
