-- CreateTable
CREATE TABLE "making_charges" (
    "id" TEXT NOT NULL,
    "materialCodeId" TEXT,
    "categoryId" TEXT,
    "makeType" TEXT,
    "wastagePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "saleWastagePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "makingCharge" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "makingChargeType" TEXT NOT NULL DEFAULT 'PER_GRAM',
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "making_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "making_charges_isActive_idx" ON "making_charges"("isActive");

-- AddForeignKey
ALTER TABLE "making_charges" ADD CONSTRAINT "making_charges_materialCodeId_fkey" FOREIGN KEY ("materialCodeId") REFERENCES "material_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "making_charges" ADD CONSTRAINT "making_charges_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
