# MediCRM — Project Handoff

A medical distribution CRM built end-to-end in this repo: PostgreSQL schema with row-level
security, an Express/TypeScript API, and a React/TypeScript frontend. This document is a
full account of what's been built, why, and the traps already found and fixed — written so
a new agent (or human) can pick this up without re-discovering the same bugs.

## What this app does

Two roles — **Admin** (sees/manages everything) and **Caller** (sees/manages only their own
assigned leads, orders, renewals, follow-ups, notifications) — run a pipeline:

**Lead** (customer intake, with a disease and medicines) → **convert to Order** (creates a
customer record + order + order lines, deducts stock) → **Renewal** tracking for repeat
medicine cycles. Alongside: a medicine/stock catalog, user management, a calendar of
follow-ups, and a dashboard with live + materialized-view stats.

Authorization is enforced by **PostgreSQL RLS**, not just hidden UI buttons — several test
cases in `docs/TEST_PLAN.md` exist specifically to prove the server rejects an action a
Caller shouldn't be able to take even when the button is still visible/clickable for them.

## Tech stack (exact versions in use)

| Layer | Tech | Version |
|---|---|---|
| Frontend | React | 19.2.7 |
| | React Router DOM | 7.18.1 |
| | Vite | 8.1.4 |
| | Tailwind CSS | 4.3.2 |
| | TypeScript | 6.0.3 |
| Backend | Node.js | v24.11.1 |
| | Express | 5.2.1 |
| | pg (node-postgres) | 8.22.0 |
| | bcryptjs | 2.4.3 |
| Database | PostgreSQL | 18.3 |

## Repo layout

```
db/
  schema.sql          — original base schema (FROZEN — later migrations do NOT get
                         back-edited into it; read schema.sql + migrations 001-012
                         together to know the live shape of a table)
  seed.sql            — demo seed data
  migrations/          001-012, applied in order (see "Migration history" below)
  README.md           — install order or a clean DB
server/
  src/
    app.ts            — route mounting, express.json, error middleware last
    db.ts             — appPool / maintPool / withUserTx (the correctness core)
    auth.ts           — bearer token auth, login/logout/me, changePassword
    errors.ts         — pg-error-code → HTTP-status mapping + friendly constraint messages
    serializers.ts    — snake_case DB rows → camelCase frontend shapes
    scheduler.ts       — matview refresh / partition creation / session cleanup, on a timer
    routes/           — one router per resource
  scripts/
    dev-setup.ts      — resets app_user password + seed users' bcrypt hashes, refreshes matviews
    clean_test_leads.ts — deletes leads matching known test-data name patterns
src/
  api/                — one thin fetch-wrapper module per resource, mirrors server/src/routes
  context/AppContext.tsx — global reducer-based state + loadAll() hydration on login/boot
  pages/              — one file per route
  components/ui/      — Button, Modal, Badge, StatusBadge, SearchableSelect, Toast, etc.
docs/TEST_PLAN.md     — 731-case UAT plan with a Known Limitations section (read this before
                         assuming something is "missing" — it may already be documented)
```

## Running it locally

```bash
# from repo root, once:
npm install
npm --prefix server install

# Postgres must already have the `medcrm` database built from db/schema.sql + db/seed.sql +
# migrations 001-012 in order (see db/README.md). Then:
npm --prefix server run setup      # resets demo passwords, refreshes matviews

# day to day:
npm run dev:all                    # concurrently runs Vite (5173) + API (3001)
```

Demo logins (seeded): `aarav.sharma@medicrm.in` / `admin123` (Admin), `sneha.iyer@medicrm.in` /
`caller123` (Caller), `kavya.reddy@medicrm.in` / `caller123` (deliberately deactivated, for
negative-login testing).

**`.claude/launch.json` has two separate configs, `dev` (5173) and `api` (3001) — do not
merge them back into one `dev:all` config.** The harness injects a `PORT` env var matching
each config's own `port` field; under one shared config, `concurrently` leaks that value into
*both* child processes, so the backend picks up the frontend's port and the two collide. This
was hit and fixed once already — see "Gotchas" below.

## Architecture

- **Two `pg.Pool`s** (`server/src/db.ts`): `appPool` (role `app_user`, RLS enforced) for
  every request-path query via `withUserTx(userId, fn)` — `connect → BEGIN → SELECT
  set_app_session($1) → fn(client) → COMMIT/ROLLBACK → release`. GUCs set this way are
  transaction-local, so the pool is safe to reuse across requests. **Never `pool.query`
  directly for authed reads** — it silently returns 0 rows since no session context is set.
  `maintPool` (role `postgres`) is scheduler-only, for matview refreshes that regular
  RLS-bound queries can't do (matviews carry no RLS policies).
