// G2g-7g close-out — GSTR-3B post-filing mutation-control layer. The analogous protection
// `gstr1FilingProtection.ts` already provides for GSTR-1, extended to the SAME frozen
// `GstReturnPeriod` table with `returnType = 'GSTR3B'` (G2g-7g's own filing lifecycle,
// `gstr3bFilingPeriod.service.ts`, already establishes FILED/LOCKED on exactly these rows — this
// file reclassifies nothing and posts no figures of its own). No schema change.
//
// WHY THIS IS NOT THE SAME SHAPE AS gstr1FilingProtection.ts: GSTR-1 protects by DOCUMENT
// IDENTITY — "was this exact document represented in the exact filed snapshot's traceability
// array" — because a GSTR-1 snapshot carries a per-invoice/per-note id list
// (`Gstr1GstnTraceability`). GSTR-3B has no such per-document identity anywhere in its frozen
// pipeline (G2g-7b/7c/7d/7f are pure period-range AGGREGATIONS keyed by `receivedDate`/
// `invoiceDate`/`creditNoteDate`/`debitNoteDate`/`returnDate` — see each reporting service's own
// loader). So GSTR-3B protection is necessarily DATE-based: "does this mutation's own effective
// date fall inside a tax period, for this exact GST registration, whose GstReturnPeriod
// (returnType='GSTR3B') is already FILED or LOCKED." This also correctly covers a brand-new
// document being CREATED (e.g. a backdated invoice) which GSTR-1's traceability check could never
// catch — a document that doesn't exist yet cannot appear in any snapshot's traceability array,
// but it can absolutely be dated into an already-filed period.
//
// Authoritative "filed" signal — identical rule to GSTR-1 (brief §4): only GstReturnPeriod.status
// FILED or LOCKED blocks a mutation. SNAPSHOT_CREATED/FILING_ATTEMPTED (and no period row at all)
// never do — a snapshot or an attempt is not yet the permanent boundary; only
// `fileGstr3bReturnPeriod`/`lockGstr3bReturnPeriod` (gstr3bFilingPeriod.service.ts) establish it.
//
// CONCURRENCY (brief §7): reuses the exact row-lock pattern `gstr1FilingProtection.ts` already
// proved — lock the candidate GstReturnPeriod row(s), in the CALLER's own mutating transaction,
// BEFORE reading status. Postgres row locks conflict regardless of which SQL statement acquired
// them, so this read serializes against a concurrent `fileGstr3bReturnPeriod`/
// `lockGstr3bReturnPeriod` call on the same row: whichever locks first runs to completion before
// the other can even read.
//
// SCOPE (brief §2/§9): registration-specific and period-specific. A FILED/LOCKED period for
// Company A + Registration A + 092026 never blocks Registration B, a different tax period, or a
// different company — the WHERE clause below is scoped on exactly company + registration +
// returnType='GSTR3B' + the one resolved taxPeriod, nothing broader.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { resolveFilingPeriodMmYYYY } from './gstr3bReporting.service';

const GSTR3B_RETURN_TYPE = 'GSTR3B';
const PROTECTING_PERIOD_STATUSES = ['FILED', 'LOCKED'] as const;

export interface Gstr3bFilingProtectionMatch {
  returnPeriodId: string;
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
  status: string;
}

type PeriodRow = { id: string; financialYear: string; taxPeriod: string; status: string };

/**
 * Looks up whether `documentDate` falls inside a FILED/LOCKED GSTR-3B return period for this
 * exact company + GST registration. Returns null (no protection) when there is no such period at
 * all, or when one exists but is not yet FILED/LOCKED (brief §4 — never inferred from snapshot
 * existence alone). `financialYear` is intentionally NOT part of the WHERE clause — `taxPeriod`
 * (MMYYYY) already fully disambiguates the calendar month+year on its own; filtering on a
 * second, independently-resolved financialYear string risks a spurious mismatch against the
 * period's own stored value for no added selectivity.
 */
export async function findGstr3bFilingProtection(
  tx: Prisma.TransactionClient,
  companyId: string,
  gstRegistrationId: string,
  documentDate: Date,
): Promise<Gstr3bFilingProtectionMatch | null> {
  if (!companyId || !gstRegistrationId || !documentDate) return null;

  const taxPeriod = resolveFilingPeriodMmYYYY(documentDate);

  // Row-lock first (brief §7) — serializes against a concurrent fileGstr3bReturnPeriod/
  // lockGstr3bReturnPeriod call on the same period row. A registration with no period for this
  // exact taxPeriod yet locks zero rows (fast path, no contention).
  await tx.$queryRaw`
    SELECT "id" FROM "gst_return_periods"
    WHERE "companyId" = ${companyId} AND "gstRegistrationId" = ${gstRegistrationId}
      AND "returnType" = ${GSTR3B_RETURN_TYPE} AND "taxPeriod" = ${taxPeriod}
    FOR UPDATE
  `;

  const rows = await tx.$queryRaw<PeriodRow[]>`
    SELECT "id", "financialYear", "taxPeriod", "status" FROM "gst_return_periods"
    WHERE "companyId" = ${companyId} AND "gstRegistrationId" = ${gstRegistrationId}
      AND "returnType" = ${GSTR3B_RETURN_TYPE} AND "taxPeriod" = ${taxPeriod}
    LIMIT 1
  `;
  const period = rows[0];
  if (!period) return null;
  if (!(PROTECTING_PERIOD_STATUSES as readonly string[]).includes(period.status)) return null;

  return {
    returnPeriodId: period.id, gstRegistrationId,
    financialYear: period.financialYear, taxPeriod: period.taxPeriod, status: period.status,
  };
}

