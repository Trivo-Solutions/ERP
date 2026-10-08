-- Photography: station camera discovery. Purely additive nullable columns on photography_stations (RLS and the composite
-- keys already cover the table): what the Camera Bridge reported about its cameras, and which camera a user asked for.
-- No row is updated, nothing is backfilled.
ALTER TABLE "photography_stations"
  ADD COLUMN "reportedCameras" JSONB,
  ADD COLUMN "camerasReportedAt" TIMESTAMP(3),
  ADD COLUMN "requestedCameraId" TEXT,
  ADD COLUMN "cameraRequestedAt" TIMESTAMP(3),
  ADD CONSTRAINT "photography_stations_requested_camera_chk"
    CHECK ("requestedCameraId" IS NULL OR "requestedCameraId" ~ '^(webcam|sony|mock):[A-Za-z0-9._:-]{1,64}$');
