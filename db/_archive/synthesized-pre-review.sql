-- =====================================================================================
-- MEDICAL CRM — CANONICAL POSTGRESQL SCHEMA (MERGED / PRODUCTION)
-- Target: PostgreSQL 15+
-- Synthesized from three independent design lenses: normalization/correctness,
-- scale/future-proofing, and security/performance. See trailing "MERGE DECISIONS &
-- CONFLICT RESOLUTIONS" notes (returned alongside this file) for why each disputed
-- point was resolved the way it was.
--
-- CONVENTIONS (applied uniformly across the whole schema)
--   * snake_case identifiers everywhere. Table names are PLURAL (users, leads, ...).
--   * Every primary key is `uuid DEFAULT gen_random_uuid()` (pgcrypto). Human-friendly
--     business keys (employee_id, order_number, sku) are separate UNIQUE constraints,
--     NEVER primary keys.
--   * Native PostgreSQL ENUM types are used for every closed, frontend-defined union
--     (roles/statuses/priorities/sources/types) instead of lookup tables — see
--     rationale note #1 for why this beat the lookup-table alternative here.
--   * timestamptz for every point-in-time column, including renewal/order "calendar"
--     dates — the client explicitly required timestamptz everywhere for future
--     multi-region correctness, so we do not use bare `date`/`timestamp` anywhere.
--   * NUMERIC(p,s) for all money. Never float/double precision.
--   * Every business table has created_at, updated_at (trigger-maintained) and a
--     nullable deleted_at (soft delete). The two deliberate, documented exceptions
--     are `sessions` (transient auth tokens — hard delete) and `audit_log` (a
--     write-once compliance ledger — mutating/soft-deleting it would defeat its
--     purpose). See rationale note #8.
--   * RLS is defense-in-depth alongside application-layer authorization. The app
--     connects through ONE pooled Postgres role (`app_user`), never as superuser and
--     never granted BYPASSRLS. Per-request identity travels in two transaction-local
--     GUCs set at the start of every transaction:
--       SELECT set_config('app.current_user_id', '<uuid>', true);
--       SELECT set_config('app.current_role',    '<super_admin|admin|caller>', true);
--     `true` (is_local) scopes the setting to the current transaction only, so it is
--     automatically cleared on COMMIT/ROLLBACK and never leaks across a pooled
--     connection (safe under PgBouncer transaction-pooling mode).
-- =====================================================================================


-- =====================================================================================
-- SECTION 0 — EXTENSIONS
-- =====================================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email without app-side lower()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram GIN indexes: fuzzy/partial phone & name search
-- pg_cron is assumed available on the managed instance (RDS/Cloud SQL/self-managed) for
-- scheduled partition creation and materialized-view refresh. If it is not installable
-- on your host, run the equivalent statements from an external scheduler instead
-- (systemd timer / Airflow / application cron). Commented invocations are included
-- inline near the features that need them; nothing below hard-depends on pg_cron.
-- CREATE EXTENSION IF NOT EXISTS pg_cron;


-- =====================================================================================
-- SECTION 1 — ENUM TYPES
-- Mirror the frontend TypeScript union types exactly (verbatim source of truth:
-- D:\work\crm\src\types\index.ts). Chosen over lookup tables for this schema — see
-- MERGE DECISIONS #1 for the justification and the trade-off being accepted.
-- =====================================================================================
CREATE TYPE user_role              AS ENUM ('super_admin','admin','caller');
CREATE TYPE user_status            AS ENUM ('active','inactive');

CREATE TYPE lead_status             AS ENUM (
  'new','contacted','follow_up_pending','interested','call_back_later',
  'no_response','not_interested','converted','closed'
);
CREATE TYPE lead_priority           AS ENUM ('low','medium','high','urgent');
CREATE TYPE lead_source             AS ENUM (
  'website','referral','walk_in','phone','social_media','advertisement','other'
);
CREATE TYPE lead_activity_type      AS ENUM (
  'call','comment','status_change','follow_up','assignment','created'
);

CREATE TYPE order_stage             AS ENUM (
  'lead','confirmed','medicine_prepared','packed','shipped','delivered'
);
CREATE TYPE payment_status          AS ENUM ('pending','partial','paid','refunded');

-- NOTE: renewal_status is NOT a column type anywhere — it is only the return type of
-- compute_renewal_status() and the derived column in renewals_view (SECTION 9). See
-- MERGE DECISIONS #4 for why this is never persisted.
CREATE TYPE renewal_status          AS ENUM ('upcoming','due_today','overdue','renewed');

CREATE TYPE followup_type           AS ENUM ('call','reminder','callback');
CREATE TYPE followup_status         AS ENUM ('pending','completed','missed');

CREATE TYPE notification_type       AS ENUM ('info','warning','success','error');
-- The four deep-link target entities named in the brief. Deliberately NOT a real FK
-- (Postgres cannot FK to "one of several tables") — see MERGE DECISIONS #6.
CREATE TYPE notification_entity_type AS ENUM ('lead','order','renewal','follow_up');

CREATE TYPE audit_action            AS ENUM ('INSERT','UPDATE','DELETE');


-- =====================================================================================
-- SECTION 2 — POOLED APPLICATION ROLE
-- One native Postgres role for the entire app tier. Per-CRM-user identity lives
-- entirely in the session GUCs (SECTION 0 header), never in native Postgres roles —
-- that is what makes RLS + FORCE ROW LEVEL SECURITY meaningful under connection
-- pooling. This role must NEVER be granted BYPASSRLS or SUPERUSER.
-- =====================================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'CHANGE_ME__store_in_secrets_manager';
  END IF;
END $$;
-- All migrations in this file run as the schema owner (a separate, non-application
-- role that DOES have the privileges to create extensions/roles/SECURITY DEFINER
-- functions). SECURITY DEFINER functions below (assigned_leads_count maintenance,
-- lead_assignments history, audit logging) must be OWNED by that schema-owner role,
-- not by app_user, so their internal writes bypass the calling session's row-level
-- restrictions on purpose (see MERGE DECISIONS #3/#7/#9) while app_user itself
-- remains fully RLS-bound for everything it does directly.


-- =====================================================================================
-- SECTION 3 — CORE ENTITY TABLES
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 3.1 users — CRM operator accounts (super_admin / admin / caller).
--     NOT the pharmacy customer identity — that is `customers` (SECTION 3.2).
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           text NOT NULL,                    -- human-friendly business key
  name                  text NOT NULL,
  phone                 text NOT NULL,
  email                 citext NOT NULL,
  password_hash         text NOT NULL,                     -- bcrypt/argon2 hash ONLY. Never plaintext.
  role                  user_role NOT NULL DEFAULT 'caller',
  status                user_status NOT NULL DEFAULT 'active',
  -- Trigger-maintained cache, never hand-set by application code. See MERGE DECISIONS #3.
  assigned_leads_count  integer NOT NULL DEFAULT 0,
  last_login_at         timestamptz,
  avatar_url            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_users_phone_format CHECK (phone ~ '^[0-9+ ()-]{7,15}$'),
  CONSTRAINT chk_users_assigned_leads_count_nonneg CHECK (assigned_leads_count >= 0)
);
COMMENT ON TABLE users IS 'CRM operator accounts. Field fidelity: employeeId->employee_id, assignedLeads->assigned_leads_count (now trigger-maintained, not hand-set), lastLogin->last_login_at, avatar->avatar_url, password->password_hash (hash, never plaintext).';
COMMENT ON COLUMN users.assigned_leads_count IS 'Denormalized, trigger-maintained cache (trg_maintain_assigned_leads_count). Never write to this column directly from application code. Reconciled nightly via v_lead_count_reconciliation (SECTION 9).';

