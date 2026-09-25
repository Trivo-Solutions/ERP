-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5: composite foreign keys on the HIGH-RISK relations.
--
-- PostgreSQL row-level security does NOT make a foreign key tenant-safe: an FK check bypasses RLS, so a plain
-- FOREIGN KEY ("categoryId") accepts ANY category id that exists — including another company's. The application
-- verifies ownership of every client-supplied id (assertOwnedByCompany), and this migration adds the database
-- backstop: each converted relation becomes a COMPOSITE key ("categoryId","companyId") -> parent("id","companyId"),
-- so the DATABASE itself refuses a child row that points at a parent owned by a different company.
--
-- Converted (58 relations) — those where a client-supplied id selects the parent, plus roles (a role from another
-- company on a member/invitation would be privilege confusion): tag -> branch/category/stock type/sub-category/
-- collection/manufacturer, tag materials -> material code/stone grade, invoice/memo/return/payment/exchange ->
-- client/branch/tag/invoice, price/making-charge masters, master hierarchies, branch transfers & stock audits,
-- procurement (PO/GRN/return -> supplier/PO/branch), hallmarking/repair/estimate/tax/export documents, and
-- company_users / company_invitations -> roles.
-- Deliberately NOT converted: dormant manufacturing/design internals (their parent ids are derived server-side,
-- not client-supplied) — they stay covered by the explicit ownership checks and the cross-company audit test.
--
-- Existing data was verified consistent first (crossCompanyForeignKeyViolations() = 0), so every new constraint
-- validates on creation.
-- ═══════════════════════════════════════════════════════════════════════════

-- DropForeignKey
ALTER TABLE "company_users" DROP CONSTRAINT "company_users_roleId_fkey";

-- DropForeignKey
ALTER TABLE "company_invitations" DROP CONSTRAINT "company_invitations_roleId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_returns" DROP CONSTRAINT "purchase_returns_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_return_items" DROP CONSTRAINT "purchase_return_items_returnId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_return_items" DROP CONSTRAINT "purchase_return_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "po_items" DROP CONSTRAINT "po_items_poId_fkey";

-- DropForeignKey
ALTER TABLE "goods_receipt_notes" DROP CONSTRAINT "goods_receipt_notes_poId_fkey";

-- DropForeignKey
ALTER TABLE "goods_receipt_notes" DROP CONSTRAINT "goods_receipt_notes_branchId_fkey";

-- DropForeignKey
ALTER TABLE "grn_items" DROP CONSTRAINT "grn_items_grnId_fkey";

-- DropForeignKey
ALTER TABLE "grn_items" DROP CONSTRAINT "grn_items_poItemId_fkey";

-- DropForeignKey
ALTER TABLE "old_gold_exchanges" DROP CONSTRAINT "old_gold_exchanges_clientId_fkey";

-- DropForeignKey
ALTER TABLE "hallmarking_items" DROP CONSTRAINT "hallmarking_items_batchId_fkey";

-- DropForeignKey
ALTER TABLE "hallmarking_items" DROP CONSTRAINT "hallmarking_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "repair_jobs" DROP CONSTRAINT "repair_jobs_clientId_fkey";

-- DropForeignKey
ALTER TABLE "repair_jobs" DROP CONSTRAINT "repair_jobs_tagId_fkey";

-- DropForeignKey
ALTER TABLE "repair_jobs" DROP CONSTRAINT "repair_jobs_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "memo_outs" DROP CONSTRAINT "memo_outs_branchId_fkey";

-- DropForeignKey
ALTER TABLE "memo_outs" DROP CONSTRAINT "memo_outs_clientId_fkey";

-- DropForeignKey
ALTER TABLE "memo_items" DROP CONSTRAINT "memo_items_memoId_fkey";

-- DropForeignKey
ALTER TABLE "memo_items" DROP CONSTRAINT "memo_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "stock_audits" DROP CONSTRAINT "stock_audits_branchId_fkey";

-- DropForeignKey
ALTER TABLE "stock_audit_items" DROP CONSTRAINT "stock_audit_items_auditId_fkey";

-- DropForeignKey
ALTER TABLE "stock_audit_items" DROP CONSTRAINT "stock_audit_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tags" DROP CONSTRAINT "jewelry_tags_branchId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tags" DROP CONSTRAINT "jewelry_tags_stockTypeId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tags" DROP CONSTRAINT "jewelry_tags_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tags" DROP CONSTRAINT "jewelry_tags_subCategoryId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tags" DROP CONSTRAINT "jewelry_tags_collectionId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tags" DROP CONSTRAINT "jewelry_tags_manufacturerId_fkey";

