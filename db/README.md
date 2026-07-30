# MediCRM — Database

Production-grade PostgreSQL schema for the Medical CRM. Designed via multi-agent design +
5-lens adversarial review, then **actually executed and tested** against PostgreSQL 18
(not just generated) — see `VERIFICATION.md` and `RECONCILIATION.md`.

## Install order (important)

Run these in order against a fresh database (PostgreSQL 15+):

```bash
createdb medcrm
psql -d medcrm -f schema.sql                                  # 1. base schema (tables, RLS, triggers, views)
psql -d medcrm -f seed.sql                                    # 2. sample data (optional, for demo/dev)
psql -d medcrm -f migrations/001_app_reconciliation.sql       # 3. app-compatibility layer
psql -d medcrm -f migrations/002_enum_to_lookup.sql           # 4. admin-editable lookup tables
psql -d medcrm -f migrations/003_followups_optional_customer.sql  # 5. follow-ups on unmatched leads
psql -d medcrm -f migrations/004_remove_super_admin.sql       # 6. two roles: admin, caller
```

Migrations run **after** seed.sql. `001` initializes the order-number sequence past any orders
already present; `002` converts the workflow enums to lookup tables (the seed's enum values are
carried over as lookup rows). On a fresh DB with no seed, skip step 2 — the rest is unchanged.

> **Demo logins work straight from the seed.** `seed.sql` contains real bcrypt digests for
> `admin123` (the three admin accounts) and `caller123` (the five caller accounts). They were
> previously placeholders that only looked like bcrypt strings, so a database built by
> following these steps could not be logged into at all.
> `kavya.reddy@medicrm.in` is seeded **inactive** on purpose, for negative-login testing.
>
> The seed uses values that satisfy the constraints in every migration state, so it can load
> before the migrations. Only the order-number **sequence** cares about ordering, which is why
> `001` runs after `seed.sql`.

## What each file is

| File | Purpose |
|---|---|
| `schema.sql` | The canonical schema — extensions, lookup enums, 13 tables, partitions, indexes, triggers, RLS policies, views, materialized views. Heavily commented. |
| `seed.sql` | Realistic sample data (Indian names/cities/medicines): 8 users, 7 customers, 6 products, 15 leads, 6 orders, etc. |
| `migrations/001_app_reconciliation.sql` | Reconciles the schema with the *actual running app*: accepts the app's phone format, makes convert-lead-to-order executable. See `RECONCILIATION.md`. |
| `migrations/002_enum_to_lookup.sql` | Converts the 7 business-workflow enums (lead status/priority/source, order stage, payment status, follow-up type/status) to **admin-editable lookup tables** — add/retire values with no deploy. System enums (roles, notification types, etc.) stay native. |
| `migrations/003_followups_optional_customer.sql` | Makes `follow_ups.customer_id` nullable so a follow-up can be scheduled on a lead not yet matched to a customer. |
| `migrations/004_remove_super_admin.sql` | Removes the `super_admin` role. **Admin** becomes the top role with full access (incl. managing other admins); **caller** is unchanged. Redefines the RLS role predicates, simplifies the escalation guard, and drops `super_admin` from the `user_role` enum. |
| `design-notes.md` | Engineering-facing writeup of the key architectural decisions. |
| `erd.mmd` | Mermaid ER diagram (paste into any mermaid renderer). |
| `VERIFICATION.md` | What was executed/tested, and the 3 bugs real execution caught. |
| `RECONCILIATION.md` | App-behavior ↔ schema gap analysis and the fixes. |
| `review-findings.json` | The 36 raw findings from the 5-lens adversarial review. |
| `tests/rls_test.sql` | 12 Row-Level Security regression tests (run as `app_user`). |
| `tests/reconciliation_test.sql` | Verifies the app-format inserts and convert-to-order flow. |
| `tests/lookup_test.sql` | Verifies enum→lookup: runtime add, FK rejection of bad values, retire, follow-up on unmatched lead. |
| `tests/lookup_rls_test.sql` | Verifies callers can read but not edit lookups; admins can (run as `app_user`). |
| `_archive/` | The 3 independent design drafts + pre-review synthesis (provenance). |

## Connecting the application

The app tier connects as the single pooled role **`app_user`** (never a superuser). Per request,
after authenticating the user, set the session context once per transaction:

```sql
SELECT set_app_session('<authenticated-user-uuid>');  -- derives role server-side from users table
```

Row-Level Security then enforces the two roles automatically: **admin** (top role — full access,
manages all users, leads, orders, etc.) and **caller** (own assigned leads / own profile only).
Do **not** set `app.current_role` yourself — `set_app_session()` derives it from the trusted
`users` row so a client can't spoof its own role.

The lead→order conversion the frontend does client-side should call:

```sql
SELECT convert_lead_to_order('<lead-uuid>');   -- returns the new order id
```

## Before production

- Install `pg_cron` (or wire an external scheduler) for monthly partition creation and
  materialized-view refresh — the schema warns about this on load.
- Change the `app_user` password (schema ships a placeholder) and store it in a secrets manager.