- **Auth**: opaque bearer token, stored server-side as `'sha256:' + sha256(token)` in
  `sessions`. `requireAuth` middleware resolves it via a `SECURITY DEFINER` helper
  (`auth_session_lookup`) since RLS would otherwise block reading `users`/`sessions` before
  any session context exists.
- **Authorization = RLS**, not app code. Route handlers just interpret what RLS already did:
  a 0-row UPDATE/DELETE → 404 ("masked not found" — the row exists, RLS just filtered it
  out); a trigger `RAISE EXCEPTION` (P0001) → 403; unique/check/FK violations → 409/400/400.
  See `server/src/errors.ts` for the full pg-code table and the friendly per-constraint
  message map.
- **Two lookup-table patterns coexist** in this schema — don't assume one when reading code:
  some fields (lead status, lead source, order stage, payment status, follow-up type/status)
  are `text` columns with an FK to a small `*_statuses`/`*_types` lookup table (migration 002
  converted these from native enums). `dosage_form` on `products` is still a plain nullable
  text with no lookup table. `lead_priority` used to be one of these lookup-backed columns
  too, until migration 012 removed it entirely (see below) — if you see it mentioned in
  `schema.sql`'s comments or in `db/erd.mmd`, that documentation is now stale for this column.
- **`schema.sql` is never edited by later migrations.** If you need to know a table's *live*
  shape, read `schema.sql` and then mentally apply every migration in `db/migrations/` in
  order — several columns (`disease`, `stock_quantity`) exist live but aren't in `schema.sql`,
  and one column (`priority`) is in `schema.sql` but no longer exists live.

## Migration history (001-012)

