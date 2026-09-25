-- CreateTable
CREATE TABLE "stone_grades" (
    "id" TEXT NOT NULL,
    "stoneTypeId" TEXT NOT NULL,
    "shape" TEXT,
    "color" TEXT,
    "clarity" TEXT,
    "cut" TEXT,
    "quality" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stone_grades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stone_grades_stoneTypeId_idx" ON "stone_grades"("stoneTypeId");

-- AddForeignKey
ALTER TABLE "stone_grades" ADD CONSTRAINT "stone_grades_stoneTypeId_fkey" FOREIGN KEY ("stoneTypeId") REFERENCES "stone_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data backfill: one stone_grades row per distinct classification combo already used by an
-- existing price_masters row (empty string treated as "not set", matching how the app has
-- always written these columns) — a straight column rename can't work here since PriceMaster
-- used to point at a StoneType directly and now must point at the (possibly brand new) Grade
-- that carries its existing classification.
INSERT INTO "stone_grades" ("id", "stoneTypeId", "shape", "color", "clarity", "cut", "quality", "isActive", "createdAt")
SELECT gen_random_uuid()::text, d."stoneTypeId", d.shape, d.color, d.clarity, d.cut, d.quality, true, now()
FROM (
    SELECT DISTINCT "stoneTypeId", NULLIF(shape, '') AS shape, NULLIF(color, '') AS color,
           NULLIF(clarity, '') AS clarity, NULLIF(cut, '') AS cut, NULLIF(quality, '') AS quality
    FROM "price_masters"
) d;

-- price_masters: add stoneGradeId, populate it from the backfilled grade matching each row's
-- own (stoneTypeId, shape, color, clarity, cut, quality), then drop the old stoneTypeId link.
-- AlterTable
ALTER TABLE "price_masters" ADD COLUMN "stoneGradeId" TEXT;

UPDATE "price_masters" pm
SET "stoneGradeId" = sg.id
FROM "stone_grades" sg
WHERE sg."stoneTypeId" = pm."stoneTypeId"
  AND sg.shape IS NOT DISTINCT FROM NULLIF(pm.shape, '')
  AND sg.color IS NOT DISTINCT FROM NULLIF(pm.color, '')
  AND sg.clarity IS NOT DISTINCT FROM NULLIF(pm.clarity, '')
  AND sg.cut IS NOT DISTINCT FROM NULLIF(pm.cut, '')
  AND sg.quality IS NOT DISTINCT FROM NULLIF(pm.quality, '');

ALTER TABLE "price_masters" ALTER COLUMN "stoneGradeId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "price_masters" DROP CONSTRAINT "price_masters_stoneTypeId_fkey";

-- DropIndex
DROP INDEX "price_masters_itemType_stoneTypeId_idx";

-- AlterTable
ALTER TABLE "price_masters" DROP COLUMN "stoneTypeId";

-- CreateIndex
CREATE INDEX "price_masters_itemType_stoneGradeId_idx" ON "price_masters"("itemType", "stoneGradeId");

-- AddForeignKey
ALTER TABLE "price_masters" ADD CONSTRAINT "price_masters_stoneGradeId_fkey" FOREIGN KEY ("stoneGradeId") REFERENCES "stone_grades"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- jewelry_tag_materials: no classification columns to key off (never had shape/color/etc.),
-- so any existing non-null stoneTypeId gets mapped to a per-StoneType "unspecified" grade
-- (all classification fields null) rather than losing the reference. Data-driven: inserts
-- nothing when no such rows exist.
INSERT INTO "stone_grades" ("id", "stoneTypeId", "isActive", "createdAt")
SELECT gen_random_uuid()::text, d."stoneTypeId", true, now()
FROM (SELECT DISTINCT "stoneTypeId" FROM "jewelry_tag_materials" WHERE "stoneTypeId" IS NOT NULL) d;

-- AlterTable
ALTER TABLE "jewelry_tag_materials" ADD COLUMN "stoneGradeId" TEXT;

UPDATE "jewelry_tag_materials" jtm
SET "stoneGradeId" = sg.id
FROM "stone_grades" sg
WHERE sg."stoneTypeId" = jtm."stoneTypeId"
  AND sg.shape IS NULL AND sg.color IS NULL AND sg.clarity IS NULL AND sg.cut IS NULL AND sg.quality IS NULL
  AND jtm."stoneTypeId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "jewelry_tag_materials" DROP CONSTRAINT "jewelry_tag_materials_stoneTypeId_fkey";

-- AlterTable
ALTER TABLE "jewelry_tag_materials" DROP COLUMN "stoneTypeId";

-- AddForeignKey
ALTER TABLE "jewelry_tag_materials" ADD CONSTRAINT "jewelry_tag_materials_stoneGradeId_fkey" FOREIGN KEY ("stoneGradeId") REFERENCES "stone_grades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
