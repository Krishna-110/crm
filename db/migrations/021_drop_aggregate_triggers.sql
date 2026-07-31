-- 021_drop_aggregate_triggers.sql
--
-- Phase 3 of the full ORM migration (docs/ORM_MIGRATION.md): derived aggregates.
--
--   update_order_total            -> AGGREGATES.order_items  (orders.total_amount)
--   maintain_assigned_leads_count -> AGGREGATES.leads        (users.assigned_leads_count)
--
-- Both triggers maintained their totals with a DELTA derived from OLD and NEW. The Prisma
-- extension never sees OLD, so the TypeScript RECOMPUTES each aggregate from its source rows
-- instead.
--
-- That is a deliberate behavioural improvement, not just a workaround. A delta drifts
-- permanently if it is ever missed or applied twice; a recomputation is idempotent and
-- repairs itself on the next write. Both triggers carried GREATEST(x, 0) clamps precisely
-- because delta arithmetic can go negative — recomputation cannot.
--
-- One consequence worth recording: any pre-existing drift in orders.total_amount or
-- users.assigned_leads_count will silently correct itself the next time a related row is
-- written, rather than persisting.

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
      AND p.proname IN ('update_order_total', 'maintain_assigned_leads_count')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tgname, r.table_name);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS update_order_total() CASCADE;
DROP FUNCTION IF EXISTS maintain_assigned_leads_count() CASCADE;

COMMIT;
