-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "district" TEXT,
ADD COLUMN     "pincode" TEXT;

-- AlterTable
ALTER TABLE "jewelry_tags" ADD COLUMN     "manufacturerId" TEXT;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
