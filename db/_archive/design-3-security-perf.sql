-- =====================================================================
-- MEDICAL CRM — POSTGRESQL SCHEMA (LENS: SECURITY & QUERY PERFORMANCE)
-- Target: PostgreSQL 15+
-- Author: Architect B (security/RLS + indexing/materialized-view focus)
-- =====================================================================
-- Read the "DESIGN RATIONALE" section at the bottom for the reasoning
-- behind every non-obvious decision. This header only sets conventions.
--
-- CONVENTIONS
--  * All primary keys are UUID (gen_random_uuid(), via pgcrypto).
--  * All timestamps are timestamptz. All money is NUMERIC(12,2).
--  * Every table has created_at/updated_at (trigger-maintained) and a
--    nullable deleted_at (soft delete) EXCEPT `sessions`, which is a
--    truly transient/authentication-token table (see rationale #10).
--  * organization_id columns are pre-declared but nullable and UNUSED
--    by policy today — see rationale #9 (multi-tenancy retrofit path).
--  * The application connects through ONE pooled Postgres role
--    (app_user). Per-request identity is passed via session GUCs
--    (`app.current_user_id`, `app.current_role`) set with
--    set_config(..., true) so it is transaction-local and cannot leak
--    across pooled connections. RLS policies read those GUCs via the
--    app_current_user_id()/app_current_role() helper functions below.
-- =====================================================================


-- =====================================================================
-- 0. EXTENSIONS
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram indexes for phone/name fuzzy search


-- =====================================================================
-- 1. ENUM TYPES (mirrors the frontend union types exactly)
-- =====================================================================
CREATE TYPE user_role         AS ENUM ('super_admin','admin','caller');
CREATE TYPE user_status       AS ENUM ('active','inactive');

CREATE TYPE lead_status       AS ENUM (
  'new','contacted','follow_up_pending','interested','call_back_later',
  'no_response','not_interested','converted','closed'
);
CREATE TYPE lead_priority     AS ENUM ('low','medium','high','urgent');
CREATE TYPE lead_source       AS ENUM (
  'website','referral','walk_in','phone','social_media','advertisement','other'
);
CREATE TYPE lead_activity_type AS ENUM (
  'call','comment','status_change','follow_up','assignment','created'
);

CREATE TYPE order_stage       AS ENUM (
  'lead','confirmed','medicine_prepared','packed','shipped','delivered'
);
CREATE TYPE payment_status    AS ENUM ('pending','partial','paid','refunded');

CREATE TYPE renewal_status    AS ENUM ('upcoming','due_today','overdue','renewed');

CREATE TYPE followup_type     AS ENUM ('call','reminder','callback');
CREATE TYPE followup_status   AS ENUM ('pending','completed','missed');

CREATE TYPE notification_type AS ENUM ('info','warning','success','error');


-- =====================================================================
-- 2. SESSION-CONTEXT HELPER FUNCTIONS (the backbone of every RLS policy)
-- =====================================================================
-- The connection layer MUST, at the start of every transaction, run:
--   SELECT set_config('app.current_user_id', '<uuid-of-caller>', true);
--   SELECT set_config('app.current_role',    '<super_admin|admin|caller>', true);
-- The `true` (is_local) argument scopes the setting to the CURRENT
-- transaction only — it is automatically cleared on COMMIT/ROLLBACK,
-- so a pooled connection handed to the next request never inherits a
-- stale identity. STABLE (not IMMUTABLE) because current_setting can
-- change within a session across transactions.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.current_role', true);
$$;

-- Generic updated_at maintenance trigger, reused by every table.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- =====================================================================
-- 3. POOLED APPLICATION ROLE
-- =====================================================================
-- One native Postgres role for the whole app tier. It must NEVER be
-- granted BYPASSRLS or SUPERUSER — that is what makes FORCE ROW LEVEL
-- SECURITY below actually mean something. Per-CRM-user identity lives
-- entirely in the GUCs above, not in native Postgres roles.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'CHANGE_ME_store_in_secrets_manager';
  END IF;
END $$;


-- =====================================================================
-- 4. CORE TABLES
-- =====================================================================

-- ---------------------------------------------------------------
-- 4.1 users
-- ---------------------------------------------------------------
CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid,                       -- reserved, unused today (see rationale #9)
  name                 text NOT NULL,
  employee_id          text NOT NULL,               -- business key
  phone                text NOT NULL,
  email                text NOT NULL,
  role                 user_role NOT NULL DEFAULT 'caller',
  status                user_status NOT NULL DEFAULT 'active',
  password_hash        text NOT NULL,               -- bcrypt/argon2 hash ONLY, never plaintext
  avatar_url           text,
  last_login           timestamptz,
  assigned_leads_count integer NOT NULL DEFAULT 0,  -- trigger-maintained, see rationale #3
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT users_employee_id_key UNIQUE (employee_id),
  CONSTRAINT users_assigned_leads_count_nonneg CHECK (assigned_leads_count >= 0)
);
-- Case-insensitive uniqueness on email without adding citext dependency.
CREATE UNIQUE INDEX ux_users_email_lower ON users (lower(email)) WHERE deleted_at IS NULL;

COMMENT ON TABLE users IS 'CRM operator accounts (super_admin/admin/caller). NOT the pharmacy customer identity — see customers.';
COMMENT ON COLUMN users.assigned_leads_count IS 'Denormalized counter maintained by trg_maintain_assigned_leads_count. Never write to this directly.';


-- ---------------------------------------------------------------
-- 4.2 customers — the canonical identity fix (rationale #1)
-- ---------------------------------------------------------------
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid,
  full_name         text NOT NULL,
  primary_mobile    text NOT NULL,                 -- business dedup key
  alternate_mobile  text,
  email             text,
  address           text,
  city              text,
  state             text,
  pincode           text,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(full_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(primary_mobile, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(alternate_mobile, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(city,'') || ' ' || coalesce(state,'') || ' ' || coalesce(pincode,'')), 'D')
  ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
-- Dedup key: one live customer per mobile number (soft-deleted rows excluded).
CREATE UNIQUE INDEX ux_customers_primary_mobile ON customers (primary_mobile) WHERE deleted_at IS NULL;

COMMENT ON TABLE customers IS 'Canonical person/identity, decoupled from Lead/Order/Renewal so repeat customers are recognizable across records (fixes frontend simplification #1).';


-- ---------------------------------------------------------------
-- 4.3 products — the catalog fix (rationale #2)
-- ---------------------------------------------------------------
CREATE TABLE products (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  sku            text NOT NULL,
  generic_name   text NOT NULL,
  brand_name     text,
  strength       text,                 -- dosage, e.g. "500mg"
  form           text,                 -- tablet / syrup / injection etc.
  unit_price     numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  is_active      boolean NOT NULL DEFAULT true,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(generic_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(brand_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sku,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(strength,'') || ' ' || coalesce(form,'')), 'C')
  ) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT products_sku_key UNIQUE (sku)
);

COMMENT ON TABLE products IS 'Medicine catalog/master. Fixes frontend simplification #2 (free-text medicine names in Order.medicines).';


-- ---------------------------------------------------------------
-- 4.4 leads
-- ---------------------------------------------------------------
CREATE TABLE leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid,
  customer_id           uuid REFERENCES customers(id),   -- nullable until matched/created
  customer_name         text NOT NULL,                    -- pre-match snapshot (frontend Lead.customerName)
  mobile                text NOT NULL,
  alternate_number      text,
  address               text NOT NULL,
  city                  text NOT NULL,
  state                 text NOT NULL,
  pincode               text NOT NULL,
  medicine_required     text NOT NULL,                    -- free-text label kept for fidelity/display
  requested_product_id  uuid REFERENCES products(id),      -- optional catalog link
  quantity              integer NOT NULL CHECK (quantity > 0),
  doctor_name           text,
  assigned_caller       uuid REFERENCES users(id),          -- live pointer; history in lead_assignments
  lead_source           lead_source NOT NULL,
  priority              lead_priority NOT NULL DEFAULT 'medium',
  status                lead_status NOT NULL DEFAULT 'new',
  last_follow_up        timestamptz,
  next_follow_up        timestamptz,
  notes                 text,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(customer_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(mobile,'') || ' ' || coalesce(alternate_number,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(medicine_required,'') || ' ' || coalesce(doctor_name,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(city,'') || ' ' || coalesce(state,'') || ' ' || coalesce(notes,'')), 'D')
  ) STORED,
  created_at            timestamptz NOT NULL DEFAULT now(),  -- also serves as frontend Lead.createdDate
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

COMMENT ON TABLE leads IS 'Frontend Lead.createdDate maps to created_at; there is no separate business date.';


-- ---------------------------------------------------------------
-- 4.5 lead_activities — append-heavy timeline, RANGE-partitioned by month
-- ---------------------------------------------------------------
CREATE TABLE lead_activities (
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid,
  lead_id      uuid NOT NULL REFERENCES leads(id),
  type         lead_activity_type NOT NULL,
  description  text NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)          -- partition key must be part of the PK
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE lead_activities IS 'Append-only timeline. No updated_at/deleted_at: entries are immutable facts, corrected only by appending a new entry.';


-- ---------------------------------------------------------------
-- 4.6 lead_assignments — reassignment history (rationale #7)
-- ---------------------------------------------------------------
CREATE TABLE lead_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  lead_id       uuid NOT NULL REFERENCES leads(id),
  assigned_to   uuid REFERENCES users(id),
  assigned_by   uuid REFERENCES users(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lead_assignments IS 'Full audit trail of who held a lead and when. leads.assigned_caller is only the live pointer; this table is the history (fixes frontend simplification #7).';


-- ---------------------------------------------------------------
-- 4.7 orders + order_items (rationale #2)
-- ---------------------------------------------------------------
CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid,
  order_number     text NOT NULL,                 -- business key
  lead_id          uuid REFERENCES leads(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  customer_name    text NOT NULL,                 -- snapshot, trigger-synced from customers.full_name
  shipping_address text NOT NULL,
  total_amount     numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  payment_status   payment_status NOT NULL DEFAULT 'pending',
  stage            order_stage NOT NULL DEFAULT 'lead',
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(order_number,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(customer_name,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(shipping_address,'')), 'D')
  ) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CONSTRAINT orders_order_number_key UNIQUE (order_number)
);

CREATE TABLE order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  quantity     integer NOT NULL CHECK (quantity > 0),
  unit_price   numeric(12,2) NOT NULL CHECK (unit_price >= 0),  -- snapshot price at order time
  line_total   numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE order_items IS 'Replaces Order.medicines inline array with a proper child table FK''d to products (fixes frontend simplification #2).';


-- ---------------------------------------------------------------
-- 4.8 renewals
-- ---------------------------------------------------------------
CREATE TABLE renewals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  customer_id     uuid NOT NULL REFERENCES customers(id),
  customer_name   text NOT NULL,                 -- snapshot, trigger-synced from customers.full_name
  order_id        uuid REFERENCES orders(id),
  product_id      uuid REFERENCES products(id),
  medicine_name   text NOT NULL,                 -- display label kept for fidelity
  order_date      date NOT NULL,
  renewal_date    date NOT NULL,
  expiry_date     date NOT NULL,
  assigned_caller uuid REFERENCES users(id),
  renewed_at      timestamptz,                   -- set when the renewal actually happens; drives status
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

COMMENT ON TABLE renewals IS 'daysRemaining/status are NOT stored — see renewals_view (fixes frontend simplification #4).';


-- ---------------------------------------------------------------
-- 4.9 follow_ups (rationale #8)
-- ---------------------------------------------------------------
CREATE TABLE follow_ups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  customer_id     uuid NOT NULL REFERENCES customers(id),
  lead_id         uuid REFERENCES leads(id),
  renewal_id      uuid REFERENCES renewals(id),
  assigned_caller uuid REFERENCES users(id),      -- denormalized from lead/renewal for RLS + fast filtering
  scheduled_date  timestamptz NOT NULL,
  type            followup_type NOT NULL,
  status          followup_status NOT NULL DEFAULT 'pending',
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

COMMENT ON TABLE follow_ups IS 'customer_id is required; lead_id/renewal_id are optional context. Fixes frontend hack #8 (Renewals page stuffing a renewal id into FollowUp.leadId).';


-- ---------------------------------------------------------------
-- 4.10 notifications — RANGE-partitioned, per-recipient (rationale #6)
-- ---------------------------------------------------------------
CREATE TABLE notifications (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id     uuid,
  recipient_user_id   uuid NOT NULL REFERENCES users(id),
  title               text NOT NULL,
  message             text NOT NULL,
  type                notification_type NOT NULL DEFAULT 'info',
  read                boolean NOT NULL DEFAULT false,
  related_entity_type text,   -- 'lead' | 'order' | 'renewal' | 'follow_up' (app-level polymorphic FK)
  related_entity_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE notifications IS 'Every notification is scoped to recipient_user_id (fixes frontend simplification #6 — mock notifications were global).';


-- ---------------------------------------------------------------
-- 4.11 audit_log — compliance trail, RANGE-partitioned
-- ---------------------------------------------------------------
CREATE TABLE audit_log (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid,
  actor_user_id  uuid REFERENCES users(id),
  action         text NOT NULL,        -- 'INSERT' | 'UPDATE' | 'DELETE' | app-defined events
  target_table   text NOT NULL,
  target_id      uuid,
  old_data       jsonb,
  new_data       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE audit_log IS 'Populated exclusively by log_audit() triggers; no direct application INSERT policy is granted.';


-- ---------------------------------------------------------------
-- 4.12 sessions — the ONE table where hard delete is appropriate
-- ---------------------------------------------------------------
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sessions IS 'Auth/session tokens. Transient by nature — hard DELETE on logout/expiry is correct here; soft-delete would only bloat an already high-churn table with no compliance value (see rationale #10).';


-- =====================================================================
-- 5. PARTITION BOOTSTRAP + MAINTENANCE
-- =====================================================================
CREATE OR REPLACE FUNCTION create_monthly_partition(parent_table text, partition_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  start_date date := date_trunc('month', partition_month)::date;
  end_date   date := (date_trunc('month', partition_month) + interval '1 month')::date;
  partition_name text := parent_table || '_' || to_char(start_date, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name, parent_table, start_date, end_date
  );
END;
$$;

-- Bootstrap: current month plus 12 months forward, for each partitioned table.
DO $$
DECLARE d timestamp;
BEGIN
  FOR d IN
    SELECT generate_series(date_trunc('month', now()), date_trunc('month', now()) + interval '12 months', interval '1 month')
  LOOP
    PERFORM create_monthly_partition('lead_activities', d::date);
    PERFORM create_monthly_partition('notifications',   d::date);
    PERFORM create_monthly_partition('audit_log',       d::date);
  END LOOP;
END $$;

-- Catch-all partitions so an unexpected out-of-range insert never fails hard.
CREATE TABLE IF NOT EXISTS lead_activities_default PARTITION OF lead_activities DEFAULT;
CREATE TABLE IF NOT EXISTS notifications_default   PARTITION OF notifications   DEFAULT;
CREATE TABLE IF NOT EXISTS audit_log_default       PARTITION OF audit_log       DEFAULT;

-- Retention/archival example (run monthly via pg_cron, see DESIGN RATIONALE #A):
--   1. COPY the partition to cold storage (S3/parquet) BEFORE dropping.
--   2. DETACH CONCURRENTLY the aged partition, then DROP TABLE it.
-- Suggested retention: lead_activities/notifications 24 months live, then archive+drop.
-- audit_log: retain 7 years live (regulated medical-distribution compliance) before archiving.
CREATE OR REPLACE FUNCTION drop_partition_if_older_than(parent_table text, cutoff_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = parent_table
      AND c.relname ~ '\d{4}_\d{2}$'
      AND to_date(right(c.relname, 7), 'YYYY_MM') < cutoff_month
  LOOP
    RAISE NOTICE 'Archive % externally before running: ALTER TABLE % DETACH PARTITION % CONCURRENTLY; DROP TABLE %;',
      part.relname, parent_table, part.relname, part.relname;
  END LOOP;
END;
$$;
-- NOTE: this function only *reports* candidates — actual archival must run outside
-- the DB (export job) before the DETACH+DROP, so the operator can verify the export
-- succeeded first. Once the team's volume outgrows hand-rolled partitions, adopt
-- pg_partman for automatic partition creation/retention instead of these functions.


-- =====================================================================
-- 6. TRIGGERS
-- =====================================================================

-- 6.1 updated_at on every non-partitioned, non-transient table -------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','customers','products','leads','lead_assignments',
    'orders','order_items','renewals','follow_ups'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t
    );
  END LOOP;
END $$;

-- 6.2 assigned_leads_count bookkeeping (rationale #3) ----------------
-- SECURITY DEFINER so this internal counter maintenance can write to
-- `users` even when the invoking app_user session is scoped as a
-- 'caller' (whose RLS policy on users would otherwise forbid it).
-- Function owner MUST be a trusted migration/admin role with BYPASSRLS
-- (e.g. the schema owner) — NEVER app_user.
CREATE OR REPLACE FUNCTION maintain_assigned_leads_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_caller IS NOT NULL AND NEW.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.assigned_caller IS DISTINCT FROM OLD.assigned_caller THEN
      IF OLD.assigned_caller IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE users SET assigned_leads_count = GREATEST(assigned_leads_count - 1, 0) WHERE id = OLD.assigned_caller;
      END IF;
      IF NEW.assigned_caller IS NOT NULL AND NEW.deleted_at IS NULL THEN
        UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller;
      END IF;
    ELSIF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.assigned_caller IS NOT NULL THEN
      -- soft delete / restore toggles whether this lead still "counts"
      IF NEW.deleted_at IS NOT NULL THEN
        UPDATE users SET assigned_leads_count = GREATEST(assigned_leads_count - 1, 0) WHERE id = NEW.assigned_caller;
      ELSE
        UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller;
      END IF;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.assigned_caller IS NOT NULL AND OLD.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = GREATEST(assigned_leads_count - 1, 0) WHERE id = OLD.assigned_caller;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_maintain_assigned_leads_count
AFTER INSERT OR UPDATE OR DELETE ON leads
FOR EACH ROW EXECUTE FUNCTION maintain_assigned_leads_count();

-- 6.3 lead_assignments history (rationale #7) -------------------------
CREATE OR REPLACE FUNCTION sync_lead_assignment_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_caller IS NOT NULL THEN
      INSERT INTO lead_assignments(lead_id, assigned_to, assigned_by, assigned_at)
      VALUES (NEW.id, NEW.assigned_caller, app_current_user_id(), now());
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.assigned_caller IS DISTINCT FROM OLD.assigned_caller THEN
    IF OLD.assigned_caller IS NOT NULL THEN
      UPDATE lead_assignments
        SET unassigned_at = now()
        WHERE lead_id = NEW.id AND assigned_to = OLD.assigned_caller AND unassigned_at IS NULL;
    END IF;
    IF NEW.assigned_caller IS NOT NULL THEN
      INSERT INTO lead_assignments(lead_id, assigned_to, assigned_by, assigned_at)
      VALUES (NEW.id, NEW.assigned_caller, app_current_user_id(), now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_lead_assignment_history
AFTER INSERT OR UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION sync_lead_assignment_history();

-- 6.4 follow_ups.assigned_caller sync (supports rationale #8) --------
CREATE OR REPLACE FUNCTION sync_followup_assigned_caller() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_caller IS NULL THEN
    IF NEW.lead_id IS NOT NULL THEN
      SELECT assigned_caller INTO NEW.assigned_caller FROM leads WHERE id = NEW.lead_id;
    ELSIF NEW.renewal_id IS NOT NULL THEN
      SELECT assigned_caller INTO NEW.assigned_caller FROM renewals WHERE id = NEW.renewal_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_followup_caller
BEFORE INSERT OR UPDATE ON follow_ups
FOR EACH ROW EXECUTE FUNCTION sync_followup_assigned_caller();

-- 6.5 customer_name snapshot sync on orders/renewals ------------------
CREATE OR REPLACE FUNCTION sync_customer_name_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    SELECT full_name INTO NEW.customer_name FROM customers WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_customer_name_sync
BEFORE INSERT OR UPDATE OF customer_id ON orders
FOR EACH ROW EXECUTE FUNCTION sync_customer_name_snapshot();

CREATE TRIGGER trg_renewals_customer_name_sync
BEFORE INSERT OR UPDATE OF customer_id ON renewals
FOR EACH ROW EXECUTE FUNCTION sync_customer_name_snapshot();

-- 6.6 privilege-escalation guard on users (complements RLS — rationale #B)
CREATE OR REPLACE FUNCTION prevent_privilege_escalation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_role() = 'caller' THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
      RAISE EXCEPTION 'callers may not modify role, status, or employee_id';
    END IF;
  END IF;

  IF app_current_role() = 'admin' THEN
    IF OLD.role <> 'caller' AND NEW.id IS DISTINCT FROM app_current_user_id() THEN
      RAISE EXCEPTION 'admins may not modify non-caller user accounts other than their own profile';
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role AND NEW.role <> 'caller' THEN
      RAISE EXCEPTION 'admins may not grant admin or super_admin roles';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_prevent_privilege_escalation
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION prevent_privilege_escalation();

-- 6.7 audit_log capture ------------------------------------------------
CREATE OR REPLACE FUNCTION log_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_log(actor_user_id, action, target_table, target_id, old_data, new_data)
  VALUES (
    app_current_user_id(),
    TG_OP,
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('UPDATE','INSERT') THEN to_jsonb(NEW) ELSE NULL END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','customers','leads','orders','renewals','follow_ups','lead_assignments'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION log_audit();',
      t
    );
  END LOOP;
END $$;


-- =====================================================================
-- 7. INDEXES
-- =====================================================================
-- 7.1 users
CREATE INDEX idx_users_role ON users (role) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_status ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_phone ON users (phone);

-- 7.2 customers
CREATE INDEX idx_customers_city_state ON customers (city, state) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_mobile_trgm ON customers USING GIN (primary_mobile gin_trgm_ops);
CREATE INDEX idx_customers_search ON customers USING GIN (search_vector);

-- 7.3 products
CREATE INDEX idx_products_active ON products (id) WHERE is_active AND deleted_at IS NULL;
CREATE INDEX idx_products_search ON products USING GIN (search_vector);

-- 7.4 leads — FKs + every commonly filtered/sorted UI column
CREATE INDEX idx_leads_customer_id ON leads (customer_id);
CREATE INDEX idx_leads_requested_product_id ON leads (requested_product_id);
CREATE INDEX idx_leads_assigned_caller ON leads (assigned_caller) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_status ON leads (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_priority ON leads (priority) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_created_at ON leads (created_at DESC);
CREATE INDEX idx_leads_next_follow_up ON leads (next_follow_up) WHERE deleted_at IS NULL AND next_follow_up IS NOT NULL;
-- "Open leads" dashboard tab — heavily hit, small hot subset:
CREATE INDEX idx_leads_open ON leads (assigned_caller, priority)
  WHERE deleted_at IS NULL AND status NOT IN ('converted','closed','not_interested');
CREATE INDEX idx_leads_search ON leads USING GIN (search_vector);
CREATE INDEX idx_leads_mobile_trgm ON leads USING GIN (mobile gin_trgm_ops);

-- 7.5 lead_activities (indexes on the partitioned parent propagate to partitions)
CREATE INDEX idx_lead_activities_lead_id_created_at ON lead_activities (lead_id, created_at DESC);
CREATE INDEX idx_lead_activities_created_by ON lead_activities (created_by);

-- 7.6 lead_assignments
CREATE INDEX idx_lead_assignments_lead_id ON lead_assignments (lead_id);
CREATE INDEX idx_lead_assignments_assigned_to ON lead_assignments (assigned_to);
CREATE INDEX idx_lead_assignments_open ON lead_assignments (lead_id) WHERE unassigned_at IS NULL;

-- 7.7 orders
CREATE INDEX idx_orders_lead_id ON orders (lead_id);
CREATE INDEX idx_orders_customer_id ON orders (customer_id);
CREATE INDEX idx_orders_stage ON orders (stage) WHERE deleted_at IS NULL;
CREATE INDEX idx_orders_payment_status ON orders (payment_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_orders_created_at ON orders (created_at DESC);
CREATE INDEX idx_orders_search ON orders USING GIN (search_vector);

-- 7.8 order_items
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_product_id ON order_items (product_id);

-- 7.9 renewals
CREATE INDEX idx_renewals_customer_id ON renewals (customer_id);
CREATE INDEX idx_renewals_assigned_caller ON renewals (assigned_caller) WHERE deleted_at IS NULL;
CREATE INDEX idx_renewals_expiry_date ON renewals (expiry_date) WHERE deleted_at IS NULL AND renewed_at IS NULL;
CREATE INDEX idx_renewals_renewal_date ON renewals (renewal_date) WHERE deleted_at IS NULL AND renewed_at IS NULL;

-- 7.10 follow_ups
CREATE INDEX idx_follow_ups_customer_id ON follow_ups (customer_id);
CREATE INDEX idx_follow_ups_lead_id ON follow_ups (lead_id);
CREATE INDEX idx_follow_ups_renewal_id ON follow_ups (renewal_id);
CREATE INDEX idx_follow_ups_assigned_caller ON follow_ups (assigned_caller) WHERE deleted_at IS NULL;
CREATE INDEX idx_follow_ups_pending ON follow_ups (scheduled_date) WHERE status = 'pending' AND deleted_at IS NULL;

-- 7.11 notifications
CREATE INDEX idx_notifications_recipient_unread ON notifications (recipient_user_id, created_at DESC) WHERE NOT read;
CREATE INDEX idx_notifications_recipient ON notifications (recipient_user_id, created_at DESC);

-- 7.12 audit_log
CREATE INDEX idx_audit_log_target ON audit_log (target_table, target_id);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_user_id);

-- 7.13 sessions
CREATE INDEX idx_sessions_user_id ON sessions (user_id);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);


-- =====================================================================
-- 8. ROW-LEVEL SECURITY
-- =====================================================================
-- Pattern for every table: ENABLE + FORCE (so even the table owner is
-- bound by policy unless it holds BYPASSRLS), then explicit per-command
-- policies driven by app_current_role()/app_current_user_id().

-- 8.1 users -------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users FOR SELECT
USING (
  app_current_role() = 'super_admin'
  OR (app_current_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_role() = 'caller' AND id = app_current_user_id())
);

CREATE POLICY users_insert ON users FOR INSERT
WITH CHECK (
  app_current_role() = 'super_admin'
  OR (app_current_role() = 'admin' AND role = 'caller')
);

CREATE POLICY users_update ON users FOR UPDATE
USING (
  app_current_role() = 'super_admin'
  OR (app_current_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_role() = 'caller' AND id = app_current_user_id())
)
WITH CHECK (
  app_current_role() = 'super_admin'
  OR (app_current_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_role() = 'caller' AND id = app_current_user_id())
);
-- Column-level restriction (caller can't touch own role/status, admin can't
-- touch other admins) is enforced by trg_prevent_privilege_escalation,
-- since RLS alone cannot compare OLD vs NEW at the column level.

CREATE POLICY users_delete ON users FOR DELETE
USING (
  app_current_role() = 'super_admin'
  OR (app_current_role() = 'admin' AND role = 'caller')
);

-- 8.2 customers -----------------------------------------------------------
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_select ON customers FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller = app_current_user_id()
      UNION ALL
        SELECT 1 FROM renewals r WHERE r.customer_id = customers.id AND r.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY customers_insert ON customers FOR INSERT
WITH CHECK (app_current_role() IN ('super_admin','admin','caller'));
-- Callers may create a brand-new customer record while converting their own lead.

CREATE POLICY customers_update ON customers FOR UPDATE
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller = app_current_user_id()
     ))
)
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY customers_delete ON customers FOR DELETE
USING (app_current_role() IN ('super_admin','admin'));

-- 8.3 products --------------------------------------------------------------
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

CREATE POLICY products_select ON products FOR SELECT USING (true);
-- Every role needs the catalog to populate lead/order forms; it holds no PII.

CREATE POLICY products_insert ON products FOR INSERT WITH CHECK (app_current_role() IN ('super_admin','admin'));
CREATE POLICY products_update ON products FOR UPDATE
  USING (app_current_role() IN ('super_admin','admin'))
  WITH CHECK (app_current_role() IN ('super_admin','admin'));
CREATE POLICY products_delete ON products FOR DELETE USING (app_current_role() IN ('super_admin','admin'));

-- 8.4 leads -------------------------------------------------------------------
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;

CREATE POLICY leads_select ON leads FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY leads_insert ON leads FOR INSERT
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY leads_update ON leads FOR UPDATE
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
)
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);
-- Note: a caller CANNOT use this UPDATE policy to reassign a lead to someone
-- else, because WITH CHECK re-evaluates assigned_caller = app_current_user_id()
-- against the NEW row too — setting assigned_caller to a different caller
-- fails the check unless an admin/super_admin performs it.

CREATE POLICY leads_delete ON leads FOR DELETE
USING (app_current_role() IN ('super_admin','admin'));

-- 8.5 lead_activities --------------------------------------------------------
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_activities_select ON lead_activities FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY lead_activities_insert ON lead_activities FOR INSERT
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller = app_current_user_id()
     ))
);
-- No UPDATE/DELETE policy is defined for any role: the timeline is append-only
-- by design (audit integrity). Corrections are made by inserting a new entry.

-- 8.6 lead_assignments -------------------------------------------------------
ALTER TABLE lead_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_assignments_select ON lead_assignments FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_to = app_current_user_id())
);
-- No direct INSERT/UPDATE policy for any role — this table is written only by
-- trg_sync_lead_assignment_history (SECURITY DEFINER), never directly by the app.

-- 8.7 orders ------------------------------------------------------------------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY orders_select ON orders FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY orders_insert ON orders FOR INSERT
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY orders_update ON orders FOR UPDATE
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller = app_current_user_id()
     ))
)
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY orders_delete ON orders FOR DELETE
USING (app_current_role() IN ('super_admin','admin'));

-- 8.8 order_items ---------------------------------------------------------
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;

CREATE POLICY order_items_select ON order_items FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.id = order_items.order_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY order_items_insert ON order_items FOR INSERT
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.id = order_items.order_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY order_items_update ON order_items FOR UPDATE
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.id = order_items.order_id AND l.assigned_caller = app_current_user_id()
     ))
)
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.id = order_items.order_id AND l.assigned_caller = app_current_user_id()
     ))
);