-- Natural keys are UNIQUE, never PK, and only enforced among live rows so a
-- soft-deleted employee_id/email can legitimately be reused after genuine off-boarding.
CREATE UNIQUE INDEX ux_users_employee_id ON users (employee_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_users_email       ON users (email)       WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- 3.2 customers — the canonical identity (fixes frontend simplification #1).
--     A repeat customer (multiple leads/orders/renewals over time — the norm for
--     chronic-medication refills in pharma distribution) is now one row, not a
--     re-typed string on every record.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         text NOT NULL,
  primary_mobile    text NOT NULL,                 -- de-facto identity/dedupe key
  alternate_mobile  text,
  email             citext,
  address           text,
  city              text,
  state             text,
  pincode           text,
  doctor_name       text,                           -- most recent/primary prescribing doctor on file
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(full_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(primary_mobile, '') || ' ' || coalesce(alternate_mobile, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(city,'') || ' ' || coalesce(state,'') || ' ' || coalesce(pincode,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(doctor_name,'')), 'D')
  ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_customers_primary_mobile CHECK (primary_mobile ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT chk_customers_alternate_mobile CHECK (alternate_mobile IS NULL OR alternate_mobile ~ '^[0-9+ ()-]{7,15}$'),
  CONSTRAINT chk_customers_pincode CHECK (pincode IS NULL OR pincode ~ '^[0-9]{6}$')
);
COMMENT ON TABLE customers IS 'Canonical person/identity, decoupled from Lead/Order/Renewal so repeat customers are recognizable across records (fixes frontend simplification #1). Dedup key: primary_mobile, a 10-digit Indian mobile number.';

-- One live customer per mobile number — the pragmatic identity signal in this domain.
-- True fuzzy/near-duplicate merging (same person, two numbers) is a human "merge
-- customers" app operation (repoint FKs, soft-delete the loser), not a DB constraint.
CREATE UNIQUE INDEX ux_customers_primary_mobile ON customers (primary_mobile) WHERE deleted_at IS NULL;
CREATE INDEX ix_customers_city_state ON customers (city, state) WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- 3.3 products — medicine catalog/master (fixes frontend simplification #2).
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku           text NOT NULL,                 -- human-friendly business key
  generic_name  text NOT NULL,
  brand_name    text,
  strength      text,                          -- e.g. '500mg'
  dosage_form   text,                          -- e.g. 'tablet','syrup','injection'
  unit_price    numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  is_active     boolean NOT NULL DEFAULT true,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(generic_name,'') || ' ' || coalesce(brand_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(sku,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(strength,'') || ' ' || coalesce(dosage_form,'')), 'C')
  ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE products IS 'Medicine catalog. Replaces free-text medicine names on Order.medicines with a real, centrally-priced catalog referenced by FK (fixes frontend simplification #2).';

CREATE UNIQUE INDEX ux_products_sku ON products (sku) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_generic_name ON products (generic_name) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_active ON products (id) WHERE is_active AND deleted_at IS NULL;


-- =====================================================================================
-- SECTION 4 — DEPENDENT TABLES & PARTITIONS
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 4.1 leads
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable until the intake is matched to (or promoted into) a customer record.
  customer_id           uuid REFERENCES customers(id) ON DELETE SET NULL,

  -- "As captured" intake snapshot — kept even after customer_id is populated, since
  -- this is a point-in-time record of what the lead said (may legitimately differ
  -- from the canonical customer record, e.g. a different address for this occasion).
  customer_name         text NOT NULL,
  mobile                text NOT NULL,
  alternate_number      text,
  address               text NOT NULL,
  city                  text NOT NULL,
  state                 text NOT NULL,
  pincode               text NOT NULL,

  medicine_required     text NOT NULL,              -- free-text label, kept for display fidelity
  requested_product_id  uuid REFERENCES products(id) ON DELETE SET NULL,
  quantity              integer NOT NULL CHECK (quantity > 0),
  doctor_name           text,

  -- Live pointer ("who has this lead now"). History lives in lead_assignments
  -- (SECTION 4.3); this column is what RLS policies join against for speed.
  assigned_caller_id    uuid REFERENCES users(id) ON DELETE SET NULL,

  lead_source           lead_source NOT NULL DEFAULT 'other',
  priority              lead_priority NOT NULL DEFAULT 'medium',
  status                lead_status NOT NULL DEFAULT 'new',

  last_follow_up_at     timestamptz,
  next_follow_up_at     timestamptz,
  notes                 text,

  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(customer_name,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(mobile,'') || ' ' || coalesce(alternate_number,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(medicine_required,'') || ' ' || coalesce(doctor_name,'')), 'C') ||
    setweight(to_tsvector('simple', coalesce(city,'') || ' ' || coalesce(state,'') || ' ' || coalesce(notes,'')), 'D')
  ) STORED,

  created_at            timestamptz NOT NULL DEFAULT now(),   -- = frontend Lead.createdDate
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT chk_leads_pincode CHECK (pincode ~ '^[0-9]{6}$'),
  CONSTRAINT chk_leads_mobile  CHECK (mobile ~ '^[6-9][0-9]{9}$'),
  CONSTRAINT chk_leads_alternate_number CHECK (alternate_number IS NULL OR alternate_number ~ '^[0-9+ ()-]{7,15}$')
);
COMMENT ON TABLE leads IS 'Lead.createdDate maps to created_at (no separate business date). Lead.activities is now the child table lead_activities. Lead.assignedCaller is now assigned_caller_id (FK) with full reassignment history in lead_assignments.';


-- ---------------------------------------------------------------------------
-- 4.2 lead_activities — append-heavy timeline (frontend Lead.activities[]),
--     RANGE-partitioned by month on created_at.
-- ---------------------------------------------------------------------------
CREATE TABLE lead_activities (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  activity_type   lead_activity_type NOT NULL,
  description     text NOT NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- updated_at/deleted_at exist per the blanket "every table" rule, but no role
  -- (not even admin, via RLS in SECTION 10) is granted UPDATE/DELETE on this table
  -- in normal operation — it is an effectively-immutable timeline; corrections are
  -- made by inserting a new entry, not editing history. See MERGE DECISIONS #8.
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  PRIMARY KEY (id, created_at)          -- partition key must be part of every unique/PK index
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE lead_activities IS 'Fixes nothing structurally vs. the frontend shape, but gives it a real FK/type instead of raw string ids, and partitions it for scale.';


-- ---------------------------------------------------------------------------
-- 4.3 lead_assignments — reassignment audit trail (fixes frontend simplification #7).
--     Separate from the live pointer leads.assigned_caller_id. Volume is bounded by
--     reassignment EVENTS (far lower than lead_activities' per-interaction volume),
--     so it is NOT partitioned initially — can adopt the same monthly-partition
--     pattern later using the exact same ensure_monthly_partition() helper if
--     reassignment volume ever becomes activity-like.
-- ---------------------------------------------------------------------------
CREATE TABLE lead_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  caller_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assigned_by   uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = system-driven
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,      -- NULL while this is the CURRENT open assignment span
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_lead_assignments_period CHECK (unassigned_at IS NULL OR unassigned_at >= assigned_at)
);
COMMENT ON TABLE lead_assignments IS 'leads.assigned_caller_id is only the live pointer; this table answers "who had this lead, when, and why it changed" for accountability. Populated exclusively by trg_sync_lead_assignment_history — never written directly by the app.';

-- At most one OPEN (unassigned_at IS NULL) assignment span per lead at a time.
CREATE UNIQUE INDEX ux_lead_assignments_open ON lead_assignments (lead_id) WHERE unassigned_at IS NULL;


-- ---------------------------------------------------------------------------
-- 4.4 orders + order_items (fixes frontend simplification #2 — no embedded array).
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      text NOT NULL,                 -- human-friendly business key
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_name     text NOT NULL,                 -- point-in-time snapshot, trigger-synced from customers.full_name
  shipping_address  text NOT NULL,                 -- snapshot at order time; may differ from customer's current address
  -- Trigger-maintained from order_items (trg_order_items_update_total) — see
  -- MERGE DECISIONS #3 for why this mirrors the assigned_leads_count trade-off.
  total_amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  payment_status    payment_status NOT NULL DEFAULT 'pending',
  stage             order_stage NOT NULL DEFAULT 'lead',
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(order_number,'')), 'A') ||
    setweight(to_tsvector('simple', coalesce(customer_name,'')), 'B') ||
    setweight(to_tsvector('simple', coalesce(shipping_address,'')), 'D')
  ) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),  -- = frontend Order.createdDate
  updated_at        timestamptz NOT NULL DEFAULT now(),  -- = frontend Order.updatedDate
  deleted_at        timestamptz,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE orders IS 'Order.medicines[] is now order_items, a proper child table FK''d to products.';

CREATE UNIQUE INDEX ux_orders_order_number ON orders (order_number) WHERE deleted_at IS NULL;

CREATE TABLE order_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id              uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- Snapshot fields: an order line must remain historically accurate even if the
  -- product catalog entry is later renamed or repriced.
  medicine_name_snapshot  text NOT NULL,
  quantity                integer NOT NULL CHECK (quantity > 0),
  unit_price_snapshot     numeric(12,2) NOT NULL CHECK (unit_price_snapshot >= 0),
  line_total              numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price_snapshot) STORED,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz
);
COMMENT ON TABLE order_items IS 'line_total is safely a STORED generated column here (unlike renewal status) because quantity/unit_price_snapshot are immutable-at-write inputs from the same row, not a function of now().';


