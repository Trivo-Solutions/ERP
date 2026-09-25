-- AlterTable: add nullable first so existing rows can be backfilled before the NOT NULL is enforced.
ALTER TABLE "tag_estimates" ADD COLUMN     "taxRate" DECIMAL(5,4) NOT NULL DEFAULT 0.03,
ADD COLUMN     "gstAmount" DECIMAL(12,2),
ADD COLUMN     "netPayableAmount" DECIMAL(12,2);

-- Backfill existing rows (same 3% INR convention as NewSalePage.tsx / DEFAULT_HSN_CODE) so a
-- pre-existing saved estimate gets a real GST/Net Payable instead of losing history.
UPDATE "tag_estimates"
SET "gstAmount" = ROUND("totalSaleAmount" * "taxRate", 2),
    "netPayableAmount" = "totalSaleAmount" + ROUND("totalSaleAmount" * "taxRate", 2)
WHERE "gstAmount" IS NULL;

ALTER TABLE "tag_estimates" ALTER COLUMN "gstAmount" SET NOT NULL,
ALTER COLUMN "netPayableAmount" SET NOT NULL;
