// G2g-7d — GSTR-3B Table 3.1(d) (RCM liability) & Table 4(A)(3) (RCM ITC) Pure Aggregation Engine.
// Pure, deterministic, side-effect free: no Prisma, no Date.now(), no HTTP imports.
// Parallel to (and never modifying) gstr3bItcAggregation.ts (G2g-7c, frozen, Table 4(A)(5)) — RCM
// liability/ITC is kept in its own separate tables here, never merged into G2g-7c's domestic
// bucket (brief §18/§20).
//
// NOT a complete GSTR-3B RCM implementation — see PHASE_G2G7D_AUDIT.md for exactly what this
// phase covers and what it explicitly defers: import of services (4(A)(2) — not modeled, this
// codebase has no import-of-service data), ISD, Rule 42/43, GSTR-2B ingestion/reconciliation
// (deferred to G2g-7e), RCM adjustment on Purchase Return/Debit Note (deferred — see brief §21;
// "foundation only" scope decision, no real RCM transaction exists yet in live data to adjust),
// and GSTR-3B filing.

import type {
  Gstr3bRcmSourceLiabilityLine,
  Gstr3bRcmAggregationOptions,
  Gstr3bRcmAggregationResult,
  Gstr3bRcmDiagnostic,
  Gstr3bRcmMoneyTotals,
  Gstr3bRcmRequirementSummary,
} from './gstr3bRcm.types';
import { classifyRcmSupply } from './gstr3bRcmClassification';
import { classifyRcmItc } from './gstr3bRcmItcEligibility';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export class Gstr3bRcmAggregationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr3bRcmAggregationError';
  }
}

