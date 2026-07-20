-- RLS verification script — run as app_user, NOT as postgres superuser.
-- Uses the schema's own intended interface: SELECT set_app_session(user_id);

\echo '=== TEST 1: No session set (unauthenticated) — expect 0 leads visible ==='
BEGIN;
SELECT count(*) AS visible_leads_no_session FROM leads;
ROLLBACK;

\echo '=== TEST 2: Impersonate caller Sneha Iyer (...004) — expect exactly 4 leads, all hers ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');
SELECT count(*) AS visible_leads, count(*) FILTER (WHERE assigned_caller_id <> '10000000-0000-0000-0000-000000000004') AS leaked_other_callers_leads
FROM leads;
ROLLBACK;

\echo '=== TEST 3: Same caller directly SELECTs a lead assigned to a DIFFERENT caller by known ID — expect 0 rows ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');
SELECT id, assigned_caller_id FROM leads WHERE id = '40000000-0000-0000-0000-000000000003'; -- belongs to caller ...005
ROLLBACK;

\echo '=== TEST 4: Same caller tries to UPDATE (steal) a lead assigned to a different caller — expect 0 rows updated ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');
UPDATE leads SET notes = 'HIJACKED BY WRONG CALLER' WHERE id = '40000000-0000-0000-0000-000000000003';
SELECT 'rows actually changed: ' || (SELECT count(*) FROM leads WHERE id='40000000-0000-0000-0000-000000000003' AND notes = 'HIJACKED BY WRONG CALLER') AS result;
ROLLBACK;

\echo '=== TEST 5: Caller tries to reassign a not-yet-owned lead to themselves — expect rejection ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');
DO $$
BEGIN
  BEGIN
    UPDATE leads SET assigned_caller_id = '10000000-0000-0000-0000-000000000004' WHERE id = '40000000-0000-0000-0000-000000000003';
    IF FOUND THEN
      RAISE NOTICE 'SECURITY HOLE: caller reassigned a lead to themselves that they did not already own!';
    ELSE
      RAISE NOTICE 'Correctly blocked: UPDATE affected 0 rows (RLS USING clause filtered it out before WITH CHECK ran)';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Correctly blocked with error: %', SQLERRM;
  END;
END $$;
ROLLBACK;

\echo '=== TEST 6: Admin (...002) — expect to see ALL 15 leads ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000002');
SELECT count(*) AS visible_leads_as_admin FROM leads;
ROLLBACK;

\echo '=== TEST 7: Admin (...001, top role) — expect ALL 15 leads AND all 8 users ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000001');
SELECT count(*) AS visible_leads_as_admin FROM leads;
SELECT count(*) AS visible_users_as_admin FROM users;
ROLLBACK;

\echo '=== TEST 8: Admin now sees ALL users incl. other admins (was: hidden) — expect 8 rows, 3 admin + 5 caller ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000002');
SELECT count(*) AS visible_users, count(*) FILTER (WHERE role = 'admin') AS admins_visible FROM users;
ROLLBACK;

\echo '=== TEST 9: Admin CAN now manage another admin (deactivate) — expect success (was: rejected) ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000002');
UPDATE users SET status = 'inactive' WHERE id = '10000000-0000-0000-0000-000000000001' AND role = 'admin';
SELECT 'rows an admin updated on another admin: ' || count(*) AS result
FROM users WHERE id = '10000000-0000-0000-0000-000000000001' AND status = 'inactive';
ROLLBACK;

\echo '=== TEST 10: Caller viewing the users table — expect self-only or 0, never full roster ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');
SELECT count(*) AS visible_users_as_caller FROM users;
ROLLBACK;

\echo '=== TEST 11: Caller viewing orders — should only see orders tied to their own leads/customers ==='
BEGIN;
SELECT set_app_session('10000000-0000-0000-0000-000000000004');
SELECT count(*) AS visible_orders_as_caller FROM orders;
ROLLBACK;

\echo '=== TEST 12: Inactive user (...008, Kavya Reddy) tries to authenticate a session — expect rejection ==='
BEGIN;
DO $$
BEGIN
  BEGIN
    PERFORM set_app_session('10000000-0000-0000-0000-000000000008');
    RAISE NOTICE 'SECURITY HOLE: inactive user was able to establish a session!';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Correctly blocked: %', SQLERRM;
  END;
END $$;
ROLLBACK;
