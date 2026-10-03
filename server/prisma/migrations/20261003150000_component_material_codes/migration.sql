-- A PO/vendor/GRN component may now be a Material Code (the same master the tag's Materials tab lists under
-- "Materials") as well as a Stone Type + Grade (its "Stones" group). Exactly one of the two identifies a row.
--
-- Additive for existing data: every existing row is a stone row (stoneTypeId set, materialCodeId NULL), so the new
-- CHECK holds for all of them. No row is read or changed, so FORCE RLS needs no lifting here.

ALTER TABLE "vendor_component_rates" ALTER COLUMN "stoneTypeId" DROP NOT NULL, ADD COLUMN "materialCodeId" TEXT;
ALTER TABLE "po_item_components"     ALTER COLUMN "stoneTypeId" DROP NOT NULL, ADD COLUMN "materialCodeId" TEXT;
ALTER TABLE "grn_item_component_rates" ALTER COLUMN "stoneTypeId" DROP NOT NULL, ADD COLUMN "materialCodeId" TEXT;

ALTER TABLE "vendor_component_rates" ADD CONSTRAINT "vendor_component_rates_materialCodeId_companyId_fkey" FOREIGN KEY ("materialCodeId", "companyId") REFERENCES "material_codes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "po_item_components" ADD CONSTRAINT "po_item_components_materialCodeId_companyId_fkey" FOREIGN KEY ("materialCodeId", "companyId") REFERENCES "material_codes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "grn_item_component_rates" ADD CONSTRAINT "grn_item_component_rates_materialCodeId_companyId_fkey" FOREIGN KEY ("materialCodeId", "companyId") REFERENCES "material_codes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one identity per row; a grade only narrows a stone.
ALTER TABLE "vendor_component_rates" ADD CONSTRAINT "vendor_component_rates_one_identity" CHECK (("stoneTypeId" IS NULL) <> ("materialCodeId" IS NULL) AND ("materialCodeId" IS NULL OR "stoneGradeId" IS NULL));
ALTER TABLE "po_item_components" ADD CONSTRAINT "po_item_components_one_identity" CHECK (("stoneTypeId" IS NULL) <> ("materialCodeId" IS NULL) AND ("materialCodeId" IS NULL OR "stoneGradeId" IS NULL));
ALTER TABLE "grn_item_component_rates" ADD CONSTRAINT "grn_item_component_rates_one_identity" CHECK (("stoneTypeId" IS NULL) <> ("materialCodeId" IS NULL) AND ("materialCodeId" IS NULL OR "stoneGradeId" IS NULL));

CREATE INDEX "vendor_component_rates_supplierId_materialCodeId_idx" ON "vendor_component_rates"("supplierId", "materialCodeId");
