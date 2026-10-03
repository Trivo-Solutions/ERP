-- 1. Sub-category code unique per category (was per company): the same code may sit under different
--    categories. Strictly looser than before, so no existing row can violate it.
DROP INDEX "sub_categories_companyId_code_key";
CREATE UNIQUE INDEX "sub_categories_companyId_categoryId_code_key" ON "sub_categories"("companyId", "categoryId", "code");

-- 2. Old Gold rate on the daily metal rate row (optional).
ALTER TABLE "metal_rates" ADD COLUMN "ogRatePerGram" DECIMAL(12,4);

-- 3. Setting Type master (company-owned). Pure additive: new table, nothing existing is touched.
CREATE TABLE "setting_types" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "setting_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "setting_types_companyId_code_key" ON "setting_types"("companyId", "code");
CREATE UNIQUE INDEX "setting_types_id_companyId_key" ON "setting_types"("id", "companyId");
CREATE INDEX "setting_types_companyId_idx" ON "setting_types"("companyId");
ALTER TABLE "setting_types" ADD CONSTRAINT "setting_types_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "setting_types" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "setting_types"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
