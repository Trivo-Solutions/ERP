-- No live/production data exists yet (pre-launch dev environment) — these 10 rows were
-- inserted directly by an earlier migration (20260825130000_seed_ledger_accounts) as a
-- GLOBAL chart of accounts, before Account became company-owned. Removed here rather than
-- backfilled to an arbitrary company; server/prisma/seed.ts now calls
-- seedChartOfAccounts(companyId) per company (see finance.service.ts), which recreates them
-- correctly scoped the moment a company is seeded.
DELETE FROM "accounts";

-- Same reasoning: the single global "Default Jewelry Tag" template inserted by
-- 20260909090000_add_tag_template is removed rather than backfilled to an arbitrary company.
-- server/prisma/seed.ts recreates an equivalent default template per company (same layout).
DELETE FROM "tag_templates";

-- DropIndex
DROP INDEX "accounts_code_key";

-- DropIndex
DROP INDEX "accounts_type_idx";

-- DropIndex
DROP INDEX "branch_transfers_transferNumber_key";

-- DropIndex
DROP INDEX "cost_centers_code_key";

-- DropIndex
DROP INDEX "invoice_payments_paymentNumber_key";

-- DropIndex
DROP INDEX "journal_entries_entryNumber_key";

-- DropIndex
DROP INDEX "memo_outs_memoNumber_key";

-- DropIndex
DROP INDEX "old_gold_exchanges_exchangeNumber_key";

-- DropIndex
DROP INDEX "sales_returns_returnNumber_key";

-- DropIndex
DROP INDEX "stock_audits_auditNumber_key";

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "branch_transfers" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "cost_centers" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "invoice_payments" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "journal_entries" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "journal_lines" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "memo_items" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "memo_outs" ADD COLUMN     "branchId" TEXT NOT NULL,
ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "old_gold_exchanges" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "sales_returns" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "stock_audits" ADD COLUMN     "companyId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "tag_templates" ADD COLUMN     "companyId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "accounts_companyId_type_idx" ON "accounts"("companyId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_companyId_code_key" ON "accounts"("companyId", "code");

-- CreateIndex
CREATE INDEX "branch_transfers_companyId_idx" ON "branch_transfers"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "branch_transfers_companyId_transferNumber_key" ON "branch_transfers"("companyId", "transferNumber");

-- CreateIndex
CREATE INDEX "cost_centers_companyId_idx" ON "cost_centers"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_companyId_code_key" ON "cost_centers"("companyId", "code");

-- CreateIndex
CREATE INDEX "invoice_payments_companyId_idx" ON "invoice_payments"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_payments_companyId_paymentNumber_key" ON "invoice_payments"("companyId", "paymentNumber");

-- CreateIndex
CREATE INDEX "journal_entries_companyId_date_isPosted_idx" ON "journal_entries"("companyId", "date", "isPosted");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_companyId_entryNumber_key" ON "journal_entries"("companyId", "entryNumber");

-- CreateIndex
CREATE INDEX "journal_lines_companyId_idx" ON "journal_lines"("companyId");

-- CreateIndex
CREATE INDEX "memo_items_companyId_idx" ON "memo_items"("companyId");

-- CreateIndex
CREATE INDEX "memo_outs_companyId_branchId_idx" ON "memo_outs"("companyId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "memo_outs_companyId_memoNumber_key" ON "memo_outs"("companyId", "memoNumber");

-- CreateIndex
CREATE INDEX "old_gold_exchanges_companyId_idx" ON "old_gold_exchanges"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "old_gold_exchanges_companyId_exchangeNumber_key" ON "old_gold_exchanges"("companyId", "exchangeNumber");

-- CreateIndex
CREATE INDEX "sales_returns_companyId_idx" ON "sales_returns"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_companyId_returnNumber_key" ON "sales_returns"("companyId", "returnNumber");

-- CreateIndex
CREATE INDEX "stock_audits_companyId_branchId_idx" ON "stock_audits"("companyId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_audits_companyId_auditNumber_key" ON "stock_audits"("companyId", "auditNumber");

-- CreateIndex
CREATE INDEX "tag_templates_companyId_idx" ON "tag_templates"("companyId");

-- AddForeignKey
ALTER TABLE "old_gold_exchanges" ADD CONSTRAINT "old_gold_exchanges_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_outs" ADD CONSTRAINT "memo_outs_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_outs" ADD CONSTRAINT "memo_outs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memo_items" ADD CONSTRAINT "memo_items_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_audits" ADD CONSTRAINT "stock_audits_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfers" ADD CONSTRAINT "branch_transfers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_templates" ADD CONSTRAINT "tag_templates_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

