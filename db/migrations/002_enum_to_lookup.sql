-- =====================================================================================
-- MIGRATION 002 — Convert business-workflow ENUMs to admin-editable lookup tables
-- Target: a database already created from schema.sql + migrations/001 (PostgreSQL 15+).
-- Run as the schema-owner / migration role.
--
-- WHY: native ENUMs can only be extended with ADD VALUE and have NO drop/rename
-- primitive, so adding/retiring a status/source/stage means a blocking migration. This
-- converts the seven BUSINESS-WORKFLOW enums to lookup tables keyed by their existing
-- `code`, so the columns keep the same text values (every `status = 'converted'` literal
-- across the schema still works) while the allowed set becomes an admin-editable table:
--   * add a value      -> INSERT a row (no deploy)
--   * retire a value   -> UPDATE is_active = false (no deploy; existing rows keep the code)
--   * rename the label -> UPDATE label (code, which app logic keys on, stays stable)
--   * rename the code  -> UPDATE code (ON UPDATE CASCADE propagates to referencing rows)
--
-- DELIBERATELY LEFT AS NATIVE ENUMS (system-fixed, not business taxonomies):
--   user_role / user_status  — wired into RLS policy logic; adding a role means writing
--                              new policies, not editing data.
--   lead_activity_type       — emitted by application code for specific events.
--   notification_type        — maps to fixed frontend rendering (colour/icon).
--   notification_entity_type — maps to the actual deep-link target tables.
--   audit_action             — the three Postgres write operations.
--   renewal_status           — derived at query time (compute_renewal_status), not stored.
--
-- Terminality (is_terminal_lead_status) stays an IMMUTABLE code function, NOT a column on
-- lead_statuses: it is used in the ix_leads_open partial-index predicate, and partial
-- index predicates require IMMUTABLE functions (a table lookup is only STABLE). Keeping it
-- in one function is still a single source of truth; classifying a new status as terminal
-- is genuine code logic (it changes which leads count as "open" in dashboards/pipelines).
-- =====================================================================================

BEGIN;

