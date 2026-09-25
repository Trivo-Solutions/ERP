-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 of full company isolation: the nine tenant-editable master tables become
-- company-owned. Until now design_categories, karat_master, product_categories, sub_categories,
-- collections, material_codes, stock_types, stone_types and stone_grades were ONE shared list:
-- `code` was globally unique, every company saw every row, and any company's admin could create
-- or edit rows visible to all of them.
--
-- After this migration each company owns an independent copy of each row (unique on
-- ("companyId", "code")), protected by the same tenant_isolation RLS policy as every other
-- tenant table. HsnCode and StateMaster are deliberately NOT touched: they are read-only
-- statutory reference data owned by the platform, not client data.
--
-- Data handling — nothing is discarded:
--   1. Every existing global row is COPIED once per existing company (new id, same values).
--   2. Every tenant row that pointed at a global row (a tag's category, a making charge's material
--      code, ...) is re-pointed at ITS OWN company's copy — matched by company, so a row can
--      never end up pointing at another company's copy.
--   3. Master->master links (sub_categories -> product_categories, stone_grades -> stone_types)
--      are re-pointed the same way, per company.
--   4. The original companyId-less rows are deleted last, once nothing references them.
-- A temp mapping table records old id -> (company, new id) so steps 2-3 are exact.
-- ═══════════════════════════════════════════════════════════════════════════

-- Old global uniqueness on code alone must go before the per-company copies are inserted.
DROP INDEX "design_categories_code_key";
DROP INDEX "karat_master_code_key";
DROP INDEX "product_categories_code_key";
DROP INDEX "sub_categories_code_key";
DROP INDEX "collections_code_key";
DROP INDEX "material_codes_code_key";
DROP INDEX "stock_types_code_key";
DROP INDEX "stone_types_code_key";

-- Nullable first so existing rows survive the column add.
ALTER TABLE "design_categories" ADD COLUMN "companyId" TEXT;
ALTER TABLE "karat_master"      ADD COLUMN "companyId" TEXT;
ALTER TABLE "product_categories" ADD COLUMN "companyId" TEXT;
ALTER TABLE "sub_categories"    ADD COLUMN "companyId" TEXT;
ALTER TABLE "collections"       ADD COLUMN "companyId" TEXT;
ALTER TABLE "material_codes"    ADD COLUMN "companyId" TEXT;
ALTER TABLE "stock_types"       ADD COLUMN "companyId" TEXT;
ALTER TABLE "stone_types"       ADD COLUMN "companyId" TEXT;
ALTER TABLE "stone_grades"      ADD COLUMN "companyId" TEXT;

CREATE TEMP TABLE _master_map (
  tbl        text NOT NULL,
  old_id     text NOT NULL,
  company_id text NOT NULL,
  new_id     text NOT NULL
);

-- ── Group 1: masters with no master parent ───────────────────────────────────

-- design_categories
INSERT INTO _master_map SELECT 'design_categories', o."id", c."id", gen_random_uuid()::text
  FROM "design_categories" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "design_categories" ("id", "companyId", "code", "name")
  SELECT m.new_id, m.company_id, o."code", o."name"
  FROM _master_map m JOIN "design_categories" o ON o."id" = m.old_id WHERE m.tbl = 'design_categories';
UPDATE "designs" d SET "categoryId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'design_categories' AND m.old_id = d."categoryId" AND m.company_id = d."companyId";

