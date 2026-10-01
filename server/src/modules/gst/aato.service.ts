// GST Phase D — AATO (Annual Aggregate Turnover) Management Service.
// Associates Company -> GST Registration -> Financial Year -> AATO record.
// Enforces Indian Financial Year logic, tenant isolation, duplicate prevention,
// audit trail history, and verification rules.

import { Prisma } from '@prisma/client';
import { assertOwnedByCompany } from '../../middleware/tenant';
import { tenantQuery, tenantTransaction, TenantContext } from '../../shared/tenantContext';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import {
  isValidFinancialYear,
  normalizeFinancialYear,
  getPrecedingFinancialYear,
  getCurrentFinancialYear,
} from '../../shared/financialYear';

export const AATO_SOURCES = [
  'MANUAL',
  'GST_PORTAL',
  'IMPORT',
  'SYSTEM_CALCULATED',
  'OTHER',
] as const;
export type AatoSource = (typeof AATO_SOURCES)[number];

export const AATO_VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'VERIFIED',
] as const;
export type AatoVerificationStatus = (typeof AATO_VERIFICATION_STATUSES)[number];

export interface SaveAatoInput {
  gstRegistrationId: string;
  financialYear: string;
  turnover: number | string | Prisma.Decimal;
  precedingTurnover?: number | string | Prisma.Decimal | null;
  source?: AatoSource;
  verificationStatus?: AatoVerificationStatus;
  verifiedDate?: Date | string | null;
  notes?: string | null;
}

