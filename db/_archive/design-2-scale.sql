-- =====================================================================================
-- MEDICAL CRM — POSTGRESQL SCHEMA (SCALE / FUTURE-PROOFING ARCHITECT)
-- Target: PostgreSQL 15+
-- =====================================================================================

-- =====================================================================================
-- 0. EXTENSIONS
-- =====================================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy / partial text search (autocomplete)
-- pg_cron is assumed available on the managed instance (RDS/Cloud SQL/self-host) for
-- scheduled partition maintenance & archival jobs. If unavailable, run the equivalent
-- functions from an external scheduler (systemd timer / Airflow / app cron).
-- CREATE EXTENSION IF NOT EXISTS pg_cron;

-- =====================================================================================
-- 1. ENUM TYPES (mirrors frontend union types exactly — see rationale for field fidelity)
-- =====================================================================================
CREATE TYPE user_role            AS ENUM ('super_admin','admin','caller');
CREATE TYPE user_status          AS ENUM ('active','inactive');

CREATE TYPE lead_status          AS ENUM (
  'new','contacted','follow_up_pending','interested','call_back_later',
  'no_response','not_interested','converted','closed'
);
CREATE TYPE lead_priority        AS ENUM ('low','medium','high','urgent');
CREATE TYPE lead_source          AS ENUM (
  'website','referral','walk_in','phone','social_media','advertisement','other'
);
CREATE TYPE lead_activity_type   AS ENUM (
  'call','comment','status_change','follow_up','assignment','created'
);

CREATE TYPE order_stage          AS ENUM (
  'lead','confirmed','medicine_prepared','packed','shipped','delivered'
);
CREATE TYPE payment_status       AS ENUM ('pending','partial','paid','refunded');

CREATE TYPE renewal_status       AS ENUM ('upcoming','due_today','overdue','renewed');

CREATE TYPE followup_type        AS ENUM ('call','reminder','callback');
CREATE TYPE followup_status      AS ENUM ('pending','completed','missed');

CREATE TYPE notification_type    AS ENUM ('info','warning','success','error');
CREATE TYPE related_entity_type  AS ENUM ('lead','order','renewal','follow_up','customer');

CREATE TYPE audit_action         AS ENUM ('INSERT','UPDATE','DELETE');

-- =====================================================================================
-- 2. GENERIC HELPER FUNCTIONS (used by many triggers/policies below)
-- =====================================================================================

-- 2.1 updated_at auto-maintenance (attached per-table further down)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- 2.2 RLS session context. The application (a single DB role, connection-pooled) MUST
-- run `SELECT set_config('app.current_user_id', '<uuid>', true);` and
-- `SELECT set_config('app.current_user_role', '<role>', true);` (or SET LOCAL) at the
-- start of every transaction, immediately after authenticating the request. These are
-- read-only helper wrappers used inside RLS policies.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_user_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_role', true), '');
$$;

