-- G2g-7a — Inward GST Foundation & Multi-GSTIN Attribution (procurement/data-model phase only;
-- no GSTR-3B aggregation, ITC eligibility, RCM calculation, or journal changes in this phase).
--
-- Three purely additive changes, all nullable (or safely defaulted) so every existing row is
-- unaffected and nothing is backfilled/guessed (CLAUDE.md §13):
--
--   grn_items.buyerRegistrationId  — which of the company's own GST registrations this inward
--     supply is attributed to. Stamped going forward by createTagFromGrnItem/openPurchaseLot at
--     the same moment those functions already stamp taxableValue/inputCgst/Sgst/Igst; existing
--     rows stay NULL. Composite FK to company_gst_registrations(id, companyId) — same pattern as
--     branches.gstRegistrationId (20260929032454_g1_gst_foundation) and
--     gst_return_periods.gstRegistrationId (20261001120000_g2g6a_gst_filing_foundation).
--
--   po_items.taxCategory — the statutory classification of a purchase line's supply (TAXABLE |
--     EXEMPT | NIL_RATED | NON_GST | ZERO_RATED — shared/taxCategory.ts). Plain nullable text,
--     no FK (five fixed statutory values, not a company-configurable master). Existing rows stay
--     NULL; createPO defaults a newly-created line to TAXABLE only when the caller omits it.
--
--   suppliers.isComposition — whether the supplier is GST-Composition-registered. NOT NULL with
--     a DEFAULT of false, since every existing supplier is presumed a regular registered dealer
--     (the status quo assumption this codebase already made everywhere before this column
--     existed) unless explicitly marked otherwise going forward.
--
-- No RLS/policy change needed: grn_items, po_items and suppliers already have FORCE ROW LEVEL
-- SECURITY and their own tenant_isolation policy; new nullable/defaulted columns on an existing
-- RLS table need no new policy. No DML in this migration — DDL only, so FORCE RLS on these
-- tables does not affect it (CLAUDE.md §11: "a migration that touches TENANT ROWS must lift
-- FORCE RLS" — this migration touches no rows, only the schema).

-- AlterTable
ALTER TABLE "grn_items" ADD COLUMN     "buyerRegistrationId" TEXT;

-- AlterTable
ALTER TABLE "po_items" ADD COLUMN     "taxCategory" TEXT;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "isComposition" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "grn_items_buyerRegistrationId_idx" ON "grn_items"("buyerRegistrationId");

-- AddForeignKey: composite — the database refuses a GRN line's buyer-registration pointer
-- crossing into another company's registration. RESTRICT: a registration a historical inward
-- document is attributed to is never deletable out from under it (and in practice is never
-- hard-deleted at all today — company.service.ts only creates/updates CompanyGstRegistration).
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_buyerRegistrationId_companyId_fkey" FOREIGN KEY ("buyerRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
