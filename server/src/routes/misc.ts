import { Router } from 'express';
import { withUserTx } from '../db.js';

export const miscRouter = Router();

const LOOKUP_TABLES: Record<string, string> = {
  leadStatuses: 'lead_statuses',
  leadPriorities: 'lead_priorities',
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

    const [totalLeads, todaysCalls, pendingFollowUps, totalOrders, renewalsDue] = await Promise.all([
      client.query('SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL'),
      client.query("SELECT count(*)::int AS n FROM follow_ups WHERE deleted_at IS NULL AND scheduled_at::date = CURRENT_DATE"),
      client.query("SELECT count(*)::int AS n FROM leads WHERE deleted_at IS NULL AND status = 'follow_up_pending'"),
      client.query('SELECT count(*)::int AS n FROM orders WHERE deleted_at IS NULL'),
      client.query("SELECT count(*)::int AS n FROM renewals_view WHERE status IN ('due_today', 'overdue')"),
    ]);

    // Admin reads the pre-aggregated matview (cheap regardless of table size); a
    // caller's own scope is small enough to aggregate live, and the matview carries no
    // per-caller RLS anyway (materialized views cannot enforce row-level security).
    const { rows: statusBreakdown } = isAdmin
      ? await client.query('SELECT status, SUM(lead_count)::int AS count FROM mv_lead_status_breakdown GROUP BY status')
      : await client.query("SELECT status, count(*)::int AS count FROM leads WHERE deleted_at IS NULL GROUP BY status");

    let callerPerformance: unknown[] = [];
    if (isAdmin) {
      const { rows } = await client.query('SELECT * FROM mv_caller_performance ORDER BY total_assigned_leads DESC');
      callerPerformance = rows.map((r) => ({
        id: r.caller_id,
        name: r.caller_name,
        assignedCount: r.total_assigned_leads,
        convertedCount: r.converted_leads,
        conversionRate: Math.round(Number(r.conversion_rate ?? 0) * 100),
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
