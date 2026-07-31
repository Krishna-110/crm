-- 019_drop_stamp_triggers.sql
--
-- Phase 1 of the full ORM migration (docs/ORM_MIGRATION.md): the mechanical field stamps.
--
-- These are now implemented in server/src/dbRules.ts and applied by the Prisma client
-- extension. They are dropped HERE, in the same change that ports them, because a rule
-- present in both places runs twice — and for stamps that means the application's value is
-- silently overwritten by the trigger's, making the port look like it worked when it did not.
--
-- Ported in this phase:
--   set_updated_at                     -> stampUpdatedAt          (20 tables)
--   set_notification_read_at           -> stampNotificationReadAt
--   normalize_leads_mobile             -> normalizeMobile
--   normalize_customers_primary_mobile -> normalizeMobile
--   (normalize_indian_mobile stays for now — see the note below)
--
-- Triggers on partitioned parents cascade to their children automatically, so the 208
-- partition-level copies of set_updated_at and set_notification_read_at go with them.

BEGIN;

-- ---------------------------------------------------------------------------------------
-- set_updated_at — attached to every table carrying an updated_at column.
-- ---------------------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT c.relname AS table_name, t.tgname
    FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_proc p      ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND p.proname IN ('set_updated_at', 'set_notification_read_at',
                        'normalize_leads_mobile', 'normalize_customers_primary_mobile')
      -- Only the parents: dropping a partitioned table's trigger removes the children's too,
      -- and dropping a child's directly is an error while the parent's still exists.
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tgname, r.table_name);
  END LOOP;
END $$;

-- The trigger functions themselves.
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;
DROP FUNCTION IF EXISTS set_notification_read_at() CASCADE;
DROP FUNCTION IF EXISTS normalize_leads_mobile() CASCADE;
DROP FUNCTION IF EXISTS normalize_customers_primary_mobile() CASCADE;
-- normalize_indian_mobile is deliberately NOT dropped yet. It is a plain helper, and the
-- two triggers that called it are gone — but convert_lead_to_order() and
-- resolve_or_create_customer_for_lead() also call it from their bodies. PL/pgSQL bodies are
-- resolved at runtime, so those calls are invisible to CASCADE: dropping it here succeeded
-- and then failed at the first lead conversion with
--   function normalize_indian_mobile(text) does not exist
-- It goes in phase 6, with the routines that use it.

COMMIT;

-- Verify: these should all report 0.
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('set_updated_at','set_notification_read_at',
--                        'normalize_leads_mobile','normalize_customers_primary_mobile');
