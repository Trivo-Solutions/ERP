-- Photography, Phase 1 (schema only). Three new company-owned tables: photography_stations, station_credentials,
-- tag_images. Purely additive: no existing table is altered (jewelry_tags in particular is untouched, so the tag
-- history trigger never fires for a photo), no row is updated, nothing is backfilled. Nothing cascades.

CREATE TABLE "photography_stations" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "registeredById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "photography_stations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "photography_stations_name_not_blank" CHECK (length(btrim("name")) > 0)
);

CREATE TABLE "station_credentials" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    CONSTRAINT "station_credentials_pkey" PRIMARY KEY ("id"),
    -- a revocation always records who did it
    CONSTRAINT "station_credentials_revoked_pair" CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL)),
    CONSTRAINT "station_credentials_token_hash_sha256" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "tag_images" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "imageType" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "reviewStatus" TEXT NOT NULL DEFAULT 'CAPTURED',
    "uploadStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "processingStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "storageKeyOriginal" TEXT,
    "storageKeyOptimized" TEXT,
    "storageKeyThumbnail" TEXT,
    "originalFilename" TEXT,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "captureSource" TEXT NOT NULL,
    "cameraLabel" TEXT,
    "stationId" TEXT,
    "capturedById" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "deleteReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tag_images_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tag_images_image_type_chk" CHECK ("imageType" IN ('PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER')),
    CONSTRAINT "tag_images_review_status_chk" CHECK ("reviewStatus" IN ('CAPTURED', 'REVIEW_REQUIRED', 'APPROVED', 'REJECTED')),
    CONSTRAINT "tag_images_upload_status_chk" CHECK ("uploadStatus" IN ('PENDING', 'CONFIRMED', 'FAILED')),
    CONSTRAINT "tag_images_processing_status_chk" CHECK ("processingStatus" IN ('PENDING', 'READY', 'FAILED')),
    CONSTRAINT "tag_images_capture_source_chk" CHECK ("captureSource" IN ('DEVICE_CAMERA', 'BRIDGE')),
    -- isPrimary mirrors imageType = 'PRIMARY' so the "one live primary per tag" index below cannot be sidestepped
    CONSTRAINT "tag_images_primary_matches_type" CHECK ("isPrimary" = ("imageType" = 'PRIMARY')),
    CONSTRAINT "tag_images_dimensions_positive" CHECK (("width" IS NULL OR "width" > 0) AND ("height" IS NULL OR "height" > 0)),
    CONSTRAINT "tag_images_size_nonneg" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
    CONSTRAINT "tag_images_sha256_format" CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "tag_images_idempotency_not_blank" CHECK (length(btrim("idempotencyKey")) > 0),
    -- an upload is only CONFIRMED once the bytes exist and their checksum is known
    CONSTRAINT "tag_images_confirmed_has_bytes" CHECK ("uploadStatus" <> 'CONFIRMED' OR ("storageKeyOriginal" IS NOT NULL AND "sha256" IS NOT NULL AND "sizeBytes" IS NOT NULL)),
    -- a deletion always records who did it
    CONSTRAINT "tag_images_deleted_pair" CHECK (("deletedAt" IS NULL) = ("deletedById" IS NULL)),
    -- object keys live under the owning company's prefix (same guard as design_files.filePath)
    CONSTRAINT "tag_images_key_original_company_prefix" CHECK ("storageKeyOriginal" IS NULL OR ("storageKeyOriginal" LIKE 'companies/' || "companyId" || '/%' AND "storageKeyOriginal" NOT LIKE '%..%')),
    CONSTRAINT "tag_images_key_optimized_company_prefix" CHECK ("storageKeyOptimized" IS NULL OR ("storageKeyOptimized" LIKE 'companies/' || "companyId" || '/%' AND "storageKeyOptimized" NOT LIKE '%..%')),
    CONSTRAINT "tag_images_key_thumbnail_company_prefix" CHECK ("storageKeyThumbnail" IS NULL OR ("storageKeyThumbnail" LIKE 'companies/' || "companyId" || '/%' AND "storageKeyThumbnail" NOT LIKE '%..%'))
);

-- Indexes / uniqueness
CREATE UNIQUE INDEX "photography_stations_companyId_name_key" ON "photography_stations"("companyId", "name");
CREATE UNIQUE INDEX "photography_stations_id_companyId_key" ON "photography_stations"("id", "companyId");
CREATE INDEX "photography_stations_companyId_branchId_idx" ON "photography_stations"("companyId", "branchId");

CREATE UNIQUE INDEX "station_credentials_tokenHash_key" ON "station_credentials"("tokenHash");
CREATE INDEX "station_credentials_companyId_stationId_idx" ON "station_credentials"("companyId", "stationId");

CREATE UNIQUE INDEX "tag_images_companyId_idempotencyKey_key" ON "tag_images"("companyId", "idempotencyKey");
CREATE UNIQUE INDEX "tag_images_id_companyId_key" ON "tag_images"("id", "companyId");
CREATE INDEX "tag_images_companyId_tagId_idx" ON "tag_images"("companyId", "tagId");
CREATE INDEX "tag_images_companyId_branchId_idx" ON "tag_images"("companyId", "branchId");
CREATE INDEX "tag_images_companyId_reviewStatus_idx" ON "tag_images"("companyId", "reviewStatus");
-- At most one LIVE primary per tag. A soft-deleted primary does not hold the slot. (Prisma cannot express a
-- partial index, so `prisma migrate diff` will list it as drift — it is owned by this migration.)
CREATE UNIQUE INDEX "tag_images_one_live_primary_per_tag" ON "tag_images"("tagId") WHERE "isPrimary" AND "deletedAt" IS NULL;

-- Foreign keys — every company-owned reference is composite (..., companyId), so a row pointing at another company's
-- tag / branch / station is refused by the database itself. Nothing cascades.
ALTER TABLE "photography_stations" ADD CONSTRAINT "photography_stations_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photography_stations" ADD CONSTRAINT "photography_stations_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photography_stations" ADD CONSTRAINT "photography_stations_registeredById_fkey"
  FOREIGN KEY ("registeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "station_credentials" ADD CONSTRAINT "station_credentials_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "station_credentials" ADD CONSTRAINT "station_credentials_stationId_companyId_fkey"
  FOREIGN KEY ("stationId", "companyId") REFERENCES "photography_stations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "station_credentials" ADD CONSTRAINT "station_credentials_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "station_credentials" ADD CONSTRAINT "station_credentials_revokedById_fkey"
  FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tag_images" ADD CONSTRAINT "tag_images_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tag_images" ADD CONSTRAINT "tag_images_tagId_companyId_fkey"
  FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tag_images" ADD CONSTRAINT "tag_images_branchId_companyId_fkey"
  FOREIGN KEY ("branchId", "companyId") REFERENCES "branches"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tag_images" ADD CONSTRAINT "tag_images_stationId_companyId_fkey"
  FOREIGN KEY ("stationId", "companyId") REFERENCES "photography_stations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tag_images" ADD CONSTRAINT "tag_images_capturedById_fkey"
  FOREIGN KEY ("capturedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tag_images" ADD CONSTRAINT "tag_images_deletedById_fkey"
  FOREIGN KEY ("deletedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (FORCE is applied by db-secure.sql to every table carrying this policy).
ALTER TABLE "photography_stations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "photography_stations"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "station_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "station_credentials"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
ALTER TABLE "tag_images" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tag_images"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