-- ---------------------------------------------------------------------------
-- 4.5 renewals (fixes frontend simplification #4 — no persisted derived state).
-- ---------------------------------------------------------------------------
CREATE TABLE renewals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name      text NOT NULL,      -- point-in-time snapshot, trigger-synced from customers.full_name
  order_id           uuid REFERENCES orders(id) ON DELETE SET NULL,
  product_id         uuid REFERENCES products(id) ON DELETE SET NULL,
  medicine_name      text NOT NULL,      -- legacy/display label, kept in sync with product_id when set
  order_date         timestamptz NOT NULL,
  renewal_date       timestamptz NOT NULL,   -- when the caller should reach out (reminder point)
  expiry_date        timestamptz NOT NULL,   -- when the customer's medicine supply actually runs out
  assigned_caller_id uuid REFERENCES users(id) ON DELETE SET NULL,
  renewed_at         timestamptz,        -- the one persisted FACT; everything else is derived (SECTION 9)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_renewals_dates CHECK (expiry_date >= order_date AND renewal_date >= order_date)
);
COMMENT ON TABLE renewals IS 'daysRemaining/status are intentionally NOT columns here — see renewals_view + compute_renewal_status() in SECTION 9, and MERGE DECISIONS #4.';

CREATE INDEX ix_renewals_expiry_pending ON renewals (expiry_date) WHERE deleted_at IS NULL AND renewed_at IS NULL;
CREATE INDEX ix_renewals_renewal_date_pending ON renewals (renewal_date) WHERE deleted_at IS NULL AND renewed_at IS NULL;


-- ---------------------------------------------------------------------------
-- 4.6 follow_ups (fixes frontend simplification #8 — the "smuggle a renewal id
--     into FollowUp.leadId" hack). customer_id is required; lead_id/renewal_id
--     are optional context.
-- ---------------------------------------------------------------------------
CREATE TABLE follow_ups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name      text NOT NULL,      -- point-in-time snapshot, trigger-synced from customers.full_name
  lead_id            uuid REFERENCES leads(id) ON DELETE SET NULL,
  renewal_id         uuid REFERENCES renewals(id) ON DELETE SET NULL,
  -- Denormalized from lead_id/renewal_id (or set directly for a customer-only
  -- follow-up with no lead/renewal context). Backed by trg_sync_followup_caller;
  -- exists so RLS can filter with a single indexed equality instead of a join,
  -- and so a customer-only follow-up still has an unambiguous owner.
  assigned_caller_id uuid REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at       timestamptz NOT NULL,
  type               followup_type NOT NULL,
  status             followup_status NOT NULL DEFAULT 'pending',
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL
);
COMMENT ON TABLE follow_ups IS 'Replaces the frontend hack of stuffing a renewal id into FollowUp.leadId. A follow-up always has a real customer anchor plus optional lead/renewal context for deep-linking.';


-- ---------------------------------------------------------------------------
-- 4.7 notifications (fixes frontend simplification #6 — recipient scoping),
--     RANGE-partitioned by month on created_at.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  recipient_user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                text NOT NULL,
  message              text NOT NULL,
  type                 notification_type NOT NULL DEFAULT 'info',
  is_read              boolean NOT NULL DEFAULT false,
  read_at              timestamptz,        -- auto-set by trg_notifications_read_at when is_read flips to true
  -- Polymorphic deep-link target for the UI. Postgres cannot enforce a real FK across
  -- multiple possible parent tables; integrity here is app-layer + the shape CHECK
  -- below. See MERGE DECISIONS #6.
  related_entity_type  notification_entity_type,
  related_entity_id    uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CONSTRAINT chk_notifications_entity_pair
    CHECK ((related_entity_type IS NULL) = (related_entity_id IS NULL)),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE notifications IS 'Every notification is scoped to recipient_user_id (fixes frontend simplification #6 — mock notifications were global with no recipient).';


-- ---------------------------------------------------------------------------
-- 4.8 audit_log — compliance trail, RANGE-partitioned by month on changed_at.
--     Deliberate second exception to "every table gets updated_at/deleted_at":
--     a mutable or soft-deletable audit ledger is a contradiction in terms. See
--     MERGE DECISIONS #8.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  table_name    text NOT NULL,
  record_id     uuid NOT NULL,
  action        audit_action NOT NULL,
  changed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  old_data      jsonb,
  new_data      jsonb,
  PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);
