// G2g-6d — GSTR-1 post-filing mutation-control layer, UPGRADED in G2g-6e to the authoritative
// period-lifecycle boundary. Builds on the frozen G2g-6a schema (GstReturnPeriod/GstFilingSnapshot/
// GstFilingAttempt) and the frozen G2g-6b/6c services (gstr1FilingSnapshot.service.ts /
// gstr1FilingAttempt.service.ts) — reclassifies NOTHING, computes NO GST figures, and does not
// modify any of those files. This file is ONLY the protection lookup + the reusable mutation guard;
// the four call sites that use it (amendInvoice/voidInvoice in sales.service.ts, cancelCreditNote in
// creditNote.service.ts, cancelSalesDebitNote in salesDebitNote.service.ts) are each a narrowly-
// scoped integration point, not a rewrite of those functions' own existing logic. The public guard
// API (`assertGstr1DocumentMutable`) is unchanged by the G2g-6e upgrade below — none of those four
// call sites needed to change.
//
// Authoritative "filed" signal (G2g-6e, brief §9 — supersedes G2g-6d's own former interpretation,
// quoted below for context): "this document was filed" is now read off GstReturnPeriod.status
// (FILED or LOCKED) + its exact filedSnapshotId, not off a bare ACCEPTED GstFilingAttempt. An
// ACCEPTED attempt records only that an accepted outcome was recorded (G2g-6c); it does not by
// itself establish the permanent filing boundary — gstr1FilingPeriod.service.ts's
// `fileGstr1ReturnPeriod` is the one controlled transition that does, and only from an attempt that
// passes every eligibility check in that file at the moment of transition. A BLOCKED or SUPERSEDED
// snapshot can never become a period's filedSnapshotId (fileGstr1ReturnPeriod re-checks this fresh,
// under lock, at transition time) — so, as before, this file never needs to re-check
// snapshot.status itself (brief §15 still holds, now via a different mechanism).
//
// [FORMER G2g-6d interpretation, now replaced]: "GstReturnPeriod.status never reaches FILED/LOCKED
// in this codebase... so 'this document was filed' is read off... an ACCEPTED GstFilingAttempt
// referencing the exact snapshot." That was correct for G2g-6d's own scope (FILED/LOCKED genuinely
// didn't exist yet) and is why G2g-6d's own test fixtures had to be updated for this phase — see
// g2g6dGstr1MutationGuard.test.ts's `acceptedFiling()` helper, which now also performs the
// authoritative FILED transition on the period row it builds, not just the attempt.
//
// Provenance source (brief §5/§14): GstFilingSnapshot.canonicalDtoJson.traceability
// (Gstr1GstnTraceability, gstr1GstnExport.types.ts) — the ONLY place the frozen pipeline keeps a
// TRIVO document id alongside a GSTR-1 section, populated unmodified by gstr1GstnAdapter.ts (frozen)
// at snapshot-build time. Nothing here re-derives or duplicates classification.
//
// KNOWN GAP, reported per the brief's §5/§11 rather than worked around: B2CS is aggregated by
// GSTN's own statutory rule "by reporting dimension, never by invoice identity"
// (gstr1OutwardAggregation.ts's own rule-16 comment) — there is no per-invoice id anywhere in the
// frozen pipeline's B2CS output for this helper to read, and re-deriving one here would mean
// re-implementing part of the frozen classifier against this file's own copy of "outward invoices
// in scope" — exactly the "new GST calculation/classification logic" the brief's hard scope
// boundary forbids. B2CS invoices are therefore NOT individually protected in this phase — only
// B2B/B2CL sales invoices, and CDNR/CDNUR credit notes and sales debit notes (every one of which
// DOES carry a TRIVO id in `traceability`).
//
// CONCURRENCY (G2g-6d's own documented gap, CLOSED in G2g-6e — brief §8): `findGstr1FilingProtection`
// now takes a row lock on every GstReturnPeriod for the target registration, inside the caller's own
// mutating transaction, BEFORE reading protection state. `fileGstr1ReturnPeriod`/
// `lockGstr1ReturnPeriod` (gstr1FilingPeriod.service.ts) take the identical FOR UPDATE lock on the
// one specific period row they transition. Postgres row locks conflict regardless of which SQL
// statement acquired them, so a multi-row "lock every period for this registration" here and a
// single-row "lock this one period" there still serialize against each other on the shared row:
// whichever transaction locks first runs to completion (commit or abort) before the other can even
// read — closing the "mutate reads stale not-yet-filed state, then writes after FILED commits"
// race G2g-6d left open.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';