-- karat_master (no tenant row references it by FK — karat fields elsewhere are free-text codes)
INSERT INTO _master_map SELECT 'karat_master', o."id", c."id", gen_random_uuid()::text
  FROM "karat_master" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "karat_master" ("id", "companyId", "code", "metalType", "purity", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."metalType", o."purity", o."isActive", o."createdAt"
  FROM _master_map m JOIN "karat_master" o ON o."id" = m.old_id WHERE m.tbl = 'karat_master';

-- product_categories
INSERT INTO _master_map SELECT 'product_categories', o."id", c."id", gen_random_uuid()::text
  FROM "product_categories" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "product_categories" ("id", "companyId", "code", "name", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."name", o."isActive", o."createdAt"
  FROM _master_map m JOIN "product_categories" o ON o."id" = m.old_id WHERE m.tbl = 'product_categories';
UPDATE "jewelry_tags" t SET "categoryId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'product_categories' AND m.old_id = t."categoryId" AND m.company_id = t."companyId";
UPDATE "making_charges" t SET "categoryId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'product_categories' AND m.old_id = t."categoryId" AND m.company_id = t."companyId";
UPDATE "invoice_items" t SET "categoryId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'product_categories' AND m.old_id = t."categoryId" AND m.company_id = t."companyId";

-- collections
INSERT INTO _master_map SELECT 'collections', o."id", c."id", gen_random_uuid()::text
  FROM "collections" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "collections" ("id", "companyId", "code", "name", "description", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."name", o."description", o."isActive", o."createdAt"
  FROM _master_map m JOIN "collections" o ON o."id" = m.old_id WHERE m.tbl = 'collections';
UPDATE "jewelry_tags" t SET "collectionId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'collections' AND m.old_id = t."collectionId" AND m.company_id = t."companyId";

-- material_codes
INSERT INTO _master_map SELECT 'material_codes', o."id", c."id", gen_random_uuid()::text
  FROM "material_codes" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "material_codes" ("id", "companyId", "code", "name", "materialType", "karat", "unit", "description", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."name", o."materialType", o."karat", o."unit", o."description", o."isActive", o."createdAt"
  FROM _master_map m JOIN "material_codes" o ON o."id" = m.old_id WHERE m.tbl = 'material_codes';
UPDATE "jewelry_tag_materials" t SET "materialCodeId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'material_codes' AND m.old_id = t."materialCodeId" AND m.company_id = t."companyId";
UPDATE "making_charges" t SET "materialCodeId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'material_codes' AND m.old_id = t."materialCodeId" AND m.company_id = t."companyId";

-- stock_types
INSERT INTO _master_map SELECT 'stock_types', o."id", c."id", gen_random_uuid()::text
  FROM "stock_types" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "stock_types" ("id", "companyId", "code", "name", "description", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."name", o."description", o."isActive", o."createdAt"
  FROM _master_map m JOIN "stock_types" o ON o."id" = m.old_id WHERE m.tbl = 'stock_types';
UPDATE "jewelry_tags" t SET "stockTypeId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'stock_types' AND m.old_id = t."stockTypeId" AND m.company_id = t."companyId";

-- stone_types
INSERT INTO _master_map SELECT 'stone_types', o."id", c."id", gen_random_uuid()::text
  FROM "stone_types" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "stone_types" ("id", "companyId", "code", "name", "itemType", "unit", "description", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."name", o."itemType", o."unit", o."description", o."isActive", o."createdAt"
  FROM _master_map m JOIN "stone_types" o ON o."id" = m.old_id WHERE m.tbl = 'stone_types';

-- ── Group 2: masters whose parent is another master (parent copies now exist) ─

-- sub_categories: each company's copy points at THAT company's copy of the parent category.
INSERT INTO _master_map SELECT 'sub_categories', o."id", c."id", gen_random_uuid()::text
  FROM "sub_categories" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "sub_categories" ("id", "companyId", "code", "name", "categoryId", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, o."code", o."name", pm.new_id, o."isActive", o."createdAt"
  FROM _master_map m
  JOIN "sub_categories" o ON o."id" = m.old_id
  JOIN _master_map pm ON pm.tbl = 'product_categories' AND pm.old_id = o."categoryId" AND pm.company_id = m.company_id
  WHERE m.tbl = 'sub_categories';
UPDATE "jewelry_tags" t SET "subCategoryId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'sub_categories' AND m.old_id = t."subCategoryId" AND m.company_id = t."companyId";

-- stone_grades: same, against stone_types.
INSERT INTO _master_map SELECT 'stone_grades', o."id", c."id", gen_random_uuid()::text
  FROM "stone_grades" o CROSS JOIN "companies" c WHERE o."companyId" IS NULL;
INSERT INTO "stone_grades" ("id", "companyId", "stoneTypeId", "shape", "color", "clarity", "cut", "quality", "isActive", "createdAt")
  SELECT m.new_id, m.company_id, pm.new_id, o."shape", o."color", o."clarity", o."cut", o."quality", o."isActive", o."createdAt"
  FROM _master_map m
  JOIN "stone_grades" o ON o."id" = m.old_id
  JOIN _master_map pm ON pm.tbl = 'stone_types' AND pm.old_id = o."stoneTypeId" AND pm.company_id = m.company_id
  WHERE m.tbl = 'stone_grades';
UPDATE "price_masters" t SET "stoneGradeId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'stone_grades' AND m.old_id = t."stoneGradeId" AND m.company_id = t."companyId";
UPDATE "jewelry_tag_materials" t SET "stoneGradeId" = m.new_id FROM _master_map m
  WHERE m.tbl = 'stone_grades' AND m.old_id = t."stoneGradeId" AND m.company_id = t."companyId";

-- ── Remove the original unscoped rows (children before parents) ──────────────
DELETE FROM "stone_grades"       WHERE "companyId" IS NULL;
DELETE FROM "sub_categories"     WHERE "companyId" IS NULL;
DELETE FROM "stone_types"        WHERE "companyId" IS NULL;
DELETE FROM "stock_types"        WHERE "companyId" IS NULL;
DELETE FROM "material_codes"     WHERE "companyId" IS NULL;
DELETE FROM "collections"        WHERE "companyId" IS NULL;
DELETE FROM "product_categories" WHERE "companyId" IS NULL;
DELETE FROM "karat_master"       WHERE "companyId" IS NULL;
DELETE FROM "design_categories"  WHERE "companyId" IS NULL;

DROP TABLE _master_map;

-- ── Constraints ──────────────────────────────────────────────────────────────
ALTER TABLE "design_categories"  ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "karat_master"       ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "product_categories" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "sub_categories"     ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "collections"        ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "material_codes"     ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "stock_types"        ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "stone_types"        ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "stone_grades"       ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "design_categories_companyId_idx"  ON "design_categories"("companyId");
CREATE INDEX "karat_master_companyId_idx"       ON "karat_master"("companyId");
CREATE INDEX "product_categories_companyId_idx" ON "product_categories"("companyId");
CREATE INDEX "sub_categories_companyId_idx"     ON "sub_categories"("companyId");
CREATE INDEX "collections_companyId_idx"        ON "collections"("companyId");
CREATE INDEX "material_codes_companyId_idx"     ON "material_codes"("companyId");
CREATE INDEX "stock_types_companyId_idx"        ON "stock_types"("companyId");
CREATE INDEX "stone_types_companyId_idx"        ON "stone_types"("companyId");
CREATE INDEX "stone_grades_companyId_idx"       ON "stone_grades"("companyId");

CREATE UNIQUE INDEX "design_categories_companyId_code_key"  ON "design_categories"("companyId", "code");
CREATE UNIQUE INDEX "karat_master_companyId_code_key"       ON "karat_master"("companyId", "code");
CREATE UNIQUE INDEX "product_categories_companyId_code_key" ON "product_categories"("companyId", "code");
CREATE UNIQUE INDEX "sub_categories_companyId_code_key"     ON "sub_categories"("companyId", "code");
CREATE UNIQUE INDEX "collections_companyId_code_key"        ON "collections"("companyId", "code");
CREATE UNIQUE INDEX "material_codes_companyId_code_key"     ON "material_codes"("companyId", "code");
CREATE UNIQUE INDEX "stock_types_companyId_code_key"        ON "stock_types"("companyId", "code");
CREATE UNIQUE INDEX "stone_types_companyId_code_key"        ON "stone_types"("companyId", "code");

-- AddForeignKey
ALTER TABLE "design_categories"  ADD CONSTRAINT "design_categories_companyId_fkey"  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "karat_master"       ADD CONSTRAINT "karat_master_companyId_fkey"       FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sub_categories"     ADD CONSTRAINT "sub_categories_companyId_fkey"     FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "collections"        ADD CONSTRAINT "collections_companyId_fkey"        FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_codes"     ADD CONSTRAINT "material_codes_companyId_fkey"     FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_types"        ADD CONSTRAINT "stock_types_companyId_fkey"        FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stone_types"        ADD CONSTRAINT "stone_types_companyId_fkey"        FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stone_grades"       ADD CONSTRAINT "stone_grades_companyId_fkey"       FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-Level Security — same inert-but-proven deployment status as every other tenant table (see
-- 20260923130000's own comment for the full "why not FORCE yet" reasoning).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'design_categories', 'karat_master', 'product_categories', 'sub_categories', 'collections',
    'material_codes', 'stock_types', 'stone_types', 'stone_grades'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I ' ||
      'USING ("companyId" = current_setting(''app.tenant_company_id'', true)) ' ||
      'WITH CHECK ("companyId" = current_setting(''app.tenant_company_id'', true))',
      t
    );
  END LOOP;
END $$;
