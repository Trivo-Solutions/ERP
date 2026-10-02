// G2g-7g — GSTR-3B filing/export preparation. Export/validation integration service.
//
// Orchestrates: frozen G2g-7f composed report (getGstr3bReconciliationReport, which already performs
// registration ownership + period resolution) -> pure serializer (gstr3bGstnWire.ts) -> pure
// validator (gstr3bGstnValidator.ts) -> audit. This file reimplements none of those three — it only
// wires them together and records that an export happened, the same posture
// gstr1Export.service.ts's own `buildGstr1GstnExport` uses for the GSTR-1 side. No GSTN API call, no
// snapshot persistence (that is gstr3bFilingSnapshot.service.ts's separate job).

import { createAuditEntry } from '../../../middleware/audit';
import type { TenantContext } from '../../../shared/tenantContext';
import { getGstr3bReconciliationReport } from './gstr3bReconciliation.service';
import { serializeGstr3bToGstnExport } from './gstr3bGstnWire';
import { validateGstr3bGstnExport, type Gstr3bGstnValidationResult } from './gstr3bGstnValidator';
import type { Gstr3bGstnExportDto } from './gstr3bGstnWire.types';

export interface Gstr3bExportParams {
  gstRegistrationId: string;
  taxPeriod: string;
  financialYear?: string;
  branchId?: string | null;
}

export interface Gstr3bExportResult {
  export: Gstr3bGstnExportDto;
  validation: Gstr3bGstnValidationResult;
}

/**
 * Builds the GSTR-3B filing/export preparation DTO for one GST registration + exact tax period
 * (+ optional branch). Ownership/branch-access checks happen at the CALLER (the router, same
 * convention every sibling GST route in finance.router.ts already uses) — this function trusts
 * `ctx`/`params` the way `getGstr3bReconciliationReport` itself already does. Never persists
 * anything beyond the one audit entry recorded here.
 */
export async function buildGstr3bGstnExport(ctx: TenantContext, params: Gstr3bExportParams, userId: string): Promise<Gstr3bExportResult> {
  const report = await getGstr3bReconciliationReport(
    ctx.companyId,
    { gstRegistrationId: params.gstRegistrationId, taxPeriod: params.taxPeriod, financialYear: params.financialYear },
    { branchAccess: ctx.branchAccess, branchId: params.branchId ?? null },
  );

  const dto = serializeGstr3bToGstnExport(report);
  const validation = validateGstr3bGstnExport(dto);

  await createAuditEntry(
    'company_gst_registrations',
    params.gstRegistrationId,
    userId,
    validation.isFilingReady ? 'GSTR3B_GSTN_EXPORT' : 'GSTR3B_GSTN_EXPORT_NOT_FILING_READY',
    undefined,
    {
      gstRegistrationId: params.gstRegistrationId,
      gstin: dto.metadata.gstin,
      financialYear: dto.metadata.financialYear,
      taxPeriod: dto.metadata.taxPeriod,
      branchId: params.branchId ?? null,
      isFilingReady: validation.isFilingReady,
      blockerCount: validation.blockers.length,
      warningCount: validation.warnings.length,
    },
    ctx.companyId,
  );

  return { export: dto, validation };
}
