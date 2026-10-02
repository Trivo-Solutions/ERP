// G2g-7c — GSTR-3B Table 4(A)(5) ITC Reporting Integration Service.
// Connects the pure aggregation engine (gstr3bItcAggregation.ts) to the real tenant-scoped
// database. Parallel to gstr3bReporting.service.ts (G2g-7b, frozen) on the inward side — reuses
// its period-resolution helper (resolveGstr3bPeriod) rather than re-deriving identical logic, but
// never imports/modifies anything from its outward aggregation or document-loading internals.
//
// Responsibilities:
// - Tenant scoping and registration identity resolution
// - Date/period resolution (delegated to gstr3bReporting.service.ts's resolveGstr3bPeriod)
// - Branch access validation
// - Loading source documents: GrnItem (intake), PurchaseReturnItem, standalone DebitNoteItem
// - Shape-adaptation into the pure engine's input contracts
// - Invoking aggregateGstr3bInwardItc()

import { tenantQuery, type BranchAccess } from '../../../shared/tenantContext';
import { AppError } from '../../../middleware/error';
import { aggregateGstr3bInwardItc } from './gstr3bItcAggregation';
import { resolveGstr3bPeriod, type Gstr3bReportDateQuery } from './gstr3bReporting.service';
import type {
  Gstr3bItcSourceGrnLine,
  Gstr3bItcSourcePurchaseReturnLine,
  Gstr3bItcSourceStandaloneDebitNoteLine,
  Gstr3bItcAggregationOptions,
  Gstr3bItcAggregationResult,
  Gstr3bItcLineFacts,
} from './gstr3bItc.types';

export interface Gstr3bItcReportScopeOptions {
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document Loaders
// ─────────────────────────────────────────────────────────────────────────────

async function loadGrnLines(companyId: string, from: Date, to: Date): Promise<Gstr3bItcSourceGrnLine[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.grnItem.findMany({
      where: {
        companyId,
        taxableValue: { not: null },
        grn: { receivedDate: { gte: from, lte: to } },
      },
      select: {
        id: true,
        grnId: true,
        taxableValue: true,
        inputCgst: true,
        inputSgst: true,
        inputIgst: true,
        buyerRegistrationId: true,
        grn: { select: { grnNumber: true, receivedDate: true, branchId: true, invoiceNumber: true, invoiceDate: true } },
        poItem: {
          select: {
            taxCategory: true,
            po: { select: { supplier: { select: { id: true, name: true, gstNumber: true, isComposition: true } } } },
          },
        },
      },
    })
  );

  return rows.map((g): Gstr3bItcSourceGrnLine => {
    const supplier = g.poItem.po.supplier;
    const facts: Gstr3bItcLineFacts = {
      buyerRegistrationId: g.buyerRegistrationId,
      supplierGstin: supplier.gstNumber,
      supplierIsComposition: supplier.isComposition,
      taxCategory: g.poItem.taxCategory,
    };
    return {
      id: g.id,
      grnId: g.grnId,
      grnNumber: g.grn.grnNumber,
      receivedDate: g.grn.receivedDate,
      branchId: g.grn.branchId,
      invoiceNumber: g.grn.invoiceNumber,
      invoiceDate: g.grn.invoiceDate,
      supplierId: supplier.id,
      supplierName: supplier.name,
      taxableValue: Number(g.taxableValue),
      cgst: Number(g.inputCgst),
      sgst: Number(g.inputSgst),
      igst: Number(g.inputIgst),
      cess: 0,
      facts,
    };
  });
}

async function loadPurchaseReturnLines(companyId: string, from: Date, to: Date): Promise<Gstr3bItcSourcePurchaseReturnLine[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.purchaseReturnItem.findMany({
      where: {
        companyId,
        return: { returnDate: { gte: from, lte: to } },
      },
      select: {
        id: true,
        amount: true,
        cgst: true,
        sgst: true,
        igst: true,
        return: { select: { id: true, returnNumber: true, returnDate: true } },
        tag: {
          select: {
            grnItem: {
              select: {
                id: true,
                buyerRegistrationId: true,
                grn: { select: { branchId: true } },
                poItem: { select: { taxCategory: true, po: { select: { supplier: { select: { gstNumber: true, isComposition: true } } } } } },
              },
            },
            purchaseLot: {
              select: {
                grnItem: {
                  select: {
                    id: true,
                    buyerRegistrationId: true,
                    grn: { select: { branchId: true } },
                    poItem: { select: { taxCategory: true, po: { select: { supplier: { select: { gstNumber: true, isComposition: true } } } } } },
                  },
                },
              },
            },
          },
        },
      },
    })
  );

  return rows.map((r): Gstr3bItcSourcePurchaseReturnLine => {
    const src = r.tag.grnItem ?? r.tag.purchaseLot?.grnItem ?? null;
    const supplier = src?.poItem.po.supplier;
    const facts: Gstr3bItcLineFacts = {
      buyerRegistrationId: src?.buyerRegistrationId ?? null,
      supplierGstin: supplier?.gstNumber ?? null,
      supplierIsComposition: supplier?.isComposition ?? false,
      taxCategory: src?.poItem.taxCategory ?? null,
    };
    return {
      id: r.id,
      returnId: r.return.id,
      returnNumber: r.return.returnNumber,
      returnDate: r.return.returnDate,
      sourceGrnLineId: src?.id ?? '',
      branchId: src?.grn.branchId ?? null,
      amount: Number(r.amount),
      cgst: Number(r.cgst),
      sgst: Number(r.sgst),
      igst: Number(r.igst),
      cess: 0,
      facts,
    };
  });
}

