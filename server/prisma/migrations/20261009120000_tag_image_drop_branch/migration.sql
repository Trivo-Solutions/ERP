-- Photography Phase 1 correction: a photograph belongs to a JewelryTag, not a branch. tag_images.branchId would go
-- stale the moment the tag is transferred. The tag's current branch is jewelry_tags.branchId; where a photo was taken
-- is tag_images.stationId -> photography_stations.branchId. Drops only the structures that existed for that column;
-- jewelry_tags / photography_stations branch links and tag_images' RLS policy are untouched. No row is updated.
-- (Dropping the column also drops its index; both are listed so the intent is explicit.)
ALTER TABLE "tag_images" DROP CONSTRAINT "tag_images_branchId_companyId_fkey";
DROP INDEX "tag_images_companyId_branchId_idx";
ALTER TABLE "tag_images" DROP COLUMN "branchId";
