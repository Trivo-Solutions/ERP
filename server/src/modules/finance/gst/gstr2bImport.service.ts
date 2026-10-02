// G2g-7e — GSTR-2B import orchestration (brief §21). Parses, validates, canonicalizes, hashes,
// detects duplicate/version, and persists an immutable GSTR-2B statement + its normalized
// documents. Mirrors gstr1FilingSnapshot.service.ts (G2g-6b)'s own hashing/versioning shape, but is
// a wholly independent module (see gstr2bNormalizer.ts's header for why the hashing helper is
// duplicated rather than imported from that named-frozen file).
//
// Does NOT reconcile during import (brief §21: "it is acceptable to have IMPORT followed by
// RECONCILE as a separate operation") — see gstr2bReconciliation.service.ts for that.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, type TenantContext } from '../../../shared/tenantContext';
import { nextSimpleCode } from '../../../shared/numberSequence';
import { normalizeGstin } from '../../../shared/gstin';
import { getFinancialYearForDate } from '../../../shared/financialYear';
import { canonicalJsonString, sha256Hex, sha256HexBytes } from '../../../shared/gst2bHash';
import { normalizeGstr2bPayload, Gstr2bNormalizationError, GSTR2B_NORMALIZER_VERSION } from './gstr2bNormalizer';
import type { Gstr2bNormalizedDocument } from './gstr2b.types';

export interface Gstr2bImportParams {
  gstRegistrationId: string;
  rawPayload: unknown;
  /** The exact uploaded bytes, captured by a raw-body-preserving parser on the import route only
   *  (never a re-serialization of the parsed object — see finance.router.ts). */
  rawBytes: Buffer;
  /** Optional explicit override — when omitted, resolved from the payload's own metadata
   *  (gstr2bNormalizer.ts). Never guessed when both are absent. */
  financialYear?: string;
  taxPeriod?: string;
}

export interface Gstr2bImportResult {
  statementId: string;
  version: number;
  duplicate: boolean;
  financialYear: string;
  taxPeriod: string;
  documentCounts: Record<string, number>;
  normalizationDiagnostics: ReturnType<typeof normalizeGstr2bPayload>['diagnostics'];
}

/** MMYYYY -> Indian FY string, so a caller need not separately supply financialYear when the
 *  payload's own taxPeriod already determines it unambiguously. */
function financialYearFromTaxPeriod(taxPeriod: string): string {
  const mm = parseInt(taxPeriod.slice(0, 2), 10);
  const yyyy = parseInt(taxPeriod.slice(2, 6), 10);
  return getFinancialYearForDate(new Date(Date.UTC(yyyy, mm - 1, 15)));
}

function toDocumentRow(d: Gstr2bNormalizedDocument, statementId: string, companyId: string): Prisma.Gst2bDocumentUncheckedCreateInput {
  return {
    companyId,
    statementId,
    section: d.section,
    documentType: d.documentType,
    supplierGstin: d.supplierGstin,
    supplierTradeName: d.supplierTradeName,
    documentNumber: d.documentNumber,
    documentDate: d.documentDate,
    documentValue: d.documentValue,
    placeOfSupply: d.placeOfSupply,
    taxableValue: d.taxableValue,
    igst: d.igst,
    cgst: d.cgst,
    sgst: d.sgst,
    cess: d.cess,
    reverseCharge: d.reverseCharge,
    itcAvailability: d.itcAvailability,
    ineligibilityReason: d.ineligibilityReason,
    supportStatus: d.supportStatus,
    rawRecord: d.rawRecord as Prisma.InputJsonValue,
  };
}

const AMENDMENT_SECTIONS = new Set(['B2BA', 'CDNRA']);

