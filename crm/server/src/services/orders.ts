import { Prisma } from '@prisma/client';
import type { Tx } from '../db/prisma.js';

/**
 * Order pricing.
 *
 * Two things used to live in the database: a GENERATED column for each line's total, and a
 * delta-based trigger keeping the order's running total in step. Both are here now, and both
 * changed shape deliberately.
 *
 * The trigger applied a DELTA on every insert, update and delete. A delta drifts permanently
 * the moment one is missed or applied twice — which is exactly why it carried a
 * GREATEST(total, 0) clamp, to stop the visible symptom of arithmetic that had already gone
 * wrong. Recomputing from the line rows is idempotent, cannot go negative, and repairs any
 * existing drift on the next write.
 */

/** A line's total. Was a GENERATED column; the rule is one multiplication and belongs here. */
export const lineTotal = (quantity: number, unitPrice: Prisma.Decimal | number): Prisma.Decimal =>
  new Prisma.Decimal(unitPrice).mul(quantity);

/**
 * Amount actually payable after the order-level discount, floored at zero.
 *
 * Was a GENERATED column carrying a CASE over discount_type. Expressed here so the pricing
 * rule is readable and testable without a database.
 */
export function payableAmount(
  total: Prisma.Decimal | number,
  discountType: 'none' | 'flat' | 'percentage',
  discountValue: Prisma.Decimal | number,
): Prisma.Decimal {
  const t = new Prisma.Decimal(total);
  const v = new Prisma.Decimal(discountValue);
  const payable =
    discountType === 'flat'
      ? t.sub(v)
      : discountType === 'percentage'
        ? t.mul(new Prisma.Decimal(1).sub(v.div(100)))
        : t;
  return payable.isNegative() ? new Prisma.Decimal(0) : payable;
}

/**
 * Recomputes an order's totals from its live line items.
 *
 * Call after any change to the order's items or its discount. Safe to call redundantly —
 * that is the point of recomputing rather than adjusting.
 */
export async function recalculateOrderTotals(tx: Tx, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { discountType: true, discountValue: true },
  });
  if (!order) return;

  const agg = await tx.orderItem.aggregate({
    where: { orderId, deletedAt: null },
    _sum: { lineTotal: true },
  });
  const total = agg._sum.lineTotal ?? new Prisma.Decimal(0);

  await tx.order.update({
    where: { id: orderId },
    data: {
      totalAmount: total,
      payableAmount: payableAmount(total, order.discountType, order.discountValue),
    },
  });
}

/**
 * The next order number, as ORD-YYYY-NNNN.
 *
 * Uses a Postgres sequence rather than counting existing rows: a count is racy under
 * concurrent conversions and would collide on the unique index. A sequence is a plain
 * database object, not procedural code, so it costs nothing against the no-PL/pgSQL goal.
 */
export async function nextOrderNumber(tx: Tx): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_number_seq') AS n`;
  const seq = String(row?.n ?? 1).padStart(4, '0');
  return `ORD-${new Date().getFullYear()}-${seq}`;
}