-- -------------------------------------------------------------------------------------
-- 1. Lookup tables (code = natural key the FKs reference). is_active lets a value be
--    retired without breaking historical rows that still carry its code.
-- -------------------------------------------------------------------------------------
CREATE TABLE lead_statuses (
  code       text PRIMARY KEY,
  label      text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_statuses (code, label, sort_order) VALUES
  ('new','New',1),('contacted','Contacted',2),('follow_up_pending','Follow-up Pending',3),
  ('interested','Interested',4),('call_back_later','Call Back Later',5),('no_response','No Response',6),
  ('not_interested','Not Interested',7),('converted','Converted',8),('closed','Closed',9);

CREATE TABLE lead_priorities (LIKE lead_statuses INCLUDING ALL);
INSERT INTO lead_priorities (code, label, sort_order) VALUES
  ('low','Low',1),('medium','Medium',2),('high','High',3),('urgent','Urgent',4);

CREATE TABLE lead_sources (LIKE lead_statuses INCLUDING ALL);
INSERT INTO lead_sources (code, label, sort_order) VALUES
  ('website','Website',1),('referral','Referral',2),('walk_in','Walk-in',3),('phone','Phone',4),
  ('social_media','Social Media',5),('advertisement','Advertisement',6),('other','Other',7);

CREATE TABLE order_stages (LIKE lead_statuses INCLUDING ALL);
INSERT INTO order_stages (code, label, sort_order) VALUES
  ('lead','Lead',1),('confirmed','Confirmed',2),('medicine_prepared','Medicine Prepared',3),
  ('packed','Packed',4),('shipped','Shipped',5),('delivered','Delivered',6);

CREATE TABLE payment_statuses (LIKE lead_statuses INCLUDING ALL);
INSERT INTO payment_statuses (code, label, sort_order) VALUES
  ('pending','Pending',1),('partial','Partial',2),('paid','Paid',3),('refunded','Refunded',4);

CREATE TABLE follow_up_types (LIKE lead_statuses INCLUDING ALL);
INSERT INTO follow_up_types (code, label, sort_order) VALUES
  ('call','Call',1),('reminder','Reminder',2),('callback','Callback',3);

CREATE TABLE follow_up_statuses (LIKE lead_statuses INCLUDING ALL);
INSERT INTO follow_up_statuses (code, label, sort_order) VALUES
  ('pending','Pending',1),('completed','Completed',2),('missed','Missed',3);

-- RLS + grants for all seven, applied uniformly: readable by any authenticated app
-- session (dropdowns must always load), writable by admin/super_admin only — matching
-- the products table's policy shape. updated_at auto-maintained like every other table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_statuses','lead_priorities','lead_sources','order_stages',
                           'payment_statuses','follow_up_types','follow_up_statuses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (app_current_role() IS NOT NULL)', t||'_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (is_admin_or_above())', t||'_insert', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (is_admin_or_above()) WITH CHECK (is_admin_or_above())', t||'_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (is_admin_or_above())', t||'_delete', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- -------------------------------------------------------------------------------------
-- 2. Drop the objects that depend on the enum columns / the enum-typed function, so the
--    ALTER COLUMN ... TYPE text calls below are unblocked. Recreated in step 6.
-- -------------------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS mv_caller_performance;
DROP MATERIALIZED VIEW IF EXISTS mv_lead_status_breakdown;
DROP INDEX IF EXISTS ix_leads_open;
DROP INDEX IF EXISTS ix_follow_ups_pending;
DROP INDEX IF EXISTS ix_follow_ups_caller_pending_scheduled;
DROP FUNCTION IF EXISTS is_terminal_lead_status(lead_status);

-- -------------------------------------------------------------------------------------
-- 3. leads.status / priority / lead_source  (enum -> text + FK to lookup)
-- -------------------------------------------------------------------------------------
ALTER TABLE leads ALTER COLUMN status      DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN priority    DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN lead_source DROP DEFAULT;
ALTER TABLE leads ALTER COLUMN status      TYPE text USING status::text;
ALTER TABLE leads ALTER COLUMN priority    TYPE text USING priority::text;
ALTER TABLE leads ALTER COLUMN lead_source TYPE text USING lead_source::text;
ALTER TABLE leads ALTER COLUMN status      SET DEFAULT 'new';
ALTER TABLE leads ALTER COLUMN priority    SET DEFAULT 'medium';
ALTER TABLE leads ALTER COLUMN lead_source SET DEFAULT 'other';
ALTER TABLE leads ADD CONSTRAINT fk_leads_status   FOREIGN KEY (status)      REFERENCES lead_statuses(code)   ON UPDATE CASCADE;
ALTER TABLE leads ADD CONSTRAINT fk_leads_priority FOREIGN KEY (priority)    REFERENCES lead_priorities(code) ON UPDATE CASCADE;
ALTER TABLE leads ADD CONSTRAINT fk_leads_source   FOREIGN KEY (lead_source) REFERENCES lead_sources(code)     ON UPDATE CASCADE;

-- -------------------------------------------------------------------------------------
-- 4. orders.stage / payment_status
-- -------------------------------------------------------------------------------------
ALTER TABLE orders ALTER COLUMN stage          DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN payment_status DROP DEFAULT;
ALTER TABLE orders ALTER COLUMN stage          TYPE text USING stage::text;
ALTER TABLE orders ALTER COLUMN payment_status TYPE text USING payment_status::text;
ALTER TABLE orders ALTER COLUMN stage          SET DEFAULT 'lead';
ALTER TABLE orders ALTER COLUMN payment_status SET DEFAULT 'pending';
ALTER TABLE orders ADD CONSTRAINT fk_orders_stage          FOREIGN KEY (stage)          REFERENCES order_stages(code)     ON UPDATE CASCADE;
ALTER TABLE orders ADD CONSTRAINT fk_orders_payment_status FOREIGN KEY (payment_status) REFERENCES payment_statuses(code) ON UPDATE CASCADE;

-- -------------------------------------------------------------------------------------
-- 5. follow_ups.type / status
-- -------------------------------------------------------------------------------------
ALTER TABLE follow_ups ALTER COLUMN status DROP DEFAULT;
ALTER TABLE follow_ups ALTER COLUMN type   TYPE text USING type::text;
ALTER TABLE follow_ups ALTER COLUMN status TYPE text USING status::text;
ALTER TABLE follow_ups ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE follow_ups ADD CONSTRAINT fk_follow_ups_type   FOREIGN KEY (type)   REFERENCES follow_up_types(code)    ON UPDATE CASCADE;
ALTER TABLE follow_ups ADD CONSTRAINT fk_follow_ups_status FOREIGN KEY (status) REFERENCES follow_up_statuses(code) ON UPDATE CASCADE;

-- -------------------------------------------------------------------------------------
-- 6. Recreate the dropped dependents against the now-text columns.
-- -------------------------------------------------------------------------------------
CREATE FUNCTION is_terminal_lead_status(p_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('converted','closed','not_interested');
$$;

CREATE INDEX ix_leads_open ON leads (assigned_caller_id, priority)
  WHERE deleted_at IS NULL AND NOT is_terminal_lead_status(status);
CREATE INDEX ix_follow_ups_pending ON follow_ups (scheduled_at)
  WHERE status = 'pending' AND deleted_at IS NULL;
CREATE INDEX ix_follow_ups_caller_pending_scheduled ON follow_ups (assigned_caller_id, scheduled_at)
  WHERE status = 'pending' AND deleted_at IS NULL;

CREATE MATERIALIZED VIEW mv_lead_status_breakdown AS
SELECT
  status,
  priority,
  lead_source,
  count(*) AS lead_count,
  count(*) FILTER (WHERE next_follow_up_at IS NOT NULL AND next_follow_up_at < now()) AS overdue_follow_up_count
FROM leads
WHERE deleted_at IS NULL
GROUP BY status, priority, lead_source
WITH NO DATA;
CREATE UNIQUE INDEX ux_mv_lead_status_breakdown ON mv_lead_status_breakdown (status, priority, lead_source);

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

GRANT SELECT ON mv_lead_status_breakdown, mv_caller_performance TO app_user;

REFRESH MATERIALIZED VIEW mv_lead_status_breakdown;
REFRESH MATERIALIZED VIEW mv_caller_performance;

-- -------------------------------------------------------------------------------------
-- 7. Drop the now-unused enum types.
-- -------------------------------------------------------------------------------------
DROP TYPE lead_status;
DROP TYPE lead_priority;
DROP TYPE lead_source;
DROP TYPE order_stage;
DROP TYPE payment_status;
DROP TYPE follow_up_type;
DROP TYPE follow_up_status;

COMMIT;
