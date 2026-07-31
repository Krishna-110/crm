import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { route } from '../lib/errors.js';
import { isAdmin } from '../auth/scope.js';
import { periodBoundaries } from '../lib/dates.js';

export const miscRouter = Router();

/** Reference data for the frontend's dropdowns. */
miscRouter.get(
  '/lookups',
  route(async (_req, res) => {
    const args = { where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, label: true } } as const;
    const [leadStatuses, leadSources, orderStages, paymentStatuses, followUpTypes, followUpStatuses] =
      await Promise.all([
        prisma.leadStatus.findMany(args),
        prisma.leadSource.findMany(args),
        prisma.orderStage.findMany(args),
        prisma.paymentStatus.findMany(args),
        prisma.followUpType.findMany(args),
        prisma.followUpStatus.findMany(args),
      ]);
    res.json({ leadStatuses, leadSources, orderStages, paymentStatuses, followUpTypes, followUpStatuses });
  }),
);

/**
 * Dashboard.
 *
 * Every figure is computed live through the scoped client, so an admin sees the whole
 * pipeline and a caller sees their own — from one set of queries, with no per-role branching
 * except the cross-caller comparisons an admin alone should see.
 *
 * Deliberately no materialized views. The previous dashboard read totalLeads live but took
 * the status breakdown from a matview refreshed every five minutes, so between a write and
 * the next refresh an admin was shown a breakdown that did not sum to the total printed
 * beside it. Live everywhere means the numbers always agree.
 */
miscRouter.get(
  '/dashboard',
  route(async (req, res) => {
    const actor = actorOf(req);
    const db = scopedFor(actor);
    const admin = isAdmin(actor);
    const { today, tomorrow, weekStart, monthStart } = periodBoundaries();
    const live = { deletedAt: null };

    const sumOrders = async (where: object) =>
      Number((await db.order.aggregate({ _sum: { totalAmount: true }, where }))._sum.totalAmount ?? 0);

    const [
      totalLeads, todaysCalls, pendingFollowUps, totalOrders, renewalsDue,
      leadsToday, leadsWeek, leadsMonth, salesToday, salesWeek, salesMonth, grouped,
    ] = await Promise.all([
      db.lead.count({ where: live }),
      db.followUp.count({ where: { ...live, scheduledAt: { gte: today, lt: tomorrow } } }),
      db.lead.count({ where: { ...live, status: 'follow_up_pending' } }),
      db.order.count({ where: live }),
      // "Due" is not-yet-renewed and the renewal date has arrived. Overdue is subsumed:
      // a renewal cannot expire before its renewal date.
      db.renewal.count({ where: { ...live, renewedAt: null, renewalDate: { lt: tomorrow } } }),
      db.lead.count({ where: { ...live, createdAt: { gte: today, lt: tomorrow } } }),
      db.lead.count({ where: { ...live, createdAt: { gte: weekStart } } }),
      db.lead.count({ where: { ...live, createdAt: { gte: monthStart } } }),
      sumOrders({ ...live, createdAt: { gte: today, lt: tomorrow } }),
      sumOrders({ ...live, createdAt: { gte: weekStart } }),
      sumOrders({ ...live, createdAt: { gte: monthStart } }),
      db.lead.groupBy({ by: ['status'], where: live, _count: { _all: true } }),
    ]);

    const leadStatusBreakdown = grouped.map((g) => ({ status: g.status, count: g._count._all }));

    // Comparing callers against each other is a manager's view, so it is admin-only —
    // matching how the frontend gates the chart.
    let callerPerformance: unknown[] = [];
    let salesByCaller: unknown[] = [];
    if (admin) {
      const callers = await prisma.user.findMany({
        where: { role: 'caller', deletedAt: null },
        select: {
          id: true,
          name: true,
          _count: { select: { assignedLeads: { where: { deletedAt: null } } } },
        },
        orderBy: { name: 'asc' },
      });

      const converted = await prisma.lead.groupBy({
        by: ['assignedCallerId'],
        where: { deletedAt: null, status: 'converted' },
        _count: { _all: true },
      });
      const convertedBy = new Map(converted.map((c) => [c.assignedCallerId, c._count._all]));

      callerPerformance = callers.map((c) => {
        const assigned = c._count.assignedLeads;
        const won = convertedBy.get(c.id) ?? 0;
        return {
          id: c.id,
          name: c.name,
          assignedCount: assigned,
          convertedCount: won,
          conversionRate: assigned === 0 ? 0 : Math.round((won / assigned) * 100),
        };
      });

      // Orders have no caller column, so sales attribute through the lead each came from.
      const sales = await prisma.order.groupBy({
        by: ['leadId'],
        where: { deletedAt: null, leadId: { not: null } },
        _sum: { totalAmount: true },
      });
      const leadOwners = new Map(
        (
          await prisma.lead.findMany({
            where: { id: { in: sales.map((s) => s.leadId!).filter(Boolean) } },
            select: { id: true, assignedCallerId: true },
          })
        ).map((l) => [l.id, l.assignedCallerId]),
      );
      const totals = new Map<string, Prisma.Decimal>();
      for (const s of sales) {
        const owner = leadOwners.get(s.leadId!);
        if (!owner) continue;
        totals.set(owner, (totals.get(owner) ?? new Prisma.Decimal(0)).add(s._sum.totalAmount ?? 0));
      }
      salesByCaller = callers
        .map((c) => ({
          callerId: c.id,
          callerName: c.name,
          totalSales: Number(totals.get(c.id) ?? 0),
        }))
        .sort((a, b) => b.totalSales - a.totalSales);
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
  }),
);

/**
 * Cross-entity search.
 *
 * Runs through the scoped client, so results are filtered by the same rules as every other
 * read. The previous implementation could not do this: full-text search lived in a database
 * view outside the scope layer, so it had to fetch candidates and re-check each one by hand.
 */
miscRouter.get(
  '/search',
  route(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    const db = scopedFor(actorOf(req));
    const like = { contains: q, mode: 'insensitive' } as const;
    const take = 10;

    const [leads, orders, customers, products] = await Promise.all([
      db.lead.findMany({
        where: { deletedAt: null, OR: [{ customerName: like }, { mobile: like }, { disease: like }] },
        select: { id: true, customerName: true },
        take,
      }),
      db.order.findMany({
        where: { deletedAt: null, OR: [{ orderNumber: like }, { customerName: like }] },
        select: { id: true, orderNumber: true, customerName: true },
        take,
      }),
      db.customer.findMany({
        where: { deletedAt: null, OR: [{ fullName: like }, { primaryMobile: like }] },
        select: { id: true, fullName: true },
        take,
      }),
      db.product.findMany({
        where: { deletedAt: null, OR: [{ brandName: like }, { genericName: like }, { sku: like }] },
        select: { id: true, brandName: true, genericName: true },
        take,
      }),
    ]);

    res.json([
      ...leads.map((l) => ({ type: 'lead', id: l.id, label: l.customerName })),
      ...orders.map((o) => ({ type: 'order', id: o.id, label: `${o.orderNumber} — ${o.customerName}` })),
      ...customers.map((c) => ({ type: 'customer', id: c.id, label: c.fullName })),
      ...products.map((p) => ({ type: 'product', id: p.id, label: p.brandName ?? p.genericName })),
    ]);
  }),
);