CREATE POLICY order_items_delete ON order_items FOR DELETE
USING (app_current_role() IN ('super_admin','admin'));

-- 8.9 renewals ------------------------------------------------------------
ALTER TABLE renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewals FORCE ROW LEVEL SECURITY;

CREATE POLICY renewals_select ON renewals FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY renewals_insert ON renewals FOR INSERT
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY renewals_update ON renewals FOR UPDATE
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
)
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY renewals_delete ON renewals FOR DELETE
USING (app_current_role() IN ('super_admin','admin'));

-- 8.10 follow_ups ------------------------------------------------------------
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups FORCE ROW LEVEL SECURITY;

CREATE POLICY follow_ups_select ON follow_ups FOR SELECT
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY follow_ups_insert ON follow_ups FOR INSERT
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND (
        assigned_caller = app_current_user_id() OR assigned_caller IS NULL
        -- NULL allowed pre-insert: trg_sync_followup_caller backfills it
        -- from lead_id/renewal_id before the row is stored, and that
        -- lookup itself is RLS-gated to the caller's own leads/renewals.
     ))
);

CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE
USING (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
)
WITH CHECK (
  app_current_role() IN ('super_admin','admin')
  OR (app_current_role() = 'caller' AND assigned_caller = app_current_user_id())
);

