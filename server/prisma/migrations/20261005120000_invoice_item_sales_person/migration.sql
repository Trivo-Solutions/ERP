-- Per-line sales attribution. Nullable: an existing line (and any line left blank) reports under SalesInvoice.salesPersonId.
ALTER TABLE "invoice_items" ADD COLUMN "salesPersonId" TEXT;

ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_salesPersonId_fkey"
  FOREIGN KEY ("salesPersonId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "invoice_items_companyId_salesPersonId_idx" ON "invoice_items"("companyId", "salesPersonId");
