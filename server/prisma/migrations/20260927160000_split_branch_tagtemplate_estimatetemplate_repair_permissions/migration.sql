-- Continues the masters:manage / role:manage split (20260927150000) onto four more bundled
-- permissions, following the same audit-then-split rule: only split where a single permission
-- string genuinely gates more than one HTTP verb on the same resource. See
-- server/src/shared/permissionCatalog.ts and each router for the current, narrower checks.
--
--   branch:manage           -> branch:create, branch:edit                 (POST/PATCH /branches — no view/delete existed)
--   tagTemplate:manage      -> tagTemplate:view, tagTemplate:create, tagTemplate:edit  (GET/POST/PUT /templates — no separate view existed, same shape role:manage was in)
--   estimateTemplate:manage -> estimateTemplate:create, estimateTemplate:edit          (POST/PUT /templates — view was already split out)
--   repair:manage           -> ADDITIVE ONLY: repair:view, repair:create, repair:edit granted
--                              alongside the untouched repair:manage, which still gates two
--                              workflow actions (status transition, add transaction) that aren't
--                              create/edit-shaped and were deliberately NOT force-split.
--
-- Data-only migration: no schema change. Broadening, never narrowing — nobody silently loses
-- access. Same FORCE RLS lift precedent as 20260927150000 (and 20260925090000 before it).
DO $$
DECLARE forced boolean;
BEGIN
  SELECT relforcerowsecurity INTO forced FROM pg_class WHERE relname = 'roles' AND relnamespace = 'public'::regnamespace;
  IF forced THEN ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY; END IF;

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(SELECT DISTINCT unnest(
      array_remove("permissions", 'branch:manage') || ARRAY['branch:create', 'branch:edit']
    ))
  )
  WHERE 'branch:manage' = ANY("permissions");

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(SELECT DISTINCT unnest(
      array_remove("permissions", 'tagTemplate:manage') || ARRAY['tagTemplate:view', 'tagTemplate:create', 'tagTemplate:edit']
    ))
  )
  WHERE 'tagTemplate:manage' = ANY("permissions");

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(SELECT DISTINCT unnest(
      array_remove("permissions", 'estimateTemplate:manage') || ARRAY['estimateTemplate:create', 'estimateTemplate:edit']
    ))
  )
  WHERE 'estimateTemplate:manage' = ANY("permissions");

  UPDATE "roles"
  SET "permissions" = (
    SELECT ARRAY(SELECT DISTINCT unnest(
      "permissions" || ARRAY['repair:view', 'repair:create', 'repair:edit']
    ))
  )
  WHERE 'repair:manage' = ANY("permissions");

  IF forced THEN ALTER TABLE "roles" FORCE ROW LEVEL SECURITY; END IF;
END $$;
