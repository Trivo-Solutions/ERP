-- AlterTable
ALTER TABLE "sales_invoices" ADD COLUMN     "salesPersonId" TEXT,
ADD COLUMN     "terms" TEXT;

-- AddForeignKey
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_salesPersonId_fkey" FOREIGN KEY ("salesPersonId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
