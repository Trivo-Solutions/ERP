-- Photography Phase 5D: remote capture commands (ERP -> Camera Bridge). One new company-owned table, purely
-- additive: no existing table is altered, no row is updated, nothing is backfilled, nothing cascades.
CREATE TABLE "photography_capture_commands" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "imageType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failureCode" TEXT,
    "failureDetail" TEXT,
    "idempotencyKey" TEXT,
    "tagImageId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "photography_capture_commands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "photography_capture_commands_status_chk" CHECK ("status" IN ('QUEUED', 'ACCEPTED', 'CAPTURING', 'UPLOADED', 'FAILED', 'EXPIRED')),
    CONSTRAINT "photography_capture_commands_image_type_chk" CHECK ("imageType" IN ('PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER')),
    -- only a finished command has a completion time; only a failed one has a failure code; only an uploaded one has an image
    CONSTRAINT "photography_capture_commands_completed_chk" CHECK (("status" IN ('UPLOADED', 'FAILED', 'EXPIRED')) = ("completedAt" IS NOT NULL)),
    CONSTRAINT "photography_capture_commands_failure_chk" CHECK ("failureCode" IS NULL OR "status" = 'FAILED'),
    CONSTRAINT "photography_capture_commands_image_chk" CHECK ("tagImageId" IS NULL OR "status" = 'UPLOADED')
);

CREATE UNIQUE INDEX "photography_capture_commands_id_companyId_key" ON "photography_capture_commands"("id", "companyId");
CREATE INDEX "photography_capture_commands_companyId_stationId_status_idx" ON "photography_capture_commands"("companyId", "stationId", "status");
CREATE INDEX "photography_capture_commands_companyId_requestedById_idx" ON "photography_capture_commands"("companyId", "requestedById");
-- At most one LIVE command per station: the camera takes one picture at a time and commands are never queued up.
-- (Prisma cannot express a partial index, so `prisma migrate diff` will list it as drift — it is owned by this migration.)
CREATE UNIQUE INDEX "photography_capture_commands_one_live_per_station" ON "photography_capture_commands"("stationId")
  WHERE "status" IN ('QUEUED', 'ACCEPTED', 'CAPTURING');

ALTER TABLE "photography_capture_commands" ADD CONSTRAINT "photography_capture_commands_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photography_capture_commands" ADD CONSTRAINT "photography_capture_commands_stationId_companyId_fkey"
  FOREIGN KEY ("stationId", "companyId") REFERENCES "photography_stations"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photography_capture_commands" ADD CONSTRAINT "photography_capture_commands_tagId_companyId_fkey"
  FOREIGN KEY ("tagId", "companyId") REFERENCES "jewelry_tags"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photography_capture_commands" ADD CONSTRAINT "photography_capture_commands_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "photography_capture_commands" ADD CONSTRAINT "photography_capture_commands_tagImageId_companyId_fkey"
  FOREIGN KEY ("tagImageId", "companyId") REFERENCES "tag_images"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "photography_capture_commands" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "photography_capture_commands"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
