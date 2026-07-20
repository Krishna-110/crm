\set ON_ERROR_STOP on
-- Run as app_user (unprivileged, RLS enforced).

\echo '=== Caller CAN read lookups (dropdowns must load) ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');  -- caller Sneha
SELECT count(*) AS caller_can_read_statuses FROM lead_statuses;
ROLLBACK;

\echo '=== Caller CANNOT add a lookup value — expect RLS block ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');  -- caller
DO $$
BEGIN
  INSERT INTO lead_statuses (code, label) VALUES ('hacked','Hacked');
  RAISE NOTICE 'SECURITY HOLE: caller inserted a lookup value!';
EXCEPTION WHEN insufficient_privilege OR others THEN
  RAISE NOTICE 'Correctly blocked caller insert: %', SQLERRM;
END $$;
ROLLBACK;

\echo '=== Admin CAN add + retire a lookup value ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000002');  -- admin Priya
INSERT INTO lead_statuses (code, label, sort_order) VALUES ('quotation_sent','Quotation Sent',10)
RETURNING code AS admin_added;
UPDATE lead_statuses SET is_active = false WHERE code = 'closed'
RETURNING code AS admin_retired, is_active;
ROLLBACK;