CREATE POLICY follow_ups_delete ON follow_ups FOR DELETE
USING (app_current_role() IN ('super_admin','admin'));

-- 8.11 notifications ----------------------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_select ON notifications FOR SELECT
USING (
  app_current_role() = 'super_admin'
  OR recipient_user_id = app_current_user_id()
);

CREATE POLICY notifications_insert ON notifications FOR INSERT
WITH CHECK (app_current_role() IN ('super_admin','admin'));
-- System-generated notifications are typically produced by a backend service
-- account running as 'admin'/'super_admin'; end users never author them directly.

CREATE POLICY notifications_update ON notifications FOR UPDATE
USING (recipient_user_id = app_current_user_id() OR app_current_role() = 'super_admin')
WITH CHECK (recipient_user_id = app_current_user_id() OR app_current_role() = 'super_admin');
-- Update is for marking read/unread only; enforce that at the app layer
-- (restrict the UPDATE statement to the `read` column).

-- 8.12 audit_log ------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_select ON audit_log FOR SELECT
USING (
  app_current_role() = 'super_admin'
  OR (app_current_role() = 'admin' AND target_table IN
        ('leads','orders','renewals','follow_ups','lead_assignments','customers'))
);
-- No INSERT/UPDATE/DELETE policy for ANY app role — rows are written solely by
-- the SECURITY DEFINER log_audit() trigger function.

