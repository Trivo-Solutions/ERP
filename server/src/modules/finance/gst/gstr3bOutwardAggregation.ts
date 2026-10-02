// G2g-7b — GSTR-3B Outward Tax Liability Pure Aggregation Engine.
// Pure, deterministic, side-effect free: no Prisma, no Date.now(), no HTTP imports.
// Aggregates outward taxable supplies for Table 3.1(a) and Table 3.2 (unregistered persons).
//
// Statutory references:
// - CBIC Circular No. 170/02/2022-GST (Clarification on Table 3.1 and Table 3.2 reporting)
// - CGST Act Section 34 (Credit Notes & Debit Notes)
// - Rule 61 of CGST Rules, 2017 (GSTR-3B filing)

import type { BranchAccess } from '../../../shared/tenantContext';
import type {
  Gstr3bOutwardSourceInvoice,
  Gstr3bOutwardSourceCreditNote,
  Gstr3bOutwardSourceSalesDebitNote,
  Gstr3bOutwardSourceSalesReturn,
  Gstr3bOutwardAggregationOptions,
  Gstr3bOutwardAggregationResult,
  Gstr3bDiagnostic,
  Gstr3bMoneyTotals,
  Gstr3bTable32UnregisteredEntry,
} from './gstr3bOutward.types';

const round2 = (n: number): number => Math.round(n * 100) / 100;

// Conservative 15-character GSTIN format regex (reused across TRIVO)
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

export class Gstr3bAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr3bAggregationError';
  }
}

/**
 * Resolves allowed branch IDs from caller's branch access and explicitly requested branchId.
 */
function resolveAllowedBranchIds(branchAccess: BranchAccess | undefined, branchId: string | null | undefined): string[] | undefined {
  if (branchId?.trim()) {
    return [branchId.trim()];
  }
  if (branchAccess && !branchAccess.allBranches) {
    return branchAccess.branchIds;
  }
  return undefined;
}

/**
 * Normalizes state code / POS string to 2-digit code if available.
 */
function normalizeStateCode(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // If it's already 2 digits, keep it
  if (/^\d{2}$/.test(trimmed)) return trimmed;
  // If it has leading zeros or 2 digits followed by letters, handle gently
  const match = trimmed.match(/^(\d{2})/);
  if (match) return match[1];
  return trimmed.toUpperCase();
}

/**
 * Pure aggregation function for GSTR-3B outward tax liability.
 */
