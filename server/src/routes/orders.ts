import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { isAdmin } from '../scope.js';
import { serializeOrder, serializeOrderItem } from '../serializers.js';

export const ordersRouter = Router();

// API key -> Prisma field, replacing the old raw-column ORDER_FIELD_MAP.
const ORDER_FIELD_MAP = {
  stage: 'stage',
  paymentStatus: 'payment_status',
  discountType: 'discount_type',
  discountValue: 'discount_value',
} as const;

// The LATERAL + json_agg aggregation becomes a nested include. Prisma runs this as one
// query per relation and stitches the result in memory rather than a single LATERAL join —
// same output shape, different execution plan. The item ordering is preserved explicitly.
const WITH_ITEMS = {
  order_items: { orderBy: { created_at: 'asc' } },
} satisfies Prisma.ordersInclude;

ordersRouter.get('/', async (req, res) => {
  const db = dbFor(req.actor);
  const orders = await db.orders.findMany({
    where: { deleted_at: null },
    include: WITH_ITEMS,
    orderBy: { created_at: 'desc' },
  });
  res.json(orders.map((o) => serializeOrder(o, o.order_items.map(serializeOrderItem))));
});

ordersRouter.patch('/:id', async (req, res) => {
  const actor = req.actor!;
  const db = dbFor(actor);

  // orders_update was admin-only, and a caller's UPDATE simply matched zero rows — so the
  // API answered 404 "Order not found", not 403 (documented in docs/TEST_PLAN.md as
  // "masked as Order not found"). Reproduced deliberately rather than switched to a 403:
  // the scoping extension would otherwise let a caller edit their OWN order, which RLS
  // never permitted, and changing the status code would be a visible API change.
  if (!isAdmin(actor)) throw ApiError.notFound('Order not found');

  const body = req.body ?? {};
  const data: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(ORDER_FIELD_MAP)) {
    if (key in body) data[field] = body[key];
  }
  if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

  const order = await withDbSession(actor, async (tx) => {
    const { count } = await tx.orders.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: data as Prisma.ordersUpdateManyMutationInput,
    });
    if (count === 0) throw ApiError.notFound('Order not found');
    return tx.orders.findUnique({ where: { id: req.params.id }, include: WITH_ITEMS });
  });
  if (!order) throw ApiError.notFound('Order not found');
  res.json(serializeOrder(order, order.order_items.map(serializeOrderItem)));
});
