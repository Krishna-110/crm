# Verification Report

This schema was not just generated — it was **actually executed** against a real local PostgreSQL 18.3 instance (`medcrm` database) to catch the class of bug that static/LLM-only review cannot: real parser errors, real constraint violations, and real aggregation logic mistakes.

## What was run

1. `schema.sql` executed top-to-bottom via `psql -v ON_ERROR_STOP=1` — **exit code 0**.
2. `seed.sql` loaded (after fixing two bugs found during the run — see below) — **exit code 0**, 11 tables populated.
3. `tests/rls_test.sql` — 12 explicit Row-Level Security test cases, run as the actual `app_user` role (not `postgres` superuser, which bypasses RLS entirely).
4. Materialized views refreshed and spot-checked against a ground-truth `COUNT(*)` query.
5. The `global_search` view queried to confirm full-text search works.
6. `audit_log` checked to confirm change tracking fires correctly.

## Bugs found and fixed during verification

Real execution surfaced three genuine bugs that survived the 5-lens adversarial review untouched:

### 1. Seed data assigned a lead to an inactive user
`schema.sql`'s own `check_leads_assigned_caller_active()` trigger correctly rejected it: *"leads.assigned_caller_id may not reference an inactive or deleted user."* Two leads and one follow-up in `seed.sql` pointed their `assigned_caller_id` at the one intentionally-inactive demo caller. Fixed by reassigning those to active callers — this is exactly the trigger doing its job; the schema was right, the seed data was wrong.

### 2. Seed data used the wrong enum
`seed.sql` set a `follow_ups.type` value to `'follow_up'` — a value that only exists in the *separate* `lead_activity_type` enum, not `follow_up_type` (which is `'call' | 'reminder' | 'callback'`). Postgres correctly rejected it. Fixed to `'call'`.

### 3. `mv_caller_performance` — join fan-out inflated every count (the important one)
The original materialized view joined `leads` **and** `follow_ups` to `users` in the same query before aggregating:

```sql
FROM users u
LEFT JOIN leads l ON l.assigned_caller_id = u.id ...
LEFT JOIN follow_ups f ON f.assigned_caller_id = u.id ...
GROUP BY u.id, u.name
```

Two independent one-to-many joins in the same `GROUP BY` produce a cross product per group: a caller with 4 leads and 4 follow-ups yields 16 joined rows, and `count(l.id)` over those 16 rows reports **16**, not 4. This is syntactically and semantically "normal-looking" SQL — nothing about it looks wrong on a read-through, and it slipped past all 5 review lenses (normalization, indexing, security, scalability, migration-safety) untouched. It was only caught by refreshing the view against real seed data and diffing the result against a direct `SELECT assigned_caller_id, count(*) FROM leads GROUP BY 1` query.

**Fixed** by pre-aggregating `leads` and `follow_ups` independently (each in its own subquery with its own `GROUP BY caller_id`) and joining only the already-aggregated, one-row-per-caller results. General lesson, left as a comment in `schema.sql` at that exact spot: **never aggregate across more than one to-many join in a single `GROUP BY`.**

## RLS test results (all 12 passed)

Run as `app_user` — a role with `rolsuper = false`, `rolbypassrls = false`, so these results reflect what the policies actually enforce, not what a superuser session would see regardless of policy.

| # | Test | Result |
|---|------|--------|
| 1 | No session set → query leads | 0 rows (default-deny) |
| 2 | Caller impersonation (`set_app_session`) → own leads only | 4 of 15, 0 leaked from other callers |
| 3 | Caller selects a specific lead belonging to another caller by ID | 0 rows |
| 4 | Caller `UPDATE`s another caller's lead | 0 rows affected |
| 5 | Caller tries to self-assign a lead they don't own | blocked, 0 rows |
| 6 | Admin queries leads | sees all 15 |
| 7 | Super Admin queries leads + users | sees all 15 leads, all 8 users |
| 8 | Admin queries `users` | sees themselves + all callers, **but not** the other admin or the super admin |
| 9 | Admin tries to demote the super admin's role | blocked, 0 rows |
| 10 | Caller queries `users` | sees only their own row (1) |
| 11 | Caller queries `orders` | sees only orders tied to their own leads (1 of 6) |
| 12 | Inactive user tries to establish a session at all | rejected: *"user ... is not active"* |

Test 12 is stronger than what was originally asked for — the schema doesn't just block *new* assignments to inactive users, it blocks them from authenticating a session at all.

Test 8/9 confirm the specific nuance from the brief that's easy to get wrong: **Admin manages Callers, but not other Admins or the Super Admin.**

## One design decision worth your input

The synthesized schema uses native PostgreSQL `ENUM` types (e.g. `lead_status`, `order_stage`) rather than admin-editable lookup tables, which deviates from the original design brief. This was a deliberate, reviewed trade-off (see the `REVIEW NOTE` comment right above `SECTION 2` in `schema.sql`): the reviewers flagged that renaming/retiring an enum value requires a full `CREATE TYPE ... USING` migration, but the schema's author judged this acceptable because these statuses are *currently* compiled into the frontend's TypeScript unions anyway — a lookup table wouldn't add real runtime flexibility until the frontend itself supports admin-editable statuses. **If you want statuses to be editable from a settings page without a deploy, tell me and I'll convert `lead_status`/`lead_priority`/`lead_source`/`order_stage` to lookup tables** — the migration path is already documented inline.

## Known operational dependency

The schema raises a runtime `WARNING` on load: `pg_cron` is not installed on this instance, so monthly partition creation (`lead_activities`, `notifications`, `audit_log`) and materialized view refresh have no automatic scheduler. This must be wired up before production use — either install `pg_cron`, or run the documented `ensure_monthly_partition(...)` and `REFRESH MATERIALIZED VIEW CONCURRENTLY ...` calls from an external scheduler (cron, a serverless scheduled function, etc.).
