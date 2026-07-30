/**
 * Phase 4 — SQL/TypeScript parity.
 *
 * The bugs this targets do not crash and do not 500. Two implementations of the same rule
 * drift apart and the numbers quietly stop agreeing.
 *
 * The migration created several of these by construction. Prisma 7 forbids @id on views and
 * reports every view column as nullable, so `renewals_view` became unusable and
 * serializeRenewal() reimplements `compute_renewal_status()` in TypeScript. The dashboard
 * reads some figures live through Prisma and others from materialized views. Nothing links
 * those implementations together except the assertions below.
 *
 * These tests are written to be order-independent: each compares two ways of computing the
 * same thing AT THE SAME INSTANT, rather than asserting absolute counts. That matters
 * because api.test.ts runs first in the same database and leaves rows behind.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/prisma.js';
import { serializeRenewal } from '../src/serializers.js';
import { as, login, ADMIN, CALLER, type Session } from './helpers/api.js';
import { withMaint, refreshMatviews } from './helpers/maint.js';

/** import.meta.dirname equivalent that works regardless of module target. */
function __dirnameCompat(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Field names declared per model in schema.prisma, keyed by the DATABASE table name
 * (honouring @@map). Parsed from the file rather than read from Prisma's runtime dmmf
 * because dmmf omits `Unsupported(...)` fields — they cannot be selected — which would make
 * the four tsvector `search_vector` columns look absent when they are in fact declared.
 */
function declaredFieldsByTable(schema: string): Map<string, Set<string>> {
  const byModel = new Map<string, Set<string>>();
  const tableNameOf = new Map<string, string>();
  let current: string | null = null;

  for (const raw of schema.split('\n')) {
    const line = raw.trim();

    const open = /^(?:model|view)\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = open[1]!;
      byModel.set(current, new Set());
      tableNameOf.set(current, current);
      continue;
    }
    if (line === '}') {
      current = null;
      continue;
    }
    if (!current || !line || line.startsWith('//')) continue;

    const mapped = /^@@map\("([^"]+)"\)/.exec(line);
    if (mapped) {
      tableNameOf.set(current, mapped[1]!);
      continue;
    }
    if (line.startsWith('@@')) continue;

    const field = /^(\w+)\s+\S/.exec(line);
    if (field) byModel.get(current)!.add(field[1]!);
  }

  const byTable = new Map<string, Set<string>>();
  for (const [model, fields] of byModel) byTable.set(tableNameOf.get(model) ?? model, fields);
  return byTable;
}

let admin: Session;
let caller: Session;

beforeAll(async () => {
  [admin, caller] = await Promise.all([login(ADMIN), login(CALLER)]);
});

// ---------------------------------------------------------------------------------------
// The assumption everything else rests on
// ---------------------------------------------------------------------------------------

describe('timezone invariant', () => {
  // compute_renewal_status(), renewals_view.days_remaining and the dashboard's period
  // boundaries all use CURRENT_DATE, which is evaluated in the SERVER's timezone. Nothing in
  // the SQL says which timezone it means. serializers.ts derives the same values in
  // TypeScript with an explicit Asia/Kolkata formatter.
  //
  // So if the database is not on IST, the two disagree for the first 5.5 hours of every IST
  // day and every parity test below becomes meaningless. Migration 018 pins it; this makes a
  // regression fail loudly here rather than silently skewing the dashboard.
  it('the database session is Asia/Kolkata', async () => {
    const [row] = await prisma.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(row?.tz).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
  });

  it("CURRENT_DATE agrees with the IST calendar date", async () => {
    const [row] = await prisma.$queryRaw<{ current: string; ist: string }[]>`
      SELECT CURRENT_DATE::text AS current,
             (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS ist
    `;
    expect(row?.current).toBe(row?.ist);
  });
});

// ---------------------------------------------------------------------------------------
// serializeRenewal() vs renewals_view
// ---------------------------------------------------------------------------------------