// Path A (purchaseReturnId set) is deliberately excluded — its ITC effect is already represented
// by the Purchase Return it wraps (same convention as finance.service.ts's getPurchaseGstSummary:
// counting both would double-count the same rupee). Cancelled notes are excluded — their ITC
// effect was undone at cancellation.
async function loadStandaloneDebitNoteLines(companyId: string, from: Date, to: Date): Promise<Gstr3bItcSourceStandaloneDebitNoteLine[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.debitNoteItem.findMany({
      where: {
        companyId,
        debitNote: { purchaseReturnId: null, status: 'ISSUED', debitNoteDate: { gte: from, lte: to } },
      },
      select: {
        id: true,
        taxableValue: true,
        cgstAmount: true,
        sgstAmount: true,
        igstAmount: true,
        debitNote: {
          select: {
            id: true,
            debitNoteNumber: true,
            debitNoteDate: true,
            grnId: true,
            supplier: { select: { gstNumber: true, isComposition: true } },
            grn: {
              select: {
                branchId: true,
                grnItems: { select: { buyerRegistrationId: true } },
              },
            },
          },
        },
      },
    })
  );

  return rows.map((d): Gstr3bItcSourceStandaloneDebitNoteLine => {
    const dn = d.debitNote;
    // A standalone Debit Note has no PoItem/taxCategory lineage of its own (its items carry only a
    // fresh HSN/rate snapshot, not a taxCategory) — documented limitation, see
    // PHASE_G2G7C_IMPLEMENTATION.md §C. The classifier routes a null taxCategory to UNRESOLVED.
    const distinctRegistrations = new Set(dn.grn.grnItems.map((g) => g.buyerRegistrationId).filter((id): id is string => !!id));
    const buyerRegistrationId = distinctRegistrations.size === 1 ? [...distinctRegistrations][0] : null;
    const facts: Gstr3bItcLineFacts = {
      buyerRegistrationId,
      supplierGstin: dn.supplier.gstNumber,
      supplierIsComposition: dn.supplier.isComposition,
      taxCategory: null,
    };
    return {
      id: d.id,
      debitNoteId: dn.id,
      debitNoteNumber: dn.debitNoteNumber,
      debitNoteDate: dn.debitNoteDate,
      grnId: dn.grnId,
      branchId: dn.grn.branchId,
      taxableValue: Number(d.taxableValue),
      cgst: Number(d.cgstAmount),
      sgst: Number(d.sgstAmount),
      igst: Number(d.igstAmount),
      cess: 0,
      facts,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Service API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the GSTR-3B Table 4(A)(5) inward ITC report for one GST registration and period.
 * Loads this company's GRN intake lines, purchase returns, and standalone debit notes for the
 * period, classifies each into ELIGIBLE / UNRESOLVED / INELIGIBLE, and aggregates them using the
 * pure aggregateGstr3bInwardItc engine.
 */
export async function getGstr3bInwardItcReport(
  companyId: string,
  gstRegistrationId: string,
  dateQuery: Gstr3bReportDateQuery,
  opts?: Gstr3bItcReportScopeOptions,
): Promise<Gstr3bItcAggregationResult> {
  // 1. Validate registration ownership.
  const registration = await tenantQuery(companyId, (tx) =>
    tx.companyGstRegistration.findFirst({
      where: { id: gstRegistrationId, companyId, isActive: true },
      select: { id: true, gstin: true, stateCode: true },
    })
  );
  if (!registration) {
    throw new AppError('GST registration not found or does not belong to this company.', 404);
  }

  // 2. Resolve period (shared with G2g-7b's outward report — identical FY/tax-period semantics).
  const period = resolveGstr3bPeriod(dateQuery);

  // 3. Load all candidate source rows concurrently.
  const [grnLines, purchaseReturnLines, standaloneDebitNoteLines] = await Promise.all([
    loadGrnLines(companyId, period.from, period.to),
    loadPurchaseReturnLines(companyId, period.from, period.to),
    loadStandaloneDebitNoteLines(companyId, period.from, period.to),
  ]);

  // 4. Construct aggregation options.
  const aggregationOptions: Gstr3bItcAggregationOptions = {
    companyId,
    gstRegistrationId,
    buyerGstin: registration.gstin,
    buyerStateCode: registration.stateCode,
    period,
    branchAccess: opts?.branchAccess,
    branchId: opts?.branchId,
  };

  // 5. Run the pure aggregation engine.
  return aggregateGstr3bInwardItc(grnLines, purchaseReturnLines, standaloneDebitNoteLines, aggregationOptions);
}
