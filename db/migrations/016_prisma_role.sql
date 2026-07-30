-- =====================================================================================
-- MIGRATION 016 — dedicated Postgres role for the Prisma data layer
--
-- Context: the app is migrating from raw `pg` (authorization via RLS) to Prisma
-- (authorization in application code, see server/src/scope.ts). Those two models cannot
-- share a connection: a plain Prisma call runs outside any transaction, so
-- set_app_session() has never run, so app_current_user_id() is NULL and every one of the
-- 71 FORCE'd RLS policies filters the result to zero rows.
--
-- Rather than disabling RLS up front (which would instantly un-scope every caller on the
-- routes still using raw SQL), Prisma connects as its own BYPASSRLS role. That lets both
-- data layers run side by side during the route-by-route cutover:
--   * un-migrated routes keep using app_user, still fully RLS-enforced
--   * migrated routes use app_prisma, enforced by scope.ts in application code
-- RLS is only disabled once every route has moved (migration 018).
--
-- NOTE: BYPASSRLS is a role attribute, so it applies to this role globally. It is
-- deliberately NOT granted to app_user, which must stay RLS-bound.
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_prisma') THEN
    CREATE ROLE app_prisma LOGIN PASSWORD 'prismatest123';
  END IF;
END
$$;

ALTER ROLE app_prisma BYPASSRLS;

GRANT USAGE ON SCHEMA public TO app_prisma;

-- Mirror app_user's table privileges. audit_log and lead_assignments are deliberately
-- excluded from write access below, matching the existing grant model where the app may
-- read them but only triggers write them.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_prisma;
REVOKE INSERT, UPDATE, DELETE ON audit_log, lead_assignments FROM app_prisma;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_prisma;

-- The app still calls these SECURITY DEFINER helpers through Prisma's $queryRaw.
GRANT EXECUTE ON FUNCTION auth_login_lookup(text) TO app_prisma;
GRANT EXECUTE ON FUNCTION auth_session_lookup(text) TO app_prisma;
GRANT EXECUTE ON FUNCTION set_app_session(uuid) TO app_prisma;
GRANT EXECUTE ON FUNCTION convert_lead_to_order(uuid, numeric) TO app_prisma;
GRANT EXECUTE ON FUNCTION resolve_or_create_customer_for_lead(uuid) TO app_prisma;

COMMENT ON ROLE app_prisma IS 'Prisma data-layer role. BYPASSRLS: authorization for Prisma-backed routes lives in server/src/scope.ts, not in RLS policies.';

COMMIT;