export interface AatoResponse {
  aato: {
    id: string;
    companyId: string;
    gstRegistrationId: string;
    financialYear: string;
    turnover: number;
    precedingTurnover: number | null;
    source: string;
    verificationStatus: string;
    verifiedDate: Date | null;
    verifiedBy: string | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  precedingAato: {
    financialYear: string;
    turnover: number | null;
    source: string | null;
    verificationStatus: string | null;
  } | null;
  financialYear: string;
  precedingFinancialYear: string;
}

function formatAatoRow(row: any) {
  return {
    id: row.id,
    companyId: row.companyId,
    gstRegistrationId: row.gstRegistrationId,
    financialYear: row.financialYear,
    turnover: Number(row.turnover),
    precedingTurnover: row.precedingTurnover !== null && row.precedingTurnover !== undefined ? Number(row.precedingTurnover) : null,
    source: row.source,
    verificationStatus: row.verificationStatus,
    verifiedDate: row.verifiedDate,
    verifiedBy: row.verifiedBy,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Retrieve the AATO record for a given GST registration and financial year,
 * including preceding financial year AATO context where available.
 */
export async function getAato(
  ctx: TenantContext,
  params: { gstRegistrationId: string; financialYear?: string }
): Promise<AatoResponse> {
  const { gstRegistrationId } = params;
  if (!gstRegistrationId) {
    throw new AppError('gstRegistrationId is required', 400);
  }

  // Tenant security: verify registration belongs to caller's company
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');

  const normalizedFy = params.financialYear
    ? normalizeFinancialYear(params.financialYear)
    : getCurrentFinancialYear();

  if (!normalizedFy || !isValidFinancialYear(normalizedFy)) {
    throw new AppError(`Invalid financial year. Must be Indian FY format "YYYY-YY" (e.g. "2024-25")`, 400);
  }

  const precedingFy = getPrecedingFinancialYear(normalizedFy);

  return tenantTransaction(ctx.companyId, async (tx) => {
    const [currentRecord, precedingRecord] = await Promise.all([
      tx.companyGstAato.findUnique({
        where: {
          companyId_gstRegistrationId_financialYear: {
            companyId: ctx.companyId,
            gstRegistrationId,
            financialYear: normalizedFy,
          },
        },
      }),
      tx.companyGstAato.findUnique({
        where: {
          companyId_gstRegistrationId_financialYear: {
            companyId: ctx.companyId,
            gstRegistrationId,
            financialYear: precedingFy,
          },
        },
      }),
    ]);

    let precedingTurnover: number | null = null;
    let precedingSource: string | null = null;
    let precedingStatus: string | null = null;

    if (currentRecord?.precedingTurnover !== null && currentRecord?.precedingTurnover !== undefined) {
      precedingTurnover = Number(currentRecord.precedingTurnover);
      precedingSource = currentRecord.source;
      precedingStatus = currentRecord.verificationStatus;
    } else if (precedingRecord) {
      precedingTurnover = Number(precedingRecord.turnover);
      precedingSource = precedingRecord.source;
      precedingStatus = precedingRecord.verificationStatus;
    }

    return {
      aato: currentRecord ? formatAatoRow(currentRecord) : null,
      precedingAato: {
        financialYear: precedingFy,
        turnover: precedingTurnover,
        source: precedingSource,
        verificationStatus: precedingStatus,
      },
      financialYear: normalizedFy,
      precedingFinancialYear: precedingFy,
    };
  });
}

/**
 * Retrieve the audit history for an AATO record / GST registration.
 */
export async function getAatoHistory(
  ctx: TenantContext,
  params: { gstRegistrationId: string; financialYear?: string; limit?: number }
) {
  const { gstRegistrationId } = params;
  if (!gstRegistrationId) {
    throw new AppError('gstRegistrationId is required', 400);
  }

  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');

  const normalizedFy = params.financialYear ? normalizeFinancialYear(params.financialYear) : undefined;
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);

  const historyRows = await tenantQuery(ctx.companyId, (tx) =>
    tx.companyGstAatoHistory.findMany({
      where: {
        companyId: ctx.companyId,
        gstRegistrationId,
        ...(normalizedFy ? { financialYear: normalizedFy } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
  );

  return historyRows.map((h) => ({
    id: h.id,
    aatoId: h.aatoId,
    gstRegistrationId: h.gstRegistrationId,
    financialYear: h.financialYear,
    turnover: Number(h.turnover),
    precedingTurnover: h.precedingTurnover !== null ? Number(h.precedingTurnover) : null,
    source: h.source,
    verificationStatus: h.verificationStatus,
    verifiedDate: h.verifiedDate,
    notes: h.notes,
    action: h.action,
    changedBy: h.changedBy,
    createdAt: h.createdAt,
  }));
}

/**
 * Create or update an AATO record for a company's GST registration and financial year.
 * Rule: Manual entries must NOT automatically become VERIFIED.
 */
export async function saveAato(ctx: TenantContext, input: SaveAatoInput) {
  const { gstRegistrationId } = input;
  if (!gstRegistrationId) {
    throw new AppError('gstRegistrationId is required', 400);
  }

  // Tenant security: ensure GST registration belongs to caller's company
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');

  // Validate Indian FY logic
  const normalizedFy = normalizeFinancialYear(input.financialYear);
  if (!normalizedFy || !isValidFinancialYear(normalizedFy)) {
    throw new AppError(`Invalid financial year: "${input.financialYear}". Must follow Indian FY format "YYYY-YY" (e.g. "2024-25")`, 400);
  }

  // Validate turnover
  const turnoverNum = Number(input.turnover);
  if (!Number.isFinite(turnoverNum) || turnoverNum < 0) {
    throw new AppError('turnover must be a non-negative number', 400);
  }

  let precedingTurnoverNum: number | null = null;
  if (input.precedingTurnover !== undefined && input.precedingTurnover !== null) {
    precedingTurnoverNum = Number(input.precedingTurnover);
    if (!Number.isFinite(precedingTurnoverNum) || precedingTurnoverNum < 0) {
      throw new AppError('precedingTurnover must be a non-negative number', 400);
    }
  }

  // Source validation
  const source: AatoSource = input.source ?? 'MANUAL';
  if (!AATO_SOURCES.includes(source)) {
    throw new AppError(`Invalid source: "${source}". Allowed: ${AATO_SOURCES.join(', ')}`, 400);
  }

  // Verification status rule:
  // "Manual values must NOT automatically become VERIFIED."
  let verificationStatus: AatoVerificationStatus = 'UNVERIFIED';
  if (input.verificationStatus === 'VERIFIED') {
    verificationStatus = 'VERIFIED';
  } else if (input.verificationStatus === 'UNVERIFIED') {
    verificationStatus = 'UNVERIFIED';
  } else {
    // Defaulting: if source is MANUAL, MUST be UNVERIFIED
    verificationStatus = 'UNVERIFIED';
  }

  let verifiedDate: Date | null = null;
  let verifiedBy: string | null = null;

  if (verificationStatus === 'VERIFIED') {
    verifiedDate = input.verifiedDate ? new Date(input.verifiedDate) : new Date();
    verifiedBy = ctx.userId;
  }

  const result = await tenantTransaction(ctx.companyId, async (tx) => {
    // Check if record already exists for company + registration + FY
    const existing = await tx.companyGstAato.findUnique({
      where: {
        companyId_gstRegistrationId_financialYear: {
          companyId: ctx.companyId,
          gstRegistrationId,
          financialYear: normalizedFy,
        },
      },
    });

    const action = existing ? (verificationStatus === 'VERIFIED' && existing.verificationStatus !== 'VERIFIED' ? 'VERIFY' : 'UPDATE') : 'CREATE';

    let savedAato;
    if (existing) {
      savedAato = await tx.companyGstAato.update({
        where: { id: existing.id },
        data: {
          turnover: turnoverNum,
          precedingTurnover: precedingTurnoverNum !== null ? precedingTurnoverNum : existing.precedingTurnover,
          source,
          verificationStatus,
          verifiedDate: verificationStatus === 'VERIFIED' ? verifiedDate : null,
          verifiedBy: verificationStatus === 'VERIFIED' ? verifiedBy : null,
          notes: input.notes !== undefined ? input.notes : existing.notes,
        },
      });
    } else {
      savedAato = await tx.companyGstAato.create({
        data: {
          companyId: ctx.companyId,
          gstRegistrationId,
          financialYear: normalizedFy,
          turnover: turnoverNum,
          precedingTurnover: precedingTurnoverNum,
          source,
          verificationStatus,
          verifiedDate,
          verifiedBy,
          notes: input.notes ?? null,
        },
      });
    }

    // Record in history table
    await tx.companyGstAatoHistory.create({
      data: {
        companyId: ctx.companyId,
        aatoId: savedAato.id,
        gstRegistrationId,
        financialYear: normalizedFy,
        turnover: savedAato.turnover,
        precedingTurnover: savedAato.precedingTurnover,
        source: savedAato.source,
        verificationStatus: savedAato.verificationStatus,
        verifiedDate: savedAato.verifiedDate,
        notes: savedAato.notes,
        action,
        changedBy: ctx.userId,
      },
    });

    return { savedAato, action };
  });

  // Audit entry in global audit logs
  await createAuditEntry(
    'company_gst_aatos',
    result.savedAato.id,
    ctx.userId,
    result.action === 'CREATE' ? 'CREATE' : 'UPDATE',
    undefined,
    formatAatoRow(result.savedAato),
    ctx.companyId
  );

  return formatAatoRow(result.savedAato);
}
