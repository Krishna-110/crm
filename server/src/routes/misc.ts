import { Router } from 'express';
import { withUserTx } from '../db.js';

export const miscRouter = Router();

const LOOKUP_TABLES: Record<string, string> = {
  leadStatuses: 'lead_statuses',
  leadSources: 'lead_sources',
  orderStages: 'order_stages',
  paymentStatuses: 'payment_statuses',
  followUpTypes: 'follow_up_types',
  followUpStatuses: 'follow_up_statuses',
};

miscRouter.get('/lookups', async (req, res) => {
  const result = await withUserTx(req.userId!, async (client) => {
    const entries = await Promise.all(
      Object.entries(LOOKUP_TABLES).map(async ([key, table]) => {
        // table is one of the fixed literals above, never request input.
        const { rows } = await client.query(`SELECT code, label FROM ${table} WHERE is_active ORDER BY sort_order`);
        return [key, rows] as const;
      }),
    );
    return Object.fromEntries(entries);
  });
  res.json(result);
});

miscRouter.get('/dashboard', async (req, res) => {
  const result = await withUserTx(req.userId!, async (client) => {
    const { rows: selfRows } = await client.query('SELECT role FROM users WHERE id = $1', [req.userId]);
    const isAdmin = selfRows[0]?.role === 'admin';

    const [totalLeads, todaysCalls, pendingFollowUps, totalOrders, renewalsDue, leadsByPeriod, salesByPeriod] = await Promise.all([
      client.query('SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL'),
      client.query("SELECT count(*)::int AS n FROM follow_ups WHERE deleted_at IS NULL AND scheduled_at::date = CURRENT_DATE"),
      client.query("SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL AND status = 'follow_up_pending'"),
      client.query('SELECT count(*)::int AS n FROM orders WHERE deleted_at IS NULL'),
      client.query("SELECT count(*)::int AS n FROM renewals_view WHERE status IN ('due_today', 'overdue')"),
      // RLS-scoped automatically, same as totalLeads above — a Caller session only ever
      // sees their own rows, Admin sees everyone's, with no explicit branching needed here.
      client.query(`
        SELECT
          count(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS today,
          count(*) FILTER (WHERE created_at >= date_trunc('week', CURRENT_DATE))::int AS this_week,
          count(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE))::int AS this_month
        FROM leads WHERE deleted_at IS NULL
      `),
      client.query(`
        SELECT
          COALESCE(SUM(total_amount) FILTER (WHERE created_at::date = CURRENT_DATE), 0) AS today,
          COALESCE(SUM(total_amount) FILTER (WHERE created_at >= date_trunc('week', CURRENT_DATE)), 0) AS this_week,
          COALESCE(SUM(total_amount) FILTER (WHERE created_at >= date_trunc('month', CURRENT_DATE)), 0) AS this_month
        FROM orders WHERE deleted_at IS NULL
      `),
    ]);

    // Admin reads the pre-aggregated matview (cheap regardless of table size); a
    // caller's own scope is small enough to aggregate live, and the matview carries no
    // per-caller RLS anyway (materialized views cannot enforce row-level security).
    const { rows: statusBreakdown } = isAdmin
      ? await client.query('SELECT status, SUM(lead_count)::int AS count FROM mv_lead_status_breakdown GROUP BY status')
      : await client.query("SELECT status, count(*)::int AS count FROM leads WHERE deleted_at IS NULL GROUP BY status");

    let callerPerformance: unknown[] = [];
    let salesByCaller: unknown[] = [];
    if (isAdmin) {
      const { rows } = await client.query('SELECT * FROM mv_caller_performance ORDER BY total_assigned_leads DESC');
      callerPerformance = rows.map((r) => ({
        id: r.caller_id,
        name: r.caller_name,
        assignedCount: r.total_assigned_leads,
        convertedCount: r.converted_leads,
        conversionRate: Math.round(Number(r.conversion_rate ?? 0) * 100),
      }));

      // Comparing callers against each other is only meaningful for a manager — mirrors
      // callerPerformance's own admin-only gating above. orders has no direct caller
      // column, so this joins through the lead each order was converted from.
      const { rows: salesRows } = await client.query(`
        SELECT u.id AS caller_id, u.name AS caller_name,
               COALESCE(SUM(o.total_amount), 0)::numeric AS total_sales
        FROM users u
        LEFT JOIN leads l ON l.assigned_caller_id = u.id AND l.deleted_at IS NULL
        LEFT JOIN orders o ON o.lead_id = l.id AND o.deleted_at IS NULL
        WHERE u.role = 'caller' AND u.deleted_at IS NULL
        GROUP BY u.id, u.name
        ORDER BY total_sales DESC
      `);
      salesByCaller = salesRows.map((r) => ({
        callerId: r.caller_id,
        callerName: r.caller_name,
        totalSales: Number(r.total_sales),
      }));
    }

    return {
      totalLeads: totalLeads.rows[0].n,
      todaysCalls: todaysCalls.rows[0].n,
      pendingFollowUps: pendingFollowUps.rows[0].n,
      totalOrders: totalOrders.rows[0].n,
      renewalsDue: renewalsDue.rows[0].n,
      leadStatusBreakdown: statusBreakdown,
      callerPerformance,
      leadsByPeriod: {
        today: leadsByPeriod.rows[0].today,
        thisWeek: leadsByPeriod.rows[0].this_week,
        thisMonth: leadsByPeriod.rows[0].this_month,
      },
      salesByPeriod: {
        today: Number(salesByPeriod.rows[0].today),
        thisWeek: Number(salesByPeriod.rows[0].this_week),
        thisMonth: Number(salesByPeriod.rows[0].this_month),
      },
      salesByCaller,
    };
  });

  res.json(result);
});

miscRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json([]);
    return;
  }

  const results = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      `SELECT entity_type, entity_id, label
       FROM global_search
       WHERE search_vector @@ websearch_to_tsquery('simple', $1)
       ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', $1)) DESC
       LIMIT 20`,
      [q],
    );
    return rows;
  });

  res.json(results.map((r) => ({ type: r.entity_type, id: r.entity_id, label: r.label })));
});
