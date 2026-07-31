# MediCRM — backend

Node + Express + Prisma + PostgreSQL. Prisma owns the schema outright.

## Setup

```bash
npm install
cp .env.example .env          # then set your Postgres password
npx prisma migrate dev        # creates the schema
npm run db:seed               # lookups, users, catalogue, demo pipeline
npm run dev                   # http://localhost:3001
```

Demo logins: `aarav.sharma@medicrm.in` / `admin123` (admin),
`sneha.iyer@medicrm.in` / `caller123` (caller).
`kavya.reddy@medicrm.in` is seeded inactive on purpose, for negative-login tests.

## Design

There is no procedural code in the database — no triggers, functions, stored procedures or
RLS. All behaviour lives in TypeScript, which means one place to read, one place to test,
and no rule that can be bypassed depending on how a connection was opened.

Deliberately not carried over from the previous schema:

| | why |
|---|---|
| Table partitioning | 3 tables cost 208 child partitions and a scheduler job. Retention is a delete. |
| `tsvector` + GIN | Search is indexed case-insensitive matching. |
| `citext` | Email is lowercased on write with a plain unique index. |
| `GENERATED` columns | `lineTotal` and `payableAmount` are computed in the order service. |
| RLS (71 policies) | Authorization is `src/auth/scope.ts`, applied by a client extension. |

The trade this accepts: nothing below the application enforces anything, so a bug in the
TypeScript is a data-integrity bug with no backstop. The test suite is the guard.

Seed dates are relative to `now()`, never absolute — the previous seed's fixed 2026 dates
made every date-derived assertion change meaning as the calendar moved.
