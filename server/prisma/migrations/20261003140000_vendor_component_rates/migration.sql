-- Vendor component pricing: PO -> GRN -> Tagging.
--
--   vendor_component_rates   a supplier's standing cost rate for a stone/pearl/bead component (StoneType, optionally a
--                            StoneGrade variant) in a unit. Only the DEFAULT a new PO line starts from.
--   po_item_components       the rate agreed on THIS PO line (copied from the vendor rate or overridden by the buyer).
--   grn_item_component_rates historical snapshot of those rates, written when the GRN line is received. Tagging reads it.
--
-- All three are new, company-owned, composite-FK'd to their parents and RLS-protected. No existing row changes.

CREATE TABLE "vendor_component_rates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "stoneTypeId" TEXT NOT NULL,
    "stoneGradeId" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'CT',
    "costRate" DECIMAL(12,4) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vendor_component_rates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendor_component_rates_companyId_idx" ON "vendor_component_rates"("companyId");
CREATE INDEX "vendor_component_rates_supplierId_stoneTypeId_idx" ON "vendor_component_rates"("supplierId", "stoneTypeId");

CREATE TABLE "po_item_components" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "poItemId" TEXT NOT NULL,
    "stoneTypeId" TEXT NOT NULL,
    "stoneGradeId" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'CT',
    "costRate" DECIMAL(12,4) NOT NULL,
    "rateSource" TEXT NOT NULL DEFAULT 'MANUAL',
    CONSTRAINT "po_item_components_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "po_item_components_companyId_idx" ON "po_item_components"("companyId");
CREATE INDEX "po_item_components_poItemId_idx" ON "po_item_components"("poItemId");

CREATE TABLE "grn_item_component_rates" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "grnItemId" TEXT NOT NULL,
    "stoneTypeId" TEXT NOT NULL,
    "stoneGradeId" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'CT',
    "costRate" DECIMAL(12,4) NOT NULL,
    CONSTRAINT "grn_item_component_rates_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "grn_item_component_rates_companyId_idx" ON "grn_item_component_rates"("companyId");
CREATE INDEX "grn_item_component_rates_grnItemId_idx" ON "grn_item_component_rates"("grnItemId");

ALTER TABLE "vendor_component_rates" ADD CONSTRAINT "vendor_component_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_component_rates" ADD CONSTRAINT "vendor_component_rates_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_component_rates" ADD CONSTRAINT "vendor_component_rates_stoneTypeId_companyId_fkey" FOREIGN KEY ("stoneTypeId", "companyId") REFERENCES "stone_types"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vendor_component_rates" ADD CONSTRAINT "vendor_component_rates_stoneGradeId_companyId_fkey" FOREIGN KEY ("stoneGradeId", "companyId") REFERENCES "stone_grades"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "po_item_components" ADD CONSTRAINT "po_item_components_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_item_components" ADD CONSTRAINT "po_item_components_poItemId_companyId_fkey" FOREIGN KEY ("poItemId", "companyId") REFERENCES "po_items"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "po_item_components" ADD CONSTRAINT "po_item_components_stoneTypeId_companyId_fkey" FOREIGN KEY ("stoneTypeId", "companyId") REFERENCES "stone_types"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_item_components" ADD CONSTRAINT "po_item_components_stoneGradeId_companyId_fkey" FOREIGN KEY ("stoneGradeId", "companyId") REFERENCES "stone_grades"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "grn_item_component_rates" ADD CONSTRAINT "grn_item_component_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grn_item_component_rates" ADD CONSTRAINT "grn_item_component_rates_grnItemId_companyId_fkey" FOREIGN KEY ("grnItemId", "companyId") REFERENCES "grn_items"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "grn_item_component_rates" ADD CONSTRAINT "grn_item_component_rates_stoneTypeId_companyId_fkey" FOREIGN KEY ("stoneTypeId", "companyId") REFERENCES "stone_types"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grn_item_component_rates" ADD CONSTRAINT "grn_item_component_rates_stoneGradeId_companyId_fkey" FOREIGN KEY ("stoneGradeId", "companyId") REFERENCES "stone_grades"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, same policy every tenant table carries (db-secure.sql FORCEs it and grants the runtime role).
ALTER TABLE "vendor_component_rates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "vendor_component_rates"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "po_item_components" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "po_item_components"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "grn_item_component_rates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "grn_item_component_rates"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
