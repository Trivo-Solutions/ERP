-- Phase 2b: procurement + quality tenant scoping. Adds companyId (required — no live data
-- predates this, see CLAUDE.md) to PurchaseRequisition/PoItem/PurchaseOrder/GoodsReceiptNote/
-- GrnItem/PurchaseReturn/PurchaseReturnItem/ApprovalHistory/HallmarkingBatch/HallmarkingItem/
-- RepairJob/RepairTransaction, replacing each document number's global unique constraint with a
-- company-scoped one, same pattern as the original Phase 2 migration.
--
-- All twelve tables were empty in every environment this migration was authored against, so the
-- NOT NULL columns and the unique-constraint replacements are unconditionally safe here — no
-- backfill/DELETE step is needed (contrast with 20260923140000, which had to clear pre-existing
-- migration-seeded rows first).

-- DropIndex
DROP INDEX "goods_receipt_notes_grnNumber_key";

-- DropIndex
DROP INDEX "hallmarking_batches_batchNumber_key";

-- DropIndex
DROP INDEX "purchase_orders_poNumber_key";

-- DropIndex
DROP INDEX "purchase_requisitions_prNumber_key";

-- DropIndex
DROP INDEX "purchase_returns_returnNumber_key";

-- DropIndex
DROP INDEX "repair_jobs_repairNumber_key";

-- AlterTable
ALTER TABLE "approval_history" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "goods_receipt_notes" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "grn_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "hallmarking_batches" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "hallmarking_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "po_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "pr_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "purchase_requisitions" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "purchase_return_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "purchase_returns" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "repair_jobs" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "repair_transactions" ADD COLUMN     "companyId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "approval_history_companyId_idx" ON "approval_history"("companyId");

-- CreateIndex
CREATE INDEX "goods_receipt_notes_companyId_idx" ON "goods_receipt_notes"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_notes_companyId_grnNumber_key" ON "goods_receipt_notes"("companyId", "grnNumber");

-- CreateIndex
CREATE INDEX "grn_items_companyId_idx" ON "grn_items"("companyId");

-- CreateIndex
CREATE INDEX "hallmarking_batches_companyId_idx" ON "hallmarking_batches"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "hallmarking_batches_companyId_batchNumber_key" ON "hallmarking_batches"("companyId", "batchNumber");

-- CreateIndex
CREATE INDEX "hallmarking_items_companyId_idx" ON "hallmarking_items"("companyId");

-- CreateIndex
CREATE INDEX "po_items_companyId_idx" ON "po_items"("companyId");

-- CreateIndex
CREATE INDEX "pr_items_companyId_idx" ON "pr_items"("companyId");

-- CreateIndex
CREATE INDEX "purchase_orders_companyId_idx" ON "purchase_orders"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_companyId_poNumber_key" ON "purchase_orders"("companyId", "poNumber");

-- CreateIndex
CREATE INDEX "purchase_requisitions_companyId_idx" ON "purchase_requisitions"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requisitions_companyId_prNumber_key" ON "purchase_requisitions"("companyId", "prNumber");

-- CreateIndex
CREATE INDEX "purchase_return_items_companyId_idx" ON "purchase_return_items"("companyId");

-- CreateIndex
CREATE INDEX "purchase_returns_companyId_idx" ON "purchase_returns"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_companyId_returnNumber_key" ON "purchase_returns"("companyId", "returnNumber");

-- CreateIndex
CREATE INDEX "repair_jobs_companyId_idx" ON "repair_jobs"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "repair_jobs_companyId_repairNumber_key" ON "repair_jobs"("companyId", "repairNumber");

-- CreateIndex
CREATE INDEX "repair_transactions_companyId_idx" ON "repair_transactions"("companyId");

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_items" ADD CONSTRAINT "po_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hallmarking_batches" ADD CONSTRAINT "hallmarking_batches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hallmarking_items" ADD CONSTRAINT "hallmarking_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_transactions" ADD CONSTRAINT "repair_transactions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requisitions" ADD CONSTRAINT "purchase_requisitions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_items" ADD CONSTRAINT "pr_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_history" ADD CONSTRAINT "approval_history_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

