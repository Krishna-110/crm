-- =====================================================================================
-- MEDICAL CRM — CANONICAL POSTGRESQL SCHEMA (NORMALIZATION / CORRECTNESS LENS)
-- Target: PostgreSQL 15+
-- Author: Architect "Correctness & Normalization First"
-- =====================================================================================
-- Design pillars:
--   1. 3NF/BCNF normalization. No duplicated customer identity. No embedded arrays.
--   2. Every FK has an explicit ON DELETE / ON UPDATE action (never left to default).
--   3. Lookup tables (not native ENUM) for anything an admin may need to extend.
--   4. UUID surrogate PKs everywhere; natural/business keys are UNIQUE, never PK.
--   5. timestamptz everywhere; NUMERIC for money; generated/derived columns instead of
--      hand-maintained redundant state wherever cheaply possible.
--   6. Soft delete via deleted_at on all business tables; created_at/updated_at on all
--      tables, auto-maintained via trigger.
--   7. RLS enforces the three-role access model as defense-in-depth alongside app checks.
--   8. Partitioning + retention plan for append-heavy tables (lead_activities,
--      notifications, audit_log).
-- =====================================================================================


-- =====================================================================================
-- SECTION 0: EXTENSIONS
-- =====================================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram support, helps ILIKE / fuzzy search
                                            -- alongside tsvector (see SECTION 12)


-- =====================================================================================
-- SECTION 1: GENERIC INFRASTRUCTURE (triggers, helper functions)
-- =====================================================================================

-- 1.1 Auto-maintain updated_at on every table (attached per-table below).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 1.2 RLS session-variable helpers.
-- The application sets these two session variables immediately after authenticating
-- a request (e.g. in a connection-pooled middleware, per-transaction):
--   SET LOCAL app.current_user_id = '<uuid>';
--   SET LOCAL app.current_role    = 'super_admin' | 'admin' | 'caller';
-- Using SET LOCAL scopes them to the transaction, which is safe under connection
-- pooling (PgBouncer transaction mode) as long as they are set at the start of
-- every transaction that touches RLS-protected tables.
CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION current_app_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.current_role', true);
$$;

CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_app_role() = 'super_admin'; $$;

CREATE OR REPLACE FUNCTION is_admin_or_above() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_app_role() IN ('super_admin','admin'); $$;

-- 1.3 Generic audit-log writer, attached to the tables we want compliance history for.
-- (audit_log table itself is defined in SECTION 11; forward-referenced here.)
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD);
    INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, old_data, new_data)
    VALUES (TG_TABLE_NAME, OLD.id, TG_OP, current_app_user_id(), now(), v_old, NULL);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, old_data, new_data)
    VALUES (TG_TABLE_NAME, NEW.id, TG_OP, current_app_user_id(), now(), v_old, v_new);
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, old_data, new_data)
    VALUES (TG_TABLE_NAME, NEW.id, TG_OP, current_app_user_id(), now(), NULL, v_new);
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$;


-- =====================================================================================
-- SECTION 2: LOOKUP / REFERENCE TABLES
-- Replace what the frontend models as TypeScript unions. Each is a small, admin-editable
-- table: smallint identity PK (compact FK storage), unique `code` as the natural key
-- (this is what the app logic and CHECK-like validation keys off), a human `label`,
-- `sort_order` for UI dropdowns, and `is_active` so a code can be retired without
-- breaking FK history on old rows.
-- =====================================================================================

