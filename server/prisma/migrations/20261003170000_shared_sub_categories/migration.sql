-- Shared sub-categories: Category <-> SubCategory becomes many-to-many.
--
-- A sub-category ("Traditional") is ONE company-owned row, linked to any number of categories through
-- category_sub_categories. This replaces the one-category-per-row design (sub_categories.categoryId),
-- including the per-category unique index added by 20261003160000 — the code is unique per company again.
--
-- Data steps (copy links, then consolidate rows that are the same logical sub-category) touch tenant rows,
-- so FORCE RLS is lifted around them exactly as 20260927120000 does, and restored in the same block.

-- 1. The link table (company-owned, composite FKs on both sides, RLS like every sibling master).
CREATE TABLE "category_sub_categories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "subCategoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "category_sub_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "category_sub_categories_companyId_categoryId_subCategoryId_key"
  ON "category_sub_categories"("companyId", "categoryId", "subCategoryId");
CREATE INDEX "category_sub_categories_companyId_subCategoryId_idx"
  ON "category_sub_categories"("companyId", "subCategoryId");
ALTER TABLE "category_sub_categories" ADD CONSTRAINT "category_sub_categories_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_sub_categories" ADD CONSTRAINT "category_sub_categories_categoryId_companyId_fkey"
  FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_sub_categories" ADD CONSTRAINT "category_sub_categories_subCategoryId_companyId_fkey"
  FOREIGN KEY ("subCategoryId", "companyId") REFERENCES "sub_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "category_sub_categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "category_sub_categories"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- 2 + 3. Copy every existing (category, sub-category) relationship, then consolidate duplicates.
DO $$
DECLARE
  t text;
  forced text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['sub_categories', 'jewelry_tags', 'category_sub_categories'] LOOP
    IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass(quote_ident(t))) THEN
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
      forced := forced || t;
    END IF;
  END LOOP;

  -- every existing relationship becomes a link (ids of sub_categories rows are untouched)
  INSERT INTO "category_sub_categories" ("id", "companyId", "categoryId", "subCategoryId")
    SELECT gen_random_uuid()::text, "companyId", "categoryId", "id" FROM "sub_categories";

  -- Same logical sub-category = same code, or same name ignoring case/whitespace, within one company.
  -- The oldest row survives (its id, code and name are kept); tags and links of the others move onto it.
  -- Two passes (code, then name) because a name-duplicate can have a different code.
  CREATE TEMP TABLE _sc_map (dup_id text, keep_id text, "companyId" text) ON COMMIT DROP;
  FOR i IN 1..2 LOOP
    TRUNCATE _sc_map;
    INSERT INTO _sc_map
      SELECT x.dup_id, x.keep_id, x."companyId" FROM (
        SELECT s."id" AS dup_id,
               first_value(s."id") OVER (PARTITION BY s."companyId",
                   CASE WHEN i = 1 THEN upper(btrim(s."code")) ELSE lower(btrim(s."name")) END
                 ORDER BY s."createdAt", s."id") AS keep_id,
               s."companyId"
          FROM "sub_categories" s
      ) x WHERE x.dup_id <> x.keep_id;

    UPDATE "jewelry_tags" jt SET "subCategoryId" = m.keep_id
      FROM _sc_map m WHERE jt."subCategoryId" = m.dup_id AND jt."companyId" = m."companyId";

    INSERT INTO "category_sub_categories" ("id", "companyId", "categoryId", "subCategoryId")
      SELECT gen_random_uuid()::text, l."companyId", l."categoryId", m.keep_id
        FROM "category_sub_categories" l JOIN _sc_map m ON m.dup_id = l."subCategoryId"
      ON CONFLICT ("companyId", "categoryId", "subCategoryId") DO NOTHING;
    DELETE FROM "category_sub_categories" l USING _sc_map m WHERE l."subCategoryId" = m.dup_id;
    DELETE FROM "sub_categories" s USING _sc_map m WHERE s."id" = m.dup_id;
  END LOOP;

  -- normalise what is left so the unique (companyId, code) below cannot trip on whitespace/case
  UPDATE "sub_categories" SET "code" = upper(btrim("code")), "name" = btrim("name");

  FOREACH t IN ARRAY forced LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 4. Retire the category-specific structure.
ALTER TABLE "sub_categories" DROP CONSTRAINT "sub_categories_categoryId_companyId_fkey";
DROP INDEX "sub_categories_companyId_categoryId_code_key";
ALTER TABLE "sub_categories" DROP COLUMN "categoryId";
CREATE UNIQUE INDEX "sub_categories_companyId_code_key" ON "sub_categories"("companyId", "code");
