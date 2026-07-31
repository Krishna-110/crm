-- 022_drop_validation_triggers.sql
--
-- Phase 4 of the full ORM migration (docs/ORM_MIGRATION.md): referential validation.
--
--   check_leads_assigned_caller_active    -> assertActiveUser
--   check_renewals_assigned_caller_active -> assertActiveUser
--   check_followup_caller_active          -> assertActiveUser
--   check_leads_requested_product_active  -> assertActiveProduct
--   check_order_items_product_active      -> assertActiveProduct
--   check_followup_customer_consistency   -> assertCustomerConsistency
--   check_order_customer_consistency      -> assertCustomerConsistency
--
-- and the two helpers they were built on, assert_active_user / assert_active_product.
--
-- These RAISE EXCEPTION, which surfaces as P0001 and is mapped to HTTP 403 by errors.ts. The
-- TypeScript throws ApiError.forbidden with the same message text, so the status and body a
-- client sees are unchanged — only the layer producing them moves.
--
-- NOT dropped here: check_caller_lead_customer_link. Despite the name it is a privilege
-- guard, not a referential one — it stops a caller attaching their lead to a customer they
-- do not own — so it belongs with the security triggers in phase 5.

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
      AND p.proname IN ('check_leads_assigned_caller_active','check_renewals_assigned_caller_active',
                        'check_followup_caller_active','check_leads_requested_product_active',
                        'check_order_items_product_active','check_followup_customer_consistency',
                        'check_order_customer_consistency')
      AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', r.tgname, r.table_name);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS check_leads_assigned_caller_active() CASCADE;
DROP FUNCTION IF EXISTS check_renewals_assigned_caller_active() CASCADE;
DROP FUNCTION IF EXISTS check_followup_caller_active() CASCADE;
DROP FUNCTION IF EXISTS check_leads_requested_product_active() CASCADE;
DROP FUNCTION IF EXISTS check_order_items_product_active() CASCADE;
DROP FUNCTION IF EXISTS check_followup_customer_consistency() CASCADE;
DROP FUNCTION IF EXISTS check_order_customer_consistency() CASCADE;
DROP FUNCTION IF EXISTS assert_active_user(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS assert_active_product(uuid, text) CASCADE;

COMMIT;
