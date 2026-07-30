# Automated test strategy

How MediCRM gets a durable test suite. Companion to `docs/TEST_PLAN.md`, which stays the
behavioural spec (731 manual UAT cases); this document covers what gets automated, in what
order, and the traps that make naive approaches fail here.

## Why now

The raw-pg → Prisma migration (migrations 016–017) moved authorization out of PostgreSQL
RLS and into application code (`server/src/scope.ts` + `server/src/scopedPrisma.ts`). The
database no longer filters rows. Every guarantee that used to be enforced by 71 RLS
policies is now enforced by TypeScript that has **no automated test covering it**.

The migration was verified by ~73 assertions written as throwaway scripts in a session
scratchpad. Those are gone. Phases 0–2 below replace them with 119 committed tests that
run in ~4s against an isolated database.

## Current state

| | |
|---|---|
| Test runner | Vitest ✅ — `npm --prefix server test` |
| Suites | Phase 1 ✅ (48) · Phase 2 ✅ (71) · Phase 3 ✅ (50) · Phase 4 ✅ (26) — 195 tests, ~20s |
| Test database | `medcrm_test` ✅ — `npm --prefix server run test:db` |
| Reset tooling | `server/scripts/reset-test-data.ts` ✅ (dev DB) |
| Typecheck | `npm --prefix server run typecheck` ✅ — covers `tests/` |
| Dev baseline | leads=16 users=9 orders=8 renewals=6 products=25 follow_ups=13 |
| Test fixture | leads=15 users=8 orders=6 renewals=6 products=6 follow_ups=8 (pure seed) |

`server/scripts/verify_scoped_prisma.ts` has been **removed** — its 13 assertions are now
in `tests/scopedPrisma.test.ts`, which covers all 11 scoped models rather than 4.

`server/src/app.ts` exports `app`; `src/index.ts` owns the `listen`. The API is already
supertest-ready with **no refactor required**.

---

## Four constraints that must shape the design

These are not hypotheticals — each one has already caused a real failure.

### 1. Test residue is invisible to name patterns

Cleaning up by `customer_name LIKE 'TEST%'` is insufficient. Tests that call
`POST /renewals/:id/renew`, `DELETE /renewals/:id`, or `PATCH /notifications/:id/read`
mutate **seed rows**, leaving residue with no name to match on. Verifying the migration
required hand-restoring renewals and a notification flag by diffing `db/seed.sql`.

`reset-test-data.ts` already handles both classes and is idempotent — a second run reports
`deleted: nothing  restored: nothing`. **Every suite must run it before and after.**

### 2. The baseline was polluted, and silently

Before this work, "38 medicines" was the assumed baseline. 13 of those rows were
`Test Inactive Med` junk from a UAT session on 2026-07-24. The real catalogue is **25**
(7 pharma + your 18 Ayurvedic products). Assertions had been passing against a number that
was partly test debris.

A baseline that drifts silently is worse than no baseline. Phase 0 pins it and asserts it.

### 3. Date-derived assertions rot on a schedule

`db/seed.sql` uses absolute 2026 dates, while renewal status, follow-up status and every
dashboard period bucket derive from `now()`:

- "Leads created this month" reads **9** today (2026-07-31) and **0** tomorrow.
- Renewal statuses flip as expiry dates pass.

The test seed must use **relative dates** (`now() - interval '26 days'`) so the fixture
holds the same shape whenever it runs. Without this, Phases 3–4 fail on a calendar.

### 4. Per-test transaction rollback is unavailable

The usual trick — wrap each test in a transaction, roll back — **does not work here**.
`withDbSession()` opens its own `$transaction`, and Prisma has no nested interactive
transactions. Isolation must come from a dedicated database plus reset, not rollback.

---

## Phases

### Phase 0 — Harness ✅

Runner: **Vitest**. ESM-native (server is ESM under `tsx`), shares transform pipeline with
the Vite 8 frontend, no extra TS config.

| Deliverable | Path | Status |
|---|---|---|
| Runner config | `server/vitest.config.ts` | **done** |
| Test DB builder | `server/scripts/build-test-db.ts` | **done** |
| Relative-date seed | `db/seed.test-shift.sql` | **done** |
| Safety guard | `server/tests/setup.ts` | **done** |
| Reset between suites | `server/scripts/reset-test-data.ts` | **done** |

The seed is *shifted*, not forked: `seed.test-shift.sql` slides every timestamp by
`(CURRENT_DATE - anchor)` so `db/seed.sql` stays the single source of truth.

The builder must create `app_prisma` with `BYPASSRLS` and apply **016 and 017**. A test DB
with RLS still enabled behaves differently from production and would mask exactly the class
of bug this suite exists to catch.

