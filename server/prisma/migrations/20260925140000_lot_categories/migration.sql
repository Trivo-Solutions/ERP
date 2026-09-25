-- Purchase lots, category by category.
--
-- A supplier's bag holds several categories (rings, necklaces, ...), each with its own gross / stone / net
-- weight and karat, and sometimes a piece count. The bag line on the PO now carries one po_item_categories row
-- per category+karat; the bag's cost stays ONE amount on the line and is split across the pieces by net weight.
--
--   po_item_categories        the category rows of a FINISHED_LOT PO line
--   purchase_lots.pieces      now optional: a total exists only when every category row states a count
--
-- Nothing existing is restated. A lot opened before this migration has no category rows and keeps working on
-- its bag-level totals (see shared/purchaseLot.ts).

ALTER TABLE "purchase_lots" ALTER COLUMN "pieces" DROP NOT NULL;

CREATE TABLE "po_item_categories" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "poItemId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "karat" TEXT NOT NULL,
    "grossWeight" DECIMAL(10,4) NOT NULL,
    "stoneWeight" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "netWeight" DECIMAL(10,4) NOT NULL,
    "pieces" INTEGER,

    CONSTRAINT "po_item_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "po_item_categories_poItemId_categoryId_karat_key" ON "po_item_categories"("poItemId", "categoryId", "karat");
CREATE INDEX "po_item_categories_companyId_idx" ON "po_item_categories"("companyId");
CREATE INDEX "po_item_categories_categoryId_idx" ON "po_item_categories"("categoryId");

ALTER TABLE "po_item_categories" ADD CONSTRAINT "po_item_categories_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- composite FKs: the database itself refuses a row pointing at another company's PO line or category
ALTER TABLE "po_item_categories" ADD CONSTRAINT "po_item_categories_poItemId_companyId_fkey"
  FOREIGN KEY ("poItemId", "companyId") REFERENCES "po_items"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "po_item_categories" ADD CONSTRAINT "po_item_categories_categoryId_companyId_fkey"
  FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, same policy every tenant table carries (db-secure.sql FORCEs it and grants the runtime role).
ALTER TABLE "po_item_categories" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "po_item_categories"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
