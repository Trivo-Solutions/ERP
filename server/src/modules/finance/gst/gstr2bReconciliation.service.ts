// G2g-7e — GSTR-2B Reconciliation Reporting Integration Service. Connects the pure matching engine
// (gstr2bReconciliation.ts) to the real tenant-scoped database. Parallel in shape to
// gstr3bRcmReporting.service.ts (G2g-7d) / gstr3bItcReporting.service.ts (G2g-7c) — reuses
// gstr3bReporting.service.ts's own resolveGstr3bPeriod helper for month-boundary math (the same
// reuse precedent G2g-7c already established), but never imports from or modifies either frozen
// aggregation engine.

import { tenantQuery, type BranchAccess } from '../../../shared/tenantContext';
import { AppError } from '../../../middleware/error';
import { resolveGstr3bPeriod } from './gstr3bReporting.service';
import { reconcileGstr2b } from './gstr2bReconciliation';
import type { Gstr2bBookInvoiceLine, Gstr2bBookReturnLine, Gstr2bDocumentForMatch, Gstr2bReconciliationResult } from './gstr2b.types';

export interface Gstr2bReconciliationQuery {
  gstRegistrationId: string;
  financialYear?: string;
  taxPeriod: string;
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

async function loadCurrentStatement(companyId: string, gstRegistrationId: string, financialYear: string, taxPeriod: string) {
  return tenantQuery(companyId, (tx) =>
    tx.gst2bStatement.findFirst({
      where: { companyId, gstRegistrationId, financialYear, taxPeriod, status: 'ACTIVE' },
    }),
  );
}

async function loadStatementDocuments(companyId: string, statementId: string): Promise<Gstr2bDocumentForMatch[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.gst2bDocument.findMany({
      where: { companyId, statementId },
      select: {
        id: true, section: true, documentType: true, supplierGstin: true, documentNumber: true, documentDate: true,
        taxableValue: true, igst: true, cgst: true, sgst: true, cess: true, reverseCharge: true,
        supportStatus: true, provenanceStatus: true, itcAvailability: true, ineligibilityReason: true,
      },
    }),
  );
  return rows.map((r): Gstr2bDocumentForMatch => ({
    id: r.id,
    section: r.section as Gstr2bDocumentForMatch['section'],
    documentType: r.documentType as Gstr2bDocumentForMatch['documentType'],
    supplierGstin: r.supplierGstin,
    documentNumber: r.documentNumber,
    documentDate: r.documentDate,
    taxableValue: Number(r.taxableValue),
    igst: Number(r.igst),
    cgst: Number(r.cgst),
    sgst: Number(r.sgst),
    cess: Number(r.cess),
    reverseCharge: r.reverseCharge,
    supportStatus: r.supportStatus as Gstr2bDocumentForMatch['supportStatus'],
    provenanceStatus: r.provenanceStatus as Gstr2bDocumentForMatch['provenanceStatus'],
    itcAvailability: r.itcAvailability as Gstr2bDocumentForMatch['itcAvailability'],
    ineligibilityReason: r.ineligibilityReason,
  }));
}

async function loadBookInvoiceLines(companyId: string, gstRegistrationId: string, from: Date, to: Date): Promise<Gstr2bBookInvoiceLine[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.goodsReceiptNote.findMany({
      where: {
        companyId,
        receivedDate: { gte: from, lte: to },
        grnItems: { some: { buyerRegistrationId: gstRegistrationId } },
      },
      select: {
        id: true, grnNumber: true, invoiceNumber: true, invoiceDate: true, branchId: true,
        po: { select: { supplier: { select: { id: true, gstNumber: true } } } },
        grnItems: {
          select: { taxableValue: true, inputCgst: true, inputSgst: true, inputIgst: true, rcmLiability: { select: { id: true } } },
        },
      },
    }),
  );

  return rows.map((g): Gstr2bBookInvoiceLine => {
    let taxableValue = 0, cgst = 0, sgst = 0, igst = 0, hasRcmLiability = false;
    for (const item of g.grnItems) {
      if (item.taxableValue !== null) {
        taxableValue += Number(item.taxableValue);
        cgst += Number(item.inputCgst);
        sgst += Number(item.inputSgst);
        igst += Number(item.inputIgst);
      }
      if (item.rcmLiability) hasRcmLiability = true;
    }
    return {
      grnId: g.id,
      grnNumber: g.grnNumber,
      supplierId: g.po.supplier.id,
      supplierGstin: g.po.supplier.gstNumber,
      invoiceNumber: g.invoiceNumber,
      invoiceDate: g.invoiceDate,
      branchId: g.branchId,
      buyerRegistrationId: gstRegistrationId,
      taxableValue: Math.round(taxableValue * 100) / 100,
      cgst: Math.round(cgst * 100) / 100,
      sgst: Math.round(sgst * 100) / 100,
      igst: Math.round(igst * 100) / 100,
      hasRcmLiability,
    };
  });
}

