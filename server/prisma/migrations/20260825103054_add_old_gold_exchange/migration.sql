-- CreateTable
CREATE TABLE "old_gold_exchanges" (
    "id" TEXT NOT NULL,
    "exchangeNumber" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "exchangeDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT NOT NULL,
    "karat" TEXT NOT NULL,
    "grossWeight" DECIMAL(10,4) NOT NULL,
    "stoneWeight" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "netWeight" DECIMAL(10,4) NOT NULL,
    "ratePerGram" DECIMAL(12,4) NOT NULL,
    "deductionPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "valuedAmount" DECIMAL(12,2) NOT NULL,
    "metalStockId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "old_gold_exchanges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "old_gold_exchanges_exchangeNumber_key" ON "old_gold_exchanges"("exchangeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "old_gold_exchanges_metalStockId_key" ON "old_gold_exchanges"("metalStockId");

-- AddForeignKey
ALTER TABLE "old_gold_exchanges" ADD CONSTRAINT "old_gold_exchanges_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "old_gold_exchanges" ADD CONSTRAINT "old_gold_exchanges_metalStockId_fkey" FOREIGN KEY ("metalStockId") REFERENCES "metal_stocks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
