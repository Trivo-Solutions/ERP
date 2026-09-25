-- CreateTable
CREATE TABLE "karat_master" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "metalType" TEXT NOT NULL,
    "purity" DECIMAL(6,4) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "karat_master_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "karat_master_code_key" ON "karat_master"("code");

-- Seed the fixed karat/purity list — the same values already hardcoded in
-- design.service.ts's upsertMetalRate() purity map and MetalRates.tsx's KARATS array.
-- This table becomes the single source of truth for both; the JS copies get wired to it
-- in application code, not removed here.
INSERT INTO "karat_master" ("id", "code", "metalType", "purity", "isActive") VALUES
    ('karatmaster_24k', '24K', 'GOLD', 0.9999, true),
    ('karatmaster_22k', '22K', 'GOLD', 0.9160, true),
    ('karatmaster_18k', '18K', 'GOLD', 0.7500, true),
    ('karatmaster_14k', '14K', 'GOLD', 0.5850, true),
    ('karatmaster_silver', 'SILVER', 'SILVER', 0.9250, true),
    ('karatmaster_pt', 'PT', 'PLATINUM', 0.9500, true);