async function loadBookReturnLines(companyId: string, gstRegistrationId: string, from: Date, to: Date): Promise<Gstr2bBookReturnLine[]> {
  const rows = await tenantQuery(companyId, (tx) =>
    tx.purchaseReturn.findMany({
      where: { companyId, returnDate: { gte: from, lte: to } },
      select: {
        id: true, returnNumber: true, returnDate: true, supplierId: true,
        supplier: { select: { gstNumber: true } },
        items: {
          select: {
            amount: true, cgst: true, sgst: true, igst: true,
            tag: {
              select: {
                grnItem: { select: { buyerRegistrationId: true, grn: { select: { invoiceNumber: true, invoiceDate: true } } } },
                purchaseLot: { select: { grnItem: { select: { buyerRegistrationId: true, grn: { select: { invoiceNumber: true, invoiceDate: true } } } } } },
              },
            },
          },
        },
      },
    }),
  );

  const result: Gstr2bBookReturnLine[] = [];
  for (const r of rows) {
    let amount = 0, cgst = 0, sgst = 0, igst = 0;
    let matchesRegistration = false;
    let originalInvoiceNumber: string | null = null;
    let originalInvoiceDate: Date | null = null;
    for (const item of r.items) {
      const src = item.tag.grnItem ?? item.tag.purchaseLot?.grnItem ?? null;
      if (src?.buyerRegistrationId === gstRegistrationId) {
        matchesRegistration = true;
        originalInvoiceNumber = originalInvoiceNumber ?? src.grn.invoiceNumber;
        originalInvoiceDate = originalInvoiceDate ?? src.grn.invoiceDate;
      }
      amount += Number(item.amount);
      cgst += Number(item.cgst);
      sgst += Number(item.sgst);
      igst += Number(item.igst);
    }
    if (!matchesRegistration) continue;
    result.push({
      returnId: r.id,
      returnNumber: r.returnNumber,
      supplierId: r.supplierId,
      supplierGstin: r.supplier.gstNumber,
      returnDate: r.returnDate,
      amount: Math.round(amount * 100) / 100,
      cgst: Math.round(cgst * 100) / 100,
      sgst: Math.round(sgst * 100) / 100,
      igst: Math.round(igst * 100) / 100,
      originalInvoiceNumber,
      originalInvoiceDate,
    });
  }
  return result;
}

/**
 * Generates the GSTR-2B vs. books reconciliation report for one GST registration and exact
 * (financialYear, taxPeriod). Unlike the from/to-flexible GSTR-3B reports, GSTR-2B is inherently a
 * single calendar-month statement, so the period must resolve to exactly one tax period — this
 * reuses resolveGstr3bPeriod purely for its month-boundary math (brief's own established reuse
 * precedent via G2g-7c), not its from/to flexibility.
 */
export async function getGstr2bReconciliationReport(
  companyId: string,
  query: Gstr2bReconciliationQuery,
): Promise<Gstr2bReconciliationResult> {
  const registration = await tenantQuery(companyId, (tx) =>
    tx.companyGstRegistration.findFirst({
      where: { id: query.gstRegistrationId, companyId, isActive: true },
      select: { id: true },
    }),
  );
  if (!registration) throw new AppError('GST registration not found or does not belong to this company.', 404);

  if (!query.taxPeriod?.trim()) throw new AppError('taxPeriod (MMYYYY) is required.', 400);
  const period = resolveGstr3bPeriod({ taxPeriod: query.taxPeriod, financialYear: query.financialYear });

  const statement = await loadCurrentStatement(companyId, query.gstRegistrationId, period.financialYear, period.taxPeriod);

  const [twoBDocuments, bookInvoiceLines, bookReturnLines] = await Promise.all([
    statement ? loadStatementDocuments(companyId, statement.id) : Promise.resolve<Gstr2bDocumentForMatch[]>([]),
    loadBookInvoiceLines(companyId, query.gstRegistrationId, period.from, period.to),
    loadBookReturnLines(companyId, query.gstRegistrationId, period.from, period.to),
  ]);

  const result = reconcileGstr2b(twoBDocuments, bookInvoiceLines, bookReturnLines, {
    companyId,
    gstRegistrationId: query.gstRegistrationId,
    financialYear: period.financialYear,
    taxPeriod: period.taxPeriod,
    statementId: statement?.id ?? null,
    statementVersion: statement?.version ?? null,
    statementImportedAt: statement?.importedAt ?? null,
    branchAccess: query.branchAccess,
    branchId: query.branchId,
  });

  if (!statement) {
    result.diagnostics.unshift({
      code: 'NO_STATEMENT_IMPORTED',
      reason: `No GSTR-2B statement has been imported yet for ${period.financialYear} / ${period.taxPeriod} — every book document below is reported as BOOK_MISSING for lack of a statement to compare against, not because a mismatch was found.`,
    });
  }

  return result;
}
