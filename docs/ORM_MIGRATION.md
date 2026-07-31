# Full ORM migration — removing all PL/pgSQL

Goal: the application owns all behaviour. No server-side procedural code — zero PL/pgSQL
functions, zero triggers. Prisma becomes the schema's source of truth.

This is a rewrite, not a refactor. It removes capability as well as code, and the sequencing
matters more than the individual ports.

## Starting point

```
plpgsql functions : 31        partitioned tables : 3  (208 child partitions)
triggers (active) : 98        GENERATED tsvector : 6
RLS policies      : 71 (already disabled)  citext columns : 2
                              CHECK constraints  : 39
                              materialized views : 2
                              GIN indexes        : 7
```

## The one rule that governs sequencing

**A behaviour must never exist in both places at once.** Porting `update_order_total` to
TypeScript while its trigger still fires means the total is computed twice; porting
`log_audit` means every change is recorded twice. So each group is ported *and* its triggers
dropped in the same step, verified by the test suite before moving on.

That is why this proceeds bottom-up by risk rather than by file.

## Where the logic goes

Triggers map naturally onto Prisma Client Extensions — the same mechanism `scopedPrisma.ts`
already uses to inject authorization. A `BEFORE` trigger becomes a mutation of `args.data`; an
`AFTER` trigger becomes work performed after `query(args)` resolves, inside the same
transaction.

Multi-statement routines (`convert_lead_to_order`, `resolve_or_create_customer_for_lead`)
become ordinary service functions wrapped in `withDbSession`.

## Phases

Each ends green on `npm test` (195) and `npm run test:e2e` (40) before the next begins.

### 1. Mechanical stamps — lowest risk
`set_updated_at` (20 tables), `set_notification_read_at`, `normalize_leads_mobile`,
`normalize_customers_primary_mobile`, `normalize_indian_mobile`.

Pure field derivation with no cross-row reads. Idempotent, so a mistake is visible
immediately rather than corrupting data.

### 2. Snapshot synchronisation
`sync_customer_name_snapshot` (3 tables), `sync_renewal_order_date`,
`sync_renewal_product_snapshot`, `sync_followup_assigned_caller`,
`sync_followup_caller_from_renewal`.

Denormalised copies kept in step with their source. Each needs one extra read.

### 3. Derived aggregates
`update_order_total`, `maintain_assigned_leads_count`.

First `AFTER` triggers with cross-row writes. Both must run in the same transaction as the
change that caused them, or a failure leaves the aggregate wrong.

### 4. Referential validation
The eight `check_*_active` / `check_*_consistency` guards, plus `assert_active_user` and
`assert_active_product`.

These currently raise P0001 and surface as 403/400. Moving them to app code changes *where*
they fail, not what the client sees — the API tests pin that.

### 5. Security enforcement — the highest-stakes step
`prevent_privilege_escalation`, `prevent_caller_lead_lifecycle_changes`,
`check_caller_lead_customer_link`, `sync_lead_assignment_history`, `log_audit`.

These are the last enforcement below the application layer. Earlier in this project a caller
could make themselves an admin precisely because these stopped firing — they caught a bug the
TypeScript had. After this step nothing catches that class of bug except the test suite, so
the existing regression tests for escalation, own-lead deletion and audit attribution are the
acceptance criteria, and `set_app_session` / `withDbSession` can only be removed once these
are gone.

### 6. Business transactions
`convert_lead_to_order`, `resolve_or_create_customer_for_lead`, `compute_renewal_status`.

The largest single unit: conversion creates a customer, an order, order lines, and deducts
stock. Becomes a service function in one interactive transaction.

### 7. Schema ownership
The point of no return. `prisma migrate` takes over from `db/migrations/*.sql`.

Deliberately lost, with replacements:

| Feature | Today | After |
|---|---|---|
| Partitioning (3 tables, 208 partitions) | monthly range partitions | plain tables |
| Full-text search | `tsvector` + 7 GIN indexes | Prisma full-text search or `contains` |
| `citext` email | case-insensitive type | lowercased on write + unique index |
| 39 CHECK constraints | database-enforced | application validation |
| 2 materialized views | scheduled refresh | live queries (already migrated) |
| `ensure_monthly_partition` | scheduler job | removed with partitioning |

### 8. Teardown
Drop every remaining function, delete `db/schema.sql` and `db/migrations/`, remove
`maintPool` and the scheduler's partition work, and rewrite the docs.

## Accepted consequences

- **No enforcement below the application layer.** A bug in TypeScript is a data-integrity
  bug with nothing behind it. This was chosen knowingly.
- **A direct database write bypasses every rule** — no triggers, no CHECKs, no RLS. Anything
  that is not this application must not write to this database.
- **Search quality drops.** Ranked, weighted full-text matching becomes substring matching
  unless Prisma's full-text support proves sufficient.
- **`audit_log` and the partitioned history tables lose partitioning**, so retention becomes
  a delete job rather than a partition drop.