COMMENT ON TABLE audit_log IS 'Populated exclusively by the SECURITY DEFINER log_audit() trigger. No application-level INSERT/UPDATE/DELETE policy is ever granted (SECTION 10) — this is the one table application code writes to only indirectly.';


-- ---------------------------------------------------------------------------
-- 4.9 sessions — the ONE table where hard delete is correct (not derived from
--     any frontend type; concrete instance of the "rare case" the brief asked
--     for). Auth/session tokens are transient and carry zero audit/business
--     value after expiry — soft-deleting them would only bloat an
--     already-high-churn table for no compliance benefit.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
  -- Deliberately NO updated_at/deleted_at. True hard DELETE on logout/expiry:
  --   DELETE FROM sessions WHERE expires_at < now();
);


-- =====================================================================================
-- SECTION 5 — PARTITION BOOTSTRAP & MAINTENANCE
-- =====================================================================================

CREATE OR REPLACE FUNCTION ensure_monthly_partition(p_parent text, p_month date)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('%s_%s', p_parent, to_char(v_start, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
      v_name, p_parent, v_start, v_end
    );
  END IF;
END;
$$;
COMMENT ON FUNCTION ensure_monthly_partition IS 'Idempotent monthly RANGE partition creator for lead_activities/notifications/audit_log. Safe to call repeatedly (e.g. from pg_cron).';

-- Bootstrap a rolling window: 2 months back through 12 months forward, for each
-- partitioned table. In production, automate ongoing creation via pg_cron (example
-- below) or pg_partman once hand-rolled partition management becomes error-prone.
DO $$
DECLARE d date;
BEGIN
  FOR d IN
    SELECT generate_series(date_trunc('month', now()) - interval '2 months',
                            date_trunc('month', now()) + interval '12 months',
                            interval '1 month')::date
  LOOP
    PERFORM ensure_monthly_partition('lead_activities', d);
    PERFORM ensure_monthly_partition('notifications',   d);
    PERFORM ensure_monthly_partition('audit_log',       d);
  END LOOP;
END $$;

-- Catch-all partitions: if the scheduled partition-creation job ever lags, inserts
-- land here instead of erroring out (then get manually redistributed later).
CREATE TABLE IF NOT EXISTS lead_activities_default PARTITION OF lead_activities DEFAULT;
CREATE TABLE IF NOT EXISTS notifications_default   PARTITION OF notifications   DEFAULT;
CREATE TABLE IF NOT EXISTS audit_log_default       PARTITION OF audit_log       DEFAULT;

-- Recurring maintenance (requires pg_cron): create next month's partitions on the 25th.
-- SELECT cron.schedule('ensure-future-partitions', '0 2 25 * *', $$
--   SELECT ensure_monthly_partition('lead_activities', (date_trunc('month', now()) + interval '1 month')::date);
--   SELECT ensure_monthly_partition('notifications',   (date_trunc('month', now()) + interval '1 month')::date);
--   SELECT ensure_monthly_partition('audit_log',       (date_trunc('month', now()) + interval '1 month')::date);
-- $$);

-- Retention/archival: this function only REPORTS candidate partitions old enough to
-- archive; it never drops anything itself. The actual data movement (COPY/export to
-- S3/Azure Blob as Parquet) must run as an external job with its own credentials and
-- retry logic, and must be verified successful BEFORE the operator runs
-- `ALTER TABLE ... DETACH PARTITION CONCURRENTLY` followed by `DROP TABLE`. Suggested
-- retention: lead_activities/notifications 24 months live before archive+drop;
-- audit_log 7 years live (regulated medical-distribution compliance) before archiving.
CREATE OR REPLACE FUNCTION list_droppable_partitions(p_parent text, p_retain_months int)
RETURNS TABLE(partition_name text, partition_upper_bound date) LANGUAGE plpgsql AS $$
DECLARE
  v_cutoff date := (date_trunc('month', now()) - (p_retain_months || ' months')::interval)::date;
BEGIN
  RETURN QUERY
  SELECT c.relname::text,
         (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([0-9-]+)'''))[1]::date
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = p_parent
    AND c.relname <> p_parent || '_default'
    AND (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([0-9-]+)'''))[1]::date <= v_cutoff;
END;
$$;
COMMENT ON FUNCTION list_droppable_partitions IS 'Reports archival candidates only. Usage: SELECT * FROM list_droppable_partitions(''lead_activities'', 24); then externally: export -> ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY -> DROP TABLE.';


-- =====================================================================================
-- SECTION 6 — INDEXES
-- Indexes declared on a partitioned parent (PG11+) are automatically created on every
-- existing AND future partition, so lead_activities/notifications/audit_log indexes
-- below are declared once on the parent.
-- =====================================================================================