-- 2.3 Generic partition-management helper (RANGE by month). Used for lead_activities,
-- notifications, audit_log. Idempotent — safe to call repeatedly (e.g. from pg_cron).
CREATE OR REPLACE FUNCTION ensure_monthly_partition(p_parent text, p_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('%s_y%sm%s', p_parent, to_char(v_start,'YYYY'), to_char(v_start,'MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      v_name, p_parent, v_start, v_end
    );
    RAISE NOTICE 'Created partition % for %', v_name, p_parent;
  END IF;
END;
$$;

-- =====================================================================================
-- 3. USERS
--    NOTE (multi-tenancy retrofit slot): a future `organization_id UUID NULL
--    REFERENCES organizations(id)` column can be added to this and every table below
--    without breaking anything, because every PK is a UUID and no natural key is used
--    as a PK. See DESIGN RATIONALE §9 for the exact, ordered migration steps.
-- =====================================================================================
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           TEXT NOT NULL,
  name                  TEXT NOT NULL,
  phone                 TEXT NOT NULL CHECK (phone ~ '^[0-9+ ()-]{7,15}$'),
  email                 CITEXT NOT NULL,
  role                  user_role NOT NULL DEFAULT 'caller',
  status                user_status NOT NULL DEFAULT 'active',
  password_hash         TEXT NOT NULL,             -- bcrypt/argon2 ONLY. Never plaintext.
  avatar_url            TEXT,
  -- Trigger-maintained cache of live lead count. See DESIGN RATIONALE §4 for why this
  -- is a maintained counter rather than a query-time COUNT(*).
  assigned_leads_count  INTEGER NOT NULL DEFAULT 0 CHECK (assigned_leads_count >= 0),
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,                -- soft delete
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON COLUMN users.assigned_leads_count IS
  'Denormalized, trigger-maintained cache — see DESIGN RATIONALE §4. Never hand-edit.';

-- Natural keys as partial-unique indexes (soft-deleted rows must not block re-use of an
-- employee_id/email — the whole point of soft delete is that old rows still "exist").
CREATE UNIQUE INDEX ux_users_employee_id ON users (employee_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_users_email       ON users (email)       WHERE deleted_at IS NULL;
CREATE INDEX ix_users_role_status ON users (role, status) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 4. CUSTOMERS  (fixes simplification #1 — canonical identity across leads/orders/renewals)
-- =====================================================================================
CREATE TABLE customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         TEXT NOT NULL,
  primary_mobile    TEXT NOT NULL CHECK (primary_mobile ~ '^[0-9+ ()-]{7,15}$'),
  alternate_mobile  TEXT,
  address           TEXT,
  city              TEXT,
  state             TEXT,
  pincode           TEXT CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$'),
  doctor_name       TEXT,
  -- Full text search (native Postgres tsvector + GIN — see rationale §7 for when to graduate)
  search_vector     TSVECTOR GENERATED ALWAYS AS (
                       to_tsvector('english',
                         coalesce(full_name,'') || ' ' ||
                         coalesce(primary_mobile,'') || ' ' ||
                         coalesce(alternate_mobile,'') || ' ' ||
                         coalesce(city,'') || ' ' || coalesce(state,'')
                       )
                     ) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Identity/dedup key: one live customer per phone number (the de-facto identity key in
-- pharma-distribution intake). Matching logic in the app: on new lead intake, look up
-- customers WHERE primary_mobile = <incoming mobile> AND deleted_at IS NULL first.
CREATE UNIQUE INDEX ux_customers_primary_mobile ON customers (primary_mobile) WHERE deleted_at IS NULL;
CREATE INDEX ix_customers_search_vector ON customers USING GIN (search_vector);
CREATE INDEX ix_customers_name_trgm ON customers USING GIN (full_name gin_trgm_ops);

CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 5. PRODUCTS (medicine catalog — fixes simplification #2)
-- =====================================================================================
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           TEXT NOT NULL,
  generic_name  TEXT NOT NULL,
  brand_name    TEXT,
  strength      TEXT,      -- e.g. "500mg"
  dosage_form   TEXT,      -- tablet / syrup / injection / etc.
  unit_price    NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  search_vector TSVECTOR GENERATED ALWAYS AS (
                   to_tsvector('english',
                     coalesce(generic_name,'') || ' ' || coalesce(brand_name,'') || ' ' ||
                     coalesce(sku,'')
                   )
                 ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ux_products_sku ON products (sku) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_search_vector ON products USING GIN (search_vector);
CREATE INDEX ix_products_active ON products (is_active) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 6. LEADS
-- =====================================================================================
CREATE TABLE leads (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL, -- NULL until matched/created
  -- Intake snapshot fields (kept even after customer_id is linked — the lead captures
  -- what the caller was TOLD at time of intake, which is a legally/operationally useful
  -- audit fact independent of what the customer record later becomes).
  customer_name         TEXT NOT NULL,
  mobile                TEXT NOT NULL CHECK (mobile ~ '^[0-9+ ()-]{7,15}$'),
  alternate_number      TEXT,
  address               TEXT NOT NULL,
  city                  TEXT NOT NULL,
  state                 TEXT NOT NULL,
  pincode               TEXT NOT NULL CHECK (pincode ~ '^[0-9]{6}$'),
  medicine_required     TEXT NOT NULL,
  requested_product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
  quantity              INTEGER NOT NULL CHECK (quantity > 0),
  doctor_name           TEXT,
  assigned_caller_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  lead_source           lead_source NOT NULL DEFAULT 'other',
  priority              lead_priority NOT NULL DEFAULT 'medium',
  status                lead_status NOT NULL DEFAULT 'new',
  last_follow_up        TIMESTAMPTZ,
  next_follow_up        TIMESTAMPTZ,
  notes                 TEXT,
  search_vector         TSVECTOR GENERATED ALWAYS AS (
                           to_tsvector('english',
                             coalesce(customer_name,'') || ' ' || coalesce(mobile,'') || ' ' ||
                             coalesce(medicine_required,'') || ' ' || coalesce(city,'') || ' ' ||
                             coalesce(doctor_name,'') || ' ' || coalesce(notes,'')
                           )
                         ) STORED,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),   -- was Lead.createdDate
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by            UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX ix_leads_assigned_caller ON leads (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_status          ON leads (status)             WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_next_follow_up  ON leads (next_follow_up)     WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_customer_id     ON leads (customer_id);
CREATE INDEX ix_leads_search_vector   ON leads USING GIN (search_vector);
CREATE INDEX ix_leads_mobile_trgm     ON leads USING GIN (mobile gin_trgm_ops);

CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 7. LEAD_ACTIVITIES  — HIGH VOLUME, APPEND-ONLY, PARTITIONED BY MONTH (created_at)
-- =====================================================================================
CREATE TABLE lead_activities (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  lead_id      UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type         lead_activity_type NOT NULL,
  description  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (id, created_at)          -- partition key MUST be part of the PK
) PARTITION BY RANGE (created_at);

-- Indexes declared on the partitioned parent are automatically created on every
-- existing AND future partition (PG11+ "partitioned indexes") — declare once here.
CREATE INDEX ix_lead_activities_lead_id ON lead_activities (lead_id, created_at DESC);

-- Safety-net partition: if partition maintenance ever lags, rows still insert here
-- instead of erroring out (then get manually redistributed).
CREATE TABLE lead_activities_default PARTITION OF lead_activities DEFAULT;

-- =====================================================================================
-- 8. LEAD_ASSIGNMENTS — reassignment audit trail (fixes simplification #7)
--    Kept separate from the live pointer (leads.assigned_caller_id) purely as history.
--    Volume is far lower than lead_activities (one row per reassignment, not per
--    interaction), so it is NOT partitioned initially — see rationale §5.
-- =====================================================================================
CREATE TABLE lead_assignments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at  TIMESTAMPTZ,           -- NULL = this is the currently-open assignment span
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_lead_assignments_lead ON lead_assignments (lead_id, assigned_at DESC);
CREATE INDEX ix_lead_assignments_user ON lead_assignments (assigned_to);
-- Only one open (unassigned_at IS NULL) assignment span per lead at a time:
CREATE UNIQUE INDEX ux_lead_assignments_open ON lead_assignments (lead_id) WHERE unassigned_at IS NULL;

CREATE TRIGGER trg_lead_assignments_updated_at BEFORE UPDATE ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 9. ORDERS
-- =====================================================================================
CREATE TABLE orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      TEXT NOT NULL,
  lead_id           UUID REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  shipping_address  TEXT NOT NULL,   -- snapshot at order time (may differ from customer's current address)
  total_amount      NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
  payment_status    payment_status NOT NULL DEFAULT 'pending',
  stage             order_stage NOT NULL DEFAULT 'lead',
  search_vector     TSVECTOR GENERATED ALWAYS AS (
                       to_tsvector('english', coalesce(order_number,'') || ' ' || coalesce(shipping_address,''))
                     ) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- was Order.createdDate
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- was Order.updatedDate
  deleted_at        TIMESTAMPTZ,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ux_orders_order_number ON orders (order_number) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_lead_id     ON orders (lead_id);
CREATE INDEX ix_orders_customer_id ON orders (customer_id);
CREATE INDEX ix_orders_stage       ON orders (stage) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_search_vector ON orders USING GIN (search_vector);

CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 10. ORDER_ITEMS (replaces the embedded Order.medicines[] array)
-- =====================================================================================
CREATE TABLE order_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id               UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id             UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name_snapshot  TEXT NOT NULL,  -- freezes name at sale time even if catalog entry is later renamed
  quantity               INTEGER NOT NULL CHECK (quantity > 0),
  unit_price             NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total             NUMERIC(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);
CREATE INDEX ix_order_items_order_id   ON order_items (order_id);
CREATE INDEX ix_order_items_product_id ON order_items (product_id);

CREATE TRIGGER trg_order_items_updated_at BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 11. RENEWALS
--     daysRemaining / status are NOT stored — see DESIGN RATIONALE §4 (view instead).
-- =====================================================================================
CREATE TABLE renewals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  order_id            UUID REFERENCES orders(id) ON DELETE SET NULL,   -- originating order, if known
  product_id          UUID REFERENCES products(id) ON DELETE SET NULL,
  medicine_name       TEXT NOT NULL,  -- snapshot, mirrors Renewal.medicineName
  order_date          TIMESTAMPTZ NOT NULL,
  renewal_date        TIMESTAMPTZ NOT NULL,
  expiry_date         TIMESTAMPTZ NOT NULL,
  assigned_caller_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  renewed_at          TIMESTAMPTZ,   -- the one persisted FACT; everything else is derived
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX ix_renewals_customer_id  ON renewals (customer_id);
CREATE INDEX ix_renewals_caller       ON renewals (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_renewals_expiry_date  ON renewals (expiry_date) WHERE deleted_at IS NULL AND renewed_at IS NULL;

CREATE TRIGGER trg_renewals_updated_at BEFORE UPDATE ON renewals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- View: derives status + days_remaining at query time (see rationale §4).
CREATE VIEW renewals_with_status AS
SELECT
  r.*,
  c.full_name AS customer_name,
  CASE
    WHEN r.renewed_at IS NOT NULL                              THEN 'renewed'
    WHEN (r.expiry_date::date - CURRENT_DATE) < 0               THEN 'overdue'
    WHEN (r.expiry_date::date - CURRENT_DATE) = 0               THEN 'due_today'
    ELSE 'upcoming'
  END::renewal_status AS status,
  (r.expiry_date::date - CURRENT_DATE) AS days_remaining   -- negative = N days overdue
FROM renewals r
JOIN customers c ON c.id = r.customer_id
WHERE r.deleted_at IS NULL;

-- =====================================================================================
-- 12. FOLLOW_UPS (fixes simplification #8 — proper customer/renewal linkage, no hack)
-- =====================================================================================
CREATE TABLE follow_ups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
  renewal_id      UUID REFERENCES renewals(id) ON DELETE SET NULL,
  scheduled_date  TIMESTAMPTZ NOT NULL,
  type            followup_type NOT NULL,
  status          followup_status NOT NULL DEFAULT 'pending',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX ix_follow_ups_customer_id    ON follow_ups (customer_id);
CREATE INDEX ix_follow_ups_lead_id        ON follow_ups (lead_id);
CREATE INDEX ix_follow_ups_renewal_id     ON follow_ups (renewal_id);
CREATE INDEX ix_follow_ups_scheduled_date ON follow_ups (scheduled_date) WHERE deleted_at IS NULL AND status = 'pending';

CREATE TRIGGER trg_follow_ups_updated_at BEFORE UPDATE ON follow_ups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================================
-- 13. NOTIFICATIONS — HIGH VOLUME, PARTITIONED BY MONTH (fixes simplification #6)
-- =====================================================================================
CREATE TABLE notifications (
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  recipient_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  message             TEXT NOT NULL,
  type                notification_type NOT NULL DEFAULT 'info',
  read                BOOLEAN NOT NULL DEFAULT false,
  read_at             TIMESTAMPTZ,
  related_entity_type related_entity_type,
  related_entity_id   UUID,               -- polymorphic pointer for deep-linking; not a DB FK
                                           -- (a real FK can't span multiple target tables —
                                           -- integrity is enforced app-side / via trigger check)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX ix_notifications_recipient ON notifications (recipient_user_id, read, created_at DESC);
CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;

-- =====================================================================================
-- 14. AUDIT_LOG — HIGH VOLUME, COMPLIANCE, PARTITIONED BY MONTH, APPEND-ONLY/IMMUTABLE
-- =====================================================================================
CREATE TABLE audit_log (
  id           UUID NOT NULL DEFAULT gen_random_uuid(),
  table_name   TEXT NOT NULL,
  record_id    UUID NOT NULL,
  action       audit_action NOT NULL,
  old_data     JSONB,
  new_data     JSONB,
  changed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);

CREATE INDEX ix_audit_log_record ON audit_log (table_name, record_id, changed_at DESC);
CREATE INDEX ix_audit_log_new_data_gin ON audit_log USING GIN (new_data);
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

-- Generic audit trigger, attached to the tables that matter most for compliance/traceability.
CREATE OR REPLACE FUNCTION fn_audit_log() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_changed_by uuid := app_current_user_id();
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log(table_name, record_id, action, old_data, changed_by)
    VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), v_changed_by);
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_log(table_name, record_id, action, old_data, new_data, changed_by)
    VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), v_changed_by);
    RETURN NEW;
  ELSE
    INSERT INTO audit_log(table_name, record_id, action, new_data, changed_by)
    VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', to_jsonb(NEW), v_changed_by);
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER trg_audit_users    AFTER INSERT OR UPDATE OR DELETE ON users    FOR EACH ROW EXECUTE FUNCTION fn_audit_log();
CREATE TRIGGER trg_audit_leads    AFTER INSERT OR UPDATE OR DELETE ON leads    FOR EACH ROW EXECUTE FUNCTION fn_audit_log();
CREATE TRIGGER trg_audit_orders   AFTER INSERT OR UPDATE OR DELETE ON orders   FOR EACH ROW EXECUTE FUNCTION fn_audit_log();
CREATE TRIGGER trg_audit_renewals AFTER INSERT OR UPDATE OR DELETE ON renewals FOR EACH ROW EXECUTE FUNCTION fn_audit_log();

-- =====================================================================================
-- 15. assigned_leads_count MAINTENANCE TRIGGER (fixes simplification #3)
-- =====================================================================================
CREATE OR REPLACE FUNCTION trg_fn_leads_maintain_assigned_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_active boolean;
  new_active boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_caller_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    old_active := (OLD.assigned_caller_id IS NOT NULL AND OLD.deleted_at IS NULL);
    new_active := (NEW.assigned_caller_id IS NOT NULL AND NEW.deleted_at IS NULL);
    IF old_active AND NOT new_active THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count - 1 WHERE id = OLD.assigned_caller_id;
    ELSIF NOT old_active AND new_active THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller_id;
    ELSIF old_active AND new_active AND OLD.assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count - 1 WHERE id = OLD.assigned_caller_id;
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

CREATE TRIGGER trg_leads_maintain_assigned_count
AFTER INSERT OR DELETE OR UPDATE OF assigned_caller_id, deleted_at ON leads
FOR EACH ROW EXECUTE FUNCTION trg_fn_leads_maintain_assigned_count();

-- Reconciliation safety-net view — compare against users.assigned_leads_count nightly;
-- a scheduled job should alert (or auto-correct) on drift rather than trust the cache blindly.
CREATE VIEW users_live_lead_counts AS
SELECT u.id AS user_id,
       count(l.id) FILTER (WHERE l.deleted_at IS NULL) AS live_assigned_leads_count
FROM users u
LEFT JOIN leads l ON l.assigned_caller_id = u.id
GROUP BY u.id;

-- =====================================================================================
-- 16. lead_assignments HISTORY-LOGGING TRIGGER (fixes simplification #7)
-- =====================================================================================
CREATE OR REPLACE FUNCTION trg_fn_leads_log_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.assigned_caller_id IS NOT NULL THEN
    INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, assigned_at)
    VALUES (NEW.id, NEW.assigned_caller_id, NEW.created_by, now());
  ELSIF TG_OP = 'UPDATE' AND NEW.assigned_caller_id IS DISTINCT FROM OLD.assigned_caller_id THEN
    IF OLD.assigned_caller_id IS NOT NULL THEN
      UPDATE lead_assignments SET unassigned_at = now()
        WHERE lead_id = NEW.id AND assigned_to = OLD.assigned_caller_id AND unassigned_at IS NULL;
    END IF;
    IF NEW.assigned_caller_id IS NOT NULL THEN
      INSERT INTO lead_assignments (lead_id, assigned_to, assigned_by, assigned_at)
      VALUES (NEW.id, NEW.assigned_caller_id, NEW.updated_by, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leads_log_assignment
AFTER INSERT OR UPDATE OF assigned_caller_id ON leads
FOR EACH ROW EXECUTE FUNCTION trg_fn_leads_log_assignment();

-- =====================================================================================
-- 17. GLOBAL SEARCH VIEW (backs the frontend's global search bar)
-- =====================================================================================
CREATE VIEW global_search_index AS
SELECT 'customer'::text AS entity_type, id AS entity_id, full_name AS label, search_vector
FROM customers WHERE deleted_at IS NULL
UNION ALL
SELECT 'lead', id, customer_name, search_vector
FROM leads WHERE deleted_at IS NULL
UNION ALL
SELECT 'order', id, order_number, search_vector
FROM orders WHERE deleted_at IS NULL;
-- Query pattern: SELECT * FROM global_search_index WHERE search_vector @@ websearch_to_tsquery('english', :q);
-- See DESIGN RATIONALE §7 for when to graduate this to a dedicated search engine.

-- =====================================================================================
-- 18. PARTITION BOOTSTRAP — create a rolling window of partitions at deploy time
-- =====================================================================================
DO $$
DECLARE
  m int;
BEGIN
  FOR m IN -1..2 LOOP  -- previous month .. next 2 months
    PERFORM ensure_monthly_partition('lead_activities', (date_trunc('month', now()) + (m || ' months')::interval)::date);
    PERFORM ensure_monthly_partition('notifications',   (date_trunc('month', now()) + (m || ' months')::interval)::date);
    PERFORM ensure_monthly_partition('audit_log',        (date_trunc('month', now()) + (m || ' months')::interval)::date);
  END LOOP;
END;
$$;

-- Recurring maintenance (requires pg_cron): create next month's partitions on the 25th.
-- SELECT cron.schedule('ensure-future-partitions', '0 2 25 * *', $$
--   SELECT ensure_monthly_partition('lead_activities', (date_trunc('month', now()) + interval '1 month')::date);
--   SELECT ensure_monthly_partition('notifications',   (date_trunc('month', now()) + interval '1 month')::date);
--   SELECT ensure_monthly_partition('audit_log',        (date_trunc('month', now()) + interval '1 month')::date);
-- $$);

-- =====================================================================================
-- 19. ARCHIVAL / RETENTION (illustrative — see DESIGN RATIONALE §6 for policy per table)
-- =====================================================================================
-- Production version should resolve partition bounds via pg_get_expr(c.relpartbound, c.oid)
-- rather than parsing the partition name, and should run the COPY-to-cold-storage step
-- (S3/Azure Blob/parquet export) via an external job BEFORE detach+drop, never inside SQL.
CREATE OR REPLACE FUNCTION list_droppable_partitions(p_parent text, p_retain_months int)
RETURNS TABLE(partition_name text, upper_bound date) LANGUAGE plpgsql AS $$
DECLARE
  v_cutoff date := (date_trunc('month', now()) - (p_retain_months || ' months')::interval)::date;
BEGIN
  RETURN QUERY
  SELECT c.relname::text,
         (regexp_matches(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([0-9-]+)'''))[1]::date
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = p_parent AND c.relname <> p_parent || '_default'
  HAVING (regexp_matches(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([0-9-]+)'''))[1]::date <= v_cutoff
  GROUP BY c.relname, c.oid, c.relpartbound;
END;
$$;
-- Usage: SELECT * FROM list_droppable_partitions('lead_activities', 24);
-- Then, per row, from an external job: ALTER TABLE lead_activities DETACH PARTITION <name> CONCURRENTLY;
-- (PG14+, avoids locking the parent) -> export -> DROP TABLE <name>;

-- =====================================================================================
-- 20. ROW-LEVEL SECURITY
-- =====================================================================================
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications      ENABLE ROW LEVEL SECURITY;
-- audit_log: no RLS — it is an internal compliance table not exposed to app roles at all
-- (access only via a separate, restricted maintenance role).

-- ---- USERS ----------------------------------------------------------------
CREATE POLICY users_select ON users FOR SELECT USING (
  app_current_user_role() = 'super_admin'
  OR (app_current_user_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_user_role() = 'caller' AND id = app_current_user_id())
);
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (
  app_current_user_role() = 'super_admin'
  OR (app_current_user_role() = 'admin' AND role = 'caller')     -- admin can only create callers
);
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    app_current_user_role() = 'super_admin'
    OR (app_current_user_role() = 'admin'  AND role = 'caller')
    OR (app_current_user_role() = 'caller' AND id = app_current_user_id())
  )
  WITH CHECK (
    app_current_user_role() = 'super_admin'
    OR (app_current_user_role() = 'admin'  AND role = 'caller')
    OR (app_current_user_role() = 'caller' AND id = app_current_user_id())
  );
-- No DELETE policy defined -> DELETE is denied to all app-level roles by default; use
-- UPDATE ... SET deleted_at = now() instead. Hard delete only via a superuser/BYPASSRLS
-- maintenance role for legal erasure requests.

-- ---- CUSTOMERS --------------------------------------------------------------
CREATE POLICY customers_select ON customers FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller_id = app_current_user_id()
        UNION ALL
        SELECT 1 FROM renewals r WHERE r.customer_id = customers.id AND r.assigned_caller_id = app_current_user_id()
     ))
);
CREATE POLICY customers_insert ON customers FOR INSERT WITH CHECK (app_current_user_role() IN ('super_admin','admin','caller'));
CREATE POLICY customers_update ON customers FOR UPDATE USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller_id = app_current_user_id()
     ))
);

-- ---- PRODUCTS ---------------------------------------------------------------
CREATE POLICY products_select ON products FOR SELECT USING (true);  -- catalog is read-visible to all authenticated roles
CREATE POLICY products_write  ON products FOR INSERT WITH CHECK (app_current_user_role() IN ('super_admin','admin'));
CREATE POLICY products_update ON products FOR UPDATE USING (app_current_user_role() IN ('super_admin','admin'));

-- ---- LEADS --------------------------------------------------------------
CREATE POLICY leads_select ON leads FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND assigned_caller_id = app_current_user_id())
);
CREATE POLICY leads_insert ON leads FOR INSERT WITH CHECK (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND (assigned_caller_id IS NULL OR assigned_caller_id = app_current_user_id()))
);
CREATE POLICY leads_update ON leads FOR UPDATE USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND assigned_caller_id = app_current_user_id())
) WITH CHECK (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND assigned_caller_id = app_current_user_id())
);

