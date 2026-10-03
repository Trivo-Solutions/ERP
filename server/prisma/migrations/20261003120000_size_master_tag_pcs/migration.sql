-- Size master (company-owned) + JewelryTag.sizeId / noOfPcs. Pure additive: new table, two nullable
-- columns, composite FKs. No existing row is touched (nothing to lift FORCE RLS around).

CREATE TABLE "sizes" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sizes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sizes_companyId_code_key" ON "sizes"("companyId", "code");
CREATE UNIQUE INDEX "sizes_id_companyId_key" ON "sizes"("id", "companyId");
CREATE INDEX "sizes_companyId_idx" ON "sizes"("companyId");

ALTER TABLE "jewelry_tags" ADD COLUMN "sizeId" TEXT, ADD COLUMN "noOfPcs" INTEGER;

ALTER TABLE "sizes" ADD CONSTRAINT "sizes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sizes" ADD CONSTRAINT "sizes_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_sizeId_companyId_fkey" FOREIGN KEY ("sizeId", "companyId") REFERENCES "sizes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RowLevelSecurity: same shape as the sibling masters (collections, stock_types, ...) — policy here,
-- FORCE applied by db-secure.sql on every deploy (it FORCEs every table carrying a tenant_isolation policy).
ALTER TABLE "sizes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sizes"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