-- 6.1 users
CREATE INDEX ix_users_role_status ON users (role, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_users_phone ON users (phone);

-- 6.2 customers
CREATE INDEX ix_customers_mobile_trgm ON customers USING GIN (primary_mobile gin_trgm_ops);
CREATE INDEX ix_customers_name_trgm ON customers USING GIN (full_name gin_trgm_ops);
CREATE INDEX ix_customers_search ON customers USING GIN (search_vector);

-- 6.3 products
CREATE INDEX ix_products_search ON products USING GIN (search_vector);

-- 6.4 leads — FKs + every commonly filtered/sorted UI column
CREATE INDEX ix_leads_customer_id ON leads (customer_id);
CREATE INDEX ix_leads_requested_product_id ON leads (requested_product_id);
CREATE INDEX ix_leads_assigned_caller ON leads (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_status ON leads (status) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_priority ON leads (priority) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_created_at ON leads (created_at DESC);
CREATE INDEX ix_leads_next_follow_up ON leads (next_follow_up_at) WHERE deleted_at IS NULL AND next_follow_up_at IS NOT NULL;
-- "Open leads" dashboard tab — heavily hit, small hot subset:
CREATE INDEX ix_leads_open ON leads (assigned_caller_id, priority)
  WHERE deleted_at IS NULL AND status NOT IN ('converted','closed','not_interested');
CREATE INDEX ix_leads_mobile_trgm ON leads USING GIN (mobile gin_trgm_ops);
CREATE INDEX ix_leads_search ON leads USING GIN (search_vector);

-- 6.5 lead_activities (propagates to all partitions)
CREATE INDEX ix_lead_activities_lead_id_created_at ON lead_activities (lead_id, created_at DESC);
CREATE INDEX ix_lead_activities_created_by ON lead_activities (created_by);

-- 6.6 lead_assignments
CREATE INDEX ix_lead_assignments_lead_id ON lead_assignments (lead_id, assigned_at DESC);
CREATE INDEX ix_lead_assignments_caller_id ON lead_assignments (caller_id);

-- 6.7 orders
CREATE INDEX ix_orders_customer_id ON orders (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_lead_id ON orders (lead_id);
CREATE INDEX ix_orders_stage ON orders (stage) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_payment_status ON orders (payment_status) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_created_at ON orders (created_at DESC);
CREATE INDEX ix_orders_search ON orders USING GIN (search_vector);

-- 6.8 order_items
CREATE INDEX ix_order_items_order_id ON order_items (order_id);
CREATE INDEX ix_order_items_product_id ON order_items (product_id);

-- 6.9 renewals
CREATE INDEX ix_renewals_customer_id ON renewals (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_renewals_assigned_caller ON renewals (assigned_caller_id) WHERE deleted_at IS NULL;

-- 6.10 follow_ups
CREATE INDEX ix_follow_ups_customer_id ON follow_ups (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_follow_ups_lead_id ON follow_ups (lead_id);
CREATE INDEX ix_follow_ups_renewal_id ON follow_ups (renewal_id);
CREATE INDEX ix_follow_ups_assigned_caller ON follow_ups (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_follow_ups_pending ON follow_ups (scheduled_at) WHERE status = 'pending' AND deleted_at IS NULL;

-- 6.11 notifications (propagates to all partitions)
CREATE INDEX ix_notifications_recipient_unread ON notifications (recipient_user_id, created_at DESC) WHERE NOT is_read;
CREATE INDEX ix_notifications_recipient ON notifications (recipient_user_id, created_at DESC);
CREATE INDEX ix_notifications_entity ON notifications (related_entity_type, related_entity_id);

-- 6.12 audit_log (propagates to all partitions)
CREATE INDEX ix_audit_log_table_record ON audit_log (table_name, record_id, changed_at DESC);
CREATE INDEX ix_audit_log_changed_by ON audit_log (changed_by);

-- 6.13 sessions
CREATE INDEX ix_sessions_user_id ON sessions (user_id);
CREATE INDEX ix_sessions_expires_at ON sessions (expires_at);


-- =====================================================================================
-- SECTION 7 — TRIGGERS AND FUNCTIONS
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 7.1 Generic helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- RLS session-context helpers. STABLE (not IMMUTABLE) because current_setting()
-- can change within a session across transactions.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_role', true), '');
$$;

CREATE OR REPLACE FUNCTION is_super_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app_current_role() = 'super_admin'; $$;

CREATE OR REPLACE FUNCTION is_admin_or_above() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT app_current_role() IN ('super_admin','admin'); $$;

-- ---------------------------------------------------------------------------
-- 7.2 updated_at wiring — every table that has the column (all except sessions,
--     which has none, per MERGE DECISIONS #8).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','customers','products','leads','lead_activities','lead_assignments',
    'orders','order_items','renewals','follow_ups','notifications'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t
    );
  END LOOP;
END $$;
-- audit_log intentionally excluded (write-once ledger, no updated_at column at all).


-- ---------------------------------------------------------------------------
-- 7.3 assigned_leads_count maintenance (fixes frontend simplification #3).
--     SECURITY DEFINER: a caller updating a lead they own must be able to
--     decrement/increment counts on OTHER users' rows (e.g. reassignment by an
--     admin touching a caller's own transaction context), which the invoking
--     session's RLS policy on `users` would otherwise forbid. Owned by the
--     schema-owner role (BYPASSRLS), never by app_user.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION maintain_assigned_leads_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_caller_id IS NOT NULL AND NEW.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    DECLARE
      old_counted boolean := (OLD.assigned_caller_id IS NOT NULL AND OLD.deleted_at IS NULL);
      new_counted boolean := (NEW.assigned_caller_id IS NOT NULL AND NEW.deleted_at IS NULL);
    BEGIN
      IF old_counted AND (NOT new_counted OR OLD.assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id) THEN
        UPDATE users SET assigned_leads_count = GREATEST(assigned_leads_count - 1, 0) WHERE id = OLD.assigned_caller_id;
      END IF;
      IF new_counted AND (NOT old_counted OR OLD.assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id) THEN
        UPDATE users SET assigned_leads_count = assigned_leads_count + 1 WHERE id = NEW.assigned_caller_id;
      END IF;
    END;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.assigned_caller_id IS NOT NULL AND OLD.deleted_at IS NULL THEN
      UPDATE users SET assigned_leads_count = GREATEST(assigned_leads_count - 1, 0) WHERE id = OLD.assigned_caller_id;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_maintain_assigned_leads_count
AFTER INSERT OR UPDATE OF assigned_caller_id, deleted_at OR DELETE ON leads
FOR EACH ROW EXECUTE FUNCTION maintain_assigned_leads_count();


-- ---------------------------------------------------------------------------
-- 7.4 lead_assignments history sync (fixes frontend simplification #7).
--     SECURITY DEFINER for the same cross-row-write reason as 7.3.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_lead_assignment_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_caller_id IS NOT NULL THEN
      INSERT INTO lead_assignments (lead_id, caller_id, assigned_by, assigned_at)
      VALUES (NEW.id, NEW.assigned_caller_id, app_current_user_id(), now());
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.assigned_caller_id IS DISTINCT FROM OLD.assigned_caller_id THEN
    IF OLD.assigned_caller_id IS NOT NULL THEN
      UPDATE lead_assignments
        SET unassigned_at = now()
        WHERE lead_id = NEW.id AND caller_id = OLD.assigned_caller_id AND unassigned_at IS NULL;
    END IF;
    IF NEW.assigned_caller_id IS NOT NULL THEN
      INSERT INTO lead_assignments (lead_id, caller_id, assigned_by, assigned_at)
      VALUES (NEW.id, NEW.assigned_caller_id, app_current_user_id(), now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_lead_assignment_history
AFTER INSERT OR UPDATE OF assigned_caller_id ON leads
FOR EACH ROW EXECUTE FUNCTION sync_lead_assignment_history();


-- ---------------------------------------------------------------------------
-- 7.5 leads lifecycle guard — callers may update leads assigned to them
--     (status/notes/follow-up scheduling) but must not be able to reassign a
--     lead away from themselves (already blocked by the RLS WITH CHECK on
--     leads_update in SECTION 10) or soft-delete/undelete it (not blocked by
--     RLS alone, since RLS cannot compare OLD.deleted_at vs NEW.deleted_at).
--     Complements RLS the same way trg_prevent_privilege_escalation (7.7) does
--     for users.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_caller_lead_lifecycle_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_role() = 'caller' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'callers may not soft-delete or restore leads';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leads_prevent_caller_lifecycle_changes
BEFORE UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION prevent_caller_lead_lifecycle_changes();


-- ---------------------------------------------------------------------------
-- 7.6 follow_ups.assigned_caller_id sync. Deliberately NOT SECURITY DEFINER:
--     it must run under the calling session's own RLS view of leads/renewals,
--     so a caller attempting to attach a follow-up to another caller's lead_id
--     simply fails to resolve an assigned_caller_id (the lookup SELECT sees no
--     row under RLS) and the subsequent RLS WITH CHECK on follow_ups then
--     rejects the insert. This is intentional defense-in-depth, not a bug.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_followup_assigned_caller() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_caller_id IS NULL THEN
    IF NEW.lead_id IS NOT NULL THEN
      SELECT assigned_caller_id INTO NEW.assigned_caller_id FROM leads WHERE id = NEW.lead_id;
    ELSIF NEW.renewal_id IS NOT NULL THEN
      SELECT assigned_caller_id INTO NEW.assigned_caller_id FROM renewals WHERE id = NEW.renewal_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_followup_caller
BEFORE INSERT OR UPDATE OF lead_id, renewal_id ON follow_ups
FOR EACH ROW EXECUTE FUNCTION sync_followup_assigned_caller();


-- ---------------------------------------------------------------------------
-- 7.7 customer_name snapshot sync — reused across orders, renewals, follow_ups.
--     Point-in-time snapshot (frozen at link time), not kept live afterwards —
--     mirrors the order_items medicine_name_snapshot rationale.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_customer_name_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
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

CREATE TRIGGER trg_follow_ups_customer_name_sync
BEFORE INSERT OR UPDATE OF customer_id ON follow_ups
FOR EACH ROW EXECUTE FUNCTION sync_customer_name_snapshot();


-- ---------------------------------------------------------------------------
-- 7.8 order_items -> orders.total_amount maintenance (mirrors the
--     assigned_leads_count trade-off: fast reads for the order list UI,
--     correctness enforced by trigger instead of the app summing on every write).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_order_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id uuid := COALESCE(NEW.order_id, OLD.order_id);
BEGIN
  UPDATE orders o
  SET total_amount = COALESCE((
    SELECT SUM(line_total) FROM order_items oi
    WHERE oi.order_id = v_order_id AND oi.deleted_at IS NULL
  ), 0)
  WHERE o.id = v_order_id;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_order_items_update_total
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION update_order_total();


-- ---------------------------------------------------------------------------
-- 7.9 notifications.read_at auto-set when is_read flips to true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_notification_read_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_read AND NOT OLD.is_read AND NEW.read_at IS NULL THEN
    NEW.read_at := now();
  ELSIF NOT NEW.is_read THEN
    NEW.read_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notifications_read_at
BEFORE UPDATE OF is_read ON notifications
FOR EACH ROW EXECUTE FUNCTION set_notification_read_at();


-- ---------------------------------------------------------------------------
-- 7.10 users privilege-escalation guard. RLS filters/validates whole ROWS; it
--      cannot compare OLD.role vs NEW.role for an UPDATE (USING sees the
--      pre-image, WITH CHECK the post-image, never both at once). This
--      BEFORE UPDATE trigger does that OLD-vs-NEW comparison — defense in
--      depth alongside the row-level RLS policies in SECTION 10.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_privilege_escalation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;  -- super_admin: full access to everything, no restriction here.
  END IF;

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


-- ---------------------------------------------------------------------------
-- 7.11 Generic audit-log writer. SECURITY DEFINER (owned by the schema-owner
--      role with BYPASSRLS) so it can always insert into audit_log even though
--      no application role is ever granted INSERT on that table directly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    TG_OP::audit_action,
    app_current_user_id(),
    now(),
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
    'users','customers','products','leads','orders','order_items','renewals',
    'follow_ups','lead_assignments'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_audit AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION log_audit();',
      t
    );
  END LOOP;
END $$;
-- lead_activities/notifications are themselves append-only logs — auditing a log is
-- redundant churn, so no audit trigger is attached to them. audit_log obviously does
-- not audit itself.


-- =====================================================================================
-- SECTION 8 — VIEWS & MATERIALIZED VIEWS (derived/computed state, never
-- persisted redundantly)
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 8.1 renewals_view — computes daysRemaining/status at query time
--     (fixes frontend simplification #4). A plain view, not a generated column
--     and not a materialized view: both depend on "now", which is not
--     IMMUTABLE (STORED GENERATED requires IMMUTABLE), and a materialized
--     snapshot could show an already-expired renewal as "upcoming" until
--     refreshed — unacceptable for a caller deciding who to call today. A
--     plain view also re-checks RLS on the base table on every call, so a
--     caller's renewal visibility restrictions are never weakened by this view.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compute_renewal_status(p_renewal_date timestamptz, p_expiry_date timestamptz, p_renewed_at timestamptz)
RETURNS renewal_status LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_renewed_at IS NOT NULL THEN 'renewed'::renewal_status
    WHEN p_expiry_date::date  < CURRENT_DATE THEN 'overdue'::renewal_status
    WHEN p_renewal_date::date <= CURRENT_DATE THEN 'due_today'::renewal_status
    ELSE 'upcoming'::renewal_status
  END;
$$;

CREATE OR REPLACE VIEW renewals_view AS
SELECT
  r.*,
  (r.expiry_date::date - CURRENT_DATE) AS days_remaining,   -- negative = N days overdue
  compute_renewal_status(r.renewal_date, r.expiry_date, r.renewed_at) AS status
FROM renewals r
WHERE r.deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- 8.2 global_search — backs the frontend's global search bar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW global_search AS
SELECT 'customer'::text AS entity_type, c.id AS entity_id, c.full_name AS label, c.search_vector
FROM customers c WHERE c.deleted_at IS NULL
UNION ALL
SELECT 'lead', l.id, l.customer_name, l.search_vector
FROM leads l WHERE l.deleted_at IS NULL
UNION ALL
SELECT 'order', o.id, o.order_number, o.search_vector
FROM orders o WHERE o.deleted_at IS NULL
UNION ALL
SELECT 'product', p.id, coalesce(p.brand_name, p.generic_name), p.search_vector
FROM products p WHERE p.deleted_at IS NULL;

COMMENT ON VIEW global_search IS 'Usage: SELECT entity_type, entity_id, label FROM global_search WHERE search_vector @@ websearch_to_tsquery(''simple'', :q) ORDER BY ts_rank(search_vector, websearch_to_tsquery(''simple'', :q)) DESC LIMIT 20. Being a plain view over RLS-protected base tables, a caller''s search never surfaces another caller''s leads/orders. Graduation note: this comfortably serves up to low-tens-of-millions of rows. Graduate to a dedicated search engine (OpenSearch/Elasticsearch/Meilisearch/Typesense) once the team needs typo-tolerant fuzzy ranking beyond pg_trgm/tsvector, multi-language stemming, faceted filter+relevance UIs, or search QPS competing with OLTP write load.';


-- ---------------------------------------------------------------------------
-- 8.3 Reconciliation view for assigned_leads_count — run on a schedule
--     (e.g. nightly) as a correctness tripwire. If it ever returns rows,
--     that is a bug alert, never a source of truth the app reads from.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_lead_count_reconciliation AS
SELECT u.id AS user_id, u.name, u.assigned_leads_count AS stored_count,
       COUNT(l.id) FILTER (WHERE l.deleted_at IS NULL) AS actual_count
FROM users u
LEFT JOIN leads l ON l.assigned_caller_id = u.id
GROUP BY u.id, u.name, u.assigned_leads_count
HAVING u.assigned_leads_count <> COUNT(l.id) FILTER (WHERE l.deleted_at IS NULL);


-- ---------------------------------------------------------------------------
-- 8.4 Materialized dashboard aggregates. These intentionally bypass per-row
--     RLS (materialized views cannot carry policies) because they expose only
--     aggregate counts, never individual lead/customer rows. Grant SELECT to
--     admin/super_admin only at the application layer — never query them on
--     behalf of a caller session.
-- ---------------------------------------------------------------------------
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
  count(l.id) AS total_assigned_leads,
  count(l.id) FILTER (WHERE l.status = 'converted') AS converted_leads,
  ROUND(
    count(l.id) FILTER (WHERE l.status = 'converted')::numeric / NULLIF(count(l.id), 0), 4
  ) AS conversion_rate,
  count(l.id) FILTER (WHERE l.status NOT IN ('converted','closed','not_interested')) AS open_leads,
  count(f.id) FILTER (WHERE f.status = 'pending' AND f.scheduled_at < now()) AS overdue_follow_ups,
  ROUND(
    AVG(EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400.0)
      FILTER (WHERE l.status = 'converted'), 2
  ) AS avg_days_to_convert
FROM users u
LEFT JOIN leads l ON l.assigned_caller_id = u.id AND l.deleted_at IS NULL
LEFT JOIN follow_ups f ON f.assigned_caller_id = u.id AND f.deleted_at IS NULL
WHERE u.role = 'caller' AND u.deleted_at IS NULL
GROUP BY u.id, u.name
WITH NO DATA;

CREATE UNIQUE INDEX ux_mv_caller_performance ON mv_caller_performance (caller_id);

-- Initial population (run once after creation, before first use):
--   REFRESH MATERIALIZED VIEW mv_lead_status_breakdown;
--   REFRESH MATERIALIZED VIEW mv_caller_performance;
-- Refresh strategy: schedule via pg_cron every 5-10 minutes, CONCURRENTLY (requires the
-- unique indexes above; avoids locking readers out during refresh):
--   SELECT cron.schedule('refresh_crm_dashboards', '*/10 * * * *', $$
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown;
--     REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance;
--   $$);
-- A 5-10 minute staleness window is acceptable for dashboard KPI tiles. If the business
-- later needs near-real-time counts, switch to a debounced LISTEN/NOTIFY-triggered
-- refresh fired from the leads/follow_ups triggers instead of polling on a timer.


-- =====================================================================================
-- SECTION 9 — ROW LEVEL SECURITY
-- Every table: ENABLE + FORCE ROW LEVEL SECURITY, so even the table owner is bound by
-- policy unless it explicitly holds BYPASSRLS (which app_user never does). super_admin
-- is given unconditional full access on every table per the explicit requirement
-- ("Super Admin: full access to everything, all tables, all rows").
-- =====================================================================================

-- ---- users ------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users FOR SELECT
USING (
  is_super_admin()
  OR (app_current_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_role() = 'caller' AND id = app_current_user_id())
);

CREATE POLICY users_insert ON users FOR INSERT
WITH CHECK (
  is_super_admin()
  OR (app_current_role() = 'admin' AND role = 'caller')      -- admin can only create callers
);

CREATE POLICY users_update ON users FOR UPDATE
USING (
  is_super_admin()
  OR (app_current_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_role() = 'caller' AND id = app_current_user_id())
)
WITH CHECK (
  is_super_admin()
  OR (app_current_role() = 'admin'  AND (role = 'caller' OR id = app_current_user_id()))
  OR (app_current_role() = 'caller' AND id = app_current_user_id())
);
-- Column-level restriction (caller can't touch own role/status/employee_id; admin
-- can't touch other admins or grant admin/super_admin) is enforced by
-- trg_prevent_privilege_escalation (SECTION 7.10) — RLS alone cannot compare
-- OLD vs NEW columns.

CREATE POLICY users_delete ON users FOR DELETE
USING (is_super_admin());
-- Hard delete is super_admin-only and rare (e.g. legal erasure). Ordinary
-- deactivation is a soft-delete/status UPDATE, already governed above.

-- ---- customers ----------------------------------------------------------------------
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

CREATE POLICY customers_select ON customers FOR SELECT
USING (
  is_admin_or_above()
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller_id = app_current_user_id()
      UNION ALL
        SELECT 1 FROM renewals r WHERE r.customer_id = customers.id AND r.assigned_caller_id = app_current_user_id()
      UNION ALL
        SELECT 1 FROM follow_ups f WHERE f.customer_id = customers.id AND f.assigned_caller_id = app_current_user_id()
     ))
);

CREATE POLICY customers_insert ON customers FOR INSERT
WITH CHECK (app_current_role() IN ('super_admin','admin','caller'));
-- Callers may create a brand-new customer record while converting/intaking their own lead.

CREATE POLICY customers_update ON customers FOR UPDATE
USING (
  is_admin_or_above()
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller_id = app_current_user_id()
     ))
)
WITH CHECK (
  is_admin_or_above()
  OR (app_current_role() = 'caller' AND EXISTS (
        SELECT 1 FROM leads l WHERE l.customer_id = customers.id AND l.assigned_caller_id = app_current_user_id()
     ))
);

CREATE POLICY customers_delete ON customers FOR DELETE USING (is_admin_or_above());

-- ---- products (catalog data, no PII; readable by every authenticated role) -----------
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;

CREATE POLICY products_select ON products FOR SELECT USING (app_current_role() IS NOT NULL);
CREATE POLICY products_insert ON products FOR INSERT WITH CHECK (is_admin_or_above());
CREATE POLICY products_update ON products FOR UPDATE USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());
CREATE POLICY products_delete ON products FOR DELETE USING (is_admin_or_above());

-- ---- leads ----------------------------------------------------------------------------
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;

CREATE POLICY leads_select ON leads FOR SELECT
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

CREATE POLICY leads_insert ON leads FOR INSERT
WITH CHECK (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

CREATE POLICY leads_update ON leads FOR UPDATE
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id())
WITH CHECK (is_admin_or_above() OR assigned_caller_id = app_current_user_id());
-- A caller cannot use this policy to reassign a lead to someone else: WITH CHECK
-- re-evaluates assigned_caller_id = app_current_user_id() against the NEW row too,
-- so setting assigned_caller_id to a different caller (or NULL) fails the check
-- unless an admin/super_admin performs it. trg_leads_prevent_caller_lifecycle_changes
-- additionally blocks a caller from toggling deleted_at.

CREATE POLICY leads_delete ON leads FOR DELETE USING (is_admin_or_above());

-- ---- lead_activities: visibility/writes inherited via parent lead --------------------
ALTER TABLE lead_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_activities_select ON lead_activities FOR SELECT
USING (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller_id = app_current_user_id())
);

CREATE POLICY lead_activities_insert ON lead_activities FOR INSERT
WITH CHECK (
  is_admin_or_above()
  OR EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_activities.lead_id AND l.assigned_caller_id = app_current_user_id())
);
-- No UPDATE/DELETE policy for 'caller' or 'admin': the timeline is append-only by
-- design (audit integrity of the interaction history). Only super_admin may correct it.
CREATE POLICY lead_activities_update ON lead_activities FOR UPDATE USING (is_super_admin());
CREATE POLICY lead_activities_delete ON lead_activities FOR DELETE USING (is_super_admin());

-- ---- lead_assignments: system-populated only; read access mirrors ownership --------
ALTER TABLE lead_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_assignments_select ON lead_assignments FOR SELECT
USING (is_admin_or_above() OR caller_id = app_current_user_id());
-- No INSERT/UPDATE/DELETE policy for ANY app role — rows are written only by
-- trg_sync_lead_assignment_history (SECURITY DEFINER), never directly by the app.

-- ---- orders / order_items: callers get READ-ONLY visibility into orders tied to
-- their own assigned leads (per the brief: "orders ... tied to a lead not assigned
-- to them should be invisible"); writes are reserved for admin/super_admin, since
-- order lifecycle management is not among the caller capabilities enumerated in the
-- brief (only "leads, comments/activities, follow-ups" are). Orders with no lead_id
-- are, by this rule, invisible to callers by default — a deliberate, conservative
-- choice, easy to loosen later if the product requires caller-initiated orders. ------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY orders_select ON orders FOR SELECT
USING (
  is_admin_or_above()
  OR (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = orders.lead_id AND l.assigned_caller_id = app_current_user_id()))
);
CREATE POLICY orders_insert ON orders FOR INSERT WITH CHECK (is_admin_or_above());
CREATE POLICY orders_update ON orders FOR UPDATE USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());
CREATE POLICY orders_delete ON orders FOR DELETE USING (is_admin_or_above());

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;

CREATE POLICY order_items_select ON order_items FOR SELECT
USING (
  is_admin_or_above()
  OR EXISTS (
       SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
       WHERE o.id = order_items.order_id AND l.assigned_caller_id = app_current_user_id()
     )
);
CREATE POLICY order_items_insert ON order_items FOR INSERT WITH CHECK (is_admin_or_above());
CREATE POLICY order_items_update ON order_items FOR UPDATE USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());
CREATE POLICY order_items_delete ON order_items FOR DELETE USING (is_admin_or_above());

-- ---- renewals: caller sees/manages only renewals directly assigned to them ---------
ALTER TABLE renewals ENABLE ROW LEVEL SECURITY;
ALTER TABLE renewals FORCE ROW LEVEL SECURITY;

CREATE POLICY renewals_select ON renewals FOR SELECT
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id());
CREATE POLICY renewals_insert ON renewals FOR INSERT WITH CHECK (is_admin_or_above());
CREATE POLICY renewals_update ON renewals FOR UPDATE USING (is_admin_or_above()) WITH CHECK (is_admin_or_above());
CREATE POLICY renewals_delete ON renewals FOR DELETE USING (is_admin_or_above());
-- Renewal creation/lifecycle is an admin/super_admin operation (schedule generation
-- from order history); callers only action them, hence no caller INSERT here — they
-- read the renewals assigned to them and act via follow_ups (below).

