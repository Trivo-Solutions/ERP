-- AlterTable
ALTER TABLE "estimate_templates" ADD COLUMN     "widthMm" DECIMAL(6,2) NOT NULL DEFAULT 80,
ADD COLUMN     "heightMm" DECIMAL(6,2) NOT NULL DEFAULT 200;

-- Drop the defaults now that existing (zero) rows are backfilled — every future insert must supply
-- both explicitly, same as TagTemplate's widthMm/heightMm.
ALTER TABLE "estimate_templates" ALTER COLUMN "widthMm" DROP DEFAULT;
ALTER TABLE "estimate_templates" ALTER COLUMN "heightMm" DROP DEFAULT;