| # | What it did |
|---|---|
| 001 | Initial app/DB reconciliation fixes found while building the backend |
| 002 | Converted several enums to lookup tables (`lead_statuses`, `lead_sources`, etc.) |
| 003 | Made follow_ups.customer_id optional |
| 004 | Removed the `super_admin` role (just `admin`/`caller` now) |
| 005 | Added `lead_medicines` child table (replaces the old single medicine_required/quantity columns on `leads`); rewrote `convert_lead_to_order()` to loop over it |
| 006 | `SECURITY DEFINER` helpers for login/session lookup (RLS can't run before a session exists) |
| 007 | **Critical security fix** — `renewals_view`/`global_search` were non-`security_invoker` views owned by a superuser, completely bypassing RLS. Verified empirically (a Caller session saw all rows, not just their own) before and after the fix |
| 008 | `resolve_or_create_customer_for_lead()` helper for the follow-up-scheduling flow |
| 009 | Granted the `product_sku_seq` sequence to `app_user` (medicine creation was failing with "permission denied for sequence") |
| 010 | Added `products.stock_quantity`; `convert_lead_to_order()` now decrements it per converted medicine line, floored at 0 (never blocks the sale — a pharmacy fulfills and restocks, it doesn't refuse a sale over a stale counter) |
| 011 | Added `leads.disease` (free text) — the new required intake field, replacing the old "medicines chosen at creation" flow |
| 012 | **Removed `leads.priority` entirely** — column, both indexes that referenced it, `lead_priorities` lookup table, and rebuilt `mv_lead_status_breakdown` without it (the dashboard's own query already aggregated that view with `GROUP BY status` only, ignoring priority, so this was a no-op for actual dashboard output) |

## Feature history (chronological, why things are the way they are)

1. **Phases 0-3 (initial build)** — DB migrations, Express scaffold + auth, all API
   endpoints, then wired the (previously mock-data) frontend to the real API.
2. **Error handling pass** — real toast notifications (`src/lib/toast.ts` + `Toast.tsx`), a
   top-level `ErrorBoundary`, and a `client.ts` fix: the 401-auto-logout handler used to fire
   on *every* 401 including a wrong-password login attempt, discarding the backend's actual
   "Invalid email or password" message.
3. **Password setup** — admin sets a password directly when creating a user; self-service
   change-password lives in the TopNav profile menu (`PATCH /api/auth/password`).
   Forgot-password was explicitly deferred, not built.
4. **UAT test plan** (`docs/TEST_PLAN.md`) — 731 cases across 19 areas, generated by a
   multi-agent workflow then hand-verified against the live DB (4 factual errors in the
   initial draft were caught and corrected this way — the draft cited `schema.sql`'s stale
   text instead of accounting for later migrations; don't repeat that mistake).
5. **Stock management** (migration 010, `src/pages/Stock.tsx`) — "Medicines" became "Stock":
   an admin can **Add Stock** (increment) or **Set Exact Amount** (absolute correction) per
   item, and `convert_lead_to_order()` deducts stock automatically per converted medicine
   line. 18 real Ayurvedic product names were added to the catalog with a deliberate ₹0
   placeholder price and 0 opening stock (never guess real business pricing data) — those
   need real prices/quantities filled in via the Stock page.
6. **Lead redesign** (migrations 011-012) — "remove the medicine section from the lead,
   replace with disease, add medicine via a comment instead": leads now capture a disease at
   creation (medicines are still choosable at creation too, per a later follow-up request —
   see below) and can also grow their medicine list one at a time by attaching a
   `{name, days}` to a comment on the Lead Detail page (`POST /leads/:id/activities` accepts
   an optional `medicine` field now, alongside `description`). Priority was removed
   everywhere in the same pass (see migration 012).
7. **Lead detail audit** — the user asked "why can't we change a lead's status" and then
   asked for the same audit applied to *every* section on the lead, which surfaced three
   real, pre-existing gaps: (a) **Edit** button on Lead Detail just navigated to `/leads` and
   did nothing else useful — fixed by navigating with `{ state: { editLeadId } }` and having
   the Leads list auto-open that lead's edit modal on mount, rather than duplicating the
   whole form on the detail page; (b) **Notes** existed end-to-end in the DB/API/backend but
   was never shown or editable anywhere in the UI; (c) **status** could only ever change via
   "Convert to Order" (hardcoded to `'converted'`) — there was no way to move a lead through
   Contacted/Follow-up Pending/etc. Added a status `<select>` on Lead Detail (excludes
   `'converted'` deliberately — that transition should only happen via the real conversion
   flow, which also creates the order) plus Status and Next Follow-up fields inside the
   Edit Lead modal itself (shown only when editing, not creating, since a new lead always
   starts at `'new'` with nothing scheduled yet).
8. **A real bug found while testing #7** — the Disease field (and the first Medicines
   Required row) were marked `required` in the *shared* create/edit form. Editing any lead
   that predates that field (i.e. has no disease yet) silently failed to save: the browser's
   native HTML5 validation blocked the submit and refocused the empty required field instead
   of calling `onSubmit` — which looks *exactly* like a missed button click in browser
   automation (several retries were wasted on this before spotting the real cause). Fixed by
   making both `required={!editingLead}` — only required when creating, not editing. A
   related landmine fixed in the same pass: the edit payload used to always send a
   `medicines` array (empty if the row was blank), and the backend treats a *present*
   `medicines` key on `PATCH /leads/:id` as "replace all of them" — so saving an edit on a
   disease-only lead with medicines added later via a comment would have silently wiped them
   out. Fixed by only including `medicines` in the payload when there's actually something in
   it.

## Known limitations (do not "fix" these without checking `docs/TEST_PLAN.md` first)

The test plan's Known Limitations section (search that file for the heading) documents
several already-understood, deliberate-or-accepted gaps as of when it was written — e.g. no
lockout on repeated failed logins, Users has no delete/status-toggle confirmation dialog,
Orders has no per-record deep-link URL. Some of these (Lead Detail's broken Edit button,
missing Notes UI) have since been fixed in this session (see #7 above) — the test plan
itself has **not** been re-generated to reflect that, so treat its Known Limitations list as
partially stale, not gospel. When in doubt, check current code, not old docs.

## Gotchas already hit once — don't re-discover these

- **Port collision via shared launch config** — see "Running it locally" above. Each dev
  process needs its own `.claude/launch.json` entry with its own `port`.
- **RLS bypass via non-`security_invoker` views** — any new view/matview that queries
  RLS-protected tables must either declare `security_invoker = true` or be understood as
  intentionally bypassing RLS (matviews always bypass RLS; that's why the scheduler's
  refresh runs on `maintPool` and the app-layer route code-gates matview reads to admin only).
- **Required-field validation across create AND edit** — any field added to a shared
  create/edit form must have its `required` attribute (and any "at least one X required" JS
  guard) conditioned on `!editingLead`, or editing older data that predates the field becomes
  silently impossible. This bit twice already (Disease, Medicines Required).
- **`PATCH` semantics for child-table arrays** — if a resource's PATCH endpoint treats "array
  key present" as "replace the whole child collection" (as `leads.medicines` does), never
  build a payload that includes that key with an empty array unless you actually mean to wipe
  it — omit the key entirely when there's nothing new to send.
- **`schema.sql` is stale by design** — always cross-reference the migration list before
  trusting a column's type/nullability/existence from `schema.sql` alone.
- **Don't guess real business data** — when asked to add real product/customer data with
  unspecified prices or quantities, add it with an explicit placeholder (₹0, 0 stock) and
  say so plainly, rather than inventing plausible-looking numbers.

## Git history

Ten commits so far, in order: project scaffolding → DB schema/migrations → backend →
frontend → test plan docs → three chore commits (launch-config split, a maintenance script,
dead-code removal) → stock management feature → the lead disease/priority/status/notes
redesign described above. Run `git log --oneline` for the exact list; each commit message
explains its own scope in more detail than this document repeats.
