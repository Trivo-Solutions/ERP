-- Additive only: no existing row is touched (every current member stays isSalesEmployee = false, no forced change).
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "company_users" ADD COLUMN "designation" TEXT;
ALTER TABLE "company_users" ADD COLUMN "isSalesEmployee" BOOLEAN NOT NULL DEFAULT false;
