-- CreateTable
CREATE TABLE "tag_estimates" (
    "id" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "estimateNumber" TEXT NOT NULL,
    "costMcRate" DECIMAL(12,4),
    "costVaPercent" DECIMAL(5,2),
    "saleMcRate" DECIMAL(12,4),
    "saleVaPercent" DECIMAL(5,2),
    "totalCostAmount" DECIMAL(12,2) NOT NULL,
    "totalSaleAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "validUntil" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_estimate_items" (
    "id" TEXT NOT NULL,
    "estimateId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "materialType" TEXT NOT NULL,
    "name" TEXT,
    "weight" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'GM',
    "costRate" DECIMAL(12,4),
    "costAmount" DECIMAL(12,2),
    "saleRate" DECIMAL(12,4),
    "saleAmount" DECIMAL(12,2),

    CONSTRAINT "tag_estimate_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tag_estimates_estimateNumber_key" ON "tag_estimates"("estimateNumber");

-- CreateIndex
CREATE INDEX "tag_estimates_tagId_idx" ON "tag_estimates"("tagId");

-- AddForeignKey
ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "jewelry_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_estimates" ADD CONSTRAINT "tag_estimates_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_estimate_items" ADD CONSTRAINT "tag_estimate_items_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "tag_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
