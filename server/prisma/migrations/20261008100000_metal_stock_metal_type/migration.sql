-- Metal Vault: which metal a lot is (GOLD | SILVER). Pure ADD COLUMN, nullable: no row is touched (NULL = GOLD, read by
-- the application), so no FORCE RLS lifting is needed.
ALTER TABLE "metal_stocks" ADD COLUMN "metalType" TEXT;