export function aggregateGstr3bOutwardSupplies(
  invoices: Gstr3bOutwardSourceInvoice[],
  creditNotes: Gstr3bOutwardSourceCreditNote[],
  salesDebitNotes: Gstr3bOutwardSourceSalesDebitNote[],
  salesReturns: Gstr3bOutwardSourceSalesReturn[],
  options: Gstr3bOutwardAggregationOptions,
): Gstr3bOutwardAggregationResult {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr3bAggregationError('A single seller GST registration ID is required before aggregating GSTR-3B outward supplies.');
  }

  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;
  const sellerStateCode = normalizeStateCode(options.sellerStateCode);

  const diagnostics: Gstr3bDiagnostic[] = [];

  // Branch scope evaluation
  const isBranchRestricted = !!options.branchId || (options.branchAccess && !options.branchAccess.allBranches);
  const isCompleteGstinScope = !isBranchRestricted;
  const partialScopeReason = isBranchRestricted ? 'PARTIAL_BRANCH_SCOPE' : null;

  if (isBranchRestricted) {
    diagnostics.push({
      code: 'PARTIAL_BRANCH_SCOPE',
      documentType: 'REPORT_SCOPE',
      reason: `Report scope is restricted to branch ${options.branchId ?? 'subset'} and does not constitute a complete GSTIN-wide statutory GSTR-3B return.`,
    });
  }

  // Counters
  let invoicesConsidered = 0;
  let invoicesExcludedByScope = 0;
  let creditNotesConsidered = 0;
  let creditNotesExcludedByScope = 0;
  let salesDebitNotesConsidered = 0;
  let salesDebitNotesExcludedByScope = 0;
  let salesReturnsConsidered = 0;
  let salesReturnsExcludedByScope = 0;

  let activeInvoicesCount = 0;
  let voidInvoicesCount = 0;
  let salesDebitNotesCount = 0;
  let cancelledSalesDebitNotesCount = 0;
  let pathACreditNotesCount = 0;
  let pathBStandaloneCreditNotesCount = 0;
  let cancelledCreditNotesCount = 0;
  let unwrappedSalesReturnsCount = 0;
  let deduplicatedSalesReturnsCount = 0;

  let invoiceCountWithOtherCharges = 0;
  let totalOtherChargesTaxable = 0;

  // Accumulators for Table 3.1(a)
  let grossTaxable = 0;
  let grossCgst = 0;
  let grossSgst = 0;
  let grossIgst = 0;
  let grossCess = 0;

  const creditNoteReductions: Gstr3bMoneyTotals = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const salesReturnReductions: Gstr3bMoneyTotals = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const salesDebitNoteAdditions: Gstr3bMoneyTotals = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };

  // Table 3.2 Unregistered supplies by POS
  const table32ByPos = new Map<string, {
    placeOfSupply: string;
    stateName: string | null;
    taxableValue: number;
    igst: number;
    counts: { invoices: number; salesDebitNotes: number; creditNotes: number; unwrappedSalesReturns: number };
  }>();

  function getOrCreateTable32Entry(pos: string) {
    let entry = table32ByPos.get(pos);
    if (!entry) {
      entry = {
        placeOfSupply: pos,
        stateName: null,
        taxableValue: 0,
        igst: 0,
        counts: { invoices: 0, salesDebitNotes: 0, creditNotes: 0, unwrappedSalesReturns: 0 },
      };
      table32ByPos.set(pos, entry);
    }
    return entry;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Process Positive Invoices
  // ─────────────────────────────────────────────────────────────────────────────
  for (const inv of invoices) {
    const invSellerReg = inv.taxDetails?.sellerRegistrationId?.trim() ?? null;
    if (invSellerReg && invSellerReg !== gstRegistrationId) {
      invoicesExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!inv.branchId || !allowedBranchIds.includes(inv.branchId))) {
      invoicesExcludedByScope++;
      continue;
    }

    const invDate = inv.invoiceDate instanceof Date && !Number.isNaN(inv.invoiceDate.getTime()) ? inv.invoiceDate : null;
    if (invDate && (invDate < from || invDate > to)) {
      invoicesExcludedByScope++;
      continue;
    }

    invoicesConsidered++;

    if (!invSellerReg) {
      diagnostics.push({
        code: 'MISSING_SELLER_REGISTRATION',
        documentType: 'INVOICE',
        documentId: inv.invoiceId,
        documentNumber: inv.invoiceNumber,
        reason: `Sales invoice ${inv.invoiceNumber} has no sellerRegistrationId and cannot be safely attributed to GST registration ${gstRegistrationId}.`,
      });
      continue;
    }

    if (inv.status === 'VOID') {
      voidInvoicesCount++;
      diagnostics.push({
        code: 'EXCLUDED_VOID',
        documentType: 'INVOICE',
        documentId: inv.invoiceId,
        documentNumber: inv.invoiceNumber,
        reason: `Sales invoice ${inv.invoiceNumber} is marked VOID and is excluded from outward tax liability.`,
      });
      continue;
    }

    if (!inv.taxDetails) {
      diagnostics.push({
        code: 'MISSING_TAX_INVOICE',
        documentType: 'INVOICE',
        documentId: inv.invoiceId,
        documentNumber: inv.invoiceNumber,
        reason: `Sales invoice ${inv.invoiceNumber} has no taxDetails (TaxInvoice) snapshot and cannot contribute to GSTR-3B tax liability.`,
      });
      continue;
    }

    activeInvoicesCount++;

    const taxable = round2(inv.taxDetails.taxableAmount);
    const cgst = round2(inv.taxDetails.cgst);
    const sgst = round2(inv.taxDetails.sgst);
    const igst = round2(inv.taxDetails.igst);
    const cess = round2(inv.taxDetails.cess);

    grossTaxable = round2(grossTaxable + taxable);
    grossCgst = round2(grossCgst + cgst);
    grossSgst = round2(grossSgst + sgst);
    grossIgst = round2(grossIgst + igst);
    grossCess = round2(grossCess + cess);

    if (inv.otherCharges > 0) {
      invoiceCountWithOtherCharges++;
      totalOtherChargesTaxable = round2(totalOtherChargesTaxable + inv.otherCharges);
      diagnostics.push({
        code: 'OUTWARD_OTHER_CHARGES_INCLUDED',
        documentType: 'INVOICE',
        documentId: inv.invoiceId,
        documentNumber: inv.invoiceNumber,
        reason: `Sales invoice ${inv.invoiceNumber} includes otherCharges of ₹${inv.otherCharges} in taxable amount and tax totals.`,
        amountDetails: { otherCharges: inv.otherCharges },
      });
    }

    // Table 3.2 check: Inter-State supplies to unregistered persons
    const buyerGstin = inv.taxDetails.buyerGstin?.trim().toUpperCase();
    const pos = normalizeStateCode(inv.taxDetails.placeOfSupply);

    if (buyerGstin) {
      if (!GSTIN_FORMAT.test(buyerGstin)) {
        diagnostics.push({
          code: 'INVALID_BUYER_GSTIN',
          documentType: 'INVOICE',
          documentId: inv.invoiceId,
          documentNumber: inv.invoiceNumber,
          reason: `Buyer GSTIN "${buyerGstin}" on invoice ${inv.invoiceNumber} does not match 15-character GSTIN format — cannot be safely classified as unregistered for Table 3.2.`,
        });
      }
      // Registered customer: excluded from Table 3.2
    } else {
      // Unregistered customer: check inter-State condition
      if (pos && sellerStateCode && pos !== sellerStateCode) {
        const entry = getOrCreateTable32Entry(pos);
        entry.taxableValue = round2(entry.taxableValue + taxable);
        entry.igst = round2(entry.igst + igst);
        entry.counts.invoices++;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Process Sales Debit Notes (Positive Outward Adjustment)
  // ─────────────────────────────────────────────────────────────────────────────
  for (const dn of salesDebitNotes) {
    const dnSellerReg = dn.sellerRegistrationId?.trim() ?? null;
    if (dnSellerReg && dnSellerReg !== gstRegistrationId) {
      salesDebitNotesExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!dn.branchId || !allowedBranchIds.includes(dn.branchId))) {
      salesDebitNotesExcludedByScope++;
      continue;
    }

    const dnDate = dn.debitNoteDate instanceof Date && !Number.isNaN(dn.debitNoteDate.getTime()) ? dn.debitNoteDate : null;
    if (dnDate && (dnDate < from || dnDate > to)) {
      salesDebitNotesExcludedByScope++;
      continue;
    }

    salesDebitNotesConsidered++;

    if (!dnSellerReg) {
      diagnostics.push({
        code: 'MISSING_SELLER_REGISTRATION',
        documentType: 'SALES_DEBIT_NOTE',
        documentId: dn.id,
        documentNumber: dn.debitNoteNumber,
        reason: `Sales debit note ${dn.debitNoteNumber} has no sellerRegistrationId and cannot be attributed to registration ${gstRegistrationId}.`,
      });
      continue;
    }

    if (dn.status === 'CANCELLED') {
      cancelledSalesDebitNotesCount++;
      diagnostics.push({
        code: 'EXCLUDED_CANCELLED',
        documentType: 'SALES_DEBIT_NOTE',
        documentId: dn.id,
        documentNumber: dn.debitNoteNumber,
        reason: `Sales debit note ${dn.debitNoteNumber} is CANCELLED and is excluded from outward tax liability.`,
      });
      continue;
    }

    salesDebitNotesCount++;

    const taxable = round2(dn.taxableAmount);
    const cgst = round2(dn.cgst);
    const sgst = round2(dn.sgst);
    const igst = round2(dn.igst);
    const cess = round2(dn.cess);

    salesDebitNoteAdditions.taxableValue = round2(salesDebitNoteAdditions.taxableValue + taxable);
    salesDebitNoteAdditions.cgst = round2(salesDebitNoteAdditions.cgst + cgst);
    salesDebitNoteAdditions.sgst = round2(salesDebitNoteAdditions.sgst + sgst);
    salesDebitNoteAdditions.igst = round2(salesDebitNoteAdditions.igst + igst);
    salesDebitNoteAdditions.cess = round2(salesDebitNoteAdditions.cess + cess);

    // Table 3.2 check: Inter-State debit note to unregistered person
    const buyerGstin = dn.buyerGstin?.trim().toUpperCase();
    const pos = normalizeStateCode(dn.placeOfSupply);

    if (buyerGstin) {
      if (!GSTIN_FORMAT.test(buyerGstin)) {
        diagnostics.push({
          code: 'INVALID_BUYER_GSTIN',
          documentType: 'SALES_DEBIT_NOTE',
          documentId: dn.id,
          documentNumber: dn.debitNoteNumber,
          reason: `Buyer GSTIN "${buyerGstin}" on debit note ${dn.debitNoteNumber} is invalid — excluded from Table 3.2.`,
        });
      }
    } else if (pos && sellerStateCode && pos !== sellerStateCode) {
      const entry = getOrCreateTable32Entry(pos);
      entry.taxableValue = round2(entry.taxableValue + taxable);
      entry.igst = round2(entry.igst + igst);
      entry.counts.salesDebitNotes++;
    }
  }

  // Track credited salesReturnIds to prevent double counting with Path A Credit Notes
  const creditedSalesReturnIds = new Set<string>();

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Process Credit Notes (Negative Outward Adjustment)
  // ─────────────────────────────────────────────────────────────────────────────
  for (const cn of creditNotes) {
    const cnSellerReg = cn.sellerRegistrationId?.trim() ?? null;
    if (cnSellerReg && cnSellerReg !== gstRegistrationId) {
      creditNotesExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!cn.branchId || !allowedBranchIds.includes(cn.branchId))) {
      creditNotesExcludedByScope++;
      continue;
    }

    const cnDate = cn.creditNoteDate instanceof Date && !Number.isNaN(cn.creditNoteDate.getTime()) ? cn.creditNoteDate : null;
    if (cnDate && (cnDate < from || cnDate > to)) {
      creditNotesExcludedByScope++;
      continue;
    }

    creditNotesConsidered++;

    if (!cnSellerReg) {
      diagnostics.push({
        code: 'MISSING_SELLER_REGISTRATION',
        documentType: 'CREDIT_NOTE',
        documentId: cn.id,
        documentNumber: cn.creditNoteNumber,
        reason: `Credit note ${cn.creditNoteNumber} has no sellerRegistrationId and cannot be attributed to registration ${gstRegistrationId}.`,
      });
      continue;
    }

    if (cn.status === 'CANCELLED') {
      cancelledCreditNotesCount++;
      diagnostics.push({
        code: 'EXCLUDED_CANCELLED',
        documentType: 'CREDIT_NOTE',
        documentId: cn.id,
        documentNumber: cn.creditNoteNumber,
        reason: `Credit note ${cn.creditNoteNumber} is CANCELLED and is excluded from outward tax liability reduction.`,
      });
      continue;
    }

    if (cn.salesReturnId) {
      pathACreditNotesCount++;
      creditedSalesReturnIds.add(cn.salesReturnId);
    } else {
      pathBStandaloneCreditNotesCount++;
    }

    const taxable = round2(cn.taxableAmount);
    const cgst = round2(cn.cgst);
    const sgst = round2(cn.sgst);
    const igst = round2(cn.igst);
    const cess = round2(cn.cess);

    creditNoteReductions.taxableValue = round2(creditNoteReductions.taxableValue + taxable);
    creditNoteReductions.cgst = round2(creditNoteReductions.cgst + cgst);
    creditNoteReductions.sgst = round2(creditNoteReductions.sgst + sgst);
    creditNoteReductions.igst = round2(creditNoteReductions.igst + igst);
    creditNoteReductions.cess = round2(creditNoteReductions.cess + cess);

    // Table 3.2 check: Inter-State credit note to unregistered person reduces Table 3.2
    const buyerGstin = cn.buyerGstin?.trim().toUpperCase();
    const pos = normalizeStateCode(cn.placeOfSupply);

    if (buyerGstin) {
      if (!GSTIN_FORMAT.test(buyerGstin)) {
        diagnostics.push({
          code: 'INVALID_BUYER_GSTIN',
          documentType: 'CREDIT_NOTE',
          documentId: cn.id,
          documentNumber: cn.creditNoteNumber,
          reason: `Buyer GSTIN "${buyerGstin}" on credit note ${cn.creditNoteNumber} is invalid — excluded from Table 3.2.`,
        });
      }
    } else if (pos && sellerStateCode && pos !== sellerStateCode) {
      const entry = getOrCreateTable32Entry(pos);
      entry.taxableValue = round2(entry.taxableValue - taxable);
      entry.igst = round2(entry.igst - igst);
      entry.counts.creditNotes++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Process Sales Returns (Deduplicated against Path A Credit Notes)
  // ─────────────────────────────────────────────────────────────────────────────
  for (const ret of salesReturns) {
    const retSellerReg = ret.sellerRegistrationId?.trim() ?? null;
    if (retSellerReg && retSellerReg !== gstRegistrationId) {
      salesReturnsExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!ret.branchId || !allowedBranchIds.includes(ret.branchId))) {
      salesReturnsExcludedByScope++;
      continue;
    }

    const retDate = ret.returnDate instanceof Date && !Number.isNaN(ret.returnDate.getTime()) ? ret.returnDate : null;
    if (retDate && (retDate < from || retDate > to)) {
      salesReturnsExcludedByScope++;
      continue;
    }

    salesReturnsConsidered++;

    if (!retSellerReg) {
      diagnostics.push({
        code: 'MISSING_SELLER_REGISTRATION',
        documentType: 'SALES_RETURN',
        documentId: ret.id,
        documentNumber: ret.returnNumber,
        reason: `Sales return ${ret.returnNumber} originates from an invoice with no sellerRegistrationId and cannot be attributed to registration ${gstRegistrationId}.`,
      });
      continue;
    }

    // Deduplication check: Is this SalesReturn wrapped by a Path A Credit Note?
    const isWrapped = !!ret.creditNoteId || creditedSalesReturnIds.has(ret.id);
    if (isWrapped) {
      deduplicatedSalesReturnsCount++;
      diagnostics.push({
        code: 'SALES_RETURN_WRAPPED_BY_CREDIT_NOTE',
        documentType: 'SALES_RETURN',
        documentId: ret.id,
        documentNumber: ret.returnNumber,
        reason: `Sales return ${ret.returnNumber} is already represented by Credit Note ${ret.creditNoteId ?? 'in period'} and is not double-counted in GSTR-3B.`,
      });
      continue;
    }

    // Unwrapped Sales Return (no credit note issued)
    unwrappedSalesReturnsCount++;
    diagnostics.push({
      code: 'UNWRAPPED_SALES_RETURN_NO_CREDIT_NOTE',
      documentType: 'SALES_RETURN',
      documentId: ret.id,
      documentNumber: ret.returnNumber,
      reason: `Sales return ${ret.returnNumber} has no formal GST Credit Note issued under Section 34. Reducing liability based on return journal amounts.`,
    });

    const taxable = round2(ret.taxableAmount);
    const cgst = round2(ret.cgst);
    const sgst = round2(ret.sgst);
    const igst = round2(ret.igst);
    const cess = round2(ret.cess);

    salesReturnReductions.taxableValue = round2(salesReturnReductions.taxableValue + taxable);
    salesReturnReductions.cgst = round2(salesReturnReductions.cgst + cgst);
    salesReturnReductions.sgst = round2(salesReturnReductions.sgst + sgst);
    salesReturnReductions.igst = round2(salesReturnReductions.igst + igst);
    salesReturnReductions.cess = round2(salesReturnReductions.cess + cess);

    // Table 3.2 check: Inter-State unwrapped sales return to unregistered person
    const buyerGstin = ret.buyerGstin?.trim().toUpperCase();
    const pos = normalizeStateCode(ret.placeOfSupply);

    if (!buyerGstin && pos && sellerStateCode && pos !== sellerStateCode) {
      const entry = getOrCreateTable32Entry(pos);
      entry.taxableValue = round2(entry.taxableValue - taxable);
      entry.igst = round2(entry.igst - igst);
      entry.counts.unwrappedSalesReturns++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Final Net Totals Calculation for Table 3.1(a)
  // ─────────────────────────────────────────────────────────────────────────────
  const netTaxable = round2(
    grossTaxable + salesDebitNoteAdditions.taxableValue - creditNoteReductions.taxableValue - salesReturnReductions.taxableValue
  );
  const netCgst = round2(
    grossCgst + salesDebitNoteAdditions.cgst - creditNoteReductions.cgst - salesReturnReductions.cgst
  );
  const netSgst = round2(
    grossSgst + salesDebitNoteAdditions.sgst - creditNoteReductions.sgst - salesReturnReductions.sgst
  );
  const netIgst = round2(
    grossIgst + salesDebitNoteAdditions.igst - creditNoteReductions.igst - salesReturnReductions.igst
  );
  const netCess = round2(
    grossCess + salesDebitNoteAdditions.cess - creditNoteReductions.cess - salesReturnReductions.cess
  );

  if (netTaxable < 0) {
    diagnostics.push({
      code: 'NEGATIVE_NET_TAXABLE_LIABILITY',
      documentType: 'REPORT_SCOPE',
      reason: `Net outward taxable value is negative (₹${netTaxable}) due to credit notes/returns exceeding gross supplies in this period.`,
      amountDetails: { netTaxableValue: netTaxable },
    });
  }

  if (netCgst < 0 || netSgst < 0 || netIgst < 0 || netCess < 0) {
    diagnostics.push({
      code: 'NEGATIVE_NET_TAX_LIABILITY',
      documentType: 'REPORT_SCOPE',
      reason: `One or more net tax liability fields are negative (CGST: ₹${netCgst}, SGST: ₹${netSgst}, IGST: ₹${netIgst}, Cess: ₹${netCess}).`,
      amountDetails: { cgst: netCgst, sgst: netSgst, igst: netIgst, cess: netCess },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Final Table 3.2 Rollup
  // ─────────────────────────────────────────────────────────────────────────────
  const table32Supplies: Gstr3bTable32UnregisteredEntry[] = Array.from(table32ByPos.values())
    .map((e) => ({
      placeOfSupply: e.placeOfSupply,
      stateName: e.stateName,
      taxableValue: round2(e.taxableValue),
      igst: round2(e.igst),
      documentCounts: { ...e.counts },
    }))
    .sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply));

  const table32TotalTaxable = round2(table32Supplies.reduce((acc, s) => acc + s.taxableValue, 0));
  const table32TotalIgst = round2(table32Supplies.reduce((acc, s) => acc + s.igst, 0));

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Assemble Complete GSTR-3B Result
  // ─────────────────────────────────────────────────────────────────────────────
  return {
    meta: {
      companyId: options.companyId,
      gstRegistrationId,
      sellerGstin: options.sellerGstin,
      sellerStateCode: options.sellerStateCode,
      financialYear: options.period.financialYear,
      taxPeriod: options.period.taxPeriod,
      period: {
        from: options.period.from,
        to: options.period.to,
      },
      isCompleteGstinScope,
      partialScopeReason,
      otherChargesBreakdown: {
        invoiceCountWithOtherCharges,
        totalOtherChargesTaxable,
      },
      sourceCounts: {
        invoicesConsidered,
        invoicesExcludedByScope,
        creditNotesConsidered,
        creditNotesExcludedByScope,
        salesDebitNotesConsidered,
        salesDebitNotesExcludedByScope,
        salesReturnsConsidered,
        salesReturnsExcludedByScope,
      },
    },
    table31: {
      table31a: {
        status: 'IMPLEMENTED',
        taxableValue: netTaxable,
        cgst: netCgst,
        sgst: netSgst,
        igst: netIgst,
        cess: netCess,
        grossTaxableValue: grossTaxable,
        grossCgst,
        grossSgst,
        grossIgst,
        grossCess,
        creditNoteReductions,
        salesReturnReductions,
        salesDebitNoteAdditions,
        documentCounts: {
          activeInvoices: activeInvoicesCount,
          salesDebitNotes: salesDebitNotesCount,
          pathBStandaloneCreditNotes: pathBStandaloneCreditNotesCount,
          pathACreditNotes: pathACreditNotesCount,
          unwrappedSalesReturns: unwrappedSalesReturnsCount,
          deduplicatedSalesReturns: deduplicatedSalesReturnsCount,
          voidInvoices: voidInvoicesCount,
          cancelledCreditNotes: cancelledCreditNotesCount,
          cancelledSalesDebitNotes: cancelledSalesDebitNotesCount,
        },
      },
      table31b: {
        status: 'UNSUPPORTED',
        reason: 'ZERO_RATED_SUPPLIES_UNSUPPORTED',
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
      },
      table31c: {
        status: 'UNSUPPORTED',
        reason: 'NIL_RATED_EXEMPT_SALES_UNSUPPORTED',
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
      },
      table31d: {
        status: 'UNSUPPORTED',
        reason: 'INWARD_RCM_EXCLUDED_IN_G2G7B',
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
      },
      table31e: {
        status: 'UNSUPPORTED',
        reason: 'NON_GST_OUTWARD_UNSUPPORTED',
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
      },
      table311: {
        status: 'UNSUPPORTED',
        reason: 'SECTION_9_5_ECO_SUPPLIES_UNSUPPORTED',
        taxableValue: 0,
        igst: 0,
        cgst: 0,
        sgst: 0,
        cess: 0,
      },
    },
    table32: {
      unregisteredPersons: {
        status: 'IMPLEMENTED',
        totalTaxableValue: table32TotalTaxable,
        totalIgst: table32TotalIgst,
        supplies: table32Supplies,
      },
      compositionPersons: {
        status: 'UNSUPPORTED',
        reason: 'CLIENT_COMPOSITION_CLASSIFICATION_UNAVAILABLE',
        totalTaxableValue: 0,
        totalIgst: 0,
        supplies: [],
      },
      uinHolders: {
        status: 'UNSUPPORTED',
        reason: 'CLIENT_UIN_CLASSIFICATION_UNAVAILABLE',
        totalTaxableValue: 0,
        totalIgst: 0,
        supplies: [],
      },
    },
    diagnostics,
  };
}
