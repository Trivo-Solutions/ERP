-- F2: a standalone/on-account payment (an advance, or a payment against a client's general
-- outstanding balance rather than one specific invoice). invoiceId becomes optional; clientId is
-- added directly on every row (backfilled from the owning invoice for existing rows) so both
-- invoice-scoped and standalone payments query uniformly for a client statement (F4) without a
-- conditional join.
ALTER TABLE "invoice_payments" ALTER COLUMN "invoiceId" DROP NOT NULL;
ALTER TABLE "invoice_payments" ADD COLUMN "clientId" TEXT;

UPDATE "invoice_payments" ip
SET "clientId" = si."clientId"
FROM "sales_invoices" si
WHERE ip."invoiceId" = si."id";

ALTER TABLE "invoice_payments" ALTER COLUMN "clientId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "invoice_payments_clientId_idx" ON "invoice_payments"("clientId");
