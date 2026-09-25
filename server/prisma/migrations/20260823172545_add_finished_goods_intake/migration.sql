-- AlterTable
ALTER TABLE "goods_receipt_notes" ADD COLUMN     "branchId" TEXT;

-- AlterTable
ALTER TABLE "jewelry_tags" ADD COLUMN     "grnItemId" TEXT;

-- CreateIndex
CREATE INDEX "goods_receipt_notes_branchId_idx" ON "goods_receipt_notes"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "jewelry_tags_grnItemId_key" ON "jewelry_tags"("grnItemId");

-- AddForeignKey
ALTER TABLE "goods_receipt_notes" ADD CONSTRAINT "goods_receipt_notes_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_grnItemId_fkey" FOREIGN KEY ("grnItemId") REFERENCES "grn_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