function emptyTotals(): Gstr3bRcmMoneyTotals {
  return { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
}

function addInto(bucket: Gstr3bRcmMoneyTotals, taxable: number, cgst: number, sgst: number, igst: number, cess: number) {
  bucket.taxableValue = round2(bucket.taxableValue + taxable);
  bucket.cgst = round2(bucket.cgst + cgst);
  bucket.sgst = round2(bucket.sgst + sgst);
  bucket.igst = round2(bucket.igst + igst);
  bucket.cess = round2(bucket.cess + cess);
}

function emptySummary(): Gstr3bRcmRequirementSummary {
  return { required: 0, notRequired: 0, notDetermined: 0 };
}

function addRequirement(summary: Gstr3bRcmRequirementSummary, value: string) {
  // Order matters: "...NOT_REQUIRED" also ends with "_REQUIRED", so the negative case must be
  // checked first.
  if (value.endsWith('_NOT_REQUIRED')) summary.notRequired++;
  else if (value.endsWith('_REQUIRED')) summary.required++;
  else summary.notDetermined++;
}

function resolveAllowedBranchIds(
  branchAccess: Gstr3bRcmAggregationOptions['branchAccess'],
  branchId: string | null | undefined,
): string[] | undefined {
  if (branchId?.trim()) return [branchId.trim()];
  if (branchAccess && !branchAccess.allBranches) return branchAccess.branchIds;
  return undefined;
}

export function aggregateGstr3bRcm(
  liabilityLines: Gstr3bRcmSourceLiabilityLine[],
  options: Gstr3bRcmAggregationOptions,
): Gstr3bRcmAggregationResult {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr3bRcmAggregationError('A single buyer GST registration ID is required before aggregating GSTR-3B RCM liability/ITC.');
  }

  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const diagnostics: Gstr3bRcmDiagnostic[] = [];

  const isBranchRestricted = !!options.branchId || (options.branchAccess && !options.branchAccess.allBranches);
  const isCompleteGstinScope = !isBranchRestricted;
  const partialScopeReason = isBranchRestricted ? 'PARTIAL_BRANCH_SCOPE' : null;
  if (isBranchRestricted) {
    diagnostics.push({
      code: 'PARTIAL_BRANCH_SCOPE',
      documentType: 'REPORT_SCOPE',
      reason: `Report scope is restricted to branch ${options.branchId ?? 'subset'} and does not constitute a complete GSTIN-wide statutory GSTR-3B RCM figure.`,
    });
  }

  const recognized = emptyTotals();
  const unresolvedLiability = emptyTotals();
  const eligible = emptyTotals();
  const unresolvedItc = emptyTotals();
  const ineligible = emptyTotals();
  const selfInvoice = emptySummary();
  const paymentVoucher = emptySummary();

  let liabilityLinesConsidered = 0;
  let liabilityLinesExcludedByScope = 0;
  const documentIds = new Set<string>();
  const supplierIds = new Set<string>();
  let lineCount = 0;

  for (const line of liabilityLines) {
    if (allowedBranchIds && (!line.branchId || !allowedBranchIds.includes(line.branchId))) {
      liabilityLinesExcludedByScope++;
      continue;
    }
    if (line.receivedDate < from || line.receivedDate > to) {
      liabilityLinesExcludedByScope++;
      continue;
    }

    const classification = classifyRcmSupply(line.facts, gstRegistrationId);
    if (classification.scope === 'EXCLUDED_OTHER_REGISTRATION') {
      liabilityLinesExcludedByScope++;
      continue;
    }

    liabilityLinesConsidered++;
    lineCount++;
    documentIds.add(`GRN:${line.grnId}`);
    supplierIds.add(line.supplierId);

    addRequirement(selfInvoice, line.selfInvoiceRequirement);
    addRequirement(paymentVoucher, line.paymentVoucherRequirement);

    if (classification.status === 'RCM_APPLICABLE') {
      addInto(recognized, line.taxableValue, line.cgst, line.sgst, line.igst, line.cess);

      const itc = classifyRcmItc(line.liabilityStatus);
      const itcBucket = itc.status === 'ELIGIBLE' ? eligible : itc.status === 'INELIGIBLE' ? ineligible : unresolvedItc;
      addInto(itcBucket, line.taxableValue, line.cgst, line.sgst, line.igst, line.cess);
      if (itc.diagnosticCode) {
        diagnostics.push({
          code: itc.diagnosticCode,
          documentType: 'RCM_LIABILITY',
          documentId: line.id,
          documentNumber: line.grnNumber,
          reason: itc.reason ?? '',
        });
      }
    } else {
      // RCM_UNRESOLVED — a flagged-but-unconfirmed amount. Never merged into `recognized`/ITC
      // buckets (brief §25: no false compliance); the whole amount's ITC question is likewise
      // unresolved by construction, since the liability itself isn't confirmed yet.
      addInto(unresolvedLiability, line.taxableValue, line.cgst, line.sgst, line.igst, line.cess);
      addInto(unresolvedItc, line.taxableValue, line.cgst, line.sgst, line.igst, line.cess);
      if (classification.diagnosticCode) {
        diagnostics.push({
          code: classification.diagnosticCode,
          documentType: 'RCM_LIABILITY',
          documentId: line.id,
          documentNumber: line.grnNumber,
          reason: classification.reason ?? '',
        });
      }
    }
  }

  // Report-level capability-gap diagnostics (emitted once, never per line).
  diagnostics.push(
    {
      code: 'RCM_TIME_OF_SUPPLY_NOT_DETERMINABLE',
      documentType: 'REPORT_SCOPE',
      reason: 'RCM time of supply (Sections 12(3)/13(3) — earliest of receipt, payment-in-books/bank-debit, or 30/60 days from the supplier\'s document) cannot be reliably computed: SupplierPayment is account-level, not linked to a specific GRN line, so the payment-date branch is never determinable, and the liability-recognition date currently used (GRN receivedDate) is a proxy, not a statutory time-of-supply calculation.',
    },
    {
      code: 'RCM_SECTION_17_5_NOT_DETERMINABLE',
      documentType: 'REPORT_SCOPE',
      reason: 'Section 17(5) blocked-credit categories cannot be reliably inferred from current transaction data — every RCM_APPLICABLE, paid liability is currently treated as ELIGIBLE under the rules this phase can check; INELIGIBLE is not a reachable outcome yet.',
    },
    {
      code: 'GSTR_2B_RCM_RECONCILIATION_UNAVAILABLE',
      documentType: 'REPORT_SCOPE',
      reason: 'This report reflects TRIVO\'s own self-assessed books only — GSTR-2B does not auto-populate RCM supplies from unregistered persons at all, and no GSTR-2B ingestion/reconciliation exists yet (deferred to G2g-7e).',
    },
  );

  return {
    meta: {
      companyId: options.companyId,
      gstRegistrationId,
      buyerGstin: options.buyerGstin,
      buyerStateCode: options.buyerStateCode,
      financialYear: options.period.financialYear,
      taxPeriod: options.period.taxPeriod,
      period: { from: options.period.from, to: options.period.to },
      isCompleteGstinScope,
      partialScopeReason,
      calculationVersion: 'g2g7d-v1',
      supplierCount: supplierIds.size,
      sourceCounts: { liabilityLinesConsidered, liabilityLinesExcludedByScope },
    },
    table3_1d: { status: 'IMPLEMENTED', recognized, unresolved: unresolvedLiability, documentCount: documentIds.size, lineCount },
    table4A3: { status: 'IMPLEMENTED', eligible, unresolved: unresolvedItc, ineligible, documentCount: documentIds.size, lineCount },
    selfInvoice,
    paymentVoucher,
    diagnostics,
  };
}