-- DropForeignKey
ALTER TABLE "branch_transfers" DROP CONSTRAINT "branch_transfers_fromBranchId_fkey";

-- DropForeignKey
ALTER TABLE "branch_transfers" DROP CONSTRAINT "branch_transfers_toBranchId_fkey";

-- DropForeignKey
ALTER TABLE "branch_transfer_items" DROP CONSTRAINT "branch_transfer_items_transferId_fkey";

-- DropForeignKey
ALTER TABLE "branch_transfer_items" DROP CONSTRAINT "branch_transfer_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "sub_categories" DROP CONSTRAINT "sub_categories_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "tag_estimates" DROP CONSTRAINT "tag_estimates_tagId_fkey";

-- DropForeignKey
ALTER TABLE "tag_estimate_items" DROP CONSTRAINT "tag_estimate_items_estimateId_fkey";

-- DropForeignKey
ALTER TABLE "stone_grades" DROP CONSTRAINT "stone_grades_stoneTypeId_fkey";

-- DropForeignKey
ALTER TABLE "price_masters" DROP CONSTRAINT "price_masters_stoneGradeId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tag_materials" DROP CONSTRAINT "jewelry_tag_materials_tagId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tag_materials" DROP CONSTRAINT "jewelry_tag_materials_materialCodeId_fkey";

-- DropForeignKey
ALTER TABLE "jewelry_tag_materials" DROP CONSTRAINT "jewelry_tag_materials_stoneGradeId_fkey";

-- DropForeignKey
ALTER TABLE "making_charges" DROP CONSTRAINT "making_charges_materialCodeId_fkey";

-- DropForeignKey
ALTER TABLE "making_charges" DROP CONSTRAINT "making_charges_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "sales_invoices" DROP CONSTRAINT "sales_invoices_branchId_fkey";

-- DropForeignKey
ALTER TABLE "sales_invoices" DROP CONSTRAINT "sales_invoices_clientId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_payments" DROP CONSTRAINT "invoice_payments_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_payments" DROP CONSTRAINT "invoice_payments_clientId_fkey";

-- DropForeignKey
ALTER TABLE "sales_returns" DROP CONSTRAINT "sales_returns_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "sales_returns" DROP CONSTRAINT "sales_returns_clientId_fkey";

-- DropForeignKey
ALTER TABLE "sales_return_items" DROP CONSTRAINT "sales_return_items_returnId_fkey";

-- DropForeignKey
ALTER TABLE "sales_return_items" DROP CONSTRAINT "sales_return_items_invoiceItemId_fkey";

-- DropForeignKey
ALTER TABLE "sales_return_items" DROP CONSTRAINT "sales_return_items_tagId_fkey";

