-- Material Purchase: OLD (24K Old Gold rate) vs PURE (24K normal Gold rate). Pure ADD COLUMN, nullable: no row is
-- touched (historical NULL is read as OLD by the application), so no FORCE RLS lifting is needed.
CREATE TYPE "MaterialPurchaseType" AS ENUM ('OLD', 'PURE');
ALTER TABLE "old_gold_exchanges" ADD COLUMN "purchaseType" "MaterialPurchaseType";
