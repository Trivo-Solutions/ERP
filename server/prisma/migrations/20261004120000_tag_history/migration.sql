-- Barcode (tag) history: an append-only ledger of every change to a jewelry_tags row.
--
-- Captured by a DATABASE TRIGGER, not by the services, so no code path — present or future — can change
-- a tag without leaving a trace (sales, memos, transfers, returns, edits, retire, repairs, scripts...).
-- Each row holds the full tag as it was AFTER the change (to_jsonb(NEW) = every column, so a new tag column
-- is captured automatically), plus the field-by-field before/after of what changed. The acting user comes
-- from the transaction setting app.actor_user_id that tenantQuery/tenantTransaction set from the request.
-- No FK on tagId: the history must outlive a deleted tag.

CREATE TABLE "tag_history" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "tagNumber" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "branchId" TEXT,
    "status" TEXT,
    "changedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "changes" JSONB,
    "snapshot" JSONB NOT NULL,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tag_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tag_history_companyId_createdAt_idx" ON "tag_history"("companyId", "createdAt");
CREATE INDEX "tag_history_companyId_tagId_createdAt_idx" ON "tag_history"("companyId", "tagId", "createdAt");
CREATE INDEX "tag_history_companyId_tagNumber_idx" ON "tag_history"("companyId", "tagNumber");
ALTER TABLE "tag_history" ADD CONSTRAINT "tag_history_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tag_history" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tag_history"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));

CREATE OR REPLACE FUNCTION tag_history_capture() RETURNS trigger AS $fn$
DECLARE
  actor text := nullif(current_setting('app.actor_user_id', true), '');
  o jsonb; n jsonb; k text;
  diff jsonb := '{}'::jsonb;
  ev text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tag_history ("id", "companyId", "tagId", "tagNumber", "event", "branchId", "status", "changedFields", "changes", "snapshot", "actorUserId")
    VALUES (gen_random_uuid()::text, NEW."companyId", NEW."id", NEW."tagNumber", 'CREATED', NEW."branchId", NEW."status",
            ARRAY[]::text[], NULL, to_jsonb(NEW), actor);
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    o := to_jsonb(OLD); n := to_jsonb(NEW);
    FOR k IN SELECT jsonb_object_keys(n) LOOP
      IF k <> 'updatedAt' AND (o -> k) IS DISTINCT FROM (n -> k) THEN
        diff := diff || jsonb_build_object(k, jsonb_build_object('from', o -> k, 'to', n -> k));
      END IF;
    END LOOP;
    IF o = n THEN RETURN NEW; END IF;
    ev := CASE
      WHEN diff ? 'status' THEN 'STATUS_CHANGE'
      WHEN diff ? 'branchId' THEN 'BRANCH_CHANGE'
      ELSE 'EDITED' END;
    INSERT INTO tag_history ("id", "companyId", "tagId", "tagNumber", "event", "branchId", "status", "changedFields", "changes", "snapshot", "actorUserId")
    VALUES (gen_random_uuid()::text, NEW."companyId", NEW."id", NEW."tagNumber", ev, NEW."branchId", NEW."status",
            ARRAY(SELECT jsonb_object_keys(diff)), diff, n, actor);
    RETURN NEW;
  ELSE
    INSERT INTO tag_history ("id", "companyId", "tagId", "tagNumber", "event", "branchId", "status", "changedFields", "changes", "snapshot", "actorUserId")
    VALUES (gen_random_uuid()::text, OLD."companyId", OLD."id", OLD."tagNumber", 'DELETED', OLD."branchId", OLD."status",
            ARRAY[]::text[], NULL, to_jsonb(OLD), actor);
    RETURN OLD;
  END IF;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER tag_history_capture
  AFTER INSERT OR UPDATE OR DELETE ON "jewelry_tags"
  FOR EACH ROW EXECUTE FUNCTION tag_history_capture();

-- Baseline: tags that already exist get one BASELINE row (their state when tracking began), so each has a
-- starting point to diff from. Touches tenant rows, so FORCE RLS is lifted around it and restored.
DO $$
DECLARE
  t text;
  forced text[] := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY['jewelry_tags', 'tag_history'] LOOP
    IF (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass(quote_ident(t))) THEN
      EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
      forced := forced || t;
    END IF;
  END LOOP;

  INSERT INTO "tag_history" ("id", "companyId", "tagId", "tagNumber", "event", "branchId", "status", "changedFields", "changes", "snapshot", "actorUserId")
    SELECT gen_random_uuid()::text, x."companyId", x."id", x."tagNumber", 'BASELINE', x."branchId", x."status",
           ARRAY[]::text[], NULL, to_jsonb(x), NULL
    FROM "jewelry_tags" x;

  FOREACH t IN ARRAY forced LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
