-- =====================================================================================
-- MIGRATION 007 — fix RLS bypass in renewals_view / global_search
-- Target: medcrm database after migrations 001-006.
-- Run as the schema-owner / migration role.
--
-- Both views are plain views (no security_invoker) owned by the postgres superuser.
-- Per Postgres's row-security rules, a non-security_invoker view's access to its
-- underlying tables is permission-checked as the VIEW OWNER, not the querying role —
-- and superusers unconditionally bypass RLS regardless of FORCE ROW LEVEL SECURITY on
-- the base tables. Empirically confirmed while building the Node backend: a caller
-- session saw all 6 renewals (not just their own 2) through renewals_view, and all 15
-- leads (not just their own 4) through global_search — despite both views' own
-- COMMENT ON VIEW text asserting RLS is inherited. Neither view was even granted to
-- app_user before now, so this was latent until this backend started querying them.
--
-- Fix: security_invoker = true makes each view evaluate the underlying tables' RLS as
-- the CALLING role (app_user, with its session's app.current_user_id/app.current_role
-- already set by set_app_session) instead of the view owner.
-- =====================================================================================

BEGIN;

ALTER VIEW renewals_view SET (security_invoker = true);
ALTER VIEW global_search SET (security_invoker = true);

GRANT SELECT ON renewals_view TO app_user;
GRANT SELECT ON global_search TO app_user;

COMMIT;
