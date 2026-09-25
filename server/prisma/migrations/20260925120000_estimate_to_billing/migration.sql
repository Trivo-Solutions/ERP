-- Estimate -> billing hand-off. An estimate can be sent to the billing counter, found there by number / item /
-- customer name, converted into an invoice line, and is then marked INVOICED against that invoice so it cannot be
-- billed twice.
--
-- Existing estimates stay OPEN (plain quotes): none of them has been "sent" to anyone.

ALTER TABLE "tag_estimates"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "sentToBillingAt" TIMESTAMP(3),
  ADD COLUMN "sentById" TEXT,
  ADD COLUMN "customerName" TEXT,
  ADD COLUMN "customerPhone" TEXT,
  ADD COLUMN "invoiceId" TEXT;

CREATE INDEX "tag_estimates_companyId_status_idx" ON "tag_estimates"("companyId", "status");

-- composite FK: the database itself refuses an estimate pointing at another company's invoice
ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_invoiceId_companyId_fkey"
  FOREIGN KEY ("invoiceId", "companyId") REFERENCES "sales_invoices"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