describe('renewal derivation — TypeScript matches the SQL view', () => {
  // The strongest test in this file. renewals_view is the original definition; the route no
  // longer reads it, so nothing else would notice the reimplementation drifting.
  it('days_remaining and status match for every renewal row', async () => {
    const [base, view] = await Promise.all([
      prisma.renewals.findMany(),
      withMaint(async (c) =>
        (
          await c.query<{ id: string; days_remaining: number; status: string }>(
            'SELECT id, days_remaining, status FROM renewals_view',
          )
        ).rows,
      ),
    ]);

    expect(base.length).toBeGreaterThan(0);
    const byId = new Map(view.map((v) => [v.id, v]));

    const mismatches: string[] = [];
    for (const row of base) {
      const expected = byId.get(row.id);
      if (!expected) continue; // the view filters soft-deleted rows
      // Pass the BASE row, so status/days_remaining are derived rather than passed through.
      const actual = serializeRenewal(row as unknown as Record<string, unknown>);
      if (actual.daysRemaining !== Number(expected.days_remaining) || actual.status !== expected.status) {
        mismatches.push(
          `${row.id}: ts=${actual.status}/${actual.daysRemaining} sql=${expected.status}/${expected.days_remaining}`,
        );
      }
    }
    expect(mismatches, `TS/SQL renewal divergence:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('the view and the API agree on how many renewals are overdue', async () => {
    const [viewRows, apiRes] = await Promise.all([
      withMaint(async (c) =>
        (await c.query<{ status: string }>('SELECT status FROM renewals_view')).rows,
      ),
      as(admin).get('/api/renewals'),
    ]);
    const sqlOverdue = viewRows.filter((r) => r.status === 'overdue').length;
    const apiOverdue = apiRes.body.filter((r: { status: string }) => r.status === 'overdue').length;
    expect(apiOverdue).toBe(sqlOverdue);
  });
});

// ---------------------------------------------------------------------------------------
// Materialized views
// ---------------------------------------------------------------------------------------

describe('materialized views', () => {
  it('mv_lead_status_breakdown matches live data once refreshed', async () => {
    await refreshMatviews();
    const rows = await withMaint(async (c) => {
      const mv = await c.query<{ status: string; count: string }>(
        'SELECT status, SUM(lead_count)::int AS count FROM mv_lead_status_breakdown GROUP BY status',
      );
      const live = await c.query<{ status: string; count: string }>(
        'SELECT status::text AS status, count(*)::int AS count FROM leads WHERE deleted_at IS NULL GROUP BY status',
      );
      return { mv: mv.rows, live: live.rows };
    });

    const norm = (rs: { status: string; count: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.status, Number(r.count)]));
    expect(norm(rows.mv)).toEqual(norm(rows.live));
  });

  it('mv_caller_performance lead counts match live data once refreshed', async () => {
    await refreshMatviews();
    const rows = await withMaint(async (c) => {
      const mv = await c.query<{ caller_id: string; total_assigned_leads: string }>(
        'SELECT caller_id, total_assigned_leads FROM mv_caller_performance',
      );
      const live = await c.query<{ caller_id: string; n: string }>(
        `SELECT assigned_caller_id AS caller_id, count(*)::int AS n
           FROM leads WHERE deleted_at IS NULL AND assigned_caller_id IS NOT NULL
          GROUP BY assigned_caller_id`,
      );
      return { mv: mv.rows, live: live.rows };
    });

    const liveById = Object.fromEntries(rows.live.map((r) => [r.caller_id, Number(r.n)]));
    for (const row of rows.mv) {
      expect(Number(row.total_assigned_leads), `caller ${row.caller_id}`).toBe(liveById[row.caller_id] ?? 0);
    }
  });

  it('the admin dashboard never contradicts itself, even mid-refresh-cycle', async () => {
    // Regression test for a real defect. leadStatusBreakdown and callerPerformance used to
    // be read from materialized views for admins while totalLeads was counted live, so
    // between a write and the scheduler's next refresh (every 5 minutes) an admin was shown
    // a breakdown that did not sum to the total printed beside it.
    //
    // Both are aggregated live now. The check that matters is that the numbers agree
    // IMMEDIATELY after a write, with no refresh in between — deliberately leaving the
    // matviews stale first, so a regression to reading them fails here.
    const sum = (r: { body: { leadStatusBreakdown: { count: number }[] } }) =>
      r.body.leadStatusBreakdown.reduce((n, x) => n + Number(x.count), 0);

    await refreshMatviews();
    const before = await as(admin).get('/api/dashboard');
    expect(sum(before)).toBe(before.body.totalLeads);

    const created = await as(admin).post('/api/leads', {
      customerName: `T4 Lag Probe ${Date.now()}`,
      mobile: '9000000044',
      address: '1 Test Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      disease: 'Hypertension',
      medicines: [{ name: 'Atorva', days: 30 }],
      assignedCaller: caller.userId,
    });
    expect(created.status).toBe(201);

    // No refreshMatviews() here — that is the point.
    const during = await as(admin).get('/api/dashboard');
    expect(during.body.totalLeads).toBe(before.body.totalLeads + 1);
    expect(sum(during), 'breakdown must track the live total with no refresh').toBe(
      during.body.totalLeads,
    );
  });

  it('callerPerformance tracks a write immediately too', async () => {
    // The same defect existed in mv_caller_performance, which fed the "4 leads · 2 converted"
    // figures. Assigning a new lead must move that caller's count with no refresh.
    const nameOf = (body: { callerPerformance: { id: string; assignedCount: number }[] }, id: string) =>
      body.callerPerformance.find((c) => c.id === id)?.assignedCount ?? 0;

    await refreshMatviews();
    const before = await as(admin).get('/api/dashboard');
    const had = nameOf(before.body, caller.userId);

    const created = await as(admin).post('/api/leads', {
      customerName: `T4 Perf Probe ${Date.now()}`,
      mobile: '9000000045',
      address: '1 Test Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
      disease: 'Hypertension',
      medicines: [{ name: 'Atorva', days: 30 }],
      assignedCaller: caller.userId,
    });
    expect(created.status).toBe(201);

    const after = await as(admin).get('/api/dashboard');
    expect(nameOf(after.body, caller.userId)).toBe(had + 1);
  });

  it("a caller's breakdown also sums to their total", async () => {
    const res = await as(caller).get('/api/dashboard');
    const sum = res.body.leadStatusBreakdown.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
    expect(sum).toBe(res.body.totalLeads);
  });
});

// ---------------------------------------------------------------------------------------
// Dashboard scalars vs independent SQL
// ---------------------------------------------------------------------------------------

describe('dashboard aggregates match independently written SQL', () => {
  let body: Record<string, never>;
  let sql: Record<string, number>;

  beforeAll(async () => {
    const res = await as(admin).get('/api/dashboard');
    body = res.body;
    sql = await withMaint(async (c) => {
      const { rows } = await c.query<Record<string, string>>(`
        SELECT
          (SELECT count(*) FROM leads WHERE deleted_at IS NULL)                              AS total_leads,
          (SELECT count(*) FROM follow_ups
             WHERE deleted_at IS NULL
               AND scheduled_at >= CURRENT_DATE AND scheduled_at < CURRENT_DATE + 1)         AS todays_calls,
          (SELECT count(*) FROM leads
             WHERE deleted_at IS NULL AND status = 'follow_up_pending')                      AS pending_follow_ups,
          (SELECT count(*) FROM orders WHERE deleted_at IS NULL)                             AS total_orders,
          (SELECT count(*) FROM renewals
             WHERE deleted_at IS NULL AND renewed_at IS NULL
               AND renewal_date < CURRENT_DATE + 1)                                          AS renewals_due,
          (SELECT count(*) FROM leads
             WHERE deleted_at IS NULL
               AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + 1)             AS leads_today,
          (SELECT count(*) FROM leads
             WHERE deleted_at IS NULL AND created_at >= date_trunc('week', CURRENT_DATE))    AS leads_week,
          (SELECT count(*) FROM leads
             WHERE deleted_at IS NULL AND created_at >= date_trunc('month', CURRENT_DATE))   AS leads_month,
          (SELECT COALESCE(SUM(total_amount), 0) FROM orders
             WHERE deleted_at IS NULL
               AND created_at >= CURRENT_DATE AND created_at < CURRENT_DATE + 1)             AS sales_today,
          (SELECT COALESCE(SUM(total_amount), 0) FROM orders
             WHERE deleted_at IS NULL AND created_at >= date_trunc('week', CURRENT_DATE))    AS sales_week,
          (SELECT COALESCE(SUM(total_amount), 0) FROM orders
             WHERE deleted_at IS NULL AND created_at >= date_trunc('month', CURRENT_DATE))   AS sales_month
      `);
      return Object.fromEntries(Object.entries(rows[0]!).map(([k, v]) => [k, Number(v)]));
    });
  });

  it.each([
    ['totalLeads', 'total_leads'],
    ['todaysCalls', 'todays_calls'],
    ['pendingFollowUps', 'pending_follow_ups'],
    ['totalOrders', 'total_orders'],
    ['renewalsDue', 'renewals_due'],
  ])('%s', (apiKey, sqlKey) => {
    expect(Number(body[apiKey as never])).toBe(sql[sqlKey]);
  });

  it('leadsByPeriod matches date_trunc buckets', () => {
    const p = body['leadsByPeriod' as never] as unknown as Record<string, number>;
    expect(Number(p.today)).toBe(sql.leads_today);
    expect(Number(p.thisWeek)).toBe(sql.leads_week);
    expect(Number(p.thisMonth)).toBe(sql.leads_month);
  });

  it('salesByPeriod matches SUM(total_amount) per bucket', () => {
    const p = body['salesByPeriod' as never] as unknown as Record<string, number>;
    expect(Number(p.today)).toBe(sql.sales_today);
    expect(Number(p.thisWeek)).toBe(sql.sales_week);
    expect(Number(p.thisMonth)).toBe(sql.sales_month);
  });

  it('salesByCaller totals reconcile with a direct join', async () => {
    const rows = await withMaint(async (c) =>
      (
        await c.query<{ caller_id: string; total_sales: string }>(`
          SELECT u.id AS caller_id, COALESCE(SUM(o.total_amount), 0)::numeric AS total_sales
            FROM users u
            LEFT JOIN leads l  ON l.assigned_caller_id = u.id AND l.deleted_at IS NULL
            LEFT JOIN orders o ON o.lead_id = l.id           AND o.deleted_at IS NULL
           WHERE u.role = 'caller' AND u.deleted_at IS NULL
           GROUP BY u.id
        `)
      ).rows,
    );
    const expected = Object.fromEntries(rows.map((r) => [r.caller_id, Number(r.total_sales)]));
    const actual = body['salesByCaller' as never] as unknown as { callerId: string; totalSales: number }[];
    expect(actual.length).toBe(rows.length);
    for (const row of actual) {
      expect(Number(row.totalSales), `caller ${row.callerId}`).toBe(expected[row.callerId]);
    }
  });

  it('callerPerformance reconciles with a direct count', async () => {
    const rows = await withMaint(async (c) =>
      (
        await c.query<{ caller_id: string; assigned: string; converted: string }>(`
          SELECT u.id AS caller_id,
                 count(l.id)                                      AS assigned,
                 count(l.id) FILTER (WHERE l.status = 'converted') AS converted
            FROM users u
            LEFT JOIN leads l ON l.assigned_caller_id = u.id AND l.deleted_at IS NULL
           WHERE u.role = 'caller' AND u.deleted_at IS NULL
           GROUP BY u.id
        `)
      ).rows,
    );
    const expected = Object.fromEntries(rows.map((r) => [r.caller_id, Number(r.assigned)]));
    const converted = Object.fromEntries(rows.map((r) => [r.caller_id, Number(r.converted)]));
    const actual = body['callerPerformance' as never] as unknown as {
      id: string;
      assignedCount: number;
      convertedCount: number;
    }[];
    expect(actual.length).toBe(rows.length);
    for (const row of actual) {
      expect(row.assignedCount, `caller ${row.id} assigned`).toBe(expected[row.id]);
      expect(row.convertedCount, `caller ${row.id} converted`).toBe(converted[row.id]);
    }
  });

  it('a caller sees no cross-caller comparison data at all', async () => {
    const res = await as(caller).get('/api/dashboard');
    expect(res.body.salesByCaller).toEqual([]);
    expect(res.body.callerPerformance).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Search — the one place scoping is done by hand
// ---------------------------------------------------------------------------------------

describe('search scoping', () => {
  // global_search is a UNION view with a tsvector column, so the match itself has to stay
  // raw SQL. It is classified GLOBAL in scopedPrisma, meaning the extension does NOT filter
  // it — misc.ts re-checks each candidate through the scoped client instead. That hand-rolled
  // filter is the only thing standing between a caller and other callers' records.
  let foreignName: string;

  beforeAll(async () => {
    const lead = await prisma.leads.findFirstOrThrow({
      where: {
        deleted_at: null,
        AND: [{ assigned_caller_id: { not: null } }, { assigned_caller_id: { not: caller.userId } }],
      },
      select: { customer_name: true },
    });
    foreignName = lead.customer_name;
  });

  it('an admin finds another caller\'s lead by name', async () => {
    const res = await as(admin).get(`/api/search?q=${encodeURIComponent(foreignName)}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('a caller finds no lead belonging to someone else', async () => {
    const res = await as(caller).get(`/api/search?q=${encodeURIComponent(foreignName)}`);
    expect(res.status).toBe(200);
    const leaked = res.body.filter((r: { type: string }) => r.type === 'lead');
    expect(leaked).toEqual([]);
  });

  it('a caller does find their OWN lead', async () => {
    const own = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: caller.userId },
      select: { customer_name: true },
    });
    const res = await as(caller).get(`/api/search?q=${encodeURIComponent(own.customer_name)}`);
    expect(res.body.some((r: { type: string }) => r.type === 'lead')).toBe(true);
  });

  it('an empty query returns nothing rather than everything', async () => {
    expect((await as(caller).get('/api/search?q=')).body).toEqual([]);
    expect((await as(caller).get('/api/search?q=%20%20')).body).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Schema drift
// ---------------------------------------------------------------------------------------

describe('schema drift — schema.prisma matches the migrated database', () => {
  // db/migrations/*.sql is the source of truth; schema.prisma is introspected from it and
  // then hand-curated (Prisma cannot author partitioned tables, GENERATED ALWAYS columns or
  // tsvector). Because the curation is manual, a migration that adds or renames a column can
  // land without schema.prisma following — and the mismatch only shows up as a runtime error
  // on whichever endpoint touches that column.
  //
  // A plain `prisma db pull` diff cannot be used as the check: it would undo the hand
  // curation (re-adding partition children, rewriting the renewals_view edit). So this
  // compares field-by-field against the live catalog instead.
  it('every field in schema.prisma exists as a column in the database', async () => {
    const { Prisma } = await import('@prisma/client');
    const models = (Prisma as unknown as {
      dmmf: {
        datamodel: {
          models: {
            name: string;
            dbName: string | null;
            fields: { name: string; dbName?: string | null; kind: string; relationName?: string }[];
          }[];
        };
      };
    }).dmmf.datamodel.models;

    const columns = await withMaint(async (c) =>
      (
        await c.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
        )
      ).rows,
    );
    const byTable = new Map<string, Set<string>>();
    for (const row of columns) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name)!.add(row.column_name);
    }

    const problems: string[] = [];
    for (const model of models) {
      const table = model.dbName ?? model.name;
      const cols = byTable.get(table);
      if (!cols) {
        problems.push(`model ${model.name}: no table/view "${table}" in the database`);
        continue;
      }
      for (const field of model.fields) {
        if (field.kind === 'object' || field.relationName) continue; // relations aren't columns
        const col = field.dbName ?? field.name;
        if (!cols.has(col)) problems.push(`${table}.${col} (model ${model.name}) missing from the database`);
      }
    }
    expect(problems, `schema.prisma is ahead of the database:\n${problems.join('\n')}`).toEqual([]);
  });

  it('no base-table column is missing from schema.prisma', async () => {
    // The direction that actually bites: a migration adds a column, schema.prisma is not
    // regenerated, and Prisma silently never reads or writes it.
    //
    // Read the schema FILE rather than the runtime dmmf. Prisma omits `Unsupported(...)`
    // fields from the generated client's field list — they cannot be selected — so the four
    // tsvector `search_vector` columns look absent via dmmf even though they are declared.
    // Parsing the file counts them, which both removes that false positive and makes this
    // check cover Unsupported columns properly.
    const schema = await readFile(path.resolve(__dirnameCompat(), '../prisma/schema.prisma'), 'utf8');
    const declared = declaredFieldsByTable(schema);

    const rows = await withMaint(async (c) =>
      (
        await c.query<{ table_name: string; column_name: string }>(`
          SELECT c.table_name, c.column_name
            FROM information_schema.columns c
            JOIN pg_class cl ON cl.relname = c.table_name
            JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
           WHERE c.table_schema = 'public'
             AND cl.relkind IN ('r','p')
             AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = cl.oid)
        `)
      ).rows,
    );

    const problems: string[] = [];
    for (const row of rows) {
      const fields = declared.get(row.table_name);
      if (!fields) continue; // table deliberately not modelled
      if (!fields.has(row.column_name)) {
        problems.push(`${row.table_name}.${row.column_name} exists in the database but not in schema.prisma`);
      }
    }
    expect(
      problems,
      `schema.prisma is stale — run \`prisma db pull\` and re-curate:\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('the schema file declares every table the database has', async () => {
    // Catches a whole table added by a migration and never introspected.
    const schema = await readFile(path.resolve(__dirnameCompat(), '../prisma/schema.prisma'), 'utf8');
    const tables = await withMaint(async (c) =>
      (
        await c.query<{ relname: string }>(`
          SELECT cl.relname FROM pg_class cl
            JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
           WHERE cl.relkind IN ('r','p')
             AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = cl.oid)
        `)
      ).rows.map((r) => r.relname),
    );
    const declared = declaredFieldsByTable(schema);
    const missing = tables.filter((t) => !declared.has(t));
    expect(missing, `tables absent from schema.prisma: ${missing.join(', ')}`).toEqual([]);
  });
});