-- ---- LEAD_ACTIVITIES ----------------------------------------------------
CREATE POLICY lead_activities_select ON lead_activities FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller_id = app_current_user_id()
     ))
);
CREATE POLICY lead_activities_insert ON lead_activities FOR INSERT WITH CHECK (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller_id = app_current_user_id()
     ))
);

-- ---- LEAD_ASSIGNMENTS ----------------------------------------------------
CREATE POLICY lead_assignments_select ON lead_assignments FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND (
        assigned_to = app_current_user_id()
        OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_assignments.lead_id AND l.assigned_caller_id = app_current_user_id())
     ))
);

-- ---- ORDERS / ORDER_ITEMS ----------------------------------------------------
CREATE POLICY orders_select ON orders FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller_id = app_current_user_id()
     ))
);
CREATE POLICY order_items_select ON order_items FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND EXISTS (
        SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
        WHERE o.id = order_items.order_id AND l.assigned_caller_id = app_current_user_id()
     ))
);

-- ---- RENEWALS -----------------------------------------------------------
CREATE POLICY renewals_select ON renewals FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND assigned_caller_id = app_current_user_id())
);

-- ---- FOLLOW_UPS -----------------------------------------------------------
CREATE POLICY follow_ups_select ON follow_ups FOR SELECT USING (
  app_current_user_role() IN ('super_admin','admin')
  OR (app_current_user_role() = 'caller' AND (
        (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = follow_ups.lead_id AND l.assigned_caller_id = app_current_user_id()))
        OR (renewal_id IS NOT NULL AND EXISTS (SELECT 1 FROM renewals r WHERE r.id = follow_ups.renewal_id AND r.assigned_caller_id = app_current_user_id()))
     ))
);

-- ---- NOTIFICATIONS -----------------------------------------------------------
CREATE POLICY notifications_select ON notifications FOR SELECT USING (
  recipient_user_id = app_current_user_id()
  OR app_current_user_role() = 'super_admin'
);
CREATE POLICY notifications_update ON notifications FOR UPDATE USING (recipient_user_id = app_current_user_id());

-- =====================================================================================
-- 21. ILLUSTRATIVE HARD-DELETE EXCEPTION TABLE (not from frontend types — see rationale §8)
-- =====================================================================================
CREATE TABLE user_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
  -- Deliberately NO deleted_at / updated_at: sessions are transient, carry no audit or
  -- business value once expired, and are TRUE-DELETEd by a scheduled job:
  --   DELETE FROM user_sessions WHERE expires_at < now();
);
CREATE INDEX ix_user_sessions_user ON user_sessions (user_id);
CREATE INDEX ix_user_sessions_expiry ON user_sessions (expires_at);