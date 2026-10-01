-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "gstRegistrationId" TEXT;

-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "cgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "igstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "lineDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "lineTotalTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sgstAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "taxableValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "uom" TEXT;

-- AlterTable
ALTER TABLE "tax_invoices" ADD COLUMN     "buyerAddress" TEXT,
ADD COLUMN     "buyerCity" TEXT,
ADD COLUMN     "buyerCountry" TEXT,
ADD COLUMN     "buyerGstin" TEXT,
ADD COLUMN     "buyerName" TEXT,
ADD COLUMN     "buyerPan" TEXT,
ADD COLUMN     "buyerPincode" TEXT,
ADD COLUMN     "buyerState" TEXT,
ADD COLUMN     "buyerStateCode" TEXT,
ADD COLUMN     "sellerAddress" TEXT,
ADD COLUMN     "sellerCity" TEXT,
ADD COLUMN     "sellerCountry" TEXT,
ADD COLUMN     "sellerDistrict" TEXT,
ADD COLUMN     "sellerLegalName" TEXT,
ADD COLUMN     "sellerPincode" TEXT,
ADD COLUMN     "sellerRegistrationId" TEXT,
ADD COLUMN     "sellerStateCode" TEXT,
ADD COLUMN     "sellerTradeName" TEXT;

-- CreateTable
CREATE TABLE "company_gst_registrations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "gstin" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "stateCode" TEXT NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "district" TEXT,
    "pincode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'India',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_gst_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_invoice_templates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "branchId" TEXT,
    "layout" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_invoice_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_gst_registrations_companyId_idx" ON "company_gst_registrations"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "company_gst_registrations_companyId_gstin_key" ON "company_gst_registrations"("companyId", "gstin");

-- CreateIndex
CREATE UNIQUE INDEX "company_gst_registrations_id_companyId_key" ON "company_gst_registrations"("id", "companyId");

-- CreateIndex
CREATE INDEX "tax_invoice_templates_companyId_idx" ON "tax_invoice_templates"("companyId");

-- CreateIndex
CREATE INDEX "tax_invoice_templates_branchId_idx" ON "tax_invoice_templates"("branchId");

-- AddForeignKey
ALTER TABLE "company_gst_registrations" ADD CONSTRAINT "company_gst_registrations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoice_templates" ADD CONSTRAINT "tax_invoice_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoice_templates" ADD CONSTRAINT "tax_invoice_templates_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoice_templates" ADD CONSTRAINT "tax_invoice_templates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_gstRegistrationId_companyId_fkey" FOREIGN KEY ("gstRegistrationId", "companyId") REFERENCES "company_gst_registrations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- G1 Part Q — backfill, run BEFORE RLS is enabled on the brand-new company_gst_registrations
-- table below (this migration runs as the owner role, which this database's grants do NOT
-- exempt from FORCE ROW LEVEL SECURITY — confirmed the hard way: enabling the policy first and
-- inserting after it failed with "new row violates row-level security policy", since no request
-- context here ever sets app.tenant_company_id). Doing every backfill INSERT/UPDATE while the two
-- new tables are still plain, unrestricted tables — then enabling RLS on them only at the very
-- end — avoids needing a lift/restore dance on tables that don't have FORCE RLS applied yet.
--
-- Every existing company with a Company.gstin gets exactly one CompanyGstRegistration row
-- (isPrimary/isActive true), migrated from its own legacy gstin/stateCode/address — so a
-- single-GSTIN company keeps working with zero manual repair. A company with no gstin at all
-- gets no row (createInvoice's existing `company.gstin ?? 'N/A'` fallback behavior is unchanged
-- for it — see sales.service.ts resolveSellerRegistration).
INSERT INTO "company_gst_registrations"
  ("id","companyId","gstin","legalName","tradeName","stateCode","address","country","isPrimary","isActive","createdAt","updatedAt")
SELECT
  'gstreg_' || c."id", c."id", c."gstin", c."name", NULL, COALESCE(c."stateCode", ''), c."address", 'India', true, true, now(), now()
