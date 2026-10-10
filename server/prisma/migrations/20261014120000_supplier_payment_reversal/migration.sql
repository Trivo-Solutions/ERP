-- Supplier payment reversal: flag columns only. Purely additive - no existing row is read or changed.
ALTER TABLE "supplier_payments" ADD COLUMN "reversedAt" TIMESTAMP(3),
  ADD COLUMN "reversedById" TEXT,
  ADD COLUMN "reversalReason" TEXT;
