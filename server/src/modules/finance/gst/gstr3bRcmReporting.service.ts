// G2g-7d — GSTR-3B RCM Reporting Integration Service.
// Connects the pure aggregation engine (gstr3bRcmAggregation.ts) to the real tenant-scoped
// database. Parallel to gstr3bItcReporting.service.ts (G2g-7c, frozen) — reuses its shared
// resolveGstr3bPeriod helper (via gstr3bReporting.service.ts) rather than re-deriving identical
// period logic, but never imports/modifies anything from the G2g-7c/7b aggregation internals.

import { tenantQuery, type BranchAccess } from '../../../shared/tenantContext';
import { AppError } from '../../../middleware/error';
import { aggregateGstr3bRcm } from './gstr3bRcmAggregation';
import { resolveGstr3bPeriod, type Gstr3bReportDateQuery } from './gstr3bReporting.service';
import type {
  Gstr3bRcmSourceLiabilityLine,
  Gstr3bRcmAggregationOptions,
  Gstr3bRcmAggregationResult,
  Gstr3bRcmLineFacts,
} from './gstr3bRcm.types';

export interface Gstr3bRcmReportScopeOptions {
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

async function loadRcmLiabilityLines(companyId: string, from: Date, to: Date): Promise<Gstr3bRcmSourceLiabilityLine[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.rcmLiability.findMany({
      where: { companyId, grnItem: { grn: { receivedDate: { gte: from, lte: to } } } },
      select: {
        id: true,
        rcmCategory: true,
        taxableValue: true,
        cgst: true,
        sgst: true,
        igst: true,
        cess: true,
        selfInvoiceRequirement: true,
        paymentVoucherRequirement: true,
        status: true,
        supplier: { select: { id: true, name: true } },
        grnItem: {
          select: {
            buyerRegistrationId: true,
            grn: { select: { id: true, grnNumber: true, receivedDate: true, branchId: true } },
            poItem: { select: { taxCategory: true } },
          },
        },
      },
    }),
  );

  return rows.map((r): Gstr3bRcmSourceLiabilityLine => {
    const facts: Gstr3bRcmLineFacts = {
      rcmCategory: r.rcmCategory,
      buyerRegistrationId: r.grnItem.buyerRegistrationId,
      taxCategory: r.grnItem.poItem.taxCategory,
    };
    return {
      id: r.id,
      grnId: r.grnItem.grn.id,
      grnNumber: r.grnItem.grn.grnNumber,
      receivedDate: r.grnItem.grn.receivedDate,
      branchId: r.grnItem.grn.branchId,
      supplierId: r.supplier.id,
      supplierName: r.supplier.name,
      taxableValue: Number(r.taxableValue),
      cgst: Number(r.cgst),
      sgst: Number(r.sgst),
      igst: Number(r.igst),
      cess: Number(r.cess),
      selfInvoiceRequirement: r.selfInvoiceRequirement as Gstr3bRcmSourceLiabilityLine['selfInvoiceRequirement'],
      paymentVoucherRequirement: r.paymentVoucherRequirement as Gstr3bRcmSourceLiabilityLine['paymentVoucherRequirement'],
      liabilityStatus: r.status as Gstr3bRcmSourceLiabilityLine['liabilityStatus'],
      facts,
    };
  });
}

/**
 * Generates the GSTR-3B Table 3.1(d) (RCM liability) / Table 4(A)(3) (RCM ITC) report for one GST
 * registration and period. Loads this company's RcmLiability rows for the period, reclassifies
 * each fresh from its live facts, and aggregates them using the pure aggregateGstr3bRcm engine.
 */
export async function getGstr3bRcmReport(
  companyId: string,
  gstRegistrationId: string,
  dateQuery: Gstr3bReportDateQuery,
  opts?: Gstr3bRcmReportScopeOptions,
): Promise<Gstr3bRcmAggregationResult> {
  const registration = await tenantQuery(companyId, (tx) =>
    tx.companyGstRegistration.findFirst({
      where: { id: gstRegistrationId, companyId, isActive: true },
      select: { id: true, gstin: true, stateCode: true },
    }),
  );
  if (!registration) {
    throw new AppError('GST registration not found or does not belong to this company.', 404);
  }

  const period = resolveGstr3bPeriod(dateQuery);
  const liabilityLines = await loadRcmLiabilityLines(companyId, period.from, period.to);

  const aggregationOptions: Gstr3bRcmAggregationOptions = {
    companyId,
    gstRegistrationId,
    buyerGstin: registration.gstin,
    buyerStateCode: registration.stateCode,
    period,
    branchAccess: opts?.branchAccess,
    branchId: opts?.branchId,
  };

  return aggregateGstr3bRcm(liabilityLines, aggregationOptions);
}