export type Gstr1ProtectedDocumentType = 'SALES_INVOICE' | 'CREDIT_NOTE' | 'SALES_DEBIT_NOTE';

const DOCUMENT_LABEL: Record<Gstr1ProtectedDocumentType, string> = {
  SALES_INVOICE: 'sales invoice',
  CREDIT_NOTE: 'credit note',
  SALES_DEBIT_NOTE: 'sales debit note',
};

// Maps each protected document type to the traceability array field(s) that can carry its id
// (gstr1GstnExport.types.ts: Gstr1GstnTraceability) — mirrors gstr1GstnAdapter.ts's own population
// of that block exactly; never invented here.
const TRACEABILITY_FIELDS: Record<Gstr1ProtectedDocumentType, string[]> = {
  SALES_INVOICE: ['b2bInvoiceIds', 'b2clInvoiceIds'],
  CREDIT_NOTE: ['cdnrCreditNoteIds', 'cdnurCreditNoteIds'],
  SALES_DEBIT_NOTE: ['cdnrDebitNoteIds', 'cdnurDebitNoteIds'],
};

export interface Gstr1FilingProtectionMatch {
  snapshotId: string;
  returnPeriodId: string;
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
  filingAttemptId: string;
}

type ProtectionRow = {
  returnPeriodId: string;
  financialYear: string;
  taxPeriod: string;
  snapshotId: string;
  filingAttemptId: string | null;
  traceability: unknown;
};

const PROTECTING_PERIOD_STATUSES = ['FILED', 'LOCKED'] as const;

/**
 * Looks up whether `documentId` (a SalesInvoice/CreditNote/SalesDebitNote id) is represented in the
 * EXACT filed snapshot of any FILED/LOCKED GstReturnPeriod for this exact company + GST registration
 * (brief §16: protection is registration-specific — a different registration's filing never
 * protects this document even within the same company).
 *
 * "Represented" means: a GstReturnPeriod with status FILED or LOCKED has a `filedSnapshotId` whose
 * own immutable `canonicalDtoJson.traceability` array for this document type contains this exact
 * id (brief §10 — only the exact filed snapshot's documents are protected; a document appearing
 * only in some OTHER, non-filed snapshot for the same period, e.g. an earlier BLOCKED draft or a
 * later DRAFT that never itself got filed, is not protected by that other snapshot's contents).
 *
 * G2g-6e concurrency fix (brief §8, see this file's own header): takes a row lock on every return
 * period for this registration, in the CALLER's own transaction, before reading — this is what
 * serializes a concurrent `fileGstr1ReturnPeriod`/`lockGstr1ReturnPeriod` call against this read.
 * A registration with zero periods locks zero rows (fast path, no contention).
 */
export async function findGstr1FilingProtection(
  tx: Prisma.TransactionClient,
  companyId: string,
  gstRegistrationId: string,
  documentType: Gstr1ProtectedDocumentType,
  documentId: string,
): Promise<Gstr1FilingProtectionMatch | null> {
  if (!companyId || !gstRegistrationId || !documentId) return null;

  await tx.$queryRaw`
    SELECT "id" FROM "gst_return_periods" WHERE "companyId" = ${companyId} AND "gstRegistrationId" = ${gstRegistrationId} FOR UPDATE
  `;

  const rows = await tx.$queryRaw<ProtectionRow[]>`
    SELECT p."id" as "returnPeriodId", p."financialYear", p."taxPeriod",
           p."filedSnapshotId" as "snapshotId", p."filedByAttemptId" as "filingAttemptId",
           s."canonicalDtoJson"->'traceability' as "traceability"
    FROM "gst_return_periods" p
    JOIN "gst_filing_snapshots" s ON s."id" = p."filedSnapshotId" AND s."companyId" = p."companyId"
    WHERE p."companyId" = ${companyId} AND p."gstRegistrationId" = ${gstRegistrationId}
      AND p."status" IN (${PROTECTING_PERIOD_STATUSES[0]}, ${PROTECTING_PERIOD_STATUSES[1]})
      AND p."filedSnapshotId" IS NOT NULL
  `;

  const fields = TRACEABILITY_FIELDS[documentType];
  for (const row of rows) {
    const traceability = row.traceability as Record<string, unknown> | null;
    if (!traceability) continue;
    for (const field of fields) {
      const ids = traceability[field];
      if (Array.isArray(ids) && ids.includes(documentId)) {
        return {
          snapshotId: row.snapshotId, returnPeriodId: row.returnPeriodId, gstRegistrationId,
          financialYear: row.financialYear, taxPeriod: row.taxPeriod, filingAttemptId: row.filingAttemptId ?? '',
        };
      }
    }
  }
  return null;
}

