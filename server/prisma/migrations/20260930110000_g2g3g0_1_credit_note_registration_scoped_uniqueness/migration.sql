-- G2g-3g-0.1: fix CreditNote numbering collision across multiple GST registrations.
--
-- CreditNote numbers are already generated per sellerRegistrationId (numberSequence.ts, key
-- `CN:${sellerRegistrationId ?? 'LEGACY'}`) — each registration draws from its own atomic counter,
-- so two registrations both legitimately produce a first note numbered "CN-2026-000001". The old
-- `credit_notes_companyId_creditNoteNumber_key` constraint was company-wide, not
-- registration-scoped, so the second registration's first note collided with the first
-- registration's and the insert failed.
--
-- Verified against the live dev database before writing this migration: `credit_notes` currently
-- has zero rows (the table shipped in 20260929120000_g2a_credit_debit_notes_foundation, one day
-- before this fix), so there is no existing duplicate data and nothing to reconcile or renumber.
--
-- Replaces the old company-wide constraint with two indexes:
--   1. A normal composite unique index scoped by (companyId, sellerRegistrationId,
--      creditNoteNumber) — covers every row with a real registration. Explicitly named because
--      Prisma's own default name for this column list is 64 bytes, one over Postgres's 63-byte
--      identifier limit, and would otherwise be silently truncated.
--   2. A PARTIAL unique index on (companyId, creditNoteNumber) WHERE "sellerRegistrationId" IS
--      NULL. Postgres never treats two NULLs as equal in a unique index, so index #1 alone would
--      not stop two legacy (no CompanyGstRegistration row) credit notes from sharing a number —
--      this closes that gap for the one group the atomic sequence's own 'LEGACY' key groups
--      together. Prisma's schema DSL cannot express a partial index, so this index exists only in
--      raw SQL here (mirrors this codebase's existing precedent of RLS policies and CHECK
--      constraints living outside schema.prisma).
--
-- No data is renamed, deleted, or renumbered. SalesInvoice, DebitNote, and NumberSequence
-- semantics are untouched.

-- DropIndex
DROP INDEX "credit_notes_companyId_creditNoteNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_company_registration_number_key" ON "credit_notes"("companyId", "sellerRegistrationId", "creditNoteNumber");

-- CreateIndex (partial — legacy/NULL-registration rows only; see comment above)
CREATE UNIQUE INDEX "credit_notes_legacy_number_key" ON "credit_notes"("companyId", "creditNoteNumber") WHERE "sellerRegistrationId" IS NULL;
