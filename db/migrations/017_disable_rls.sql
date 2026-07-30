-- 017_disable_rls.sql
--
-- Phase 5 of the raw-pg -> Prisma migration: retire row-level security as the
-- authorization mechanism.
--
-- WHY
-- ---
-- Every request now goes through Prisma, which connects as app_prisma (BYPASSRLS), so
-- these policies have not been consulted by the application since 016_prisma_role.sql.
-- Authorization moved into TypeScript: the predicates live in server/src/scope.ts (a
-- one-to-one translation of the 71 policies below) and are injected into every query by
-- the client extension in server/src/scopedPrisma.ts.
--
-- Leaving RLS enabled-but-bypassed is worse than disabling it: it reads as a live second
-- line of defence when it is not one, and the next person to add a route would reasonably
-- assume the database is still filtering rows for them. It is not.
--
-- DISABLE, NOT DROP
-- -----------------
-- The 71 policies are deliberately left in pg_policy. They are the written record of what
-- the rules were, they are what scope.ts was derived from, and re-enabling is a one-line
-- ALTER per table (see the rollback block at the bottom) rather than a rewrite. Disabled
-- policies cost nothing at runtime.
--
-- WHAT THIS DOES NOT TOUCH
-- ------------------------
-- * The SECURITY DEFINER routines (convert_lead_to_order, resolve_or_create_customer_for_lead,
--   auth_login_lookup, auth_session_lookup) keep their own ownership checks. Those read
--   app_current_role()/app_current_user_id(), which is why the application still calls
--   set_app_session() -- see withDbSession() in server/src/scopedPrisma.ts.
-- * The five triggers that branch on those same GUCs (prevent_privilege_escalation,
--   prevent_caller_lead_lifecycle_changes, check_caller_lead_customer_link,
--   sync_lead_assignment_history, log_audit) are untouched and still fire. They are NOT
--   part of RLS and remain a real enforcement layer -- but only for writes issued inside
--   withDbSession(), which scopedPrisma.ts enforces fail-closed.
-- * set_app_session() and the app_current_*() helpers stay; the above depends on them.

BEGIN;

-- 20 tables. `p` = partitioned parent; its partitions never had relrowsecurity set of
-- their own, and Prisma addresses the parent, so the parent is the only place to change.
ALTER TABLE audit_log          DISABLE ROW LEVEL SECURITY;  -- partitioned
ALTER TABLE customers          DISABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_statuses DISABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_types    DISABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups         DISABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities    DISABLE ROW LEVEL SECURITY;  -- partitioned
ALTER TABLE lead_assignments   DISABLE ROW LEVEL SECURITY;
ALTER TABLE lead_medicines     DISABLE ROW LEVEL SECURITY;
ALTER TABLE lead_sources       DISABLE ROW LEVEL SECURITY;
ALTER TABLE lead_statuses      DISABLE ROW LEVEL SECURITY;
ALTER TABLE leads              DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      DISABLE ROW LEVEL SECURITY;  -- partitioned
ALTER TABLE order_items        DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_stages       DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders             DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_statuses   DISABLE ROW LEVEL SECURITY;
ALTER TABLE products           DISABLE ROW LEVEL SECURITY;
ALTER TABLE renewals           DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions           DISABLE ROW LEVEL SECURITY;
ALTER TABLE users              DISABLE ROW LEVEL SECURITY;

-- FORCE only matters while RLS is enabled (it makes policies apply to the table owner
-- too). Cleared as well so the catalog does not imply an enforcement level that is off.
ALTER TABLE audit_log          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE customers          NO FORCE ROW LEVEL SECURITY;
ALTER TABLE follow_up_statuses NO FORCE ROW LEVEL SECURITY;
ALTER TABLE follow_up_types    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE follow_ups         NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_activities    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_medicines     NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_sources       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE lead_statuses      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE leads              NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE order_items        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE order_stages       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE orders             NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_statuses   NO FORCE ROW LEVEL SECURITY;
ALTER TABLE products           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE renewals           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE users              NO FORCE ROW LEVEL SECURITY;

-- app_user was the pre-Prisma application login. Its only protection was RLS, which the
-- statements above just removed -- so as of this migration it is a login with full table
-- grants and no row filtering whatsoever. Nothing connects as it any more (server/src/db.ts
-- keeps only maintPool, which uses MAINT_PGUSER), so take away its ability to log in.
--
-- NOLOGIN rather than DROP ROLE: it still owns grants that document the old access model,
-- and dropping it would require reassigning them. Restore with:
--   ALTER ROLE app_user WITH LOGIN;
ALTER ROLE app_user WITH NOLOGIN;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK (re-enable RLS exactly as it was -- all 20 were ENABLE + FORCE):
--
--   BEGIN;
--   ALTER ROLE app_user WITH LOGIN;
--   DO $$
--   DECLARE t text;
--   BEGIN
--     FOREACH t IN ARRAY ARRAY[
--       'audit_log','customers','follow_up_statuses','follow_up_types','follow_ups',
--       'lead_activities','lead_assignments','lead_medicines','lead_sources',
--       'lead_statuses','leads','notifications','order_items','order_stages','orders',
--       'payment_statuses','products','renewals','sessions','users'
--     ] LOOP
--       EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
--       EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
--     END LOOP;
--   END $$;
--   COMMIT;
--
-- The policies themselves were never dropped, so this is sufficient. Note that restoring
-- RLS does NOT by itself restore enforcement for the running app: app_prisma has BYPASSRLS
-- (016_prisma_role.sql), so the API would keep using scope.ts regardless.
-- ---------------------------------------------------------------------------
