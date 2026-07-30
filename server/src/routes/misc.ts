import { Router } from 'express';
import { prisma } from '../prisma.js';
import { dbFor } from '../scopedPrisma.js';
import { isAdmin } from '../scope.js';

export const miscRouter = Router();

miscRouter.get('/lookups', async (req, res) => {
  const db = dbFor(req.actor);
  const args = { where: { is_active: true }, orderBy: { sort_order: 'asc' } } as const;

  // Was one templated query per table with the table name interpolated; these are ordinary
  // models now, so the string building goes away entirely.
  const [leadStatuses, leadSources, orderStages, paymentStatuses, followUpTypes, followUpStatuses] =
    await Promise.all([
      db.lead_statuses.findMany({ ...args, select: { code: true, label: true } }),
      db.lead_sources.findMany({ ...args, select: { code: true, label: true } }),
      db.order_stages.findMany({ ...args, select: { code: true, label: true } }),
      db.payment_statuses.findMany({ ...args, select: { code: true, label: true } }),
      db.follow_up_types.findMany({ ...args, select: { code: true, label: true } }),
      db.follow_up_statuses.findMany({ ...args, select: { code: true, label: true } }),
    ]);

  res.json({ leadStatuses, leadSources, orderStages, paymentStatuses, followUpTypes, followUpStatuses });
});

miscRouter.get('/dashboard', async (req, res) => {
  const actor = req.actor!;
  const db = dbFor(actor);
  const admin = isAdmin(actor);

  // Period boundaries are computed by Postgres rather than in JS on purpose. CURRENT_DATE
  // and date_trunc('week', ...) are evaluated in the database session's Asia/Kolkata
  // timezone (and week starts Monday); re-deriving that in Node invites exactly the
  // off-by-one-day bugs the d10() helper in serializers.ts exists to avoid. One cheap query
  // yields the instants, which are then used as ordinary Prisma date filters — so the
  // counts still run through the scoping extension.
  const [bounds] = await prisma.$queryRaw<
    { today: Date; tomorrow: Date; week_start: Date; month_start: Date }[]
  >`
    SELECT CURRENT_DATE::timestamptz                        AS today,
           (CURRENT_DATE + 1)::timestamptz                  AS tomorrow,
           date_trunc('week', CURRENT_DATE)::timestamptz    AS week_start,
           date_trunc('month', CURRENT_DATE)::timestamptz   AS month_start
  `;
  if (!bounds) throw new Error('Failed to resolve dashboard date boundaries');
  const { today, tomorrow, week_start, month_start } = bounds;

  const notDeleted = { deleted_at: null };
  const sumAmount = async (where: object) =>
    Number((await db.orders.aggregate({ _sum: { total_amount: true }, where }))._sum.total_amount ?? 0);

  const [
    totalLeads,
    todaysCalls,
    pendingFollowUps,
    totalOrders,
    renewalsDue,
    leadsToday,
    leadsWeek,
    leadsMonth,
    salesToday,
    salesWeek,
    salesMonth,
  ] = await Promise.all([
    db.leads.count({ where: notDeleted }),
    db.follow_ups.count({ where: { ...notDeleted, scheduled_at: { gte: today, lt: tomorrow } } }),
    db.leads.count({ where: { ...notDeleted, status: 'follow_up_pending' } }),
    db.orders.count({ where: notDeleted }),
    // renewals_view's status IN ('due_today','overdue') expands to "not yet renewed and
    // renewal_date has arrived". The overdue case (expiry_date < today) is subsumed because
    // chk_renewals_renewal_before_expiry guarantees renewal_date <= expiry_date.
    db.renewals.count({ where: { ...notDeleted, renewed_at: null, renewal_date: { lt: tomorrow } } }),
    db.leads.count({ where: { ...notDeleted, created_at: { gte: today, lt: tomorrow } } }),
    db.leads.count({ where: { ...notDeleted, created_at: { gte: week_start } } }),
    db.leads.count({ where: { ...notDeleted, created_at: { gte: month_start } } }),
    sumAmount({ ...notDeleted, created_at: { gte: today, lt: tomorrow } }),
    sumAmount({ ...notDeleted, created_at: { gte: week_start } }),
    sumAmount({ ...notDeleted, created_at: { gte: month_start } }),
  ]);

  // Admin reads the pre-aggregated matview (cheap regardless of table size); a caller's own
  // scope is small enough to aggregate live. Matviews cannot carry RLS and are not Prisma
  // models, so they stay raw — and stay behind this admin branch for that reason.
  let leadStatusBreakdown: { status: string; count: number }[];
  if (admin) {
    leadStatusBreakdown = await prisma.$queryRaw`
      SELECT status, SUM(lead_count)::int AS count FROM mv_lead_status_breakdown GROUP BY status
    `;
  } else {
    const grouped = await db.leads.groupBy({
      by: ['status'],
      where: notDeleted,
      _count: { _all: true },
    });
    leadStatusBreakdown = grouped.map((g) => ({ status: g.status, count: g._count._all }));
  }

  let callerPerformance: unknown[] = [];
  let salesByCaller: unknown[] = [];
  if (admin) {
    const perf = await prisma.$queryRaw<
      {
        caller_id: string;
        caller_name: string;
        total_assigned_leads: number;
        converted_leads: number;
        conversion_rate: string | null;
      }[]
    >`SELECT * FROM mv_caller_performance ORDER BY total_assigned_leads DESC`;
    callerPerformance = perf.map((r) => ({
      id: r.caller_id,
      name: r.caller_name,
      assignedCount: Number(r.total_assigned_leads),
      convertedCount: Number(r.converted_leads),
      conversionRate: Math.round(Number(r.conversion_rate ?? 0) * 100),
    }));

    // Comparing callers against each other is only meaningful for a manager — mirrors
    // callerPerformance's own admin-only gating. orders has no direct caller column, so
    // this joins through the lead each order was converted from.
    const salesRows = await prisma.$queryRaw<
      { caller_id: string; caller_name: string; total_sales: string }[]
    >`
      SELECT u.id AS caller_id, u.name AS caller_name,
             COALESCE(SUM(o.total_amount), 0)::numeric AS total_sales
      FROM users u
      LEFT JOIN leads l ON l.assigned_caller_id = u.id AND l.deleted_at IS NULL
      LEFT JOIN orders o ON o.lead_id = l.id AND o.deleted_at IS NULL
      WHERE u.role = 'caller' AND u.deleted_at IS NULL
      GROUP BY u.id, u.name
      ORDER BY total_sales DESC
    `;
    salesByCaller = salesRows.map((r) => ({
      callerId: r.caller_id,
      callerName: r.caller_name,
      totalSales: Number(r.total_sales),
    }));
  }

  res.json({
    totalLeads,
    todaysCalls,
    pendingFollowUps,
    totalOrders,
    renewalsDue,
    leadStatusBreakdown,
    callerPerformance,
    leadsByPeriod: { today: leadsToday, thisWeek: leadsWeek, thisMonth: leadsMonth },
    salesByPeriod: { today: salesToday, thisWeek: salesWeek, thisMonth: salesMonth },
    salesByCaller,
  });
});

