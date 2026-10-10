-- Offer management, step 1 (schema only). A dated promotion on the SALE rates of a piece (making charge, VA,
-- stone, optionally metal). Purely additive: no existing row is read, updated or backfilled, and nothing
-- references these tables yet. Never cascades.

CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "offers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offers_dates_ordered" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE TABLE "offer_rules" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "stoneTypeId" TEXT,
    "categoryId" TEXT,
    "karat" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "offer_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "offer_rules_component_valid" CHECK ("component" IN ('MAKING_CHARGE', 'VA', 'STONE', 'METAL')),
    CONSTRAINT "offer_rules_mode_valid" CHECK ("mode" IN ('PERCENT_OFF', 'FIXED_RATE')),
    CONSTRAINT "offer_rules_value_nonneg" CHECK ("value" >= 0),
    CONSTRAINT "offer_rules_percent_max" CHECK ("mode" <> 'PERCENT_OFF' OR "value" <= 100),
    CONSTRAINT "offer_rules_stone_type_only_on_stone" CHECK ("stoneTypeId" IS NULL OR "component" = 'STONE')
);

CREATE UNIQUE INDEX "offers_id_companyId_key" ON "offers"("id", "companyId");
CREATE INDEX "offers_companyId_isActive_effectiveFrom_idx" ON "offers"("companyId", "isActive", "effectiveFrom");
CREATE INDEX "offer_rules_companyId_idx" ON "offer_rules"("companyId");
CREATE INDEX "offer_rules_offerId_idx" ON "offer_rules"("offerId");

ALTER TABLE "offers" ADD CONSTRAINT "offers_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offers" ADD CONSTRAINT "offers_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offers" ADD CONSTRAINT "offers_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "offer_rules" ADD CONSTRAINT "offer_rules_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_rules" ADD CONSTRAINT "offer_rules_offerId_companyId_fkey"
  FOREIGN KEY ("offerId", "companyId") REFERENCES "offers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_rules" ADD CONSTRAINT "offer_rules_stoneTypeId_companyId_fkey"
  FOREIGN KEY ("stoneTypeId", "companyId") REFERENCES "stone_types"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "offer_rules" ADD CONSTRAINT "offer_rules_categoryId_companyId_fkey"
  FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (FORCE is applied by db-secure.sql to every table carrying this policy).
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "offers"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "offer_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "offer_rules"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