/** Deterministic business error (brief §8), the GSTR-3B counterpart of Gstr1FilingProtectionError.
 *  A distinct errorCode (`GSTR3B_FILED_PERIOD_IMMUTABLE`) so an HTTP caller/test can tell this
 *  apart from a GSTR-1 rejection, a permission/ownership failure, a validation error, or a missing
 *  registration — the global error handler (middleware/error.ts) only ever surfaces `err.message`,
 *  so every fact is embedded in the message text, and also kept as plain properties for a caller
 *  (or a test) that wants them directly. */
export class Gstr3bFilingProtectionError extends AppError {
  readonly errorCode = 'GSTR3B_FILED_PERIOD_IMMUTABLE' as const;
  readonly documentType: string;
  readonly documentId: string;
  readonly gstRegistrationId: string;
  readonly financialYear: string;
  readonly taxPeriod: string;
  readonly returnPeriodId: string;
  readonly periodStatus: string;
  readonly action: string;

  constructor(match: Gstr3bFilingProtectionMatch, documentType: string, documentId: string, action: string) {
    super(
      `This ${documentType.toLowerCase().replace(/_/g, ' ')} (${documentId}) falls within a GSTR-3B return period ` +
      `that is already ${match.status} — GST registration ${match.gstRegistrationId}, period ` +
      `${match.financialYear}/${match.taxPeriod} — and its underlying GST records cannot be ${action}. ` +
      `[GSTR3B_FILED_PERIOD_IMMUTABLE]`,
      409,
    );
    this.name = 'Gstr3bFilingProtectionError';
    this.documentType = documentType;
    this.documentId = documentId;
    this.gstRegistrationId = match.gstRegistrationId;
    this.financialYear = match.financialYear;
    this.taxPeriod = match.taxPeriod;
    this.returnPeriodId = match.returnPeriodId;
    this.periodStatus = match.status;
    this.action = action;
  }
}

/**
 * The reusable mutation guard (brief §6: `assertGstr3bPeriodMutable`). Call from inside the SAME
 * transaction as the mutation, after ownership/dependency/other-state checks, once the document's
 * own effective date and attributed GST registration are known. Resolves silently (no protection)
 * when either is missing — a document never attributed to a registration (no branch GST
 * registration configured, a non-INR/non-taxable line, ...) was never representable in any
 * GstReturnPeriod, which is itself always keyed by one; same posture as `assertGstr1DocumentMutable`.
 * Does not perform the mutation's own permission/ownership checks (brief §19) — those remain the
 * caller's job.
 */
export async function assertGstr3bPeriodMutable(
  tx: Prisma.TransactionClient,
  companyId: string,
  params: {
    documentType: string;
    documentId: string;
    gstRegistrationId: string | null | undefined;
    documentDate: Date | null | undefined;
    action: string;
  },
): Promise<void> {
  const { documentType, documentId, gstRegistrationId, documentDate, action } = params;
  if (!gstRegistrationId || !documentDate) return;

  const match = await findGstr3bFilingProtection(tx, companyId, gstRegistrationId, documentDate);
  if (!match) return;

  throw new Gstr3bFilingProtectionError(match, documentType, documentId, action);
}

/**
 * Optional, compact `GSTR3B_MUTATION_BLOCKED` audit entry (brief §13) — call from a `catch` block
 * AROUND the mutation's own `tenantTransaction`, never from inside it (identical reasoning to
 * `auditGstr1MutationBlocked`: `createAuditEntry` writes via its own connection, so it must run
 * only once the enclosing transaction has actually aborted). A no-op for any other error — never
 * records a false "mutation blocked" entry for an unrelated failure. Wired only into the
 * cancel/reversal-style call sites that already follow this try/catch-audit convention for
 * GSTR-1 (brief §13: "follow the existing convention" — creation paths roll back on throw and
 * record nothing, matching `gstr1FilingProtection.ts`'s own identical choice).
 */
export async function auditGstr3bMutationBlocked(
  err: unknown,
  tableName: string,
  userId: string,
  companyId: string,
): Promise<void> {
  if (!(err instanceof Gstr3bFilingProtectionError)) return;
  await createAuditEntry(
    tableName, err.documentId, userId, 'GSTR3B_MUTATION_BLOCKED',
    undefined,
    {
      documentType: err.documentType, attemptedAction: err.action,
      gstRegistrationId: err.gstRegistrationId, financialYear: err.financialYear, taxPeriod: err.taxPeriod,
      returnPeriodId: err.returnPeriodId, periodStatus: err.periodStatus,
    },
    companyId,
  );
}
