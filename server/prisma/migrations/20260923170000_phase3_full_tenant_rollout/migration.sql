-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 3: full tenant-scoping rollout. Adds companyId (required — no live data predates this,
-- see CLAUDE.md) to every remaining operational model across the schema: Design/BOM/CostEstimate,
-- Supplier, MetalStock/StoneLot/Consumable, SalesOrder/OrderItem/MaterialReservation/
-- ClientNotification, JobCard/JobProcess/WipTracking/QcCheckpoint, Artisan/KarigarLedger/
-- ProcessTolerance/SubcontractorInvoice, HardwareDevice, MetalRate, PriceMaster/MakingCharge,
-- TagEstimate/EstimateTemplate, and denormalized companyId onto every remaining child/detail
-- table (StockAuditItem, BranchTransferItem, JewelryTagMaterial, SalesReturnItem,
-- ExportDocument, TaxInvoice, etc). Document-number unique constraints are all replaced with
-- [companyId, number] compounds, same pattern as every earlier Phase 2 migration.
--
-- A handful of tables had pre-existing seed rows (from prisma/seed.ts — sample design, sample
-- suppliers, process tolerances, today's metal rates) that predate per-company scoping and have
-- no honest companyId to backfill. They're cleared here (same precedent as the original Phase 2
-- migration clearing accounts/tag_templates) — verified first that nothing else in the dev/test
-- DB references them (purchaseOrder/artisan/purchaseReturn/jobCard/orderItem/costEstimate/
-- jewelryTag.designId were all confirmed at 0 rows). seed.ts is updated to recreate all of these
-- properly company-scoped.
DELETE FROM "cost_estimates";
DELETE FROM "bom_items";
DELETE FROM "bom_processes";
DELETE FROM "design_files";
DELETE FROM "designs";
DELETE FROM "suppliers";
DELETE FROM "process_tolerances";
DELETE FROM "metal_rates";

-- DropIndex
DROP INDEX "artisans_artisanCode_key";

-- DropIndex
DROP INDEX "consumables_itemCode_key";

-- DropIndex
DROP INDEX "cost_estimates_estimateNumber_key";

-- DropIndex
DROP INDEX "designs_designCode_idx";

-- DropIndex
DROP INDEX "designs_designCode_key";

-- DropIndex
DROP INDEX "hardware_devices_deviceId_key";

-- DropIndex
DROP INDEX "job_cards_jobNumber_idx";

-- DropIndex
DROP INDEX "job_cards_jobNumber_key";

-- DropIndex
DROP INDEX "metal_rates_date_idx";

-- DropIndex
DROP INDEX "metal_rates_date_karat_currency_key";

-- DropIndex
DROP INDEX "metal_stocks_stockCode_key";

-- DropIndex
DROP INDEX "process_tolerances_processName_key";

-- DropIndex
DROP INDEX "sales_orders_orderNumber_key";

-- DropIndex
DROP INDEX "stone_lots_lotNumber_key";

-- DropIndex
DROP INDEX "subcontractor_invoices_invoiceNumber_key";

-- DropIndex
DROP INDEX "suppliers_supplierCode_key";

-- DropIndex
DROP INDEX "tag_estimates_estimateNumber_key";

-- AlterTable
ALTER TABLE "artisans" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "bom_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "bom_processes" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "branch_transfer_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "client_notifications" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "consumable_transactions" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "consumables" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "cost_estimates" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "design_files" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "designs" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "estimate_templates" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "export_documents" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "hardware_devices" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "jewelry_tag_materials" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "job_cards" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "job_processes" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "karigar_ledger" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "making_charges" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "material_reservations" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "metal_rates" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "metal_stocks" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "order_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "price_masters" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "process_tolerances" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "qc_checkpoints" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "sales_return_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "stock_audit_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "stone_lot_splits" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "stone_lots" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "subcontractor_invoices" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "tag_estimate_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "tag_estimates" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "tax_invoices" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "wip_tracking" ADD COLUMN     "companyId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "artisans_companyId_idx" ON "artisans"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "artisans_companyId_artisanCode_key" ON "artisans"("companyId", "artisanCode");

-- CreateIndex
CREATE INDEX "bom_items_companyId_idx" ON "bom_items"("companyId");

-- CreateIndex
CREATE INDEX "bom_processes_companyId_idx" ON "bom_processes"("companyId");

-- CreateIndex
CREATE INDEX "branch_transfer_items_companyId_idx" ON "branch_transfer_items"("companyId");

-- CreateIndex
CREATE INDEX "client_notifications_companyId_idx" ON "client_notifications"("companyId");

-- CreateIndex
CREATE INDEX "consumable_transactions_companyId_idx" ON "consumable_transactions"("companyId");

-- CreateIndex
CREATE INDEX "consumables_companyId_idx" ON "consumables"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "consumables_companyId_itemCode_key" ON "consumables"("companyId", "itemCode");

-- CreateIndex
CREATE INDEX "cost_estimates_companyId_idx" ON "cost_estimates"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_estimates_companyId_estimateNumber_key" ON "cost_estimates"("companyId", "estimateNumber");

-- CreateIndex
CREATE INDEX "design_files_companyId_idx" ON "design_files"("companyId");

-- CreateIndex
CREATE INDEX "designs_companyId_idx" ON "designs"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "designs_companyId_designCode_key" ON "designs"("companyId", "designCode");

-- CreateIndex
CREATE INDEX "estimate_templates_companyId_idx" ON "estimate_templates"("companyId");

