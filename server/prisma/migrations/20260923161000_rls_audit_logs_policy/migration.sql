-- ═══════════════════════════════════════════════════════════════════════════
-- Row-Level Security for audit_logs — same inert-but-proven deployment status as every other
-- RLS migration in this project (see 20260923130000/20260923150000's own comments for the full
-- "why not FORCE yet" reasoning).
--
-- audit_logs.companyId is NULLABLE (see its schema comment) — a row written by a module that
-- isn't tenant-scoped yet has no honest companyId to stamp. The same tenant_isolation policy
-- shape used everywhere else is still correct here without a NULL-aware special case:
--   - USING: `NULL = current_setting(...)` evaluates to NULL, not TRUE, so a session never sees
--     an unscoped row through this policy — fail-safe, not a leak.
--   - WITH CHECK: Postgres treats a NULL policy-check result as "not violated" (only FALSE
--     blocks a write), so inserting a legitimately-unscoped (companyId: null) audit entry from a
--     dormant/not-yet-tenant-scoped module still succeeds even once FORCE is eventually enabled.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_logs"
  USING ("companyId" = current_setting('app.tenant_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.tenant_company_id', true));
