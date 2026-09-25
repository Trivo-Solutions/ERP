-- AlterTable: paymentNumber is an auto-generated internal transaction number (NumberGen.payment(),
-- format PMT-YYYY-NNNNNN), separate from the free-text external referenceNo (bank ref/cheque/UPI
-- txn id). Existing rows predate this column, so add nullable, backfill with a placeholder unique
-- per row, then make it required — same pattern as prior backfilled additions in this repo.
ALTER TABLE "invoice_payments" ADD COLUMN "paymentNumber" TEXT;

UPDATE "invoice_payments"
SET "paymentNumber" = 'PMT-LEGACY-' || SUBSTRING(md5(id) FOR 8)
WHERE "paymentNumber" IS NULL;

ALTER TABLE "invoice_payments" ALTER COLUMN "paymentNumber" SET NOT NULL;

CREATE UNIQUE INDEX "invoice_payments_paymentNumber_key" ON "invoice_payments"("paymentNumber");