FROM "companies" c
WHERE c."gstin" IS NOT NULL AND c."gstin" <> ''
ON CONFLICT ("companyId","gstin") DO NOTHING;

-- branches / tax_invoices are pre-existing tenant tables that already have FORCE ROW LEVEL
-- SECURITY from earlier migrations (when it's on): FORCE is lifted for the statement and
-- restored (only where it was already on — a single-role dev/test DB that never ran
-- db-secure.sql is left exactly as it was) — same pattern as
-- 20260925090000_purchase_input_gst / 20260925100000_supplier_payments.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'branches' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "branches" NO FORCE ROW LEVEL SECURITY; END IF;

  -- Every branch of a company that got a registration above is pointed at that (its only, primary)
  -- registration — preserving today's single-GSTIN-company behavior exactly (CLAUDE.md Part B).
  UPDATE "branches" b
  SET "gstRegistrationId" = g."id"
  FROM "company_gst_registrations" g
  WHERE g."companyId" = b."companyId" AND g."isPrimary" = true AND b."gstRegistrationId" IS NULL;

  IF forced THEN ALTER TABLE "branches" FORCE ROW LEVEL SECURITY; END IF;
END $$;

DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'tax_invoices' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "tax_invoices" NO FORCE ROW LEVEL SECURITY; END IF;

  -- One-time historical snapshot for every invoice that predates G1 (Part Q): the best available
  -- data is what Company/Client look like TODAY, which is an approximation, not a true
  -- point-in-time record (no such record existed before this migration) — recorded here as the
  -- documented limitation, not silently presented as exact. Every invoice created AFTER this
  -- migration gets a real, exact-at-the-time snapshot from sales.service.ts. buyerStateCode is
  -- backfilled only by an exact (case/whitespace-insensitive) name match against state_master,
  -- not the full alias-aware resolveStateCode() — a deliberately partial best-effort backfill
  -- rather than reimplementing that resolution in SQL.
  UPDATE "tax_invoices" t
  SET
    "sellerRegistrationId" = g."id",
    "sellerLegalName" = COALESCE(g."legalName", c."name"),
    "sellerTradeName" = g."tradeName",
    "sellerStateCode" = COALESCE(g."stateCode", c."stateCode"),
    "sellerAddress" = COALESCE(g."address", c."address"),
    "sellerCity" = g."city",
    "sellerDistrict" = g."district",
    "sellerPincode" = g."pincode",
    "sellerCountry" = COALESCE(g."country", 'India'),
    "buyerName" = cl."name",
    "buyerGstin" = cl."gstNumber",
    "buyerPan" = cl."panNumber",
    "buyerAddress" = cl."address",
    "buyerCity" = cl."city",
    "buyerState" = cl."state",
    "buyerStateCode" = sm."code",
    "buyerPincode" = cl."pincode",
    "buyerCountry" = cl."country"
  FROM "sales_invoices" si
  LEFT JOIN "companies" c ON c."id" = si."companyId"
  LEFT JOIN "company_gst_registrations" g ON g."companyId" = si."companyId" AND g."isPrimary" = true
  LEFT JOIN "clients" cl ON cl."id" = si."clientId"
  LEFT JOIN "state_master" sm ON lower(trim(sm."name")) = lower(trim(cl."state"))
  WHERE si."id" = t."invoiceId" AND si."companyId" = t."companyId" AND t."sellerLegalName" IS NULL;

  IF forced THEN ALTER TABLE "tax_invoices" FORCE ROW LEVEL SECURITY; END IF;
END $$;

-- RowLevelSecurity: both new tables are company-owned tenant tables — same policy shape as every
-- other tenant table (see prisma/production-rls-roles.sql). Enabled only now, AFTER the backfill
-- above, precisely so that backfill (run by the owner role, with no app.tenant_company_id set)
-- could freely read/write every company's rows in one pass.
ALTER TABLE "company_gst_registrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_gst_registrations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "company_gst_registrations"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

ALTER TABLE "tax_invoice_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tax_invoice_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tax_invoice_templates"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