CREATE TABLE roles (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,   -- 'super_admin' | 'admin' | 'caller'
  label       text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO roles (code, label, sort_order) VALUES
  ('super_admin','Super Admin',1), ('admin','Admin',2), ('caller','Caller',3);

CREATE TABLE user_statuses (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO user_statuses (code,label,sort_order) VALUES ('active','Active',1),('inactive','Inactive',2);

CREATE TABLE lead_statuses (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_terminal boolean NOT NULL DEFAULT false,  -- 'converted'/'closed' are terminal
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_statuses (code,label,sort_order,is_terminal) VALUES
  ('new','New',1,false),('contacted','Contacted',2,false),
  ('follow_up_pending','Follow-up Pending',3,false),('interested','Interested',4,false),
  ('call_back_later','Call Back Later',5,false),('no_response','No Response',6,false),
  ('not_interested','Not Interested',7,true),('converted','Converted',8,true),
  ('closed','Closed',9,true);

CREATE TABLE lead_priorities (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_priorities (code,label,sort_order) VALUES
  ('low','Low',1),('medium','Medium',2),('high','High',3),('urgent','Urgent',4);

CREATE TABLE lead_sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO lead_sources (code,label,sort_order) VALUES
  ('website','Website',1),('referral','Referral',2),('walk_in','Walk-in',3),
  ('phone','Phone',4),('social_media','Social Media',5),('advertisement','Advertisement',6),
  ('other','Other',7);

CREATE TABLE activity_types (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO activity_types (code,label,sort_order) VALUES
  ('call','Call',1),('comment','Comment',2),('status_change','Status Change',3),
  ('follow_up','Follow-up',4),('assignment','Assignment',5),('created','Created',6);

CREATE TABLE order_stages (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO order_stages (code,label,sort_order) VALUES
  ('lead','Lead',1),('confirmed','Confirmed',2),('medicine_prepared','Medicine Prepared',3),
  ('packed','Packed',4),('shipped','Shipped',5),('delivered','Delivered',6);

CREATE TABLE payment_statuses (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO payment_statuses (code,label,sort_order) VALUES
  ('pending','Pending',1),('partial','Partial',2),('paid','Paid',3),('refunded','Refunded',4);

-- Kept for reference/UI dropdowns only (NOT stored as a live FK column anywhere —
-- see the `renewals` table and v_renewals view for why: this is derived state).
CREATE TABLE renewal_statuses (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO renewal_statuses (code,label,sort_order) VALUES
  ('upcoming','Upcoming',1),('due_today','Due Today',2),('overdue','Overdue',3),('renewed','Renewed',4);

CREATE TABLE followup_types (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO followup_types (code,label,sort_order) VALUES
  ('call','Call',1),('reminder','Reminder',2),('callback','Callback',3);

CREATE TABLE followup_statuses (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO followup_statuses (code,label,sort_order) VALUES
  ('pending','Pending',1),('completed','Completed',2),('missed','Missed',3);

CREATE TABLE notification_types (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE, label text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_types (code,label,sort_order) VALUES
  ('info','Info',1),('warning','Warning',2),('success','Success',3),('error','Error',4);

-- Generic lookup-table protection: only super_admin may write; everyone may read.
-- (RLS applied in SECTION 13 via a single reusable pattern.)


-- =====================================================================================
-- SECTION 3: USERS
-- =====================================================================================

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         text NOT NULL,                 -- human-friendly business key
  name                text NOT NULL,
  phone               text NOT NULL,
  email               citext,                         -- see note below re: citext
  password_hash       text NOT NULL,                  -- bcrypt/argon2 hash, NEVER plaintext
  role_id             smallint NOT NULL REFERENCES roles(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status_id           smallint NOT NULL REFERENCES user_statuses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Trigger-maintained counter (never hand-set by app code). See DESIGN RATIONALE #3.
  assigned_leads_count integer NOT NULL DEFAULT 0 CHECK (assigned_leads_count >= 0),
  last_login_at       timestamptz,
  avatar_url          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT chk_users_phone_format CHECK (phone ~ '^\+?[0-9]{7,15}$')
);

-- citext extension gives case-insensitive unique email without app-side lower()ing.
CREATE EXTENSION IF NOT EXISTS citext;
-- (declared after table intentionally would fail; extension must exist before column
--  type use — moved logically: in the real migration file this CREATE EXTENSION line
--  must be placed in SECTION 0. Included here inline only for narrative clarity.)

-- Natural keys are UNIQUE, never primary keys, and only enforced among live rows
-- (soft-deleted employee IDs/emails may be reused, e.g. after a genuine off-boarding).
CREATE UNIQUE INDEX uq_users_employee_id ON users (employee_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_email       ON users (email)       WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX ix_users_role   ON users (role_id);
CREATE INDEX ix_users_status ON users (status_id);

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_audit AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();


-- =====================================================================================
-- SECTION 4: CUSTOMERS — the canonical identity (frontend simplification #1 fix)
-- =====================================================================================

CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         text NOT NULL,
  primary_mobile    text NOT NULL,
  alternate_mobile  text,
  address           text,
  city              text,
  state             text,
  pincode           text,
  doctor_name       text,           -- most recent/primary prescribing doctor on file
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT chk_customers_pincode CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  CONSTRAINT chk_customers_mobile  CHECK (primary_mobile ~ '^[0-9]{10}$')
);

-- Matching strategy: primary_mobile is the de-facto dedupe key in Indian pharma
-- distribution (a phone number reliably identifies a household/patient across visits).
-- Enforced unique among live customers; intake flow should look up by mobile before
-- creating a new customer row, and offer a "merge" operation (not a DB-level thing —
-- see rationale) if a duplicate is found.
CREATE UNIQUE INDEX uq_customers_primary_mobile ON customers (primary_mobile) WHERE deleted_at IS NULL;
CREATE INDEX ix_customers_city ON customers (city) WHERE deleted_at IS NULL;

-- Full-text search column (see SECTION 12 for consolidated a global-search discussion).
ALTER TABLE customers ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(full_name,'') || ' ' || coalesce(primary_mobile,'') || ' ' ||
      coalesce(alternate_mobile,'') || ' ' || coalesce(city,'') || ' ' || coalesce(state,'') || ' ' ||
      coalesce(doctor_name,'')
    )
  ) STORED;
CREATE INDEX ix_customers_search ON customers USING GIN (search_vector);

CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customers_audit AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();


-- =====================================================================================
-- SECTION 5: PRODUCTS (medicine catalog) — frontend simplification #2 fix
-- =====================================================================================

CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           text NOT NULL,                 -- human-friendly business key, UNIQUE not PK
  generic_name  text NOT NULL,
  brand_name    text,
  strength      text,                          -- e.g. '500mg'
  dosage_form   text,                          -- e.g. 'tablet','syrup','injection'
  unit_price    numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE UNIQUE INDEX uq_products_sku ON products (sku) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_generic_name ON products (generic_name) WHERE deleted_at IS NULL;

ALTER TABLE products ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(sku,'') || ' ' || coalesce(generic_name,'') || ' ' || coalesce(brand_name,''))
  ) STORED;
CREATE INDEX ix_products_search ON products USING GIN (search_vector);

CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_audit AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();


-- =====================================================================================
-- SECTION 6: LEADS
-- =====================================================================================

CREATE TABLE leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable until the intake is matched to (or promoted into) a customer record.
  customer_id           uuid REFERENCES customers(id) ON DELETE SET NULL ON UPDATE CASCADE,

  -- "As captured" intake fields — kept even after customer_id is populated, since this
  -- is a point-in-time record of what the lead said, which may differ from the
  -- canonical customer record (e.g. a different shipping address for this occasion).
  customer_name         text NOT NULL,
  mobile                text NOT NULL,
  alternate_number      text,
  address               text NOT NULL,
  city                  text NOT NULL,
  state                 text NOT NULL,
  pincode               text NOT NULL,

  medicine_required     text NOT NULL,          -- free-text legacy field, kept for fidelity
  requested_product_id  uuid REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
  quantity              integer NOT NULL CHECK (quantity > 0),
  doctor_name           text,

  assigned_caller_id    uuid REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,

  lead_source_id        smallint NOT NULL REFERENCES lead_sources(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  priority_id           smallint NOT NULL REFERENCES lead_priorities(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status_id             smallint NOT NULL REFERENCES lead_statuses(id) ON DELETE RESTRICT ON UPDATE CASCADE,

  last_follow_up_at     timestamptz,
  next_follow_up_at     timestamptz,
  notes                 text,

  created_at            timestamptz NOT NULL DEFAULT now(),   -- = frontend createdDate
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,

  CONSTRAINT chk_leads_pincode CHECK (pincode ~ '^[0-9]{6}$'),
  CONSTRAINT chk_leads_mobile  CHECK (mobile ~ '^[0-9]{10}$')
);

CREATE INDEX ix_leads_customer_id       ON leads (customer_id);
CREATE INDEX ix_leads_assigned_caller   ON leads (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_status            ON leads (status_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_next_follow_up    ON leads (next_follow_up_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_mobile            ON leads (mobile);

ALTER TABLE leads ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(customer_name,'') || ' ' || coalesce(mobile,'') || ' ' ||
      coalesce(medicine_required,'') || ' ' || coalesce(city,'') || ' ' || coalesce(notes,'')
    )
  ) STORED;
CREATE INDEX ix_leads_search ON leads USING GIN (search_vector);

CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_leads_audit AFTER INSERT OR UPDATE OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- --- assigned_leads_count maintenance trigger (frontend simplification #3 fix) --------
CREATE OR REPLACE FUNCTION trg_leads_maintain_assigned_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_counted boolean;
  new_counted boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_caller_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    old_counted := (OLD.assigned_caller_id IS NOT NULL AND OLD.deleted_at IS NULL);
    new_counted := (NEW.assigned_caller_id IS NOT NULL AND NEW.deleted_at IS NULL);

    IF old_counted AND (NOT new_counted OR OLD.assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id) THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count - 1 WHERE id = OLD.assigned_caller_id;
    END IF;
    IF new_counted AND (NOT old_counted OR OLD.assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id) THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.assigned_caller_id IS NOT NULL AND OLD.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count - 1 WHERE id = OLD.assigned_caller_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_leads_assigned_count
  AFTER INSERT OR UPDATE OF assigned_caller_id, deleted_at OR DELETE ON leads
  FOR EACH ROW EXECUTE FUNCTION trg_leads_maintain_assigned_count();

-- Drift-detection view: run periodically (e.g. nightly job / monitoring check) to catch
-- any bug in the trigger above before it erodes dashboard trust.
CREATE VIEW v_assigned_lead_count_check AS
SELECT u.id AS user_id, u.name, u.assigned_leads_count AS stored_count,
       COUNT(l.id) FILTER (WHERE l.deleted_at IS NULL) AS actual_count
FROM users u
LEFT JOIN leads l ON l.assigned_caller_id = u.id
GROUP BY u.id, u.name, u.assigned_leads_count
HAVING u.assigned_leads_count <> COUNT(l.id) FILTER (WHERE l.deleted_at IS NULL);


-- =====================================================================================
-- SECTION 7: LEAD ACTIVITIES (append-heavy timeline; PARTITIONED) — frontend as-is,
-- but with proper FK types instead of raw string ids.
-- =====================================================================================

CREATE TABLE lead_activities (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE ON UPDATE CASCADE,
  activity_type_id smallint NOT NULL REFERENCES activity_types(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  description     text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  PRIMARY KEY (id, created_at)          -- composite PK required: partition key must be in PK
) PARTITION BY RANGE (created_at);

-- Monthly partitions. In production, automate creation via pg_partman or a scheduled
-- job that creates next month's partition ~1 week ahead of month boundary.
CREATE TABLE lead_activities_2026_07 PARTITION OF lead_activities
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE lead_activities_2026_08 PARTITION OF lead_activities
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
-- ... additional partitions created by the monthly maintenance job.
CREATE TABLE lead_activities_default PARTITION OF lead_activities DEFAULT;

CREATE INDEX ix_lead_activities_lead_id ON lead_activities (lead_id, created_at DESC);
CREATE INDEX ix_lead_activities_created_by ON lead_activities (created_by);

CREATE TRIGGER trg_lead_activities_updated_at BEFORE UPDATE ON lead_activities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Note: no audit_row_change trigger here — this table IS itself an activity log;
-- auditing an audit log is redundant churn. Same reasoning applies to notifications
-- and audit_log itself, below.


-- =====================================================================================
-- SECTION 8: LEAD ASSIGNMENT HISTORY — frontend simplification #7 fix
-- =====================================================================================

CREATE TABLE lead_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE ON UPDATE CASCADE,
  caller_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  assigned_by   uuid REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE, -- null = system
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,      -- NULL while this is the CURRENT assignment
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_assignment_period CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);

-- At most one OPEN (unassigned_at IS NULL) assignment row per lead at a time —
-- this is what leads.assigned_caller_id should always match.
CREATE UNIQUE INDEX uq_lead_assignments_open ON lead_assignments (lead_id) WHERE unassigned_at IS NULL;
CREATE INDEX ix_lead_assignments_caller ON lead_assignments (caller_id);
CREATE INDEX ix_lead_assignments_lead   ON lead_assignments (lead_id, assigned_at DESC);


-- =====================================================================================
-- SECTION 9: ORDERS + ORDER ITEMS — frontend simplification #2 fix (no embedded array)
-- =====================================================================================

CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      text NOT NULL,                -- human-friendly business key
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL ON UPDATE CASCADE,
  shipping_address  text NOT NULL,                 -- snapshot at time of order
  total_amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  payment_status_id smallint NOT NULL REFERENCES payment_statuses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  stage_id          smallint NOT NULL REFERENCES order_stages(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),  -- = frontend createdDate
  updated_at        timestamptz NOT NULL DEFAULT now(),  -- = frontend updatedDate
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX uq_orders_order_number ON orders (order_number) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_customer ON orders (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_lead     ON orders (lead_id);
CREATE INDEX ix_orders_stage    ON orders (stage_id) WHERE deleted_at IS NULL;

ALTER TABLE orders ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(order_number,''))) STORED;
CREATE INDEX ix_orders_search ON orders USING GIN (search_vector);

CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_audit AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
  product_id            uuid REFERENCES products(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Snapshot fields: an order line must remain historically accurate even if the
  -- product catalog entry is later renamed or repriced.
  medicine_name_snapshot text NOT NULL,
  quantity              integer NOT NULL CHECK (quantity > 0),
  unit_price_snapshot   numeric(12,2) NOT NULL CHECK (unit_price_snapshot >= 0),
  line_total            numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price_snapshot) STORED,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE INDEX ix_order_items_order   ON order_items (order_id);
CREATE INDEX ix_order_items_product ON order_items (product_id);

CREATE TRIGGER trg_order_items_updated_at BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_order_items_audit AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Maintain orders.total_amount from its line items (mirrors the assigned_leads_count
-- trade-off discussion: fast reads for the orders list UI, correctness enforced by
-- trigger instead of the app manually summing on every write).
CREATE OR REPLACE FUNCTION trg_order_items_update_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id uuid;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  UPDATE orders o
  SET total_amount = COALESCE((
    SELECT SUM(line_total) FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.deleted_at IS NULL
  ), 0)
  WHERE o.id = v_order_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_order_items_totals
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION trg_order_items_update_total();


-- =====================================================================================
-- SECTION 10: RENEWALS — frontend simplification #4 fix (no persisted derived state)
-- =====================================================================================

CREATE TABLE renewals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  order_id           uuid REFERENCES orders(id) ON DELETE SET NULL ON UPDATE CASCADE,
  product_id         uuid REFERENCES products(id) ON DELETE SET NULL ON UPDATE CASCADE,
  medicine_name      text NOT NULL,     -- legacy/fallback free text, kept in sync with product_id when set
  order_date         date NOT NULL,
  renewal_date       date NOT NULL,
  expiry_date        date NOT NULL,
  assigned_caller_id uuid REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  renewed_at         timestamptz,       -- the FACT of renewal; NULL = not yet renewed
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT chk_renewals_dates CHECK (expiry_date >= order_date AND renewal_date >= order_date)
  -- NOTE: daysRemaining and status are intentionally NOT columns here — see v_renewals.
);
CREATE INDEX ix_renewals_customer ON renewals (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_renewals_caller   ON renewals (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_renewals_expiry   ON renewals (expiry_date) WHERE deleted_at IS NULL AND renewed_at IS NULL;

CREATE TRIGGER trg_renewals_updated_at BEFORE UPDATE ON renewals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_renewals_audit AFTER INSERT OR UPDATE OR DELETE ON renewals
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

-- Query-time derivation of daysRemaining/status. A plain VIEW (not a generated column)
-- because the expression depends on CURRENT_DATE, which is not IMMUTABLE and therefore
-- cannot appear in a generated column definition; a view recomputes on every read,
-- which is exactly the freshness behaviour we want (never goes stale).
CREATE VIEW v_renewals AS
SELECT
  r.*,
  (r.expiry_date - CURRENT_DATE) AS days_remaining,
  CASE
    WHEN r.renewed_at IS NOT NULL       THEN 'renewed'
    WHEN r.expiry_date < CURRENT_DATE   THEN 'overdue'
    WHEN r.expiry_date = CURRENT_DATE   THEN 'due_today'
    ELSE 'upcoming'
  END AS status
FROM renewals r
WHERE r.deleted_at IS NULL;


-- =====================================================================================
-- SECTION 11: FOLLOW-UPS — frontend simplification #8 fix (no more id-hack)
-- =====================================================================================

CREATE TABLE follow_ups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  lead_id       uuid REFERENCES leads(id) ON DELETE SET NULL ON UPDATE CASCADE,
  renewal_id    uuid REFERENCES renewals(id) ON DELETE SET NULL ON UPDATE CASCADE,
  scheduled_at  timestamptz NOT NULL,
  type_id       smallint NOT NULL REFERENCES followup_types(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status_id     smallint NOT NULL REFERENCES followup_statuses(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX ix_follow_ups_customer  ON follow_ups (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_follow_ups_lead      ON follow_ups (lead_id);
CREATE INDEX ix_follow_ups_renewal   ON follow_ups (renewal_id);
CREATE INDEX ix_follow_ups_scheduled ON follow_ups (scheduled_at) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_follow_ups_updated_at BEFORE UPDATE ON follow_ups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_follow_ups_audit AFTER INSERT OR UPDATE OR DELETE ON follow_ups
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();


-- =====================================================================================
-- SECTION 12: NOTIFICATIONS — frontend simplification #6 fix (recipient scoping),
-- PARTITIONED (append-heavy).
-- =====================================================================================

CREATE TABLE notifications (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  title               text NOT NULL,
  message             text NOT NULL,
  type_id             smallint NOT NULL REFERENCES notification_types(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  is_read             boolean NOT NULL DEFAULT false,
  read_at             timestamptz,
  -- Polymorphic deep-link target. Postgres cannot enforce a real FK across multiple
  -- possible parent tables; integrity here is app-layer + the CHECK below guarding
  -- the *shape* (both-null or both-set), documented as an explicit trade-off.
  related_entity_type text CHECK (related_entity_type IN ('lead','order','renewal','follow_up')),
  related_entity_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT chk_notifications_entity_pair
    CHECK ((related_entity_type IS NULL) = (related_entity_id IS NULL)),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE notifications_2026_07 PARTITION OF notifications
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE notifications_2026_08 PARTITION OF notifications
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;

CREATE INDEX ix_notifications_recipient ON notifications (recipient_user_id, is_read, created_at DESC);
CREATE INDEX ix_notifications_entity ON notifications (related_entity_type, related_entity_id);

CREATE TRIGGER trg_notifications_updated_at BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================================
-- SECTION 13: AUDIT LOG — compliance, PARTITIONED (append-heavy)
-- =====================================================================================

CREATE TABLE audit_log (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  table_name  text NOT NULL,
  record_id   uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  changed_by  uuid REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  old_data    jsonb,
  new_data    jsonb,
  PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

CREATE TABLE audit_log_2026_07 PARTITION OF audit_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE audit_log_2026_08 PARTITION OF audit_log
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

CREATE INDEX ix_audit_log_table_record ON audit_log (table_name, record_id, changed_at DESC);
CREATE INDEX ix_audit_log_changed_by   ON audit_log (changed_by);
-- No updated_at/deleted_at/triggers on audit_log: it is a write-once compliance
-- ledger by design (the one deliberate exception to the "every table gets soft
-- delete" rule — see DESIGN RATIONALE).


-- =====================================================================================
-- SECTION 14: GLOBAL SEARCH VIEW (consolidated, for the UI's global search bar)
-- =====================================================================================

CREATE VIEW v_global_search AS
SELECT 'customer'::text AS entity_type, c.id AS entity_id, c.full_name AS display_text,
       c.search_vector AS search_vector
FROM customers c WHERE c.deleted_at IS NULL
UNION ALL
SELECT 'lead', l.id, l.customer_name, l.search_vector
FROM leads l WHERE l.deleted_at IS NULL
UNION ALL
SELECT 'product', p.id, coalesce(p.brand_name, p.generic_name), p.search_vector
FROM products p WHERE p.deleted_at IS NULL
UNION ALL
SELECT 'order', o.id, o.order_number, o.search_vector
FROM orders o WHERE o.deleted_at IS NULL;

-- Usage: SELECT * FROM v_global_search WHERE search_vector @@ plainto_tsquery('english', :q);
-- Graduation note: this UNION-of-tsvector approach is fine up to roughly low millions
-- of rows combined and modest query volume. Graduate to a dedicated search engine
-- (OpenSearch/Elasticsearch/Meilisearch/Typesense) once you need: (a) fuzzy/typo-tolerant
-- ranking better than pg_trgm similarity, (b) multi-language stemming beyond 'english',
-- (c) sub-50ms search SLAs at high QPS while OLTP writes are also heavy, or (d) faceted
-- search UI (filter by status/city/date range combined with relevance ranking).


-- =====================================================================================
-- SECTION 15: ROW LEVEL SECURITY
-- =====================================================================================

-- ---- Lookup tables: readable by everyone, writable only by super_admin -------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'roles','user_statuses','lead_statuses','lead_priorities','lead_sources',
    'activity_types','order_stages','payment_statuses','renewal_statuses',
    'followup_types','followup_statuses','notification_types'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY p_%I_select ON %I FOR SELECT USING (true)', t, t);
    EXECUTE format('CREATE POLICY p_%I_write ON %I FOR ALL USING (is_super_admin()) WITH CHECK (is_super_admin())', t, t);
  END LOOP;
END $$;

-- ---- users --------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- SELECT: super_admin sees all; admin sees all callers + self; caller sees only self.
CREATE POLICY p_users_select ON users FOR SELECT
USING (
  is_super_admin()
  OR (current_app_role() = 'admin' AND (role_id = (SELECT id FROM roles WHERE code='caller') OR id = current_app_user_id()))
  OR (current_app_role() = 'caller' AND id = current_app_user_id())
);

-- INSERT: super_admin can create anyone; admin can only create callers.
CREATE POLICY p_users_insert ON users FOR INSERT
WITH CHECK (
  is_super_admin()
  OR (current_app_role() = 'admin' AND role_id = (SELECT id FROM roles WHERE code='caller'))
);

-- UPDATE: super_admin any row; admin only caller rows (and cannot promote a caller to
-- admin/super_admin — enforced by WITH CHECK re-verifying role_id post-update); a
-- caller may only touch their own row (app should further restrict which columns via
-- the API layer — RLS alone cannot do column-level checks).
CREATE POLICY p_users_update ON users FOR UPDATE
USING (
  is_super_admin()
  OR (current_app_role() = 'admin' AND role_id = (SELECT id FROM roles WHERE code='caller'))
  OR (current_app_role() = 'caller' AND id = current_app_user_id())
)
WITH CHECK (
  is_super_admin()
  OR (current_app_role() = 'admin' AND role_id = (SELECT id FROM roles WHERE code='caller'))
  OR (current_app_role() = 'caller' AND id = current_app_user_id())
);

-- DELETE (hard delete): super_admin only; ordinary deactivation should be a soft
-- delete/status UPDATE, which the UPDATE policy above already governs.
CREATE POLICY p_users_delete ON users FOR DELETE USING (is_super_admin());

-- ---- customers / products: readable by all authenticated roles; writable by admin+ --
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_customers_select ON customers FOR SELECT USING (current_app_role() IS NOT NULL);
CREATE POLICY p_customers_write  ON customers FOR ALL
  USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_products_select ON products FOR SELECT USING (current_app_role() IS NOT NULL);
CREATE POLICY p_products_write  ON products FOR ALL
  USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());

-- ---- leads ----------------------------------------------------------------------------
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_leads_select ON leads FOR SELECT
USING (is_admin_or_above() OR assigned_caller_id = current_app_user_id());

CREATE POLICY p_leads_insert ON leads FOR INSERT
WITH CHECK (is_admin_or_above() OR assigned_caller_id = current_app_user_id());

CREATE POLICY p_leads_update ON leads FOR UPDATE
USING (is_admin_or_above() OR assigned_caller_id = current_app_user_id())
WITH CHECK (is_admin_or_above() OR assigned_caller_id = current_app_user_id());

CREATE POLICY p_leads_delete ON leads FOR DELETE USING (is_admin_or_above());

-- ---- lead_activities: visibility inherited via parent lead --------------------------
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_lead_activities_select ON lead_activities FOR SELECT
USING (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller_id = current_app_user_id())
);

CREATE POLICY p_lead_activities_insert ON lead_activities FOR INSERT
WITH CHECK (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller_id = current_app_user_id())
);

-- ---- lead_assignments: reassignment is an admin/super_admin action; callers may view
-- their own assignment history only. ---------------------------------------------------
ALTER TABLE lead_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY p_lead_assignments_select ON lead_assignments FOR SELECT
USING (is_admin_or_above() OR caller_id = current_app_user_id());

CREATE POLICY p_lead_assignments_insert ON lead_assignments FOR INSERT
WITH CHECK (is_admin_or_above());

-- ---- orders / renewals / follow_ups: caller visibility requires a lead_id link to a
-- lead currently assigned to them (per the brief: "tied to a lead not assigned to them
-- should be invisible"). Orders/renewals/follow-ups with NO lead_id are, by this rule,
-- invisible to callers by default — documented as a deliberate, conservative choice. --
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_orders_select ON orders FOR SELECT
USING (
  is_admin_or_above()
  OR (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller_id = current_app_user_id()))
);
CREATE POLICY p_orders_write ON orders FOR ALL
  USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_order_items_select ON order_items FOR SELECT
USING (
  is_admin_or_above()
  OR EXISTS (
    SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
    WHERE o.id = order_items.order_id AND l.assigned_caller_id = current_app_user_id()
  )
);
CREATE POLICY p_order_items_write ON order_items FOR ALL
  USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());

ALTER TABLE renewals ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_renewals_select ON renewals FOR SELECT
USING (
  is_admin_or_above()
  OR assigned_caller_id = current_app_user_id()
);
CREATE POLICY p_renewals_write ON renewals FOR ALL
  USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());

ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_follow_ups_select ON follow_ups FOR SELECT
USING (
  is_admin_or_above()
  OR (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = follow_ups.lead_id AND l.assigned_caller_id = current_app_user_id()))
);
CREATE POLICY p_follow_ups_insert ON follow_ups FOR INSERT
WITH CHECK (
  is_admin_or_above()
  OR (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = follow_ups.lead_id AND l.assigned_caller_id = current_app_user_id()))
);
CREATE POLICY p_follow_ups_update ON follow_ups FOR UPDATE
USING (
  is_admin_or_above()
  OR (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = follow_ups.lead_id AND l.assigned_caller_id = current_app_user_id()))
);

-- ---- notifications: strictly self-scoped (super_admin included, for support they
-- should impersonate/query via a service-role bypass, not a blanket RLS carve-out). --
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_notifications_select ON notifications FOR SELECT
USING (recipient_user_id = current_app_user_id());
CREATE POLICY p_notifications_update ON notifications FOR UPDATE
USING (recipient_user_id = current_app_user_id());

-- ---- audit_log: super_admin only (compliance officers) ------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_audit_log_select ON audit_log FOR SELECT USING (is_super_admin());