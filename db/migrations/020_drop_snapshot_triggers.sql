-- 020_drop_snapshot_triggers.sql
--
-- Phase 2 of the full ORM migration (docs/ORM_MIGRATION.md): snapshot synchronisation.
--
-- Ported into server/src/dbRules.ts and applied by the Prisma client extension. Dropped in
-- the same change that ports them, per the rule in ORM_MIGRATION.md — a behaviour in both
-- places runs twice.
--
--   sync_customer_name_snapshot       -> SNAPSHOTS (follow_ups, orders, renewals)
--   sync_renewal_order_date           -> SNAPSHOTS.renewals.order_date
--   sync_renewal_product_snapshot     -> SNAPSHOTS.renewals.medicine_name
--   sync_followup_assigned_caller     -> inheritFollowUpCaller
--   sync_followup_caller_from_renewal -> applyAfterWriteRules
--
-- These rules read inside the caller's transaction via the client published on
-- AsyncLocalStorage, so a snapshot resolves against rows created earlier in the same
-- transaction — which lead conversion depends on.
--
-- NOTE: sync_followup_assigned_caller also called assert_active_user(). That guard stays in
-- the database and is ported in phase 4, so it is deliberately not duplicated in TypeScript.

BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.relname AS table_name, t.tgname
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_proc p      ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = 'public'
      AND p.proname IN ('sync_customer_name_snapshot','sync_renewal_order_date',
                        'sync_renewal_product_snapshot','sync_followup_assigned_caller',
                        'sync_followup_caller_from_renewal')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tgname, r.table_name);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS sync_customer_name_snapshot() CASCADE;
DROP FUNCTION IF EXISTS sync_renewal_order_date() CASCADE;
DROP FUNCTION IF EXISTS sync_renewal_product_snapshot() CASCADE;
DROP FUNCTION IF EXISTS sync_followup_assigned_caller() CASCADE;
DROP FUNCTION IF EXISTS sync_followup_caller_from_renewal() CASCADE;

COMMIT;
