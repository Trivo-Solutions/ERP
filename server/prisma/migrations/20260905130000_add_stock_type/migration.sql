-- CreateTable
CREATE TABLE "stock_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_types_code_key" ON "stock_types"("code");

-- AlterTable
ALTER TABLE "jewelry_tags" ADD COLUMN "stockTypeId" TEXT;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_stockTypeId_fkey" FOREIGN KEY ("stockTypeId") REFERENCES "stock_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
