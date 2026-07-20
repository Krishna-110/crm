-- =====================================================================================
-- MIGRATION 004 — Remove the super_admin role (two roles: admin, caller)
-- Target: a database already created from schema.sql + migrations/001..003 (PG 15+).
-- Run as the schema-owner / migration role.
--
-- WHY: the product now has only two roles. With super_admin gone, ADMIN becomes the top
-- role with complete access — including managing other admins (there is no higher role to
-- restrict it). CALLER is unchanged (own leads / own profile only).
--
-- Approach (minimal, low-risk): the ~14 RLS policies and the privilege-escalation trigger
-- are all built on two predicates, is_super_admin() and is_admin_or_above(). Rather than
-- rewrite every policy, both predicates are redefined to mean "the admin (top) role", so
-- every place that previously granted super_admin-only power now correctly grants admins,
-- and every "admin OR self" policy still lets callers reach their own rows. Then the
-- escalation guard is simplified and 'super_admin' is removed from the enum.
-- =====================================================================================

BEGIN;

-- 1. Collapse any existing super_admin users into admin.
UPDATE users SET role = 'admin' WHERE role = 'super_admin';

-- 2. Role predicates: admin is now the top role. is_super_admin() is retained as a
--    synonym for is_admin_or_above() so the policies referencing it keep working; both
--    now evaluate to "current session is an admin".
CREATE OR REPLACE FUNCTION is_admin_or_above() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app_current_role() = 'admin'; $$;

CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app_current_role() = 'admin'; $$;
COMMENT ON FUNCTION is_super_admin() IS
  'Retained synonym for is_admin_or_above() after the super_admin role was removed (migration 004). Admin is the top role; both predicates mean "current session is an admin".';

-- 3. Privilege-escalation guard, simplified for two roles: admin (top role) may modify any
--    user account, including other admins and role grants; a caller still may not change
--    their own role, status, or employee_id. (Replaces the version that let only
--    super_admin through and forbade admins from touching non-caller accounts.)
CREATE OR REPLACE FUNCTION prevent_privilege_escalation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_role() = 'admin' THEN
    RETURN NEW;
  END IF;
  IF app_current_role() = 'caller' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
      RAISE EXCEPTION 'callers may not modify role, status, or employee_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Remove the now-stale 'super_admin' literal from customers_insert (any authenticated
--    session may create a customer — unchanged in effect).
DROP POLICY IF EXISTS customers_insert ON customers;
CREATE POLICY customers_insert ON customers FOR INSERT
WITH CHECK (app_current_role() IS NOT NULL);

-- 5. Rewrite the three users policies that referenced the role column, both (a) to express
--    the clean two-role rule — admin sees/creates/edits any user, caller only their own —
--    and (b) so they no longer reference the `role` column at all, which is what blocks the
--    ALTER COLUMN TYPE in step 6 (and would block any future change too). Row-level access
--    is here; the column-level rule (a caller can't change their own role/status/employee_id)
--    stays in trg_prevent_privilege_escalation.
DROP POLICY users_select ON users;
DROP POLICY users_insert ON users;
DROP POLICY users_update ON users;

CREATE POLICY users_select ON users FOR SELECT
USING (is_admin_or_above() OR id = app_current_user_id());

CREATE POLICY users_insert ON users FOR INSERT
WITH CHECK (is_admin_or_above());

CREATE POLICY users_update ON users FOR UPDATE
USING (is_admin_or_above() OR id = app_current_user_id())
WITH CHECK (is_admin_or_above() OR id = app_current_user_id());

-- 6. mv_caller_performance filters on users.role ("WHERE u.role = 'caller'"), so it also
--    depends on the column and blocks the type change. Drop it before the swap; recreated
--    verbatim in step 8.
DROP MATERIALIZED VIEW mv_caller_performance;

-- 7. Drop 'super_admin' from the user_role enum. No column value holds it (step 1) and no
--    policy/view references the column anymore (steps 5-6), so the standard
--    create-new / cast / drop-old / rename swap is safe. set_app_session declares a
--    `user_role` local var in its (late-compiled) body only — not a hard catalog dependency.
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
CREATE TYPE user_role_new AS ENUM ('admin','caller');
ALTER TABLE users ALTER COLUMN role TYPE user_role_new USING role::text::user_role_new;
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'caller';
DROP TYPE user_role;
ALTER TYPE user_role_new RENAME TO user_role;

-- 8. Recreate mv_caller_performance (unchanged definition — the fixed, pre-aggregated one).
CREATE MATERIALIZED VIEW mv_caller_performance AS
SELECT
  u.id AS caller_id,
  u.name AS caller_name,
  COALESCE(la.total_assigned_leads, 0) AS total_assigned_leads,
  COALESCE(la.converted_leads, 0) AS converted_leads,
  ROUND(COALESCE(la.converted_leads, 0)::numeric / NULLIF(la.total_assigned_leads, 0), 4) AS conversion_rate,
  COALESCE(la.open_leads, 0) AS open_leads,
  COALESCE(fu.overdue_follow_ups, 0) AS overdue_follow_ups,
  la.avg_days_to_convert
FROM users u
LEFT JOIN (
  SELECT
    assigned_caller_id,
    count(*) AS total_assigned_leads,
    count(*) FILTER (WHERE status = 'converted') AS converted_leads,
    count(*) FILTER (WHERE NOT is_terminal_lead_status(status)) AS open_leads,
    ROUND(
      AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 86400.0)
        FILTER (WHERE status = 'converted'), 2
    ) AS avg_days_to_convert
  FROM leads
  WHERE deleted_at IS NULL AND assigned_caller_id IS NOT NULL
  GROUP BY assigned_caller_id
) la ON la.assigned_caller_id = u.id
LEFT JOIN (
  SELECT
    assigned_caller_id,
    count(*) FILTER (WHERE status = 'pending' AND scheduled_at < now()) AS overdue_follow_ups
  FROM follow_ups
  WHERE deleted_at IS NULL AND assigned_caller_id IS NOT NULL
  GROUP BY assigned_caller_id
) fu ON fu.assigned_caller_id = u.id
WHERE u.role = 'caller' AND u.deleted_at IS NULL
WITH NO DATA;
CREATE UNIQUE INDEX ux_mv_caller_performance ON mv_caller_performance (caller_id);
GRANT SELECT ON mv_caller_performance TO app_user;
REFRESH MATERIALIZED VIEW mv_caller_performance;

COMMIT;