export async function importGstr2bStatement(
  ctx: TenantContext,
  params: Gstr2bImportParams,
  userId: string,
): Promise<Gstr2bImportResult> {
  const registration = await tenantTransaction(ctx.companyId, (tx) =>
    tx.companyGstRegistration.findFirst({
      where: { id: params.gstRegistrationId, companyId: ctx.companyId, isActive: true },
      select: { id: true, gstin: true },
    }),
  );
  if (!registration) {
    throw new AppError('GST registration not found or does not belong to this company.', 404);
  }

  let normalized;
  try {
    normalized = normalizeGstr2bPayload(params.rawPayload);
  } catch (err) {
    if (err instanceof Gstr2bNormalizationError) throw new AppError(`GSTR-2B payload could not be parsed: ${err.message}`, 400);
    throw err;
  }

  // Security-critical cross-check (PHASE_G2G7E_AUDIT.md §5): a caller who legitimately owns
  // registration A must not be able to attribute a DIFFERENT GSTIN's statement to it.
  if (normalized.meta.gstin && normalizeGstin(normalized.meta.gstin) !== normalizeGstin(registration.gstin)) {
    throw new AppError(
      `The uploaded statement's own GSTIN (${normalized.meta.gstin}) does not match the selected GST registration's GSTIN (${registration.gstin}).`,
      400,
    );
  }

  const taxPeriod = params.taxPeriod?.trim() || normalized.meta.taxPeriod;
  if (!taxPeriod) {
    throw new AppError('Could not resolve a tax period (MMYYYY) from the uploaded statement — pass "taxPeriod" explicitly.', 400);
  }
  if (!/^\d{6}$/.test(taxPeriod)) {
    throw new AppError(`Invalid taxPeriod "${taxPeriod}" — expected MMYYYY (e.g. "092026").`, 400);
  }
  const financialYear = params.financialYear?.trim() || financialYearFromTaxPeriod(taxPeriod);

  const sourceFileHash = sha256HexBytes(params.rawBytes);
  const canonicalPayloadHash = sha256Hex(canonicalJsonString(params.rawPayload));

  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    const existingActive = await tx.gst2bStatement.findFirst({
      where: { companyId: ctx.companyId, gstRegistrationId: params.gstRegistrationId, financialYear, taxPeriod, status: 'ACTIVE' },
    });

    if (existingActive && (existingActive.sourceFileHash === sourceFileHash || existingActive.canonicalPayloadHash === canonicalPayloadHash)) {
      return { statement: existingActive, duplicate: true as const, documents: [] as Gstr2bNormalizedDocument[] };
    }

    // Reuses shared/numberSequence.ts's proven atomic per-key counter (CN:/SDN:/SELFINV: precedent)
    // rather than inventing a new row-lock scheme — see PHASE_G2G7E_AUDIT.md §1.
    const sequenceKey = `GST2B:${params.gstRegistrationId}:${financialYear}:${taxPeriod}`;
    const formatted = await nextSimpleCode(ctx.companyId, sequenceKey, 'V', 1, tx);
    const version = parseInt(formatted.slice('V-'.length), 10);

    if (existingActive) {
      await tx.gst2bStatement.update({ where: { id: existingActive.id }, data: { status: 'SUPERSEDED' } });
    }

    let statement;
    try {
      statement = await tx.gst2bStatement.create({
        data: {
          companyId: ctx.companyId,
          gstRegistrationId: params.gstRegistrationId,
          financialYear,
          taxPeriod,
          source: 'GSTN_JSON',
          generatedAt: normalized.meta.generatedAt,
          importedById: userId,
          sourceFileHash,
          canonicalPayloadHash,
          normalizerVersion: GSTR2B_NORMALIZER_VERSION,
          rawPayload: params.rawPayload as Prisma.InputJsonValue,
          status: 'ACTIVE',
          version,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('A concurrent GSTR-2B import was detected for this exact period — please retry.', 409);
      }
      throw err;
    }

    const nonAmendmentDocs = normalized.documents.filter((d) => !AMENDMENT_SECTIONS.has(d.section));
    const amendmentDocs = normalized.documents.filter((d) => AMENDMENT_SECTIONS.has(d.section));

    if (nonAmendmentDocs.length > 0) {
      await tx.gst2bDocument.createMany({ data: nonAmendmentDocs.map((d) => toDocumentRow(d, statement.id, ctx.companyId)) });
    }

    // Amendment documents need a per-row best-effort lookup of what they amend (brief §15) — never
    // guessed, only linked when an exact supplier+document-number match exists among this
    // registration's previously imported documents (any statement/version, current or superseded).
    for (const d of amendmentDocs) {
      let amendsDocumentId: string | null = null;
      let provenanceStatus: 'CURRENT' | 'AMENDED' = 'CURRENT';
      if (d.amendsDocumentNumber && d.supplierGstin) {
        const original = await tx.gst2bDocument.findFirst({
          where: {
            companyId: ctx.companyId,
            supplierGstin: d.supplierGstin,
            documentNumber: d.amendsDocumentNumber,
            statement: { gstRegistrationId: params.gstRegistrationId },
          },
          orderBy: { createdAt: 'desc' },
        });
        if (original) {
          amendsDocumentId = original.id;
          provenanceStatus = 'AMENDED';
          await tx.gst2bDocument.update({ where: { id: original.id }, data: { provenanceStatus: 'SUPERSEDED' } });
        }
      }
      await tx.gst2bDocument.create({
        data: { ...toDocumentRow(d, statement.id, ctx.companyId), amendsDocumentId, provenanceStatus },
      });
    }

    return { statement, duplicate: false as const, documents: normalized.documents };
  });

  const documentCounts: Record<string, number> = {};
  for (const d of result.documents) documentCounts[d.section] = (documentCounts[d.section] ?? 0) + 1;

  await createAuditEntry(
    'gst2b_statements', result.statement.id, userId, result.duplicate ? 'GST2B_STATEMENT_DUPLICATE_IMPORT_IGNORED' : 'GST2B_STATEMENT_IMPORTED',
    undefined,
    {
      gstRegistrationId: params.gstRegistrationId, financialYear, taxPeriod, version: result.statement.version,
      documentCounts, sourceFileHash, canonicalPayloadHash, normalizationDiagnosticCount: normalized.diagnostics.length,
    },
    ctx.companyId,
  );

  return {
    statementId: result.statement.id,
    version: result.statement.version,
    duplicate: result.duplicate,
    financialYear,
    taxPeriod,
    documentCounts,
    normalizationDiagnostics: normalized.diagnostics,
  };
}
