-- Per-user, per-company saved table layouts (column order / visibility / widths). Purely additive: one new table.
-- Personal preference data owned by one membership; the composite FK means the database refuses a layout whose
-- companyId differs from its member's company. Cascades only from the membership (it is not business data).
CREATE TABLE "user_table_layouts" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyUserId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "layout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_table_layouts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_table_layouts_tableId_shape" CHECK ("tableId" ~ '^[A-Za-z0-9._:-]{1,120}$')
);
CREATE UNIQUE INDEX "user_table_layouts_companyUserId_tableId_key" ON "user_table_layouts"("companyUserId", "tableId");
CREATE INDEX "user_table_layouts_companyId_idx" ON "user_table_layouts"("companyId");

ALTER TABLE "user_table_layouts" ADD CONSTRAINT "user_table_layouts_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_table_layouts" ADD CONSTRAINT "user_table_layouts_companyUserId_companyId_fkey"
  FOREIGN KEY ("companyUserId", "companyId") REFERENCES "company_users"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_table_layouts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "user_table_layouts"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
