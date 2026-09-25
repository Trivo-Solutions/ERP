-- Purchase lots (bags): finished pieces bought on ONE supplier invoice line and tagged one at a time.
--
-- Suppliers bill finished jewellery by category as a lot (e.g. 14 rings, gross/net weight, one amount), not
-- piece by piece. Until now a piece could only enter stock through its own PO line (one line = one piece =
-- one tag), so a lot invoice meant hand-splitting the amount across N lines.
--
--   po_items.netWeight        the bag's net weight (a FINISHED_LOT line; gross is the existing `weight`)
--   purchase_lots             one row per received FINISHED_LOT line; opened by the GRN, which is also where the
--                             payable + input GST are booked (see PurchaseLot in schema.prisma)
--   jewelry_tags.purchaseLotId  the lot a tag was cut from (many tags per lot); costPrice on such a tag is its
--                             allocated share of the lot's cost
--   grn_items (id, companyId) unique — the composite-FK target for purchase_lots
--
-- Nothing existing is restated: every column is nullable / new, and no existing row changes.

ALTER TABLE "po_items" ADD COLUMN "netWeight" DECIMAL(10,4);

CREATE UNIQUE INDEX "grn_items_id_companyId_key" ON "grn_items"("id", "companyId");

CREATE TABLE "purchase_lots" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "grnItemId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "karat" TEXT,
    "pieces" INTEGER NOT NULL,
    "grossWeight" DECIMAL(10,4) NOT NULL,
    "netWeight" DECIMAL(10,4) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closeNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_lots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_lots_grnItemId_key" ON "purchase_lots"("grnItemId");
CREATE UNIQUE INDEX "purchase_lots_grnItemId_companyId_key" ON "purchase_lots"("grnItemId", "companyId");
CREATE UNIQUE INDEX "purchase_lots_id_companyId_key" ON "purchase_lots"("id", "companyId");
CREATE INDEX "purchase_lots_companyId_status_idx" ON "purchase_lots"("companyId", "status");

ALTER TABLE "purchase_lots" ADD CONSTRAINT "purchase_lots_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- composite FK: the database itself refuses a lot pointing at another company's GRN line
ALTER TABLE "purchase_lots" ADD CONSTRAINT "purchase_lots_grnItemId_companyId_fkey"
  FOREIGN KEY ("grnItemId", "companyId") REFERENCES "grn_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jewelry_tags" ADD COLUMN "purchaseLotId" TEXT;
CREATE INDEX "jewelry_tags_purchaseLotId_idx" ON "jewelry_tags"("purchaseLotId");
-- composite FK: the database itself refuses a tag cut from another company's lot
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_purchaseLotId_companyId_fkey"
  FOREIGN KEY ("purchaseLotId", "companyId") REFERENCES "purchase_lots"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, same policy every tenant table carries (db-secure.sql FORCEs it and grants the runtime role).
ALTER TABLE "purchase_lots" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "purchase_lots"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