Pin `TZ=Asia/Kolkata` in the runner config — a UTC runner silently changes every
date-derived assertion.

### Phase 1 — Authorization units (no DB, milliseconds) ✅ 48 tests

`scope.ts` is pure functions returning Prisma where-fragments — the highest
value-per-effort target in the codebase, because it *is* the replacement for 71 RLS policies.

- Every scope (`leadScope`, `renewalScope`, `orderScope`, `orderItemScope`,
  `customerScope`, `followUpScope`, `userScope`, `notificationScope`, `leadChildScope`)
  × admin and caller. Admin must return `{}`; caller must return the documented predicate.
- Every assertion helper: `requireAdmin`, `assertLeadAssignable`, `assertCanEditUser`,
  `assertOwnsNotification`, `assertFollowUpAssignable`.
- `serializers.ts`: `istDayDiff` across month/year rollover and midnight edges.

### Phase 2 — `scopedPrisma` integration (DB, no HTTP) ✅ 71 tests

Phase 1 proved `scope.ts` computes the right predicate. This proves `scopedPrisma.ts`
applies it to every query — a separate failure mode, since a correct predicate that never
reaches the `where` clause protects nothing.

- Scope injection across **all 11 scoped models** × both roles, asserting the extension's
  result equals the same query with the scope passed explicitly.
- A separate "actually narrows" group asserts caller < admin and caller > 0, so the parity
  assertions above cannot pass vacuously.
- Fail-closed guards: `upsert` refused; every write outside `withDbSession` refused.
- Structural: all 23 models/views driven through the extension, so an unclassified table
  fails CI rather than throwing in production.
- Regressions: `findUnique` survives `where.AND` injection; a lazy `PrismaPromise` returned
  from an arrow still runs inside the session.

Mutation-checked: disabling injection fails 26 tests, removing the write guard fails 3,
removing the upsert refusal fails 1.

### Phase 3 — API surface (supertest) ✅ 50 tests

The authz matrix: **19 mutating + 8 read endpoints × 2 roles**, asserting status *and* that
a forbidden write left no trace.

- Read parity against the pinned baseline.
- Masked-404 semantics (`PATCH /orders/:id` as caller → 404, not 403).
- Error mapping: P0001→403, unique→409, FK/check→400, P2025→404, and the **P2010 unwrap**
  that keeps trigger rejections at 403 rather than 500.

Two conventions the suite pins deliberately:

- A refused write is asserted **both** by status code and by re-reading the row. A 403 that
  still wrote is exactly the failure this suite exists to catch, and status alone cannot
  tell the difference.
- Some refusals are 404 rather than 403 (`PATCH /orders/:id` as a caller). That is the
  RLS-era masking convention, preserved through the migration, so it is pinned rather than
  "fixed".

Request shapes are easy to get wrong and produce misleading passes — `POST /users` takes
`name`/`phone` (not `fullName`), `/leads/:id/follow-ups` takes `scheduledDate` (not
`scheduledAt`), `PATCH /auth/password` returns **204**, and `/auth/me` nests its payload
under `user` while `/auth/login` returns `{ token, user }`. All five cost a debugging cycle;
they are centralised in `tests/helpers/api.ts`.

Isolation differs from Phase 2: Phase 3 genuinely mutates, so `tests/globalSetup.ts`
rebuilds `medcrm_test` once per run rather than relying on a snapshot canary.

`db/seed.sql` used to ship placeholder password hashes — strings that looked like bcrypt but
were not digests of anything — so a database installed per `db/README.md` could not be
logged into, and every API test returned 401. The hashes are now real, and the builder
**verifies** them rather than overwriting them, so the credentials live in one place and a
future drift fails with a clear message instead of 50 unexplained 401s.

`npm test` runs `tsc -p tsconfig.test.json` before Vitest, so the suite cannot run with a
type error in it. That gap is how an invalid `activity_type` reached a passing test.

Mutation-checked: removing `set_app_session()` from `withDbSession` — the exact
vulnerability that was live during the migration — fails 5 tests; removing the P2010 unwrap
fails 4; removing the orders admin gate fails 1.

### Phase 4 — SQL/TS parity ✅ 24 tests

The class of bug that ships silently, because nothing crashes. Every test compares two ways
of computing the same thing **at the same instant**, so the suite is order-independent —
`api.test.ts` runs first in the same database and leaves rows behind.

- `serializeRenewal` vs `renewals_view`, row by row. The route no longer reads the view, so
  nothing else would notice the TypeScript reimplementation drifting.
- Dashboard scalars, period buckets and `salesByCaller` vs independently written SQL.
- Materialized views vs live data after a refresh — proving the *definitions* are right,
  separately from staleness.
