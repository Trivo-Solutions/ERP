-- Offer management step 2: an estimate remembers the offer applied to it and the pre-offer rates. Purely additive
-- (nullable columns, one composite FK); no existing row is read or changed.
ALTER TABLE "tag_estimates"
  ADD COLUMN "offerId" TEXT,
  ADD COLUMN "offerName" TEXT,
  ADD COLUMN "baseSaleMcRate" DECIMAL(12,4),
  ADD COLUMN "baseSaleVaPercent" DECIMAL(5,2);
ALTER TABLE "tag_estimate_items" ADD COLUMN "baseSaleRate" DECIMAL(12,4);
ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_offerId_companyId_fkey"
  FOREIGN KEY ("offerId", "companyId") REFERENCES "offers"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