-- DropForeignKey
ALTER TABLE "export_documents" DROP CONSTRAINT "export_documents_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "tax_invoices" DROP CONSTRAINT "tax_invoices_invoiceId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "roles_id_companyId_key" ON "roles"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_id_companyId_key" ON "suppliers"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_returns_id_companyId_key" ON "purchase_returns"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_id_companyId_key" ON "purchase_orders"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "po_items_id_companyId_key" ON "po_items"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipt_notes_id_companyId_key" ON "goods_receipt_notes"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_id_companyId_key" ON "clients"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "hallmarking_batches_id_companyId_key" ON "hallmarking_batches"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "repair_jobs_invoiceId_companyId_key" ON "repair_jobs"("invoiceId", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "memo_outs_id_companyId_key" ON "memo_outs"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_audits_id_companyId_key" ON "stock_audits"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "jewelry_tags_id_companyId_key" ON "jewelry_tags"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_transfers_id_companyId_key" ON "branch_transfers"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_id_companyId_key" ON "product_categories"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sub_categories_id_companyId_key" ON "sub_categories"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "collections_id_companyId_key" ON "collections"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "material_codes_id_companyId_key" ON "material_codes"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tag_estimates_id_companyId_key" ON "tag_estimates"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_types_id_companyId_key" ON "stock_types"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "stone_types_id_companyId_key" ON "stone_types"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "stone_grades_id_companyId_key" ON "stone_grades"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_invoices_id_companyId_key" ON "sales_invoices"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_id_companyId_key" ON "invoice_items"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_id_companyId_key" ON "sales_returns"("id", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_invoices_invoiceId_companyId_key" ON "tax_invoices"("invoiceId", "companyId");

-- AddForeignKey
ALTER TABLE "company_users" ADD CONSTRAINT "company_users_roleId_companyId_fkey" FOREIGN KEY ("roleId", "companyId") REFERENCES "roles"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_roleId_companyId_fkey" FOREIGN KEY ("roleId", "companyId") REFERENCES "roles"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_returns" ADD CONSTRAINT "purchase_returns_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_returnId_companyId_fkey" FOREIGN KEY ("returnId", "companyId") REFERENCES "purchase_returns"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_return_items" ADD CONSTRAINT "purchase_return_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplierId_companyId_fkey" FOREIGN KEY ("supplierId", "companyId") REFERENCES "suppliers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "po_items" ADD CONSTRAINT "po_items_poId_companyId_fkey" FOREIGN KEY ("poId", "companyId") REFERENCES "purchase_orders"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_poId_companyId_fkey" FOREIGN KEY ("poId", "companyId") REFERENCES "purchase_orders"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_grnId_companyId_fkey" FOREIGN KEY ("grnId", "companyId") REFERENCES "goods_receipt_notes"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_poItemId_companyId_fkey" FOREIGN KEY ("poItemId", "companyId") REFERENCES "po_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "old_gold_exchanges" ADD CONSTRAINT "old_gold_exchanges_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hallmarking_items" ADD CONSTRAINT "hallmarking_items_batchId_companyId_fkey" FOREIGN KEY ("batchId", "companyId") REFERENCES "hallmarking_batches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hallmarking_items" ADD CONSTRAINT "hallmarking_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_jobs" ADD CONSTRAINT "repair_jobs_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_outs" ADD CONSTRAINT "memo_outs_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_outs" ADD CONSTRAINT "memo_outs_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_items" ADD CONSTRAINT "memo_items_memoId_companyId_fkey" FOREIGN KEY ("memoId", "companyId") REFERENCES "memo_outs"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_items" ADD CONSTRAINT "memo_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_items" ADD CONSTRAINT "stock_audit_items_auditId_companyId_fkey" FOREIGN KEY ("auditId", "companyId") REFERENCES "stock_audits"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audit_items" ADD CONSTRAINT "stock_audit_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_stockTypeId_companyId_fkey" FOREIGN KEY ("stockTypeId", "companyId") REFERENCES "stock_types"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_subCategoryId_companyId_fkey" FOREIGN KEY ("subCategoryId", "companyId") REFERENCES "sub_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_collectionId_companyId_fkey" FOREIGN KEY ("collectionId", "companyId") REFERENCES "collections"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_manufacturerId_companyId_fkey" FOREIGN KEY ("manufacturerId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfers" ADD CONSTRAINT "branch_transfers_fromBranchId_companyId_fkey" FOREIGN KEY ("fromBranchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfers" ADD CONSTRAINT "branch_transfers_toBranchId_companyId_fkey" FOREIGN KEY ("toBranchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfer_items" ADD CONSTRAINT "branch_transfer_items_transferId_companyId_fkey" FOREIGN KEY ("transferId", "companyId") REFERENCES "branch_transfers"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfer_items" ADD CONSTRAINT "branch_transfer_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_estimate_items" ADD CONSTRAINT "tag_estimate_items_estimateId_companyId_fkey" FOREIGN KEY ("estimateId", "companyId") REFERENCES "tag_estimates"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stone_grades" ADD CONSTRAINT "stone_grades_stoneTypeId_companyId_fkey" FOREIGN KEY ("stoneTypeId", "companyId") REFERENCES "stone_types"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_masters" ADD CONSTRAINT "price_masters_stoneGradeId_companyId_fkey" FOREIGN KEY ("stoneGradeId", "companyId") REFERENCES "stone_grades"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_materialCodeId_companyId_fkey" FOREIGN KEY ("materialCodeId", "companyId") REFERENCES "material_codes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_stoneGradeId_companyId_fkey" FOREIGN KEY ("stoneGradeId", "companyId") REFERENCES "stone_grades"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "making_charges" ADD CONSTRAINT "making_charges_materialCodeId_companyId_fkey" FOREIGN KEY ("materialCodeId", "companyId") REFERENCES "material_codes"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "making_charges" ADD CONSTRAINT "making_charges_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_categoryId_companyId_fkey" FOREIGN KEY ("categoryId", "companyId") REFERENCES "product_categories"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_clientId_companyId_fkey" FOREIGN KEY ("clientId", "companyId") REFERENCES "clients"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_returnId_companyId_fkey" FOREIGN KEY ("returnId", "companyId") REFERENCES "sales_returns"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_invoiceItemId_companyId_fkey" FOREIGN KEY ("invoiceItemId", "companyId") REFERENCES "invoice_items"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_items" ADD CONSTRAINT "sales_return_items_tagId_companyId_fkey" FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_documents" ADD CONSTRAINT "export_documents_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_invoiceId_companyId_fkey" FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