- Search scoping. `global_search` is classified GLOBAL, so the extension does **not** filter
  it; `misc.ts` re-checks candidates by hand, and that hand-rolled filter is the only thing
  protecting it.
- Schema drift, in both directions. A plain `prisma db pull` diff cannot be the check — it
  would undo the hand curation (re-adding partition children, rewriting the `renewals_view`
  edit). Instead the schema **file** is parsed and compared field-by-field against the live
  catalog. The file, not the runtime dmmf: Prisma omits `Unsupported(...)` fields from the
  client, which made the four `tsvector` columns look absent when they are declared.

**Two findings, both acted on:**

1. *The database timezone was never pinned.* `compute_renewal_status()`,
   `renewals_view.days_remaining` and the dashboard's period boundaries all use
   `CURRENT_DATE`, evaluated in the **server's** timezone, while `serializers.ts` is
   explicitly IST. They agreed only because this machine's OS is IST. On a UTC host — the
   default for most CI runners and cloud databases — they disagree for the first 5.5 hours of
   every IST day: a renewal could read `overdue` in one place and `due_today` in the other.
   Migration **018** pins it at the database level so every consumer inherits it, and the
   invariant is now asserted.

2. *The admin dashboard contradicted itself.* `totalLeads` was read live through Prisma,
   while an admin's `leadStatusBreakdown` and `callerPerformance` came from materialized
   views the scheduler refreshes every 5 minutes. Between a write and the next refresh an
   admin saw a breakdown that did not sum to the total printed beside it, and per-caller
   figures that ignored the lead just created. Callers were unaffected — their branch was
   already live.

   **Fixed:** both are aggregated live for every role now. The breakdown collapses onto the
   query the caller branch already used — the scoping extension supplies the role difference,
   so one code path serves both instead of two that could drift. `callerPerformance` became a
   live query mirroring the matview's definition for the three fields the API returns, and
   now sits alongside `salesByCaller`, which was already live.

   The matviews are kept and still refreshed: nothing on the request path reads them, but a
   matview nothing refreshes is a worse trap than one nothing reads, since the next person to
   query it gets stale numbers with no indication. `scheduler.ts` says so explicitly.

Mutation-checked: deriving renewal dates in UTC fails the TS/SQL parity test; dropping the
`renewed_at` filter from `renewalsDue` fails the dashboard comparison; a migration adding a
column names it exactly (`leads.probe_drift_col exists in the database but not in
schema.prisma`).

### Phase 5 — Frontend

**Playwright E2E** over component tests: login → 6 pages → one write each, both roles.
It covers the admin/caller gating that currently requires manual checking.

Note: the in-app browser pane does not composite reliably here — pixel clicks silently fail
and `form_input` does not trigger React's controlled-input state. Verification had to be
driven through injected JS. **Playwright launches its own browser and is unaffected**, so
this is a constraint on ad-hoc checking, not on the E2E suite.

### Phase 6 — CI

Single `npm test` at root fanning out to both packages; test DB built in CI; `TZ` pinned;
migration replay on a clean DB as a separate job.

---

## Regression catalogue

Each row is a real bug found during the migration. Each becomes a named test.

| Bug | Phase | Why it mattered |
|---|---|---|
| Caller could set own role to `admin` (HTTP 200) | 3 | Trigger disarmed by NULL session GUC |
| Caller could soft-delete own lead (204) | 3 | Same root cause |
| `audit_log.changed_by` written NULL | 3 | Silent loss of attribution |
| Lazy `PrismaPromise` escaped the ALS scope | 2 | Broke legitimate writes |
| `AND`-wrapping broke `findUnique` | 2 | Would 500 every by-id read |
| P2010 masked SQLSTATE → 403 became 500 | 3 | Wrong status on every trigger rejection |
| Renewal status derived in TS ≠ SQL view | 4 | Silent data divergence |
| 13 test products inflating the catalogue | 0 | Baseline drift went unnoticed for weeks |

## Sequencing

Effort is front-loaded: Phase 0 carries the risk, Phases 1–4 are mechanical once a clean DB
exists per run. **Phase 3 before Phase 0's isolation is worse than nothing** — it mutates
seed data, which is how the polluted baseline happened in the first place.

Phases 1 and 2 are the highest value per hour: they cover the RLS replacement directly and
need no HTTP layer.

## Known gaps this suite does not close

- `maintPool` needs superuser in the test DB for `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- Partitioned tables (`notifications`, `lead_activities`, `audit_log`) need
  `ensure_monthly_partition()` run for the test window or inserts fail.
- Three duplicate `Krishna` user rows share one email (two soft-deleted). Real data, not
  test residue — left alone deliberately, but worth a decision.