-- CreateIndex
CREATE INDEX "export_documents_companyId_idx" ON "export_documents"("companyId");

-- CreateIndex
CREATE INDEX "hardware_devices_companyId_idx" ON "hardware_devices"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "hardware_devices_companyId_deviceId_key" ON "hardware_devices"("companyId", "deviceId");

-- CreateIndex
CREATE INDEX "jewelry_tag_materials_companyId_idx" ON "jewelry_tag_materials"("companyId");

-- CreateIndex
CREATE INDEX "job_cards_companyId_idx" ON "job_cards"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "job_cards_companyId_jobNumber_key" ON "job_cards"("companyId", "jobNumber");

-- CreateIndex
CREATE INDEX "job_processes_companyId_idx" ON "job_processes"("companyId");

-- CreateIndex
CREATE INDEX "karigar_ledger_companyId_idx" ON "karigar_ledger"("companyId");

-- CreateIndex
CREATE INDEX "making_charges_companyId_idx" ON "making_charges"("companyId");

-- CreateIndex
CREATE INDEX "material_reservations_companyId_idx" ON "material_reservations"("companyId");

-- CreateIndex
CREATE INDEX "metal_rates_companyId_date_idx" ON "metal_rates"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "metal_rates_companyId_date_karat_currency_key" ON "metal_rates"("companyId", "date", "karat", "currency");

-- CreateIndex
CREATE INDEX "metal_stocks_companyId_idx" ON "metal_stocks"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "metal_stocks_companyId_stockCode_key" ON "metal_stocks"("companyId", "stockCode");

-- CreateIndex
CREATE INDEX "order_items_companyId_idx" ON "order_items"("companyId");

-- CreateIndex
CREATE INDEX "price_masters_companyId_idx" ON "price_masters"("companyId");

-- CreateIndex
CREATE INDEX "process_tolerances_companyId_idx" ON "process_tolerances"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "process_tolerances_companyId_processName_key" ON "process_tolerances"("companyId", "processName");

-- CreateIndex
CREATE INDEX "qc_checkpoints_companyId_idx" ON "qc_checkpoints"("companyId");

-- CreateIndex
CREATE INDEX "sales_orders_companyId_idx" ON "sales_orders"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_companyId_orderNumber_key" ON "sales_orders"("companyId", "orderNumber");

-- CreateIndex
CREATE INDEX "sales_return_items_companyId_idx" ON "sales_return_items"("companyId");

-- CreateIndex
CREATE INDEX "stock_audit_items_companyId_idx" ON "stock_audit_items"("companyId");

-- CreateIndex
CREATE INDEX "stone_lot_splits_companyId_idx" ON "stone_lot_splits"("companyId");

-- CreateIndex
CREATE INDEX "stone_lots_companyId_idx" ON "stone_lots"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "stone_lots_companyId_lotNumber_key" ON "stone_lots"("companyId", "lotNumber");

-- CreateIndex
CREATE INDEX "subcontractor_invoices_companyId_idx" ON "subcontractor_invoices"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "subcontractor_invoices_companyId_invoiceNumber_key" ON "subcontractor_invoices"("companyId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "suppliers_companyId_idx" ON "suppliers"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_companyId_supplierCode_key" ON "suppliers"("companyId", "supplierCode");

-- CreateIndex
CREATE INDEX "tag_estimate_items_companyId_idx" ON "tag_estimate_items"("companyId");

-- CreateIndex
CREATE INDEX "tag_estimates_companyId_idx" ON "tag_estimates"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_estimates_companyId_estimateNumber_key" ON "tag_estimates"("companyId", "estimateNumber");

-- CreateIndex
CREATE INDEX "tax_invoices_companyId_idx" ON "tax_invoices"("companyId");

-- CreateIndex
CREATE INDEX "wip_tracking_companyId_idx" ON "wip_tracking"("companyId");

-- AddForeignKey
ALTER TABLE "hardware_devices" ADD CONSTRAINT "hardware_devices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "designs" ADD CONSTRAINT "designs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_files" ADD CONSTRAINT "design_files_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_processes" ADD CONSTRAINT "bom_processes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_rates" ADD CONSTRAINT "metal_rates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_estimates" ADD CONSTRAINT "cost_estimates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_stocks" ADD CONSTRAINT "metal_stocks_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stone_lots" ADD CONSTRAINT "stone_lots_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stone_lot_splits" ADD CONSTRAINT "stone_lot_splits_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumables" ADD CONSTRAINT "consumables_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consumable_transactions" ADD CONSTRAINT "consumable_transactions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_notifications" ADD CONSTRAINT "client_notifications_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_processes" ADD CONSTRAINT "job_processes_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wip_tracking" ADD CONSTRAINT "wip_tracking_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_checkpoints" ADD CONSTRAINT "qc_checkpoints_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artisans" ADD CONSTRAINT "artisans_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_ledger" ADD CONSTRAINT "karigar_ledger_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_tolerances" ADD CONSTRAINT "process_tolerances_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcontractor_invoices" ADD CONSTRAINT "subcontractor_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_items" ADD CONSTRAINT "stock_audit_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfer_items" ADD CONSTRAINT "branch_transfer_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_estimate_items" ADD CONSTRAINT "tag_estimate_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_templates" ADD CONSTRAINT "estimate_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_masters" ADD CONSTRAINT "price_masters_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "making_charges" ADD CONSTRAINT "making_charges_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_documents" ADD CONSTRAINT "export_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

