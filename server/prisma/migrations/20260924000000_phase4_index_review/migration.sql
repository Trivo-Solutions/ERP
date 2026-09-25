-- Phase 4 Part N — index review. Four composite indexes added against real, existing query
-- patterns (not speculative): reports.router.ts's dashboard (SalesInvoice/GoodsReceiptNote
-- recent-activity queries, JobCard status KPIs) and sales.service.ts's checkMemoAlerts (scoped to
-- companyId in this same phase — see that function's own comment). See schema.prisma's own
-- comments on each index for the specific call site it serves.

-- CreateIndex
CREATE INDEX "goods_receipt_notes_companyId_createdAt_idx" ON "goods_receipt_notes"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "job_cards_companyId_status_idx" ON "job_cards"("companyId", "status");

-- CreateIndex
CREATE INDEX "memo_outs_companyId_status_returnDeadline_idx" ON "memo_outs"("companyId", "status", "returnDeadline");

-- CreateIndex
CREATE INDEX "sales_invoices_companyId_createdAt_idx" ON "sales_invoices"("companyId", "createdAt");

