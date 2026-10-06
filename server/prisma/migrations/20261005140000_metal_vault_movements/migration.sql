-- Metal Vault movement ledger + the columns the material-sale / return / customer-purchase flows need.
-- Purely additive: no UPDATE, no backfill, no existing row touched.

-- Composite-FK target so a movement can never point at another company's vault lot.
CREATE UNIQUE INDEX "metal_stocks_id_companyId_key" ON "metal_stocks"("id", "companyId");

CREATE TABLE "metal_stock_movements" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT,
    "metalStockId" TEXT NOT NULL,
    "movementType" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "reversesMovementId" TEXT,
    "materialName" TEXT NOT NULL,
    "karat" TEXT NOT NULL,
    "purity" DECIMAL(6,4) NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "beforeAvailableWt" DECIMAL(12,4) NOT NULL,
    "afterAvailableWt" DECIMAL(12,4) NOT NULL,
    "unitCostPerGram" DECIMAL(12,4) NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "metal_stock_movements_pkey" PRIMARY KEY ("id")
);
-- Idempotency: the same cause can never move the same lot in the same way twice.
CREATE UNIQUE INDEX "metal_stock_movements_companyId_movementType_referenceType__key"
  ON "metal_stock_movements"("companyId", "movementType", "referenceType", "referenceId", "metalStockId");
CREATE INDEX "metal_stock_movements_companyId_createdAt_idx" ON "metal_stock_movements"("companyId", "createdAt");
CREATE INDEX "metal_stock_movements_companyId_metalStockId_idx" ON "metal_stock_movements"("companyId", "metalStockId");
CREATE INDEX "metal_stock_movements_companyId_referenceType_referenceId_idx" ON "metal_stock_movements"("companyId", "referenceType", "referenceId");

ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_metalStockId_companyId_fkey"
  FOREIGN KEY ("metalStockId", "companyId") REFERENCES "metal_stocks"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "metal_stock_movements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "metal_stock_movements"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

-- A loose-metal (vault) sale line.
ALTER TABLE "invoice_items" ADD COLUMN "materialSale" BOOLEAN NOT NULL DEFAULT false;

-- A return line is now either a tagged piece or a weight of material.
ALTER TABLE "sales_return_items" ALTER COLUMN "tagId" DROP NOT NULL;
ALTER TABLE "sales_return_items" ADD COLUMN "returnedWeight" DECIMAL(12,4);
CREATE INDEX "sales_return_items_invoiceItemId_idx" ON "sales_return_items"("invoiceItemId");

-- Customer purchase: where it was taken in, and the tagged piece it consumed (if any).
ALTER TABLE "old_gold_exchanges" ADD COLUMN "branchId" TEXT;
ALTER TABLE "old_gold_exchanges" ADD COLUMN "tagId" TEXT;
CREATE INDEX "old_gold_exchanges_tagId_idx" ON "old_gold_exchanges"("tagId");
ALTER TABLE "old_gold_exchanges" ADD CONSTRAINT "old_gold_exchanges_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "old_gold_exchanges" ADD CONSTRAINT "old_gold_exchanges_tagId_companyId_fkey"
  FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
