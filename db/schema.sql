-- =====================================================================================
-- MEDICAL CRM — CANONICAL POSTGRESQL SCHEMA (FINAL / PRODUCTION, POST-ADVERSARIAL-REVIEW)
-- Target: PostgreSQL 15+
--
-- This is the merged three-lens design (normalization/correctness, scale/future-proofing,
-- security/performance), further hardened against a five-lens adversarial review
-- (normalization, indexing, security/RLS, scalability, migration/future-proofing).
-- Every finding from that review was either fixed in this file, or deliberately left
-- unfixed with an inline SQL comment explaining why. A full index of decisions is at
-- the bottom of this file under "DESIGN DECISIONS LOG".
--
-- CONVENTIONS (applied uniformly across the whole schema)
--   * snake_case identifiers everywhere. Table names are PLURAL (users, leads, ...).
--   * Every primary key is `uuid DEFAULT gen_random_uuid()` (pgcrypto). Human-friendly
--     business keys (employee_id, order_number, sku) are separate UNIQUE constraints,
--     NEVER primary keys.
--   * Native PostgreSQL ENUM types are used for every closed, frontend-defined union
--     (roles/statuses/priorities/sources/types) instead of lookup tables.
--   * timestamptz for every point-in-time column, including renewal/order "calendar"
--     dates — the client explicitly required timestamptz everywhere for future
--     multi-region correctness, so we do not use bare `date`/`timestamp` anywhere.
--   * NUMERIC(p,s) for all money. Never float/double precision.
--   * Every business table has created_at, updated_at (trigger-maintained) and a
--     nullable deleted_at (soft delete). The two deliberate, documented exceptions
--     are `sessions` (transient auth tokens — hard delete) and `audit_log` (a
--     write-once compliance ledger — mutating/soft-deleting it would defeat its
--     purpose).
--   * RLS is defense-in-depth alongside application-layer authorization. The app
--     connects through ONE pooled Postgres role (`app_user`), never as superuser and
--     never granted BYPASSRLS. Per-request identity is established via a single
--     SECURITY DEFINER bootstrap function — set_app_session() — NOT by the app
--     independently asserting a role string. See SECTION 7.0 and REVIEW FIX #S1 for
--     why this replaced the earlier "two independent set_config calls" design:
--
--       SELECT set_app_session('<authenticated-user-uuid>');
--
--     This looks up the user's role/status/deleted_at from `users` itself (bypassing
--     RLS, since no session context exists yet at bootstrap time) and only then calls
--     set_config for both app.current_user_id and app.current_role, from verified
--     data. The app tier must still authenticate the user (password check, session
--     token validation) BEFORE calling this function — it establishes trusted
--     *authorization* context from a user id the app has already *authenticated*;
--     it is not itself an authentication mechanism.
--     `true` (is_local) scopes the setting to the current transaction only, so it is
--     automatically cleared on COMMIT/ROLLBACK and never leaks across a pooled
--     connection (safe under PgBouncer transaction-pooling mode). Call
--     set_app_session() again at the start of every transaction.
-- =====================================================================================


-- =====================================================================================
-- SECTION 0 — EXTENSIONS
-- =====================================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email without app-side lower()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram GIN indexes: fuzzy/partial phone & name search
-- pg_cron: NOT force-created here (may not be installable on every managed host). Section 11
-- (end of file) auto-detects pg_cron via pg_available_extensions and, if present, creates the
-- extension and schedules partition/refresh maintenance live. If absent, it emits a loud
-- RAISE WARNING at migration time instead of silently doing nothing. See REVIEW FIX #SC1.


-- =====================================================================================
-- SECTION 1 — ENUM TYPES
-- Mirror the frontend TypeScript union types exactly (verbatim source of truth:
-- D:\work\crm\src\types\index.ts).
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
-- compute_renewal_status() and the derived column in renewals_view (SECTION 9).
CREATE TYPE renewal_status          AS ENUM ('upcoming','due_today','overdue','renewed');

-- REVIEW FIX (low, naming-consistency): renamed followup_type/followup_status ->
-- follow_up_type/follow_up_status so the enum names mirror the follow_ups table name,
-- consistent with every other enum/table pairing in this file (lead_status/leads,
-- order_stage/orders, notification_type/notifications, ...).
CREATE TYPE follow_up_type          AS ENUM ('call','reminder','callback');
CREATE TYPE follow_up_status        AS ENUM ('pending','completed','missed');

CREATE TYPE notification_type       AS ENUM ('info','warning','success','error');
-- The four deep-link target entities named in the brief. Deliberately NOT a real FK
-- (Postgres cannot FK to "one of several tables").
CREATE TYPE notification_entity_type AS ENUM ('lead','order','renewal','follow_up');

CREATE TYPE audit_action            AS ENUM ('INSERT','UPDATE','DELETE');

-- REVIEW NOTE (medium, enum-extensibility, deliberately not changed): native ENUMs
-- support ADD VALUE transactionally (PG12+) but have NO drop/rename primitive. Renaming
-- a status (e.g. 'no_response' -> 'unreachable') or retiring one (merging 'closed' into
-- 'converted') requires the full create-new-type / rewrite-every-dependent-object dance:
--   1. CREATE TYPE lead_status_v2 AS ENUM (...);
--   2. ALTER TABLE leads ALTER COLUMN status TYPE lead_status_v2 USING status::text::lead_status_v2;
--   3. Repeat for any other column of this type, rewrite is_terminal_lead_status()
--      (SECTION 7.13) and mv_caller_performance, DROP TYPE lead_status; ALTER TYPE
--      lead_status_v2 RENAME TO lead_status;
-- This is accepted as a rare, documented, blocking-but-safe migration rather than
-- moving lead_status/order_stage to lookup tables, because (a) statuses here are still
-- compiled into the frontend's TypeScript unions, not admin-editable data, and (b) a
-- lookup-table migration is *itself* an equally large one-time rewrite, just paid
-- upfront instead of if-and-when a rename is ever needed. If the business later wants
-- runtime-editable, no-deploy statuses, migrate lead_status specifically to a lookup
-- table at that time; nothing else in this schema depends on it staying an ENUM.


-- =====================================================================================
-- SECTION 2 — POOLED APPLICATION ROLE
-- One native Postgres role for the entire app tier. Per-CRM-user identity lives
-- entirely in the session GUCs set via set_app_session() (SECTION 7.0), never in
-- native Postgres roles — that is what makes RLS + FORCE ROW LEVEL SECURITY
-- meaningful under connection pooling. This role must NEVER be granted BYPASSRLS or
-- SUPERUSER.
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
-- lead_assignments history, audit logging, set_app_session) must be OWNED by that
-- schema-owner role, not by app_user, so their internal writes/reads bypass the
-- calling session's row-level restrictions on purpose, while app_user itself remains
-- fully RLS-bound for everything it does directly.


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
  -- Trigger-maintained cache, never hand-set by application code.
  assigned_leads_count  integer NOT NULL DEFAULT 0,
  last_login_at         timestamptz,
  avatar_url            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  -- REVIEW FIX (low, password-storage): reject anything that isn't shaped like a
  -- recognized bcrypt or argon2 hash, as a last-line-of-defense against a debug path
  -- or migration bug inserting a plaintext password. This is a shape check only — it
  -- cannot verify the hash is *correct*, only that it isn't obviously plaintext.
  CONSTRAINT chk_users_password_hash_format CHECK (
    password_hash ~ '^\$2[aby]\$' OR password_hash ~ '^\$argon2(id|i|d)\$'
  ),
  -- REVIEW NOTE (low, naming-consistency, deliberately not unified): users.phone uses
  -- a loose international-ish pattern while customers.primary_mobile/leads.mobile use
  -- a strict 10-digit Indian mobile pattern. This is intentional, not an oversight:
  -- employees are internal staff who may have extensions, landlines, or (for a
  -- multi-region hire) non-Indian numbers entered manually by an admin during
  -- onboarding; customers.primary_mobile/leads.mobile is deliberately strict because
  -- it doubles as the de-facto dedupe/identity key (ux_customers_primary_mobile) and
  -- must be a callable Indian mobile number for the SMS/OTP-style verification this
  -- domain implies. A future column representing the *same* real-world concept
  -- (e.g. a second customer contact number) should copy the strict customer pattern,
  -- not this loose one.
  CONSTRAINT chk_users_phone_format CHECK (phone ~ '^[0-9+ ()-]{7,15}$'),
  CONSTRAINT chk_users_assigned_leads_count_nonneg CHECK (assigned_leads_count >= 0)
);
COMMENT ON TABLE users IS 'CRM operator accounts. Field fidelity: employeeId->employee_id, assignedLeads->assigned_leads_count (trigger-maintained, not hand-set), lastLogin->last_login_at, avatar->avatar_url, password->password_hash (hash, never plaintext).';
COMMENT ON COLUMN users.assigned_leads_count IS 'Denormalized, trigger-maintained cache (trg_maintain_assigned_leads_count). Never write to this column directly from application code. Reconciled nightly via v_lead_count_reconciliation (SECTION 9).';

