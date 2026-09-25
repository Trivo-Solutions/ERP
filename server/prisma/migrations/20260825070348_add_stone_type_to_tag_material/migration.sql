-- AlterTable
ALTER TABLE "jewelry_tag_materials" ADD COLUMN     "stoneTypeId" TEXT;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_stoneTypeId_fkey" FOREIGN KEY ("stoneTypeId") REFERENCES "stone_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;