-- 8.13 sessions ---------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_all ON sessions
USING (app_current_role() = 'super_admin' OR user_id = app_current_user_id())
WITH CHECK (app_current_role() = 'super_admin' OR user_id = app_current_user_id());


-- =====================================================================
-- 9. VIEWS (derived/computed state — never persisted redundantly)
-- =====================================================================

-- 9.1 renewals_view — computes daysRemaining/status at query time (rationale #4)
CREATE OR REPLACE FUNCTION compute_renewal_status(p_renewal_date date, p_expiry_date date, p_renewed_at timestamptz)
RETURNS renewal_status LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_renewed_at IS NOT NULL THEN 'renewed'::renewal_status
    WHEN p_expiry_date < CURRENT_DATE THEN 'overdue'::renewal_status
    WHEN p_renewal_date <= CURRENT_DATE THEN 'due_today'::renewal_status
    ELSE 'upcoming'::renewal_status
  END;
$$;

CREATE OR REPLACE VIEW renewals_view AS
SELECT
  r.*,
  (r.expiry_date - CURRENT_DATE) AS days_remaining,
  compute_renewal_status(r.renewal_date, r.expiry_date, r.renewed_at) AS status
FROM renewals r
WHERE r.deleted_at IS NULL;
-- A plain (non-materialized) view re-executes the base query per call, which
-- means it re-checks RLS on `renewals` for the invoking session every time —
-- exactly the security property we need. Never a materialized view here,
-- because status/days_remaining must always reflect "now", and a stale
-- materialized copy could show a caller an already-expired renewal as
-- "upcoming".

-- 9.2 global_search — backs the frontend's global search bar
CREATE OR REPLACE VIEW global_search AS
SELECT 'customer'::text AS entity_type, id, full_name AS label, search_vector, deleted_at
  FROM customers
UNION ALL
SELECT 'lead', id, customer_name, search_vector, deleted_at
  FROM leads
UNION ALL
SELECT 'order', id, order_number, search_vector, deleted_at
  FROM orders
UNION ALL
SELECT 'product', id, coalesce(brand_name, generic_name), search_vector, deleted_at
  FROM products;
-- Usage from the app:
--   SELECT entity_type, id, label
--   FROM global_search
--   WHERE deleted_at IS NULL
--     AND search_vector @@ websearch_to_tsquery('simple', :q)
--   ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', :q)) DESC
--   LIMIT 20;
-- Being a plain view over RLS-protected base tables, a caller's search never
-- surfaces another caller's leads/customers/orders.


-- =====================================================================
-- 10. MATERIALIZED VIEWS — dashboard aggregates
-- =====================================================================
-- These intentionally bypass per-row RLS (materialized views cannot carry
-- policies) because they expose only aggregate counts, never individual
-- lead/customer rows. They are refreshed by a scheduled job running as a
-- privileged role (not exposed to 'caller' sessions) — grant SELECT on
-- them only to 'admin'/'super_admin' at the application layer, and never
-- query them directly on behalf of a 'caller'.

-- 10.1 Lead status breakdown (status x priority x source counts)
CREATE MATERIALIZED VIEW mv_lead_status_breakdown AS
SELECT
  status,
  priority,
  lead_source,
  count(*) AS lead_count,
  count(*) FILTER (WHERE next_follow_up IS NOT NULL AND next_follow_up < now()) AS overdue_follow_up_count
FROM leads
WHERE deleted_at IS NULL
GROUP BY status, priority, lead_source
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_lead_status_breakdown ON mv_lead_status_breakdown (status, priority, lead_source);

-- 10.2 Caller performance (per-caller conversion + workload)
CREATE MATERIALIZED VIEW mv_caller_performance AS
SELECT
  u.id AS caller_id,
  u.name AS caller_name,
  count(l.id) AS total_assigned_leads,
  count(l.id) FILTER (WHERE l.status = 'converted') AS converted_leads,
  ROUND(
    count(l.id) FILTER (WHERE l.status = 'converted')::numeric
      / NULLIF(count(l.id), 0), 4
  ) AS conversion_rate,
  count(l.id) FILTER (WHERE l.status NOT IN ('converted','closed','not_interested')) AS open_leads,
  count(f.id) FILTER (WHERE f.status = 'pending' AND f.scheduled_date < now()) AS overdue_follow_ups,
  ROUND(
    AVG(EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400.0)
      FILTER (WHERE l.status = 'converted'), 2
  ) AS avg_days_to_convert
FROM users u
LEFT JOIN leads l ON l.assigned_caller = u.id AND l.deleted_at IS NULL
LEFT JOIN follow_ups f ON f.assigned_caller = u.id AND f.deleted_at IS NULL
WHERE u.role = 'caller' AND u.deleted_at IS NULL
GROUP BY u.id, u.name
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_caller_performance ON mv_caller_performance (caller_id);

-- Initial population (must run once after creation, before first use):
--   REFRESH MATERIALIZED VIEW mv_lead_status_breakdown;
--   REFRESH MATERIALIZED VIEW mv_caller_performance;

-- Refresh strategy: schedule via pg_cron (or an external scheduler) every
-- 5-10 minutes. CONCURRENTLY requires the unique indexes above and avoids
-- locking the view against readers during refresh:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule(
--     'refresh_crm_dashboards',
--     '*/10 * * * *',
--     $$REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown;
--       REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance;$$
--   );
-- A 5-10 minute staleness window is acceptable for dashboard KPI tiles;
-- if the business later needs near-real-time counts, switch to a
-- LISTEN/NOTIFY-triggered refresh (debounced) fired from the leads trigger.


-- =====================================================================
-- 11. GRANTS
-- =====================================================================
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT SELECT ON mv_lead_status_breakdown, mv_caller_performance TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
-- app_user is intentionally NOT granted BYPASSRLS. All SECURITY DEFINER
-- trigger functions above must be owned by a separate, non-login-exposed
-- role (e.g. the migration/schema-owner role) that DOES have BYPASSRLS,
-- so bookkeeping writes (counters, history, audit) succeed regardless of
-- the calling session's restricted view of the data.