-- ---- follow_ups: callers may fully manage follow-ups tied to their own leads/
-- renewals/customers — this IS an explicit caller capability in the brief
-- ("schedule follow-ups on those leads"). -------------------------------------------
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups FORCE ROW LEVEL SECURITY;

CREATE POLICY follow_ups_select ON follow_ups FOR SELECT
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

CREATE POLICY follow_ups_insert ON follow_ups FOR INSERT
WITH CHECK (
  is_admin_or_above()
  OR assigned_caller_id = app_current_user_id()
  -- assigned_caller_id may still be NULL at the moment WITH CHECK evaluates only if
  -- trg_sync_followup_caller (a BEFORE trigger) could not resolve it — e.g. a caller
  -- pointed lead_id/renewal_id at a lead/renewal not their own, so the trigger's own
  -- RLS-scoped lookup returned nothing. In that case assigned_caller_id stays NULL,
  -- fails this check, and the insert is correctly rejected.
);

CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id())
WITH CHECK (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

CREATE POLICY follow_ups_delete ON follow_ups FOR DELETE USING (is_admin_or_above());

-- ---- notifications: strictly self-scoped, super_admin sees all per the explicit
-- "full access to everything" requirement. -----------------------------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_select ON notifications FOR SELECT
USING (is_super_admin() OR recipient_user_id = app_current_user_id());

CREATE POLICY notifications_insert ON notifications FOR INSERT
WITH CHECK (is_admin_or_above());
-- System/backend-generated notifications are authored by a service context running
-- as admin/super_admin; end users never author notifications directly.

CREATE POLICY notifications_update ON notifications FOR UPDATE
USING (is_super_admin() OR recipient_user_id = app_current_user_id())
WITH CHECK (is_super_admin() OR recipient_user_id = app_current_user_id());
-- Intended for mark-as-read only; restrict the UPDATE statement to is_read/read_at
-- at the application layer (RLS cannot itself restrict which columns an UPDATE touches).

CREATE POLICY notifications_delete ON notifications FOR DELETE USING (is_super_admin());

-- ---- audit_log: no application role gets INSERT/UPDATE/DELETE — the SECURITY
-- DEFINER log_audit() trigger is the only writer. super_admin reads everything;
-- admin reads only the tables it is responsible for managing. ----------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_select ON audit_log FOR SELECT
USING (
  is_super_admin()
  OR (app_current_role() = 'admin' AND table_name IN
        ('leads','orders','order_items','renewals','follow_ups','lead_assignments','customers'))
);

-- ---- sessions: strictly self-scoped; super_admin can see all for support/incident
-- response. -------------------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_all ON sessions
USING (is_super_admin() OR user_id = app_current_user_id())
WITH CHECK (is_super_admin() OR user_id = app_current_user_id());


-- =====================================================================================
-- SECTION 10 — GRANTS
-- =====================================================================================
GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT SELECT ON mv_lead_status_breakdown, mv_caller_performance TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
-- app_user is intentionally NOT granted BYPASSRLS and is NOT the owner of any object.
-- All SECURITY DEFINER trigger functions (7.3, 7.4, 7.11) must be owned by the
-- separate schema-owner/migration role (which does have BYPASSRLS), so internal
-- bookkeeping writes succeed regardless of the calling session's restricted view of
-- the data, while direct application queries remain fully RLS-bound.
--
-- Two caveats worth remembering operationally: (1) a Postgres SUPERUSER role always
-- bypasses RLS regardless of FORCE — no connection pool or migration runner should
-- ever authenticate to this database as superuser; (2) FORCE ROW LEVEL SECURITY only
-- changes behavior for the table's OWNER — non-owners (like app_user, a mere grantee)
-- were always subject to RLS. FORCE is a safety net here in case app_user or another
-- role is ever accidentally granted ownership later.

-- =====================================================================================
-- END OF SCHEMA
-- =====================================================================================