const SEARCH_LIMIT = 20;

miscRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.json([]);
    return;
  }
  const db = dbFor(req.actor);

  // global_search is a UNION over customers/leads/orders/products with a tsvector column.
  // Full-text search has no Prisma equivalent, so the match itself stays raw — but the view
  // used to be filtered per-branch by RLS through `security_invoker = true` (migration 007),
  // and that protection is gone under a BYPASSRLS role. Ranked candidates are therefore
  // re-checked against the scoped client below before anything is returned.
  //
  // The raw query over-fetches so that filtering out other callers' rows cannot leave the
  // caller with fewer than SEARCH_LIMIT visible results.
  const candidates = await prisma.$queryRaw<{ entity_type: string; entity_id: string; label: string }[]>`
    SELECT entity_type, entity_id, label
    FROM global_search
    WHERE search_vector @@ websearch_to_tsquery('simple', ${q})
    ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', ${q})) DESC
    LIMIT ${SEARCH_LIMIT * 10}
  `;
  if (candidates.length === 0) {
    res.json([]);
    return;
  }

  const idsOfType = (type: string) => candidates.filter((c) => c.entity_type === type).map((c) => c.entity_id);
  const [leads, orders, customers, products] = await Promise.all([
    db.leads.findMany({ where: { id: { in: idsOfType('lead') } }, select: { id: true } }),
    db.orders.findMany({ where: { id: { in: idsOfType('order') } }, select: { id: true } }),
    db.customers.findMany({ where: { id: { in: idsOfType('customer') } }, select: { id: true } }),
    db.products.findMany({ where: { id: { in: idsOfType('product') } }, select: { id: true } }),
  ]);

  const visible = new Set([...leads, ...orders, ...customers, ...products].map((r) => r.id));
  res.json(
    candidates
      .filter((c) => visible.has(c.entity_id))
      .slice(0, SEARCH_LIMIT)
      .map((r) => ({ type: r.entity_type, id: r.entity_id, label: r.label })),
  );
});
