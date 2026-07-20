# Medical CRM — Database Design Notes

## Entity Overview

The schema centers on five core entities: **`users`** (internal CRM operators — super_admin/admin/caller), **`customers`** (the canonical person/identity, decoupled from any single interaction), **`products`** (medicine catalog), **`leads`** (sales intake pipeline), and **`orders`**/`order_items` (fulfillment). Two supporting entities close specific gaps in the original frontend model: **`renewals`** (recurring medicine-refill reminders, with status derived at query time rather than stored) and **`follow_ups`** (a unified scheduling entity anchored to a customer, with optional lead/renewal context — replacing an earlier hack of overloading a lead-id field). `lead_activities`, `notifications`, and `audit_log` are append-heavy logs, monthly-partitioned. `lead_assignments` is a system-maintained reassignment history table; `sessions` is the one table using true hard delete.

Every table carries `created_at`/`updated_at`/`deleted_at` (soft delete) except `sessions` (transient, hard-deleted) and `audit_log` (a write-once ledger — mutating it would defeat its purpose).

## ID Strategy

Every primary key is `uuid DEFAULT gen_random_uuid()`. Human-friendly identifiers (`employee_id`, `order_number`, `sku`) are separate `UNIQUE` (partial, `WHERE deleted_at IS NULL`) constraints, never primary keys. This is deliberate: UUID PKs mean no cross-table FK ever needs to change shape later, so a future multi-tenant retrofit (composite `(organization_id, id)` keys) or a business-key rename stays additive instead of touching every foreign key in the schema.

## Access Model: Three Roles via RLS

`super_admin`, `admin`, and `caller` are enforced through Postgres Row-Level Security, not solely in application code. The app connects as a single pooled role, `app_user` — never as superuser, never with `BYPASSRLS` — so RLS is real defense-in-depth, not decoration.

Per-CRM-user identity lives in transaction-local GUCs (`app.current_user_id`, `app.current_role`), set via one bootstrap function per transaction:

```sql
SELECT set_app_session('11111111-2222-3333-4444-555555555555');
```

`set_app_session()` is `SECURITY DEFINER`: it looks up `role`/`status`/`deleted_at` directly from `users` (bypassing RLS only for this one lookup, since no session context exists yet) and derives **both** GUCs from that verified row. The app must already have authenticated the user (password/OTP/session token) before calling this — it establishes authorization context, not authentication. The key property: the app can only ever assert a user id, never an independent role string, so a forged claim or injection point upstream can't make a caller session self-report as `super_admin`. Because `set_config(..., true)` scopes to the current transaction, this is safe under PgBouncer transaction pooling — call it again at the start of every transaction.

Policies then read `app_current_role()`/`app_current_user_id()` (STABLE wrapper functions over `current_setting`). Example: `leads_update` lets a caller touch only rows where `assigned_caller_id = app_current_user_id()`, checked in both `USING` and `WITH CHECK` so a caller can't reassign a lead away from themselves. Column-level rules RLS can't express (e.g. "callers can't flip `deleted_at`", "admins can't grant admin role") are enforced by companion `BEFORE UPDATE` triggers that compare OLD vs NEW.

## Partitioning & Archival

`lead_activities`, `notifications`, and `audit_log` are `RANGE`-partitioned by month on their timestamp column, bootstrapped 2 months back to 12 months forward, with a catch-all `DEFAULT` partition as a safety net. `ensure_monthly_partition()` is idempotent and scheduled via `pg_cron` (auto-detected; if unavailable, migration raises a loud `WARNING` naming the exact statements an external scheduler must run — silent default-partition growth was treated as a real production risk). `list_droppable_partitions()` reports archival candidates for `DETACH`/`DROP`; documented retention is 24 months for activities/notifications, 7 years for `audit_log` (regulated medical-distribution compliance). `orders`/`order_items`/`follow_ups` are deliberately *not* partitioned yet — they grow roughly 1:1 with leads/customers, not per-interaction — but use the same machinery whenever volume warrants it.

## Adding New Lookup Values Without a Migration

Adding a new enum member (e.g. a new `lead_source`) is cheap and non-blocking: `ALTER TYPE lead_source ADD VALUE 'sms_campaign'` runs transactionally on PG12+. What is *not* cheap is renaming or retiring a value — Postgres has no `DROP`/`RENAME VALUE` primitive, so that requires the full create-new-type/rewrite-dependents dance. This is accepted deliberately: these enums mirror frontend TypeScript unions (compiled, not admin-editable), so renames are expected to be rare. `is_terminal_lead_status()` is the single source of truth for "which lead statuses are terminal" — referenced by both the partial index `ix_leads_open` and `mv_caller_performance` — so a future terminal status only needs to change in one place. If the business later wants runtime-editable, no-deploy statuses, migrate `lead_status` specifically to a lookup table; nothing else in the schema depends on it staying an ENUM.

## Path to Multi-Tenancy

No `organization_id` exists today — there's exactly one tenant, so adding it now would be pure speculative cost. The retrofit is designed to be additive: (1) create `organizations`, (2) add nullable `organization_id` to each business table, (3) backfill and `SET NOT NULL`, (4) rewrite natural-key partial-unique indexes as composite `(organization_id, key)`, (5) add one `RESTRICTIVE` tenant-isolation policy per table. Two traps to avoid when that day comes: FK targets must be validated same-org (composite FKs or a trigger check — a bare shared `organization_id` column on both sides doesn't stop cross-tenant linkage), and `log_audit()`'s function body must be edited to pull `organization_id` out of `NEW`/`OLD` the moment the column is added, or historical audit rows will have it NULL.

## Deliberately Deferred / Out of Scope

- **Multi-phone/multi-address per customer** — `customers` has flat `primary_mobile`/`alternate_mobile` and single address columns, consumed by a `STORED` generated `search_vector`. Normalizing into child tables later forces a full-table rewrite regardless of when it's done, so it's deferred until there's a real requirement.
- **Inventory/stock tracking** — no `stock_quantity` on `products` (purely additive whenever needed). A nullable `batch_number` *was* added to `order_items` now, because unlike stock counters it carries a historical dependency: lines written before it exists can never be retroactively attributed to a batch, which matters for recall traceability.
- **Subscriptions** — `renewals.previous_renewal_id` is a nullable self-reference, not a full `subscriptions` table, since no recurring-billing concept exists yet.
- **Search at scale** — `global_search` is a plain view over `tsvector`/GIN, adequate to low tens of millions of rows; graduate to a dedicated search engine only once fuzzy/faceted/multi-language needs exceed it.
- **Bulk-reassignment contention** on `assigned_leads_count` — the per-row trigger is correct and cheap for normal traffic; known bulk paths (offboarding, import) should batch deltas at the application layer rather than the schema changing default behavior.