import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { isAdmin } from '../auth/scope.js';
import { serializeOrder } from '../lib/serialize.js';
import { recalculateOrderTotals } from '../services/orders.js';
import { auditUpdate } from '../services/audit.js';

export const ordersRouter = Router();

const WITH_ITEMS = { items: { orderBy: { createdAt: 'asc' } } } as const;

ordersRouter.get(
  '/',
  route(async (req, res) => {
    const orders = await scopedFor(actorOf(req)).order.findMany({
      where: { deletedAt: null },
      include: WITH_ITEMS,
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders.map(serializeOrder));
  }),
);

ordersRouter.patch(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    const id = param(req, 'id');
    const body = req.body ?? {};

    // Editing an order is admin-only, and answers 404 rather than 403 for a caller. That is
    // deliberate: the previous system enforced this with a row filter, so a caller's update
    // simply matched nothing and the API said "not found". Changing it to 403 now would tell
    // a caller that an order they cannot touch exists.
    if (!isAdmin(actor)) throw ApiError.notFound('Order not found');

    const before = await prisma.order.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('Order not found');

    const data: Record<string, unknown> = {};
    if ('stage' in body) data.stage = body.stage;
    if ('paymentStatus' in body) data.paymentStatus = body.paymentStatus;
    if ('discountType' in body) data.discountType = body.discountType;
    if ('discountValue' in body) data.discountValue = Number(body.discountValue) || 0;
    if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

    const order = await prisma.$transaction(async (tx) => {
      const updated = await tx.order.update({ where: { id }, data });
      // A discount change moves the payable amount, so the totals are rebuilt rather than
      // patched — the same recomputation any line-item change triggers.
      if ('discountType' in body || 'discountValue' in body) {
        await recalculateOrderTotals(tx, id);
      }
      await auditUpdate(tx, actor, 'orders', before, updated);
      return tx.order.findUniqueOrThrow({ where: { id }, include: WITH_ITEMS });
    });

    res.json(serializeOrder(order));
  }),
);
