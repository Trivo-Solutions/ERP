-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "tagId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoice_items_tagId_key" ON "invoice_items"("tagId");

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "jewelry_tags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