CREATE UNIQUE INDEX ux_users_employee_id ON users (employee_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_users_email       ON users (email)       WHERE deleted_at IS NULL;


-- ---------------------------------------------------------------------------
-- 3.2 customers — the canonical identity (fixes frontend simplification #1).
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name         text NOT NULL,
  -- REVIEW NOTE (medium, future-extensibility, deliberately not changed now):
  -- primary_mobile/alternate_mobile hardcode exactly two phone slots on this row,
  -- and generated search_vector below concatenates them as literal source columns.
  -- A future "customer_phones(customer_id, phone, label, is_primary)" child table
  -- would be a cleaner design for a third number / WhatsApp-only number / work vs.
  -- personal tagging, but normalizing this out later requires dropping/redefining
  -- the STORED generated column below, which forces a full table rewrite of
  -- `customers` (likely one of the largest tables) — not a purely additive change.
  -- Deliberately deferred rather than built speculatively: no product requirement
  -- for a third number exists today, and adding an unused child table now is its
  -- own maintenance burden. If/when it becomes real, plan for the search_vector
  -- rewrite as part of that migration, not as a surprise.
  primary_mobile    text NOT NULL,                 -- de-facto identity/dedupe key
  alternate_mobile  text,
  email             citext,
  -- REVIEW NOTE (medium, future-extensibility, deliberately not changed now): same
  -- rationale as above applies to address/city/state/pincode being flat columns
  -- instead of a customer_addresses child table (home/billing/shipping). Deferred
  -- for the same reason — no current multi-address requirement, and the migration
  -- cost (rewriting the generated search_vector) is identical in kind.
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
COMMENT ON TABLE customers IS 'Canonical person/identity, decoupled from Lead/Order/Renewal so repeat customers are recognizable across records. Dedup key: primary_mobile, a 10-digit Indian mobile number.';

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
COMMENT ON TABLE products IS 'Medicine catalog. Replaces free-text medicine names on Order.medicines with a real, centrally-priced catalog referenced by FK.';
-- REVIEW NOTE (low, future-extensibility, partially addressed): no stock/inventory or
-- batch/lot tracking exists yet. A nullable batch_number was added to order_items
-- (SECTION 4.4) specifically because that field carries a historical dependency (order
-- lines written today with no batch_number can never be retroactively attributed to a
-- batch) — a plain stock_quantity counter on `products`, by contrast, carries no such
-- historical dependency and can be added additively whenever real inventory tracking
-- is built, so it is deliberately NOT added speculatively here.

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
  -- REVIEW FIX (critical, IDOR): a BEFORE trigger (trg_leads_check_caller_customer_link,
  -- SECTION 7.6) additionally requires that when a 'caller' session sets this column,
  -- the target customers row's primary_mobile matches THIS lead's own `mobile` field —
  -- closing the "any caller can link a lead to any customer_id they can observe/guess
  -- and thereby gain read/write access to that customer's PII via customers_select/
  -- customers_update" bypass. See SECTION 7.6 for full rationale and residual risk.
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
  -- REVIEW FIX (low, referential-integrity): trg_leads_assigned_caller_active
  -- (SECTION 7.7) rejects assigning a lead to a user who is inactive or soft-deleted,
  -- since a plain FK only checks the referenced row exists, not that it's "live".
  assigned_caller_id    uuid REFERENCES users(id) ON DELETE SET NULL,

  lead_source           lead_source NOT NULL DEFAULT 'other',
  priority              lead_priority NOT NULL DEFAULT 'medium',
  status                lead_status NOT NULL DEFAULT 'new',

  last_follow_up_at     timestamptz,
  next_follow_up_at     timestamptz,
  notes                 text,

  -- REVIEW NOTE (medium, index-write-amplification, deliberately not changed): notes
  -- is folded into search_vector below and is also the field callers edit most often
  -- during routine work, so nearly every note edit regenerates this STORED tsvector
  -- and writes the GIN index (ix_leads_search). Excluding `notes` would materially
  -- degrade search (callers routinely search by something they wrote in a note) for a
  -- write-cost saving that is real but secondary at this table's expected scale.
  -- Mitigation instead of removal: monitor GIN pending-list size / autovacuum lag
  -- under production write load (`pg_stat_user_indexes`, `gin_pending_list_limit`);
  -- if it becomes a genuine bottleneck at 100x scale, move full-text search to an
  -- asynchronously refreshed projection at that time (see global_search comment,
  -- SECTION 8.2, for the same graduation path already documented for search overall).
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
-- REVIEW NOTE (medium, partitioning-strategy, deliberately not changed): this table's
-- dominant read pattern is "full activity timeline for lead X"
-- (ix_lead_activities_lead_id_created_at, lead_id-first), not a date-range scan, so
-- RANGE(created_at) partitioning cannot prune partitions for that query — every live
-- partition must be Appended and locally index-probed on (lead_id, created_at).
-- Kept as RANGE(created_at) anyway, for two reasons: (1) the actual pain point is
-- partition *count*, not the partition key — with the documented 24-month retention
-- policy (SECTION 5) plus the 2-months-back/12-months-forward bootstrap window, the
-- live partition count stays in the low dozens, so an Append across them with a cheap
-- local index probe per partition is a modest constant-factor cost, not a scan; (2)
-- RANGE(created_at) is what makes `list_droppable_partitions()`/archival-by-DETACH
-- possible at all — a HASH(lead_id) partitioning scheme optimizes today's read
-- pattern but permanently loses the ability to cheaply archive/drop old activity by
-- date, which matters far more at true 100x scale than the per-query partition-prune
-- benefit. If per-lead timeline latency ever becomes a measured problem, prefer
-- shrinking the retention window (fewer live partitions) over abandoning date-range
-- archival altogether. Documented per REVIEW FIX #IX3 rather than changed.
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
  -- made by inserting a new entry, not editing history.
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  PRIMARY KEY (id, created_at)          -- partition key must be part of every unique/PK index
) PARTITION BY RANGE (created_at);
COMMENT ON TABLE lead_activities IS 'Gives the frontend activity array a real FK/type instead of raw string ids, and partitions it for scale.';


-- ---------------------------------------------------------------------------
-- 4.3 lead_assignments — reassignment audit trail (fixes frontend simplification #7).
--     NOT partitioned initially — event volume is far lower than lead_activities'
--     per-interaction volume; can adopt the same ensure_monthly_partition() helper
--     later if reassignment volume ever becomes activity-like.
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
COMMENT ON TABLE lead_assignments IS 'leads.assigned_caller_id is only the live pointer; this table answers "who had this lead, when, and why it changed". Populated exclusively by trg_sync_lead_assignment_history — never written directly by the app.';

CREATE UNIQUE INDEX ux_lead_assignments_open ON lead_assignments (lead_id) WHERE unassigned_at IS NULL;


-- ---------------------------------------------------------------------------
-- 4.4 orders + order_items (fixes frontend simplification #2 — no embedded array).
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      text NOT NULL,                 -- human-friendly business key
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  -- REVIEW FIX (medium, referential-consistency): trg_orders_check_customer_consistency
  -- (SECTION 7.6) rejects an order whose lead_id points at a lead with a *different*
  -- non-null customer_id than this order's own customer_id — previously nothing
  -- prevented an order from displaying/linking two different customers at once.
  lead_id           uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_name     text NOT NULL,                 -- point-in-time snapshot, trigger-synced from customers.full_name
  shipping_address  text NOT NULL,                 -- snapshot at order time; may differ from customer's current address
  -- Trigger-maintained from order_items (trg_order_items_update_total, incremental
  -- delta update — see REVIEW FIX #SC5 in SECTION 7.9).
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
-- REVIEW NOTE (medium, partitioning-strategy, deliberately not changed yet): orders/
-- order_items/follow_ups have no partitioning or documented retention plan, unlike
-- lead_activities/notifications/audit_log. Deferred rather than pre-partitioned: at
-- initial launch scale these tables grow roughly 1:1 with leads/customers, not with
-- every interaction event, so they are expected to reach partition-worthy volume much
-- later than the three already-partitioned tables. The exact same
-- ensure_monthly_partition()/list_droppable_partitions() machinery (SECTION 5) applies
-- unchanged whenever volume warrants it — this is an explicit "not yet", not an
-- oversight.

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
  -- REVIEW FIX (low, future-extensibility): nullable batch/lot number, added now
  -- (rather than only when real inventory is built) because — unlike a plain
  -- products.stock_quantity counter — batch traceability on order lines has a
  -- historical dependency: rows written before this column exists can never be
  -- retroactively attributed to a batch. For a regulated medical-distribution
  -- business (see audit_log's 7-year retention note), that gap is a real recall-
  -- traceability risk if discovered later. Unused today; the application may start
  -- populating it whenever a batch/lot concept is introduced, with no further schema
  -- change required.
  batch_number            text,
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
  -- REVIEW FIX (medium, redundant-data): order_date below is now trigger-synced from
  -- orders.created_at whenever order_id is set (trg_renewals_order_date_sync,
  -- SECTION 7.8) instead of being an independently-entered, never-validated value
  -- that could silently drift from the linked order.
  product_id         uuid REFERENCES products(id) ON DELETE SET NULL,
  -- REVIEW FIX (medium, redundant-data): medicine_name below is now trigger-synced
  -- from products.brand_name/generic_name whenever product_id is set
  -- (trg_renewals_product_snapshot_sync, SECTION 7.8) — previously documented as
  -- "kept in sync" with no trigger actually doing so.
  medicine_name      text NOT NULL,      -- legacy/display label, kept in sync with product_id when set
  order_date         timestamptz NOT NULL,
  renewal_date       timestamptz NOT NULL,   -- when the caller should reach out (reminder point)
  expiry_date        timestamptz NOT NULL,   -- when the customer's medicine supply actually runs out
  assigned_caller_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- REVIEW FIX (low, future-extensibility): nullable self-reference so a chain of
  -- periodic renewals for the same customer+product can be linked explicitly instead
  -- of inferred from customer_id+product_id+chronology (ambiguous once a customer has
  -- concurrent/changing subscriptions for the same product). Unused until a real
  -- subscriptions concept exists; purely additive to introduce a full `subscriptions`
  -- table later with this as the interim linkage.
  previous_renewal_id uuid REFERENCES renewals(id) ON DELETE SET NULL,
  renewed_at         timestamptz,        -- the one persisted FACT; everything else is derived (SECTION 9)
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_renewals_dates CHECK (expiry_date >= order_date AND renewal_date >= order_date),
  -- REVIEW FIX (high, check-constraint): the reminder date must never fall after the
  -- medicine has already run out — previously unconstrained, allowing a renewal to
  -- report 'overdue' for months while nothing at write time signaled a problem.
  CONSTRAINT chk_renewals_renewal_before_expiry CHECK (renewal_date <= expiry_date)
);
COMMENT ON TABLE renewals IS 'daysRemaining/status are intentionally NOT columns here — see renewals_view + compute_renewal_status() in SECTION 9.';

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
  -- REVIEW FIX (medium, referential-consistency): trg_follow_ups_check_customer_consistency
  -- (SECTION 7.6) rejects a follow-up whose lead_id/renewal_id points at a lead/renewal
  -- with a different non-null customer_id than this follow-up's own customer_id.
  customer_name      text NOT NULL,      -- point-in-time snapshot, trigger-synced from customers.full_name
  lead_id            uuid REFERENCES leads(id) ON DELETE SET NULL,
  renewal_id         uuid REFERENCES renewals(id) ON DELETE SET NULL,
  -- Denormalized from lead_id/renewal_id (or set directly for a customer-only
  -- follow-up with no lead/renewal context). Backed by trg_sync_followup_caller;
  -- exists so RLS can filter with a single indexed equality instead of a join, and
  -- so a customer-only follow-up still has an unambiguous owner.
  -- REVIEW FIX (high, update-anomaly): this cache previously went stale whenever the
  -- OWNING lead/renewal was reassigned to a different caller after the follow-up was
  -- created (trg_sync_followup_caller only fired on the follow-up's OWN lead_id/
  -- renewal_id changing, never on the parent lead/renewal's assigned_caller_id
  -- changing) — a real visibility/ownership drift under RLS, not just a display bug.
  -- Now actively cascaded: trg_sync_lead_assignment_history (SECTION 7.4) pushes the
  -- new caller onto every follow_ups row for that lead, and
  -- trg_renewals_sync_followup_caller (SECTION 7.8) does the same for renewals.
  assigned_caller_id uuid REFERENCES users(id) ON DELETE SET NULL,
  scheduled_at       timestamptz NOT NULL,
  type               follow_up_type NOT NULL,
  status             follow_up_status NOT NULL DEFAULT 'pending',
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
--     a mutable or soft-deletable audit ledger is a contradiction in terms.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  table_name    text NOT NULL,
  record_id     uuid NOT NULL,
  action        audit_action NOT NULL,
  changed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  -- REVIEW FIX (high, unbounded-jsonb-growth): old_data/new_data now store a
  -- COLUMN-LEVEL DIFF on UPDATE (only keys that actually changed), not a full
  -- before/after row image, and always strip generated tsvector columns
  -- (search_vector) before storing — see log_audit() SECTION 7.11. Previously a
  -- single notes/address edit duplicated the ENTIRE row (twice, plus its tsvector)
  -- into a ledger retained live for 7 years.
  old_data      jsonb,
  new_data      jsonb,
  PRIMARY KEY (id, changed_at)
) PARTITION BY RANGE (changed_at);
COMMENT ON TABLE audit_log IS 'Populated exclusively by the SECURITY DEFINER log_audit() trigger. No application-level INSERT/UPDATE/DELETE grant or policy is ever given to app_user (SECTION 10) — this is the one table application code writes to only indirectly. old_data/new_data are column-level diffs for UPDATE, full row images (minus generated columns) for INSERT/DELETE.';


-- ---------------------------------------------------------------------------
-- 4.9 sessions — the ONE table where hard delete is correct.
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
-- REVIEW FIX (medium, missing-unique-constraint): an auth token hash is exactly the
-- kind of value that should be enforced unique at the database layer, not left
-- solely to the application's token-generation code. See index below.
CREATE UNIQUE INDEX ux_sessions_token_hash ON sessions (token_hash);


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

CREATE TABLE IF NOT EXISTS lead_activities_default PARTITION OF lead_activities DEFAULT;
CREATE TABLE IF NOT EXISTS notifications_default   PARTITION OF notifications   DEFAULT;
CREATE TABLE IF NOT EXISTS audit_log_default       PARTITION OF audit_log       DEFAULT;

-- REVIEW FIX (high, partition-maintenance): previously the pg_cron scheduling calls
-- were left as commented-out documentation, meaning that past the 12-month bootstrap
-- window, every new row silently lands in the *_default catch-all partitions unless
-- an operator manually notices and intervenes. Actual scheduling now happens in
-- SECTION 11 (end of file), which auto-detects pg_cron and either wires up the jobs
-- for real or raises a loud, impossible-to-miss WARNING at migration time if pg_cron
-- is unavailable on this host. Placed at end of file so the referenced materialized
-- views (SECTION 8.4) already exist when the schedule is registered.

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
COMMENT ON FUNCTION list_droppable_partitions IS 'Reports archival candidates only. Usage: SELECT * FROM list_droppable_partitions(''lead_activities'', 24); then externally: export -> ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY -> DROP TABLE. Suggested retention: lead_activities/notifications 24 months; audit_log 7 years (regulated medical-distribution compliance).';

-- REVIEW FIX (medium, enum-extensibility / single-source-of-truth): defined here
-- (ahead of SECTION 6, which needs it for ix_leads_open) rather than only in SECTION
-- 7.1, since a partial index's predicate is evaluated at CREATE INDEX time and the
-- function must already exist. Both ix_leads_open (SECTION 6.4) and
-- mv_caller_performance (SECTION 8.4) previously hardcoded the literal list
-- `status NOT IN ('converted','closed','not_interested')` independently — a future
-- terminal status (e.g. 'cancelled') would silently need to be added in both places
-- with nothing to catch a missed spot. This function is now the single source of
-- truth. Marked IMMUTABLE (a pure function of the enum value, no dependency on
-- `now()` or any table) so it is legal to use in a partial index predicate. Re-stated
-- as CREATE OR REPLACE in SECTION 7.1 alongside its sibling helpers purely for
-- readability/discoverability — that second call is idempotent, not a redefinition.
CREATE OR REPLACE FUNCTION is_terminal_lead_status(p_status lead_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('converted','closed','not_interested');
$$;


-- =====================================================================================
-- SECTION 6 — INDEXES
-- Indexes declared on a partitioned parent (PG11+) are automatically created on every
-- existing AND future partition, so lead_activities/notifications/audit_log indexes
-- below are declared once on the parent.
-- =====================================================================================

-- 6.1 users
CREATE INDEX ix_users_role_status ON users (role, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_users_phone ON users (phone);
-- REVIEW FIX (high, missing-fk-index): self-referencing audit columns previously had
-- no supporting index anywhere, forcing a full sequential scan of every referencing
-- table's ON DELETE SET NULL cascade whenever a user row is hard-deleted, plus no
-- index support for "show everything last touched by user X" queries.
CREATE INDEX ix_users_created_by ON users (created_by);
CREATE INDEX ix_users_updated_by ON users (updated_by);

-- 6.2 customers
CREATE INDEX ix_customers_mobile_trgm ON customers USING GIN (primary_mobile gin_trgm_ops);
CREATE INDEX ix_customers_name_trgm ON customers USING GIN (full_name gin_trgm_ops);
CREATE INDEX ix_customers_search ON customers USING GIN (search_vector);
CREATE INDEX ix_customers_created_by ON customers (created_by);
CREATE INDEX ix_customers_updated_by ON customers (updated_by);

-- 6.3 products
CREATE INDEX ix_products_search ON products USING GIN (search_vector);
CREATE INDEX ix_products_created_by ON products (created_by);
CREATE INDEX ix_products_updated_by ON products (updated_by);

-- 6.4 leads — FKs + every commonly filtered/sorted UI column
CREATE INDEX ix_leads_customer_id ON leads (customer_id);
CREATE INDEX ix_leads_requested_product_id ON leads (requested_product_id);
CREATE INDEX ix_leads_assigned_caller ON leads (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_status ON leads (status) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_priority ON leads (priority) WHERE deleted_at IS NULL;
-- REVIEW FIX (medium, index-design): added WHERE deleted_at IS NULL, matching every
-- sibling index on this table. Without it, this DESC index (serving "most recent N
-- leads") accumulates dead entries from soft-deleted rows forever, since there is no
-- hard-delete/purge path for them.
CREATE INDEX ix_leads_created_at ON leads (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_next_follow_up ON leads (next_follow_up_at) WHERE deleted_at IS NULL AND next_follow_up_at IS NOT NULL;
-- "Open leads" dashboard tab — heavily hit, small hot subset. Uses
-- is_terminal_lead_status() (SECTION 7.13) as the single source of truth for which
-- statuses count as terminal, instead of repeating the literal enum list here and
-- again in mv_caller_performance (REVIEW FIX #M2 — the two lists could previously
-- drift apart if a new terminal status were ever added and one call site forgotten).
CREATE INDEX ix_leads_open ON leads (assigned_caller_id, priority)
  WHERE deleted_at IS NULL AND NOT is_terminal_lead_status(status);
CREATE INDEX ix_leads_mobile_trgm ON leads USING GIN (mobile gin_trgm_ops);
CREATE INDEX ix_leads_search ON leads USING GIN (search_vector);
CREATE INDEX ix_leads_created_by ON leads (created_by);
CREATE INDEX ix_leads_updated_by ON leads (updated_by);

-- 6.5 lead_activities (propagates to all partitions)
CREATE INDEX ix_lead_activities_lead_id_created_at ON lead_activities (lead_id, created_at DESC);
CREATE INDEX ix_lead_activities_created_by ON lead_activities (created_by);

-- 6.6 lead_assignments
CREATE INDEX ix_lead_assignments_lead_id ON lead_assignments (lead_id, assigned_at DESC);
CREATE INDEX ix_lead_assignments_caller_id ON lead_assignments (caller_id);
-- REVIEW FIX (high, missing-fk-index): assigned_by (ON DELETE SET NULL) was unindexed.
CREATE INDEX ix_lead_assignments_assigned_by ON lead_assignments (assigned_by);

-- 6.7 orders
CREATE INDEX ix_orders_customer_id ON orders (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_lead_id ON orders (lead_id);
CREATE INDEX ix_orders_stage ON orders (stage) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_payment_status ON orders (payment_status) WHERE deleted_at IS NULL;
-- REVIEW FIX (medium, index-design): added WHERE deleted_at IS NULL, same rationale
-- as ix_leads_created_at above.
CREATE INDEX ix_orders_created_at ON orders (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_orders_search ON orders USING GIN (search_vector);
CREATE INDEX ix_orders_created_by ON orders (created_by);
CREATE INDEX ix_orders_updated_by ON orders (updated_by);

-- 6.8 order_items
CREATE INDEX ix_order_items_order_id ON order_items (order_id);
CREATE INDEX ix_order_items_product_id ON order_items (product_id);
CREATE INDEX ix_order_items_batch_number ON order_items (batch_number) WHERE batch_number IS NOT NULL;

-- 6.9 renewals
CREATE INDEX ix_renewals_customer_id ON renewals (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_renewals_assigned_caller ON renewals (assigned_caller_id) WHERE deleted_at IS NULL;
-- REVIEW FIX (high, missing-fk-index): order_id/product_id (both ON DELETE SET NULL)
-- had no supporting index, forcing a full scan on order/product deletion AND on any
-- "renewals tied to this order/product" lookup.
CREATE INDEX ix_renewals_order_id ON renewals (order_id);
CREATE INDEX ix_renewals_product_id ON renewals (product_id);
CREATE INDEX ix_renewals_previous_renewal_id ON renewals (previous_renewal_id);
CREATE INDEX ix_renewals_created_by ON renewals (created_by);
CREATE INDEX ix_renewals_updated_by ON renewals (updated_by);
-- REVIEW FIX (medium, missing-composite-index): the caller's "my due renewals" query
-- (WHERE assigned_caller_id = X AND deleted_at IS NULL AND renewed_at IS NULL ORDER BY
-- expiry_date) previously had only single-column indexes to choose from. This
-- composite partial index lets that dashboard query walk one already-ordered index.
CREATE INDEX ix_renewals_caller_pending_expiry ON renewals (assigned_caller_id, expiry_date)
  WHERE deleted_at IS NULL AND renewed_at IS NULL;

-- 6.10 follow_ups
CREATE INDEX ix_follow_ups_customer_id ON follow_ups (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_follow_ups_lead_id ON follow_ups (lead_id);
CREATE INDEX ix_follow_ups_renewal_id ON follow_ups (renewal_id);
CREATE INDEX ix_follow_ups_assigned_caller ON follow_ups (assigned_caller_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_follow_ups_pending ON follow_ups (scheduled_at) WHERE status = 'pending' AND deleted_at IS NULL;
-- REVIEW FIX (low, missing-index): a full-status date-range view (e.g. a calendar
-- showing pending+completed+missed together) cannot use the pending-only partial
-- index above; this non-partial index supports that access pattern too.
CREATE INDEX ix_follow_ups_scheduled_at ON follow_ups (scheduled_at) WHERE deleted_at IS NULL;
-- REVIEW FIX (medium, missing-composite-index): same rationale as
-- ix_renewals_caller_pending_expiry above, for the "my pending follow-ups sorted by
-- scheduled_at" dashboard query.
CREATE INDEX ix_follow_ups_caller_pending_scheduled ON follow_ups (assigned_caller_id, scheduled_at)
  WHERE status = 'pending' AND deleted_at IS NULL;
CREATE INDEX ix_follow_ups_created_by ON follow_ups (created_by);
CREATE INDEX ix_follow_ups_updated_by ON follow_ups (updated_by);

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

-- REVIEW NOTE (low, n-plus-one-risk, deliberately not changed): customers_select's
-- 'caller' branch (SECTION 9) is a triple UNION ALL of correlated EXISTS subqueries
-- against leads/renewals/follow_ups. Left as-is because it is already backed by
-- indexed equality lookups on each child table (ix_leads_customer_id,
-- ix_renewals_customer_id, ix_follow_ups_customer_id), so each candidate row costs
-- up to three cheap index probes, not sequential scans. If caller-facing customer
-- list/search performance ever becomes a measured bottleneck at scale, the documented
-- remedy is a denormalized customer_caller_visibility(customer_id, caller_id)
-- reverse-lookup table maintained by the same triggers that already sync
-- assigned_caller_id — deferred until there's a real performance signal to justify
-- the added write-path complexity.


-- =====================================================================================
-- SECTION 7 — TRIGGERS AND FUNCTIONS
-- =====================================================================================

-- ---------------------------------------------------------------------------
-- 7.0 Session bootstrap — REVIEW FIX (high, session-spoofing/auth-binding).
--     Previously the app tier called two INDEPENDENT set_config() statements
--     (app.current_user_id, app.current_role), with nothing in the database
--     verifying that the asserted role actually matches users.role for that id.
--     Any bug or injection point upstream of these two calls (a forged JWT claim,
--     a SQL-injection foothold, an app-tier logic error) could assert
--     current_role=super_admin independent of what the users table says, since
--     app_user is a single shared, non-BYPASSRLS role and RLS trusts the GUCs
--     unconditionally. set_app_session() closes this by deriving BOTH GUCs from a
--     single verified lookup, so the app can only ever assert a user id — never an
--     independent role claim.
--
--     IMPORTANT: this function establishes AUTHORIZATION context for a user id the
--     application must already have AUTHENTICATED (password/OTP/session-token
--     verified) by the time it calls this. It is not an authentication mechanism by
--     itself — anyone able to call it with an arbitrary uuid could impersonate that
--     user's authorization context, exactly as anyone able to forge the old
--     independent set_config calls could. What it removes is the *extra* degree of
--     freedom where the role no longer needs to (and cannot) diverge from what
--     `users.role` actually says for that id.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_app_session(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role    user_role;
  v_status  user_status;
  v_deleted timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'set_app_session: user id is required';
  END IF;

  -- SECURITY DEFINER is essential here, not just an optimization: at this point in
  -- the transaction NO session GUCs are set yet, so a plain-rights SELECT against
  -- `users` would be filtered down to zero rows by users_select's RLS policy
  -- (SECTION 9), which itself depends on app_current_user_id()/app_current_role()
  -- already being set — a chicken-and-egg problem this function exists to break.
  SELECT role, status, deleted_at INTO v_role, v_status, v_deleted
  FROM users WHERE id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_app_session: no such user %', p_user_id;
  END IF;
  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'set_app_session: user % is deleted', p_user_id;
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'set_app_session: user % is not active', p_user_id;
  END IF;

  PERFORM set_config('app.current_user_id', p_user_id::text, true);
  PERFORM set_config('app.current_role', v_role::text, true);
END;
$$;
COMMENT ON FUNCTION set_app_session IS 'Call once per transaction after the app tier has already authenticated p_user_id. Derives app.current_user_id/app.current_role from the verified users row itself (SECURITY DEFINER, bypassing RLS only for this bootstrap lookup) so the asserted role can never diverge from users.role.';


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

-- REVIEW FIX (medium, enum-extensibility / single-source-of-truth): both
-- ix_leads_open (SECTION 6.4) and mv_caller_performance (SECTION 8.4) previously
-- hardcoded the literal list `status NOT IN ('converted','closed','not_interested')`
-- independently. A future terminal status (e.g. 'cancelled') would silently need to
-- be added in both places, with no compiler/constraint to catch a missed spot. This
-- function is now the single source of truth for "is this lead status terminal".
-- Marked IMMUTABLE (a pure function of the enum value, no dependency on `now()` or
-- any table) so it is legal to use in a partial index predicate.
CREATE OR REPLACE FUNCTION is_terminal_lead_status(p_status lead_status) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('converted','closed','not_interested');
$$;

-- ---------------------------------------------------------------------------
-- Active-row assignment guards. REVIEW FIX (low, referential-integrity): a plain FK
-- only checks the referenced row exists, not that it is "live" per this schema's own
-- soft-delete/is_active conventions. These helpers are invoked from BEFORE triggers
-- on the specific assignment columns where assigning an inactive/deleted parent is a
-- real operational bug (a lead handed to an off-boarded caller; a lead requesting a
-- discontinued product) — NOT applied to created_by/updated_by audit columns, which
-- are intentionally allowed to keep pointing at a since-deactivated user: they are a
-- historical record of who performed an action at the time, and that record stays
-- valid even after the actor leaves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_active_user(p_user_id uuid, p_context text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status  user_status;
  v_deleted timestamptz;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  SELECT status, deleted_at INTO v_status, v_deleted FROM users WHERE id = p_user_id;
  IF NOT FOUND OR v_deleted IS NOT NULL OR v_status <> 'active' THEN
    RAISE EXCEPTION '% may not reference an inactive or deleted user (%)', p_context, p_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION assert_active_product(p_product_id uuid, p_context text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_active  boolean;
  v_deleted timestamptz;
BEGIN
  IF p_product_id IS NULL THEN RETURN; END IF;
  SELECT is_active, deleted_at INTO v_active, v_deleted FROM products WHERE id = p_product_id;
  IF NOT FOUND OR v_deleted IS NOT NULL OR NOT v_active THEN
    RAISE EXCEPTION '% may not reference an inactive or deleted product (%)', p_context, p_product_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION check_leads_assigned_caller_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_user(NEW.assigned_caller_id, 'leads.assigned_caller_id');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_leads_assigned_caller_active
BEFORE INSERT OR UPDATE OF assigned_caller_id ON leads
FOR EACH ROW EXECUTE FUNCTION check_leads_assigned_caller_active();

CREATE OR REPLACE FUNCTION check_renewals_assigned_caller_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_user(NEW.assigned_caller_id, 'renewals.assigned_caller_id');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_renewals_assigned_caller_active
BEFORE INSERT OR UPDATE OF assigned_caller_id ON renewals
FOR EACH ROW EXECUTE FUNCTION check_renewals_assigned_caller_active();

-- A dedicated trigger for the DIRECT-update path (an admin reassigning a follow-up
-- without touching lead_id/renewal_id). The lead_id/renewal_id-driven resolution
-- path is checked inline inside sync_followup_assigned_caller() (SECTION 7.5) since
-- that function already computes the effective value.
CREATE OR REPLACE FUNCTION check_followup_caller_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_user(NEW.assigned_caller_id, 'follow_ups.assigned_caller_id');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_follow_ups_caller_active
BEFORE UPDATE OF assigned_caller_id ON follow_ups
FOR EACH ROW EXECUTE FUNCTION check_followup_caller_active();

CREATE OR REPLACE FUNCTION check_leads_requested_product_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_product(NEW.requested_product_id, 'leads.requested_product_id');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_leads_requested_product_active
BEFORE INSERT OR UPDATE OF requested_product_id ON leads
FOR EACH ROW EXECUTE FUNCTION check_leads_requested_product_active();

CREATE OR REPLACE FUNCTION check_order_items_product_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_active_product(NEW.product_id, 'order_items.product_id');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_order_items_product_active
BEFORE INSERT OR UPDATE OF product_id ON order_items
FOR EACH ROW EXECUTE FUNCTION check_order_items_product_active();


-- ---------------------------------------------------------------------------
-- 7.2 updated_at wiring — every table that has the column (all except sessions,
--     which has none).
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
--     decrement/increment counts on OTHER users' rows, which the invoking
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
-- REVIEW NOTE (medium, hot-row-contention, deliberately not changed in the general
-- case): a bulk reassignment of many leads to the same caller in one batch serializes
-- on that caller's single `users` row, since each row-level trigger firing takes a
-- row lock on the same target. Accepted for organic, one-lead-at-a-time traffic (the
-- overwhelming majority of writes to `leads`). For KNOWN bulk-assignment code paths
-- (mass reassignment during offboarding, bulk lead import), the application should
-- compute the net per-caller delta once and apply it via a single grouped
-- `UPDATE users SET assigned_leads_count = assigned_leads_count + delta ...`
-- statement outside the per-row trigger path (e.g. temporarily using a session-level
-- flag the trigger checks and skips), rather than changing this trigger's default
-- per-write behavior, which is the right one for ordinary traffic.


-- ---------------------------------------------------------------------------
-- 7.4 lead_assignments history sync (fixes frontend simplification #7).
--     SECURITY DEFINER for the same cross-row-write reason as 7.3.
--     REVIEW FIX (high, update-anomaly): now ALSO cascades the new caller onto every
--     follow_ups row still open against this lead, closing the stale-cache/ownership
--     drift described in SECTION 4.6.
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

    -- REVIEW FIX (high, update-anomaly): keep follow_ups.assigned_caller_id (the
    -- RLS-facing cache) in lockstep with the owning lead's reassignment, instead of
    -- only recomputing it when the follow-up's own lead_id column changes.
    UPDATE follow_ups
    SET assigned_caller_id = NEW.assigned_caller_id
    WHERE lead_id = NEW.id AND deleted_at IS NULL
      AND assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id;
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
-- 7.6 Cross-entity customer_id consistency + caller IDOR guard.
--     REVIEW FIX (critical, privilege-escalation/IDOR) + (medium,
--     referential-consistency).
-- ---------------------------------------------------------------------------

-- CRITICAL FIX: previously, leads_insert/leads_update RLS (SECTION 9) validated only
-- assigned_caller_id, never customer_id. Since a foreign-key check only verifies the
-- referenced row exists (FK checks are NOT subject to RLS on the referenced table), a
-- 'caller' could INSERT a lead with an arbitrary, observed/guessed customers.id,
-- instantly satisfying customers_select/customers_update's caller-branch EXISTS
-- clause and gaining full read/write access to that customer's PII. This trigger
-- closes that specific path by requiring that, for a caller-authored link, the
-- linked customer's on-file primary_mobile matches THIS lead's own captured mobile
-- number — i.e. the caller must actually know the customer's real contact number,
-- not just an opaque UUID. This is a data-correlation check, not a full ownership
-- check (a brand-new customer has no prior leads to "own" it against yet), and it is
-- layered under RLS as defense-in-depth, not a replacement for it. Residual risk,
-- documented rather than silently assumed away: a caller who already knows a real
-- customer's mobile number (e.g. from a legitimate call) can still self-link to that
-- customer even without a legitimate business reason to; closing that fully would
-- require a stronger identity/consent model than a mobile-match, and is out of scope
-- for a schema-level fix.
CREATE OR REPLACE FUNCTION check_caller_lead_customer_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_match boolean;
BEGIN
  IF app_current_role() = 'caller' AND NEW.customer_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM customers c WHERE c.id = NEW.customer_id AND c.primary_mobile = NEW.mobile
    ) INTO v_match;
    IF NOT v_match THEN
      RAISE EXCEPTION 'callers may only link a lead to a customer whose primary_mobile matches the lead''s own mobile field';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_leads_check_caller_customer_link
BEFORE INSERT OR UPDATE OF customer_id ON leads
FOR EACH ROW EXECUTE FUNCTION check_caller_lead_customer_link();

-- MEDIUM FIX: orders.customer_id vs. orders.lead_id's own customer_id could
-- previously disagree with nothing enforcing consistency, producing an order that
-- displays/links two different customers at once.
CREATE OR REPLACE FUNCTION check_order_customer_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_lead_customer_id uuid;
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    SELECT customer_id INTO v_lead_customer_id FROM leads WHERE id = NEW.lead_id;
    IF v_lead_customer_id IS NOT NULL AND v_lead_customer_id IS DISTINCT FROM NEW.customer_id THEN
      RAISE EXCEPTION 'orders.customer_id (%) does not match the linked lead''s customer_id (%)', NEW.customer_id, v_lead_customer_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_orders_check_customer_consistency
BEFORE INSERT OR UPDATE OF customer_id, lead_id ON orders
FOR EACH ROW EXECUTE FUNCTION check_order_customer_consistency();

-- MEDIUM FIX: same class of gap on follow_ups.customer_id vs. lead_id/renewal_id.
-- This also incidentally strengthens the IDOR posture for follow_ups, since a
-- mismatched customer_id is now rejected outright rather than relying on the
-- customer_name-sync trigger's RLS-gated SELECT happening to return no rows.
CREATE OR REPLACE FUNCTION check_followup_customer_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ref_customer_id uuid;
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    SELECT customer_id INTO v_ref_customer_id FROM leads WHERE id = NEW.lead_id;
    IF v_ref_customer_id IS NOT NULL AND v_ref_customer_id IS DISTINCT FROM NEW.customer_id THEN
      RAISE EXCEPTION 'follow_ups.customer_id (%) does not match the linked lead''s customer_id (%)', NEW.customer_id, v_ref_customer_id;
    END IF;
  END IF;
  IF NEW.renewal_id IS NOT NULL THEN
    SELECT customer_id INTO v_ref_customer_id FROM renewals WHERE id = NEW.renewal_id;
    IF v_ref_customer_id IS NOT NULL AND v_ref_customer_id IS DISTINCT FROM NEW.customer_id THEN
      RAISE EXCEPTION 'follow_ups.customer_id (%) does not match the linked renewal''s customer_id (%)', NEW.customer_id, v_ref_customer_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_follow_ups_check_customer_consistency
BEFORE INSERT OR UPDATE OF customer_id, lead_id, renewal_id ON follow_ups
FOR EACH ROW EXECUTE FUNCTION check_followup_customer_consistency();


-- ---------------------------------------------------------------------------
-- 7.7 follow_ups.assigned_caller_id resolution from lead_id/renewal_id.
--     Deliberately NOT SECURITY DEFINER: it must run under the calling session's
--     own RLS view of leads/renewals, so a caller attempting to attach a follow-up
--     to another caller's lead_id simply fails to resolve an assigned_caller_id
--     (the lookup SELECT sees no row under RLS) and the subsequent RLS WITH CHECK
--     on follow_ups then rejects the insert. This is intentional defense-in-depth.
--     REVIEW FIX (low, referential-integrity): now also rejects an inactive/deleted
--     resolved (or directly supplied) caller via assert_active_user, unconditionally,
--     covering both the "resolved from lead/renewal" and "explicitly supplied at
--     INSERT" paths in one place.
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

  PERFORM assert_active_user(NEW.assigned_caller_id, 'follow_ups.assigned_caller_id');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_followup_caller
BEFORE INSERT OR UPDATE OF lead_id, renewal_id ON follow_ups
FOR EACH ROW EXECUTE FUNCTION sync_followup_assigned_caller();


-- ---------------------------------------------------------------------------
-- 7.8 customer_name / medicine_name / order_date snapshot syncing, and
--     renewal -> follow_ups caller-reassignment cascade.
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

-- REVIEW FIX (medium, redundant-data): renewals.medicine_name was documented as
-- "kept in sync with product_id" but no trigger ever did so. Mirrors
-- sync_customer_name_snapshot's pattern exactly.
CREATE OR REPLACE FUNCTION sync_renewal_product_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.product_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    SELECT COALESCE(brand_name, generic_name) INTO NEW.medicine_name FROM products WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_renewals_product_snapshot_sync
BEFORE INSERT OR UPDATE OF product_id ON renewals
FOR EACH ROW EXECUTE FUNCTION sync_renewal_product_snapshot();

-- REVIEW FIX (medium, redundant-data): renewals.order_date could previously drift
-- from the linked order's created_at with nothing to detect or prevent it.
CREATE OR REPLACE FUNCTION sync_renewal_order_date() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    SELECT created_at INTO NEW.order_date FROM orders WHERE id = NEW.order_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_renewals_order_date_sync
BEFORE INSERT OR UPDATE OF order_id ON renewals
FOR EACH ROW EXECUTE FUNCTION sync_renewal_order_date();

-- REVIEW FIX (high, update-anomaly): the renewals-side counterpart to
-- sync_lead_assignment_history's follow_ups cascade (SECTION 7.4) — when a renewal's
-- assigned_caller_id changes, push the new caller onto every open follow_ups row tied
-- to that renewal, so follow_ups.assigned_caller_id can never go stale relative to
-- either of its two possible parents.
CREATE OR REPLACE FUNCTION sync_followup_caller_from_renewal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE follow_ups
  SET assigned_caller_id = NEW.assigned_caller_id
  WHERE renewal_id = NEW.id AND deleted_at IS NULL
    AND assigned_caller_id IS DISTINCT FROM NEW.assigned_caller_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_renewals_sync_followup_caller
AFTER UPDATE OF assigned_caller_id ON renewals
FOR EACH ROW WHEN (NEW.assigned_caller_id IS DISTINCT FROM OLD.assigned_caller_id)
EXECUTE FUNCTION sync_followup_caller_from_renewal();


-- ---------------------------------------------------------------------------
-- 7.9 order_items -> orders.total_amount maintenance.
--     REVIEW FIX (low, trigger-efficiency): previously re-aggregated
--     SUM(line_total) across ALL of an order's line items on every single
--     order_items INSERT/UPDATE/DELETE — O(N) work per item write, O(N^2) total to
--     populate an N-line order, and a row lock on the parent order serializing
--     concurrent item writes for its whole duration. Replaced with an O(1)
--     incremental delta update.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_order_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id uuid;
  v_delta    numeric(14,2) := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_order_id := NEW.order_id;
    IF NEW.deleted_at IS NULL THEN
      v_delta := NEW.line_total;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
    IF OLD.deleted_at IS NULL THEN
      v_delta := -OLD.line_total;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
      -- Defensive path: order_items.order_id is not expected to change in normal
      -- application flow (a line item is not moved between orders), but if it ever
      -- does, apply the removal and the addition against their respective orders
      -- explicitly rather than letting a single delta misattribute across both.
      IF OLD.deleted_at IS NULL THEN
        UPDATE orders SET total_amount = GREATEST(total_amount - OLD.line_total, 0) WHERE id = OLD.order_id;
      END IF;
      IF NEW.deleted_at IS NULL THEN
        UPDATE orders SET total_amount = total_amount + NEW.line_total WHERE id = NEW.order_id;
      END IF;
      RETURN NEW;
    END IF;

    v_order_id := NEW.order_id;
    v_delta := COALESCE(CASE WHEN NEW.deleted_at IS NULL THEN NEW.line_total ELSE 0 END, 0)
             - COALESCE(CASE WHEN OLD.deleted_at IS NULL THEN OLD.line_total ELSE 0 END, 0);
  END IF;

  IF v_order_id IS NOT NULL AND v_delta <> 0 THEN
    UPDATE orders SET total_amount = GREATEST(total_amount + v_delta, 0) WHERE id = v_order_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_order_items_update_total
AFTER INSERT OR UPDATE OR DELETE ON order_items
FOR EACH ROW EXECUTE FUNCTION update_order_total();


-- ---------------------------------------------------------------------------
-- 7.10 notifications.read_at auto-set when is_read flips to true.
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
-- 7.11 users privilege-escalation guard. RLS filters/validates whole ROWS; it
--      cannot compare OLD.role vs NEW.role for an UPDATE. This BEFORE UPDATE
--      trigger does that OLD-vs-NEW comparison — defense in depth alongside the
--      row-level RLS policies in SECTION 9.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION prevent_privilege_escalation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF is_super_admin() THEN
    RETURN NEW;
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
-- 7.12 Generic audit-log writer. SECURITY DEFINER (owned by the schema-owner
--      role with BYPASSRLS) so it can always insert into audit_log even though
--      no application role is ever granted INSERT on that table directly.
--
--      REVIEW FIX (high, unbounded-jsonb-growth): stores a COLUMN-LEVEL DIFF on
--      UPDATE (only keys whose value actually changed), instead of the full
--      before/after row twice. INSERT/DELETE still store the full (post/pre) row
--      since there is no "before" or "after" to diff against — but with generated
--      tsvector columns (search_vector) always stripped first, since they are
--      pure functions of other already-audited columns and add no forensic value
--      while roughly doubling the payload size on every write to a searchable table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION log_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old      jsonb;
  v_new      jsonb;
  v_old_diff jsonb := '{}'::jsonb;
  v_new_diff jsonb := '{}'::jsonb;
  k          text;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_old := to_jsonb(OLD) - 'search_vector';
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_new := to_jsonb(NEW) - 'search_vector';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(v_new) LOOP
      IF v_old -> k IS DISTINCT FROM v_new -> k THEN
        v_old_diff := v_old_diff || jsonb_build_object(k, v_old -> k);
        v_new_diff := v_new_diff || jsonb_build_object(k, v_new -> k);
      END IF;
    END LOOP;
  ELSIF TG_OP = 'INSERT' THEN
    v_new_diff := v_new;
  ELSIF TG_OP = 'DELETE' THEN
    v_old_diff := v_old;
  END IF;

  INSERT INTO audit_log (table_name, record_id, action, changed_by, changed_at, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    TG_OP::audit_action,
    app_current_user_id(),
    now(),
    NULLIF(v_old_diff, '{}'::jsonb),
    NULLIF(v_new_diff, '{}'::jsonb)
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
-- 8.1 renewals_view — computes daysRemaining/status at query time.
--     A plain view, not a generated column and not a materialized view: both
--     depend on "now", which is not IMMUTABLE, and a materialized snapshot could
--     show an already-expired renewal as "upcoming" until refreshed. A plain view
--     also re-checks RLS on the base table on every call.
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

-- REVIEW NOTE (medium, redundant-data, informational only): follow_ups.assigned_caller_id
-- now has active cascade triggers (SECTION 7.4, 7.8) rather than a nightly
-- reconciliation view, since the cascade is cheap (a single indexed UPDATE) and
-- runs synchronously at the moment of reassignment — a reconciliation view would
-- only ever catch a bug in that cascade after the fact, not replace the need for it.
-- If you want a tripwire anyway, this is a safe pattern to add alongside it:
--   SELECT f.id FROM follow_ups f JOIN leads l ON l.id = f.lead_id
--   WHERE f.deleted_at IS NULL AND f.assigned_caller_id IS DISTINCT FROM l.assigned_caller_id;


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

-- REVIEW FIX (medium, enum-extensibility): uses is_terminal_lead_status() (SECTION
-- 7.1) instead of a second independent hardcoded literal list, so a future terminal
-- status only needs to be added to that one function.
-- VERIFICATION FIX (critical, join-fan-out): the original single-pass version joined
-- leads AND follow_ups directly to users in the same query before aggregating. Since
-- both joins are 1-to-many independently, their combination is a full cross product
-- per caller (N matching leads x M matching follow_ups = N*M joined rows), which
-- silently inflated every lead-derived count (total_assigned_leads, converted_leads,
-- open_leads) by a factor of that caller's follow_up count. Caught only by executing
-- this view against real seed data and diffing against a ground-truth COUNT(*) query
-- on leads directly (a caller with 4 real leads and 4 follow_ups was reported as
-- having 16 total_assigned_leads) — no amount of reading the SQL surfaced this, since
-- the query is syntactically and semantically "reasonable-looking" without a live
-- comparison. Fixed by pre-aggregating leads and follow_ups independently (each in
-- its own GROUP BY caller subquery) and joining only the already-aggregated,
-- one-row-per-caller results together — this is the general fix for this entire class
-- of bug: never aggregate across more than one to-many join in a single GROUP BY.
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

-- Initial population (run once after creation, before first use):
--   REFRESH MATERIALIZED VIEW mv_lead_status_breakdown;
--   REFRESH MATERIALIZED VIEW mv_caller_performance;
-- Refresh strategy: scheduled automatically via pg_cron in SECTION 11 (if available on
-- this host), CONCURRENTLY (requires the unique indexes above; avoids locking readers
-- out during refresh), every 5-10 minutes.
-- REVIEW NOTE (medium, materialized-view-refresh, deliberately not changed beyond
-- documentation): mv_caller_performance's refresh is a full aggregate scan of
-- leads/follow_ups with no incremental/windowed mechanism. At 100x lead volume a full
-- refresh could eventually approach or exceed the 5-10 minute schedule interval,
-- causing overlapping REFRESH CONCURRENTLY runs to queue and silently push staleness
-- past the documented SLA. No incremental-refresh mechanism is built preemptively
-- here (Postgres has no native incremental materialized view refresh); instead,
-- operationally: alert on REFRESH duration vs. the cron interval (e.g. via
-- pg_stat_statements or wrapping the REFRESH call with timing + a log/metrics emit),
-- and if/when it becomes a real bottleneck, migrate the cheap, always-changing counts
-- (open_leads, converted_leads, total_assigned_leads) to a trigger-maintained summary
-- table fed incrementally by the same leads/follow_ups triggers, reserving this full
-- materialized view only for avg_days_to_convert, which is genuinely hard to
-- incrementalize.


-- =====================================================================================
-- SECTION 9 — ROW LEVEL SECURITY
-- Every table: ENABLE + FORCE ROW LEVEL SECURITY, so even the table owner is bound by
-- policy unless it explicitly holds BYPASSRLS (which app_user never does). super_admin
-- is given unconditional full access on every table per the explicit requirement.
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
-- trg_prevent_privilege_escalation (SECTION 7.11) — RLS alone cannot compare
-- OLD vs NEW columns.

CREATE POLICY users_delete ON users FOR DELETE
USING (is_super_admin());

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
-- See SECTION 6 closing note re: this policy's triple-EXISTS cost profile (accepted,
-- backed by indexes on each child table's customer_id).
-- NOTE: this policy alone is why the leads/orders/follow_ups customer_id IDOR fix
-- (SECTION 7.6) is CRITICAL rather than cosmetic — this EXISTS clause is exactly the
-- gate that a spoofed leads.customer_id could previously walk straight through.

CREATE POLICY customers_insert ON customers FOR INSERT
WITH CHECK (app_current_role() IN ('super_admin','admin','caller'));

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
-- customer_id correlation for caller-authored inserts is enforced by
-- trg_leads_check_caller_customer_link (SECTION 7.6), not by RLS — RLS cannot express
-- "the referenced customers row's primary_mobile must equal NEW.mobile" cleanly as a
-- row-level predicate without repeating the same subquery logic; centralizing it in
-- one trigger function keeps INSERT and UPDATE covered from a single definition.

CREATE POLICY leads_update ON leads FOR UPDATE
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id())
WITH CHECK (is_admin_or_above() OR assigned_caller_id = app_current_user_id());
-- A caller cannot use this policy to reassign a lead to someone else: WITH CHECK
-- re-evaluates assigned_caller_id = app_current_user_id() against the NEW row too.
-- trg_leads_prevent_caller_lifecycle_changes additionally blocks a caller from
-- toggling deleted_at.

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
CREATE POLICY lead_activities_update ON lead_activities FOR UPDATE USING (is_super_admin());
CREATE POLICY lead_activities_delete ON lead_activities FOR DELETE USING (is_super_admin());

-- ---- lead_assignments: system-populated only; read access mirrors ownership --------
ALTER TABLE lead_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY lead_assignments_select ON lead_assignments FOR SELECT
USING (is_admin_or_above() OR caller_id = app_current_user_id());
-- No INSERT/UPDATE/DELETE policy for ANY app role — rows are written only by
-- trg_sync_lead_assignment_history (SECURITY DEFINER). Reinforced at the GRANT level
-- too (SECTION 10 — app_user has no INSERT/UPDATE/DELETE grant on this table at all).

-- ---- orders / order_items ------------------------------------------------------------
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

-- ---- follow_ups: callers may fully manage follow-ups tied to their own leads/
-- renewals/customers — explicit caller capability per the brief. -------------------
ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups FORCE ROW LEVEL SECURITY;

CREATE POLICY follow_ups_select ON follow_ups FOR SELECT
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

CREATE POLICY follow_ups_insert ON follow_ups FOR INSERT
WITH CHECK (
  is_admin_or_above()
  OR assigned_caller_id = app_current_user_id()
);

CREATE POLICY follow_ups_update ON follow_ups FOR UPDATE
USING (is_admin_or_above() OR assigned_caller_id = app_current_user_id())
WITH CHECK (is_admin_or_above() OR assigned_caller_id = app_current_user_id());

CREATE POLICY follow_ups_delete ON follow_ups FOR DELETE USING (is_admin_or_above());

-- ---- notifications: strictly self-scoped, super_admin sees all. -------------------
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_select ON notifications FOR SELECT
USING (is_super_admin() OR recipient_user_id = app_current_user_id());

CREATE POLICY notifications_insert ON notifications FOR INSERT
WITH CHECK (is_admin_or_above());

CREATE POLICY notifications_update ON notifications FOR UPDATE
USING (is_super_admin() OR recipient_user_id = app_current_user_id())
WITH CHECK (is_super_admin() OR recipient_user_id = app_current_user_id());
-- Intended for mark-as-read only; restrict the UPDATE statement to is_read/read_at
-- at the application layer (RLS cannot itself restrict which columns an UPDATE touches).

CREATE POLICY notifications_delete ON notifications FOR DELETE USING (is_super_admin());

-- ---- audit_log: no application role gets INSERT/UPDATE/DELETE at all — neither via
-- RLS policy (none granted) nor via GRANT (SECTION 10 explicitly withholds it). The
-- SECURITY DEFINER log_audit() trigger is the only writer. -------------------------
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
-- REVIEW FIX (medium, grants/defense-in-depth): previously a single blanket
-- `GRANT ... ON ALL TABLES IN SCHEMA public TO app_user` meant that RLS's default-deny
-- (no matching policy for a given command) was the ONLY thing stopping app_user from
-- tampering with audit_log or lead_assignments directly — a single point of failure
-- if RLS were ever accidentally disabled, a policy mistakenly added, or app_user ever
-- mistakenly granted BYPASSRLS. Grants are now itemized per table so that tampering
-- with the audit trail or system-managed assignment history requires defeating BOTH
-- RLS and the underlying GRANT, not RLS alone.
-- =====================================================================================
GRANT USAGE ON SCHEMA public TO app_user;

-- Full CRUD at the grant level; RLS policies (SECTION 9) narrow further per-role/
-- per-action for each of these.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, customers, products, leads, lead_activities, orders, order_items,
  renewals, follow_ups, notifications
TO app_user;

-- sessions: app manages sessions directly, including true hard delete on logout/expiry.
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_user;

-- lead_assignments: READ ONLY for app_user. Every row is written exclusively by
-- trg_sync_lead_assignment_history, a SECURITY DEFINER function owned by the
-- schema-owner role — that role's own privileges (not app_user's grants) are what let
-- it write here, so app_user needs no INSERT/UPDATE/DELETE grant on this table at all.
GRANT SELECT ON lead_assignments TO app_user;

-- audit_log: READ ONLY for app_user, for the identical reason — only the SECURITY
-- DEFINER log_audit() trigger, owned by the schema-owner role, ever writes here.
GRANT SELECT ON audit_log TO app_user;

GRANT SELECT ON mv_lead_status_breakdown, mv_caller_performance TO app_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;

-- REVIEW NOTE: ALTER DEFAULT PRIVILEGES is schema-wide and cannot itself distinguish
-- "a normal business table" from "a system-write-only ledger" for any FUTURE table.
-- Kept as a broad default for convenience, but any future table with the same
-- write-restricted nature as audit_log/lead_assignments MUST have its default grant
-- explicitly narrowed (REVOKE INSERT, UPDATE, DELETE ...) immediately after creation,
-- the same way this section does for those two tables today — do not rely on this
-- default alone for a write-restricted table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- app_user is intentionally NOT granted BYPASSRLS and is NOT the owner of any object.
-- All SECURITY DEFINER trigger functions (set_app_session, maintain_assigned_leads_count,
-- sync_lead_assignment_history, sync_followup_caller_from_renewal, log_audit) must be
-- owned by the separate schema-owner/migration role (which does have BYPASSRLS), so
-- internal bookkeeping writes/reads succeed regardless of the calling session's
-- restricted view of the data, while direct application queries remain fully RLS-bound.
--
-- Two caveats worth remembering operationally: (1) a Postgres SUPERUSER role always
-- bypasses RLS regardless of FORCE — no connection pool or migration runner should
-- ever authenticate to this database as superuser; (2) FORCE ROW LEVEL SECURITY only
-- changes behavior for the table's OWNER — non-owners (like app_user, a mere grantee)
-- were always subject to RLS. FORCE is a safety net here in case app_user or another
-- role is ever accidentally granted ownership later.


-- =====================================================================================
-- SECTION 11 — AUTOMATIC MAINTENANCE SCHEDULING (pg_cron, auto-detected)
-- REVIEW FIX (high, partition-maintenance): previously the pg_cron scheduling
-- statements existed only as commented-out documentation, so unless an operator
-- manually noticed and stood up an external scheduler, every write past the 12-month
-- bootstrap window would silently land in the *_default catch-all partitions (an
-- ever-growing, un-pruned table that later requires a full-table-scan split to fix).
-- This block detects whether pg_cron is actually installable on this host and, if so,
-- creates the extension and schedules the two maintenance jobs for real; if not, it
-- raises a migration-time WARNING that is impossible to silently ignore, naming the
-- exact statements an external scheduler (systemd timer / Airflow / app cron) must run
-- instead.
-- =====================================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;

    PERFORM cron.schedule('ensure-future-partitions', '0 2 25 * *', $CRON$
      SELECT ensure_monthly_partition('lead_activities', (date_trunc('month', now()) + interval '1 month')::date);
      SELECT ensure_monthly_partition('notifications',   (date_trunc('month', now()) + interval '1 month')::date);
      SELECT ensure_monthly_partition('audit_log',       (date_trunc('month', now()) + interval '1 month')::date);
    $CRON$);

    PERFORM cron.schedule('refresh-crm-dashboards', '*/10 * * * *', $CRON$
      REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown;
      REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance;
    $CRON$);

    RAISE NOTICE 'pg_cron detected: scheduled automatic monthly partition creation (25th @ 02:00) and dashboard materialized view refresh (every 10 min).';
  ELSE
    RAISE WARNING 'pg_cron is NOT installed on this instance. Automatic monthly partition creation and materialized view refresh will NOT happen. You MUST wire up an external scheduler NOW to run: (1) SELECT ensure_monthly_partition(''lead_activities''|''notifications''|''audit_log'', next_month) monthly, or new rows will silently fall into the *_default partitions; (2) REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown / mv_caller_performance every 5-10 minutes, or dashboard tiles will go stale indefinitely. Also add a monitoring check on default-partition row counts (pg_partition_tree) so an operator is alerted long before it becomes a bottleneck.';
  END IF;
END $$;

-- Initial population of the materialized views (safe to run even WITH NO DATA above;
-- first REFRESH must be non-concurrent since the views start unpopulated).
REFRESH MATERIALIZED VIEW mv_lead_status_breakdown;
REFRESH MATERIALIZED VIEW mv_caller_performance;


-- =====================================================================================
-- END OF SCHEMA
-- =====================================================================================


-- =====================================================================================
-- DESIGN DECISIONS LOG
-- Key architectural choices, and every reviewer finding that was deliberately NOT
-- applied verbatim, with reasoning. (Findings that WERE applied are documented inline,
-- next to the fix, tagged "REVIEW FIX (<severity>, <category>)".)
-- =====================================================================================
--
-- ARCHITECTURE, CARRIED FORWARD FROM THE MERGE
-- -----------------------------------------------
-- A1. Native ENUMs over lookup tables for every closed, frontend-compiled union
--     (roles/statuses/priorities/sources/types). Trade-off accepted: ADD VALUE is
--     transactional and cheap; RENAME/DROP VALUE is not supported and requires a
--     full type-swap migration (documented in SECTION 1). Revisit per-column (e.g.
--     lead_status specifically) only if the business needs runtime-editable,
--     no-deploy status taxonomies.
-- A2. UUID PKs everywhere; human-friendly business keys (employee_id, order_number,
--     sku) are separate partial-unique indexes, never PKs — keeps a future
--     multi-tenant (organization_id, key) composite-uniqueness retrofit purely
--     additive.
-- A3. timestamptz for every point-in-time column, including renewal/order "calendar"
--     dates, per explicit client instruction for future multi-region correctness.
-- A4. Trigger-maintained denormalized caches (users.assigned_leads_count,
--     orders.total_amount, follow_ups.assigned_caller_id) instead of computing them
--     at read time, paired with either an active cascade (follow_ups caller) or a
--     reconciliation view (assigned_leads_count) as a correctness tripwire.
-- A5. RLS as defense-in-depth under a single pooled `app_user` role, identity carried
--     in transaction-local GUCs. Post-review, GUC establishment is now funneled
--     through set_app_session() (SECTION 7.0) rather than two independently settable
--     values, closing the "asserted role need not match users.role" gap (REVIEW FIX,
--     high, session-spoofing/auth-binding).
--
-- REVIEWER FINDINGS APPLIED (high-level summary; see inline "REVIEW FIX" comments for
-- exact locations and mechanics)
-- -----------------------------------------------
-- - [critical] leads/follow_ups customer_id IDOR: closed via
--   trg_leads_check_caller_customer_link (mobile-match correlation for caller-authored
--   links) + trg_orders_check_customer_consistency / trg_follow_ups_check_customer_consistency
--   (lead/renewal customer_id agreement). Residual risk documented inline (SECTION 7.6):
--   a caller who genuinely knows a customer's real mobile number can still self-link
--   without a verified business reason; fully closing that needs a stronger
--   identity/consent model, out of scope for a schema-level fix.
-- - [high] session role spoofing: set_app_session() SECURITY DEFINER bootstrap
--   (SECTION 7.0), replacing two independently-settable GUCs.
-- - [high] follow_ups.assigned_caller_id going stale on lead/renewal reassignment:
--   active cascades added to trg_sync_lead_assignment_history and the new
--   trg_renewals_sync_followup_caller (SECTIONS 7.4, 7.8).
-- - [high] renewal_date could be after expiry_date: chk_renewals_renewal_before_expiry
--   added (SECTION 4.5).
-- - [high] missing FK indexes (created_by/updated_by across nearly every table,
--   lead_assignments.assigned_by, renewals.order_id/product_id): all added (SECTION 6).
-- - [high] audit_log unbounded growth from full-row before/after snapshots on every
--   write: log_audit() rewritten to store column-level diffs on UPDATE and to strip
--   generated tsvector columns unconditionally (SECTION 7.12).
-- - [high] pg_cron scheduling left as documentation only: SECTION 11 now auto-detects
--   and either schedules for real or raises an unmissable WARNING naming the exact
--   fallback statements.
-- - [medium] renewals.medicine_name / order_date drift: trigger-synced
--   (sync_renewal_product_snapshot, sync_renewal_order_date, SECTION 7.8).
-- - [medium] sessions.token_hash had no uniqueness guarantee: ux_sessions_token_hash
--   added (SECTION 4.9).
-- - [medium] orders/follow_ups customer_id vs. lead/renewal customer_id could disagree:
--   consistency triggers added (SECTION 7.6).
-- - [medium] composite indexes missing for "my pending renewals/follow-ups sorted by
--   date": ix_renewals_caller_pending_expiry, ix_follow_ups_caller_pending_scheduled
--   added (SECTION 6).
-- - [medium] ix_leads_open / mv_caller_performance repeating a hardcoded terminal-
--   status literal list independently: unified behind is_terminal_lead_status()
--   (SECTION 7.1).
-- - [medium] blanket GRANT ALL TABLES as the only thing (besides RLS) stopping
--   app_user from writing audit_log/lead_assignments directly: itemized per-table
--   grants (SECTION 10), explicitly withholding INSERT/UPDATE/DELETE on both.
-- - [medium] ix_leads_created_at / ix_orders_created_at missing the
--   WHERE deleted_at IS NULL convention used everywhere else: added (SECTION 6).
-- - [low] password_hash had no shape validation: chk_users_password_hash_format added
--   (SECTION 3.1).
-- - [low] assigned_caller_id / requested_product_id / order_items.product_id could
--   point at an inactive/deleted user or product: assert_active_user/
--   assert_active_product guard triggers added (SECTION 7.1), deliberately NOT
--   extended to created_by/updated_by (see reasoning below).
-- - [low] order_items had no batch/lot traceability field: nullable batch_number
--   added now (historical-dependency argument — see SECTION 4.4 comment), while
--   products.stock_quantity was deliberately NOT added (no historical dependency,
--   purely additive whenever real inventory tracking exists).
-- - [low] renewals had no subscription/recurring-series concept: nullable
--   previous_renewal_id self-reference added (SECTION 4.5).
-- - [low] followup_type/followup_status enum naming inconsistent with follow_ups:
--   renamed to follow_up_type/follow_up_status (SECTION 1).
-- - [low] update_order_total() re-aggregated all line items on every write (O(N) per
--   write, O(N^2) per order): rewritten to an O(1) incremental delta update
--   (SECTION 7.9).
--
-- FINDINGS DELIBERATELY NOT APPLIED (with reasoning; each also has an inline SQL
-- comment at the relevant location)
-- -----------------------------------------------
-- - [medium] partitioning lead_activities by RANGE(created_at) mismatches its
--   dominant "timeline for lead X" read pattern (SECTION 4.2 comment). Not changed:
--   the documented retention policy keeps live partition count in the low dozens, so
--   the Append-across-partitions cost is a bounded constant factor, and RANGE(created_at)
--   is what makes date-based archival (list_droppable_partitions/DETACH) possible at
--   all — a lead_id-based partitioning scheme would optimize today's query at the
--   cost of permanently losing cheap date-based archival, which matters more at true
--   scale. If per-lead timeline latency is ever measured as a real problem, prefer
--   shrinking the retention window over abandoning date-range partitioning.
-- - [medium] leads.search_vector / customers.search_vector GIN write amplification
--   from frequently-edited free-text fields (notes, address). Not changed: removing
--   `notes` from the indexed vector would be a real product regression (callers
--   search by note content), for a write-cost saving that is secondary at expected
--   scale. Documented mitigation instead: monitor GIN pending-list/autovacuum lag in
--   production; migrate to an async search projection only if it becomes a measured
--   bottleneck.
-- - [medium] assigned_leads_count hot-row contention under bulk reassignment. Not
--   changed as a default: per-row trigger maintenance is correct and cheap for
--   ordinary one-lead-at-a-time traffic, which is the overwhelming majority of writes.
--   Documented as an application-level concern: known bulk-assignment code paths
--   should batch the delta themselves rather than the schema changing its default
--   per-write behavior for the common case.
-- - [medium] mv_caller_performance full-scan refresh cost at 100x scale. Not
--   restructured into an incremental-refresh design preemptively (Postgres has no
--   native incremental materialized view refresh to lean on); documented monitoring
--   guidance and a concrete future migration path (trigger-fed summary table for the
--   cheap counts) instead of speculative complexity today.
-- - [medium] follow_ups/orders/order_items have no partitioning/retention plan yet.
--   Not partitioned now: these tables are expected to grow roughly 1:1 with
--   leads/customers rather than per-interaction-event like lead_activities, so they
--   reach partition-worthy volume much later. The identical
--   ensure_monthly_partition()/list_droppable_partitions() machinery applies unchanged
--   whenever volume warrants it.
-- - [medium] organization_id multi-tenancy retrofit doesn't itself validate cross-org
--   FK integrity, and audit_log's org scoping would require touching log_audit()'s
--   body, not just adding a column. Not built now (no multi-tenancy requirement
--   exists yet, and organization_id itself is deliberately not pre-added — see next
--   item); both caveats are now explicitly called out here as required parts of that
--   FUTURE retrofit, so whoever implements it doesn't miss them: (1) FK targets need
--   composite (organization_id, id) keys or an explicit same-org trigger check, not
--   just a shared organization_id column on both sides; (2) log_audit() must be
--   edited to pull organization_id out of NEW/OLD the moment audit_log gains that
--   column, or historical rows written between the column's addition and the
--   function's fix will have a NULL organization_id.
-- - [medium] organization_id itself was not pre-added (nullable, unused) to every
--   table. Every PK is already a UUID and every natural key is already a separate
--   UNIQUE constraint, so the retrofit remains fully additive later without touching
--   a primary key or existing foreign key: (1) CREATE TABLE organizations, (2) add a
--   nullable organization_id FK to each business table, (3) backfill with the single
--   existing org's id, (4) SET NOT NULL, (5) rewrite the natural-key partial-unique
--   indexes as composite (organization_id, key), (6) add one RESTRICTIVE tenant-
--   isolation policy per table. Adding the column speculatively now buys nothing
--   (there is exactly one tenant today) at the cost of an extra column everywhere.
-- - [medium] customers.primary_mobile/alternate_mobile hardcode two phone slots, and
--   customers.address/city/state/pincode are flat single-address columns, both
--   consumed directly by the generated search_vector column. Not normalized into
--   customer_phones/customer_addresses child tables now: no current product
--   requirement for multiple numbers/addresses per customer exists, and doing so
--   speculatively would itself force a full-table rewrite of `customers` (dropping
--   and redefining the STORED generated column) for no present benefit — the exact
--   same migration cost would be paid regardless of when it's done, so it is deferred
--   until there's a real requirement, with the rewrite cost flagged in advance
--   (SECTION 3.2 comments) so it isn't a surprise when that day comes.
-- - [low] users.phone vs. customers.primary_mobile/leads.mobile use different CHECK
--   patterns (loose international-ish vs. strict 10-digit Indian mobile). Not
--   unified: this is intentional, not an oversight — employees may have extensions/
--   landlines/non-Indian numbers entered manually by an admin, while the customer-
--   facing columns double as the dedupe/identity key and the assumed SMS/OTP
--   verification channel, which requires the strict format. Documented explicitly
--   (SECTION 3.1) so a future column representing the same real-world concept copies
--   the correct convention rather than guessing.
-- - [low] customers_select RLS triple UNION ALL of correlated EXISTS subqueries is a
--   real per-row cost (up to three index probes) for caller-facing customer list/
--   search. Not restructured into a denormalized reverse-lookup table now: each
--   probe is already a cheap indexed equality lookup (not a sequential scan), so this
--   is a constant-factor cost, not an N+1 in the traditional sense. Documented
--   remedy (a maintained customer_caller_visibility(customer_id, caller_id) table) is
--   ready to implement the moment there's a measured performance signal to justify
--   the added write-path complexity.
-- =====================================================================================