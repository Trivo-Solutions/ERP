-- Additive: session revocation on password change (see auth.service.ts changePassword / authenticate).
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
