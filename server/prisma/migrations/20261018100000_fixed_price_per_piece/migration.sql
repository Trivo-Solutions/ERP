-- Additive: every existing category and tag stays WEIGHT_BASED.
ALTER TABLE "product_categories" ADD COLUMN "pricingMode" TEXT NOT NULL DEFAULT 'WEIGHT_BASED';
ALTER TABLE "jewelry_tags" ADD COLUMN "pricingMode" TEXT NOT NULL DEFAULT 'WEIGHT_BASED';
