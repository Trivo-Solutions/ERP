-- Splits the single 'role:manage' permission string into four granular ones (role:view,
-- role:create, role:edit, role:delete) so the Role editor's grid can grant/deny each
-- independently — see server/src/shared/permissionCatalog.ts and settings.router.ts, which now
-- gate GET/POST/PATCH/DELETE /settings/roles on these four strings instead of one shared one.
--
-- Data-only migration: no schema change. Any existing Role row that already held 'role:manage'
-- (in practice: SALES_MANAGER, seeded by the starter package) gets the four new strings instead,
-- deduped against whatever it already had — broadening, never narrowing, so nobody silently loses
-- access. `roles` is a tenant table: once db-secure.sql has FORCEd row-level security, even its
-- owner (who runs migrations) is filtered by the policy and this UPDATE would touch nothing — so
-- FORCE is lifted for the statement and restored after, same precedent as
-- 20260925090000_purchase_input_gst's ledger-account seed. A single-role dev/test database never
-- had it forced and is left as it was.
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'roles' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY; END IF;

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(
      SELECT DISTINCT unnest(
        array_remove("permissions", 'role:manage') || ARRAY['role:view', 'role:create', 'role:edit', 'role:delete']
      )
    )
  )
  WHERE 'role:manage' = ANY("permissions");

  IF forced THEN ALTER TABLE "roles" FORCE ROW LEVEL SECURITY; END IF;
END $$;
