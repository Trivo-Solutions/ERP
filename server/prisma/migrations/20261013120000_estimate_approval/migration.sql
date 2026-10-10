-- Offers: an estimate priced below its offer is sent FOR APPROVAL instead of to billing. Purely additive - two nullable
-- columns and one composite FK; no existing row is read or changed.
ALTER TABLE "tag_estimate_items" ADD COLUMN "materialId" TEXT;
ALTER TABLE "discount_approvals" ADD COLUMN "estimateId" TEXT;
CREATE INDEX "discount_approvals_estimateId_idx" ON "discount_approvals"("estimateId");
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_estimateId_companyId_fkey"
  FOREIGN KEY ("estimateId", "companyId") REFERENCES "tag_estimates"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
