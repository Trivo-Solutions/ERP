-- AlterTable
ALTER TABLE "jewelry_tags" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "collectionId" TEXT,
ADD COLUMN     "makeType" TEXT NOT NULL DEFAULT 'GOLD',
ADD COLUMN     "subCategoryId" TEXT;

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_categories" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sub_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "materialType" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'GM',
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stone_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stone_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_masters" (
    "id" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "stoneTypeId" TEXT NOT NULL,
    "shape" TEXT,
    "color" TEXT,
    "clarity" TEXT,
    "cut" TEXT,
    "weightFrom" DECIMAL(10,4),
    "weightTo" DECIMAL(10,4),
    "quality" TEXT,
    "pricePerCarat" DECIMAL(12,4) NOT NULL,
    "priceUnit" TEXT NOT NULL DEFAULT 'PER_CARAT',
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_masters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewelry_tag_materials" (
    "id" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "materialCodeId" TEXT,
    "code" TEXT NOT NULL,
    "materialType" TEXT NOT NULL,
    "size" TEXT,
    "pieces" INTEGER,
    "weight" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'GM',
    "costRate" DECIMAL(12,4),
    "costAmount" DECIMAL(12,2),
    "saleRate" DECIMAL(12,4),
    "saleAmount" DECIMAL(12,2),

    CONSTRAINT "jewelry_tag_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_code_key" ON "product_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sub_categories_code_key" ON "sub_categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "collections_code_key" ON "collections"("code");

-- CreateIndex
CREATE UNIQUE INDEX "material_codes_code_key" ON "material_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "stone_types_code_key" ON "stone_types"("code");

-- CreateIndex
CREATE INDEX "price_masters_itemType_stoneTypeId_idx" ON "price_masters"("itemType", "stoneTypeId");

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_subCategoryId_fkey" FOREIGN KEY ("subCategoryId") REFERENCES "sub_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tags" ADD CONSTRAINT "jewelry_tags_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_categories" ADD CONSTRAINT "sub_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "product_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_masters" ADD CONSTRAINT "price_masters_stoneTypeId_fkey" FOREIGN KEY ("stoneTypeId") REFERENCES "stone_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "jewelry_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_materialCodeId_fkey" FOREIGN KEY ("materialCodeId") REFERENCES "material_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