/** Deterministic business error (brief §17). The message carries every requested detail (document
 *  type, id, filing period, registration, reason) because this codebase's global error handler
 *  (middleware/error.ts) only ever surfaces `err.message` to the HTTP response, never extra fields —
 *  the same facts are also kept as plain properties for a caller that wants them directly (e.g. the
 *  optional audit helper below, or a test). */
export class Gstr1FilingProtectionError extends AppError {
  readonly errorCode = 'GSTR1_FILED_DOCUMENT_IMMUTABLE' as const;
  readonly documentType: Gstr1ProtectedDocumentType;
  readonly documentId: string;
  readonly gstRegistrationId: string;
  readonly financialYear: string;
  readonly taxPeriod: string;
  readonly returnPeriodId: string;
  readonly snapshotId: string;
  readonly filingAttemptId: string;
  readonly action: string;

  constructor(match: Gstr1FilingProtectionMatch, documentType: Gstr1ProtectedDocumentType, documentId: string, action: string) {
    super(
      `This ${DOCUMENT_LABEL[documentType]} (${documentId}) was represented in an accepted GSTR-1 filing ` +
      `— GST registration ${match.gstRegistrationId}, period ${match.financialYear}/${match.taxPeriod} — ` +
      `and cannot be ${action}. [GSTR1_FILED_DOCUMENT_IMMUTABLE]`,
      409,
    );
    this.name = 'Gstr1FilingProtectionError';
    this.documentType = documentType;
    this.documentId = documentId;
    this.gstRegistrationId = match.gstRegistrationId;
    this.financialYear = match.financialYear;
    this.taxPeriod = match.taxPeriod;
    this.returnPeriodId = match.returnPeriodId;
    this.snapshotId = match.snapshotId;
    this.filingAttemptId = match.filingAttemptId;
    this.action = action;
  }
}

/**
 * The reusable mutation guard (brief §6). Call from inside the SAME transaction as the mutation
 * (brief §20), after ownership/dependency checks and after the document's current row has been
 * read under lock — the exact point `amendInvoice`/`voidInvoice`/`cancelCreditNote`/
 * `cancelSalesDebitNote` already run their own other state guards (status/IRN/etc). Resolves
 * silently when the document is not protected (including when it has no `gstRegistrationId` at
 * all — a document never attributed to a registration was never representable in any
 * GstReturnPeriod, which is itself always keyed by one). Throws `Gstr1FilingProtectionError` (409)
 * when it is. Does not perform the mutation's own permission/ownership checks — those remain the
 * caller's job (brief §19: "does not bypass the existing permission checks").
 */
export async function assertGstr1DocumentMutable(
  tx: Prisma.TransactionClient,
  companyId: string,
  params: {
    documentType: Gstr1ProtectedDocumentType;
    documentId: string;
    gstRegistrationId: string | null | undefined;
    action: string;
  },
): Promise<void> {
  const { documentType, documentId, gstRegistrationId, action } = params;
  if (!gstRegistrationId) return;

  const match = await findGstr1FilingProtection(tx, companyId, gstRegistrationId, documentType, documentId);
  if (!match) return;

  throw new Gstr1FilingProtectionError(match, documentType, documentId, action);
}

/**
 * Optional, compact `GSTR1_MUTATION_BLOCKED` audit entry (brief §18) — call from a `catch` block
 * AROUND the mutation's own `tenantTransaction`, never from inside it (same reasoning every other
 * audit call in this codebase already follows — `createAuditEntry` writes via its own connection,
 * so recording it before the enclosing transaction has actually settled is the established wrong
 * pattern elsewhere; here it is simplest to just call this after the transaction has aborted and
 * the `Gstr1FilingProtectionError` has propagated out). A no-op for any other error — never records
 * a false "mutation blocked" entry for an unrelated failure, and never floods AuditLog (brief §18)
 * since it only ever fires on this one specific rejection.
 */
export async function auditGstr1MutationBlocked(
  err: unknown,
  tableName: string,
  userId: string,
  companyId: string,
): Promise<void> {
  if (!(err instanceof Gstr1FilingProtectionError)) return;
  await createAuditEntry(
    tableName, err.documentId, userId, 'GSTR1_MUTATION_BLOCKED',
    undefined,
    {
      documentType: err.documentType, attemptedAction: err.action,
      gstRegistrationId: err.gstRegistrationId, financialYear: err.financialYear, taxPeriod: err.taxPeriod,
      returnPeriodId: err.returnPeriodId, snapshotId: err.snapshotId, filingAttemptId: err.filingAttemptId,
    },
    companyId,
  );
}
