// G2g-7f — Complete GSTR-3B Aggregation & Reconciliation. Reporting integration service.
//
// Connects the pure composition engine (gstr3bReconciliationComposition.ts) to the real
// tenant-scoped database. This file does NOT reimplement any GST logic — it only:
//   1. Validates registration ownership (same pattern as every sibling G2g-7b/7c/7d/7e service).
//   2. Resolves the period once (resolveGstr3bPeriod, shared with every sibling report).
//   3. Calls the four frozen reporting services verbatim — getGstr3bOutwardReport (G2g-7b),
//      getGstr3bInwardItcReport (G2g-7c), getGstr3bRcmReport (G2g-7d), getGstr2bReconciliationReport
//      (G2g-7e) — never their internal aggregation/loader functions directly.
//   4. Reads (never writes) a GstReturnPeriod row with returnType='GSTR3B' for filing-status
//      reporting context only — this phase creates no row, files nothing, locks nothing. See
//      gstr3bReconciliation.types.ts's own header for why 'GSTR3B' is a safe, pre-anticipated value.
//   5. Hands everything to composeGstr3bReconciliationReport().

import { tenantQuery, type BranchAccess } from '../../../shared/tenantContext';
import { AppError } from '../../../middleware/error';
import { resolveGstr3bPeriod, type Gstr3bReportDateQuery } from './gstr3bReporting.service';
import { getGstr3bOutwardReport } from './gstr3bReporting.service';
import { getGstr3bInwardItcReport } from './gstr3bItcReporting.service';
import { getGstr3bRcmReport } from './gstr3bRcmReporting.service';
import { getGstr2bReconciliationReport } from './gstr2bReconciliation.service';
import { composeGstr3bReconciliationReport } from './gstr3bReconciliationComposition';
import type { Gstr3bReconciliationFilingStatus, Gstr3bFilingLifecycleStatus, Gstr3bReconciliationReport } from './gstr3bReconciliation.types';

export interface Gstr3bReconciliationReportScopeOptions {
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

export interface Gstr3bReconciliationReportQuery {
  gstRegistrationId: string;
  taxPeriod: string;
  financialYear?: string;
}

const KNOWN_LIFECYCLE_STATUSES = new Set<Gstr3bFilingLifecycleStatus>(['OPEN', 'SNAPSHOT_CREATED', 'FILING_ATTEMPTED', 'FILED', 'LOCKED']);

async function resolveFilingStatus(
  companyId: string,
  gstRegistrationId: string,
  financialYear: string,
  taxPeriod: string,
): Promise<Gstr3bReconciliationFilingStatus> {
  // Read-only lookup against the existing G2g-6 GstReturnPeriod model (frozen) — never written here.
  const period = await tenantQuery(companyId, (tx) =>
    tx.gstReturnPeriod.findFirst({
      where: { companyId, gstRegistrationId, returnType: 'GSTR3B', financialYear, taxPeriod },
      select: { id: true, status: true, filedAt: true, lockedAt: true },
    }),
  );

  if (!period) {
    return {
      returnType: 'GSTR3B',
      status: 'NOT_STARTED',
      periodId: null,
      filedAt: null,
      lockedAt: null,
      note: 'No GSTR-3B return period record exists for this registration/period yet. This is expected — no service in this codebase creates one; this report is a pre-filing reconciliation view only.',
    };
  }

  const status: Gstr3bFilingLifecycleStatus = KNOWN_LIFECYCLE_STATUSES.has(period.status as Gstr3bFilingLifecycleStatus)
    ? (period.status as Gstr3bFilingLifecycleStatus)
    : 'OPEN';

  return {
    returnType: 'GSTR3B',
    status,
    periodId: period.id,
    filedAt: period.filedAt,
    lockedAt: period.lockedAt,
    note:
      status === 'FILED' || status === 'LOCKED'
        ? 'This return period is already FILED/LOCKED. This report remains a reconciliation view only — it cannot file, amend, or unlock it.'
        : 'This return period has not reached FILED/LOCKED yet.',
  };
}

/**
 * Generates the composed GSTR-3B reconciliation report: outward liability (G2g-7b) + RCM (G2g-7d) +
 * book ITC (G2g-7c) + GSTR-2B reconciliation (G2g-7e), for one GST registration and exact
 * (financialYear, taxPeriod). Unlike the from/to-flexible individual GSTR-3B reports, this endpoint
 * requires an exact taxPeriod — GSTR-2B is inherently a single calendar-month statement (same
 * constraint getGstr2bReconciliationReport already enforces), so the composed report must be too.
 */
export async function getGstr3bReconciliationReport(
  companyId: string,
  query: Gstr3bReconciliationReportQuery,
  opts?: Gstr3bReconciliationReportScopeOptions,
): Promise<Gstr3bReconciliationReport> {
  const { gstRegistrationId } = query;
  if (!gstRegistrationId) throw new AppError('gstRegistrationId is required.', 400);
  if (!query.taxPeriod?.trim()) throw new AppError('taxPeriod (MMYYYY) is required.', 400);

  const registration = await tenantQuery(companyId, (tx) =>
    tx.companyGstRegistration.findFirst({
      where: { id: gstRegistrationId, companyId, isActive: true },
      select: { id: true, gstin: true, stateCode: true, legalName: true },
    }),
  );
  if (!registration) {
    throw new AppError('GST registration not found or does not belong to this company.', 404);
  }

  const dateQuery: Gstr3bReportDateQuery = { taxPeriod: query.taxPeriod, financialYear: query.financialYear };
  const period = resolveGstr3bPeriod(dateQuery);

  const [outward, itc, rcm, twoB, filingStatus] = await Promise.all([
    getGstr3bOutwardReport(companyId, gstRegistrationId, dateQuery, opts),
    getGstr3bInwardItcReport(companyId, gstRegistrationId, dateQuery, opts),
    getGstr3bRcmReport(companyId, gstRegistrationId, dateQuery, opts),
    getGstr2bReconciliationReport(companyId, {
      gstRegistrationId,
      taxPeriod: period.taxPeriod,
      financialYear: period.financialYear,
      branchAccess: opts?.branchAccess,
      branchId: opts?.branchId,
    }),
    resolveFilingStatus(companyId, gstRegistrationId, period.financialYear, period.taxPeriod),
  ]);

  return composeGstr3bReconciliationReport({
    companyId,
    gstRegistrationId,
    gstin: registration.gstin,
    stateCode: registration.stateCode,
    legalName: registration.legalName,
    financialYear: period.financialYear,
    taxPeriod: period.taxPeriod,
    period: { from: period.from, to: period.to },
    outward,
    itc,
    rcm,
    twoB,
    statementAvailable: twoB.meta.statementId !== null,
    filingStatus,
    branchAccess: opts?.branchAccess,
    branchId: opts?.branchId,
  });
}
