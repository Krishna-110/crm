import { Router } from 'express';
import type pg from 'pg';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeOrder, serializeOrderItem } from '../serializers.js';

export const ordersRouter = Router();

const ORDER_WITH_ITEMS_SQL = `
  SELECT o.*, oi.items
  FROM orders o
  LEFT JOIN LATERAL (
    SELECT json_agg(i ORDER BY i.created_at) AS items
    FROM order_items i WHERE i.order_id = o.id
  ) oi ON true
`;

function rowToOrder(row: Record<string, any>) {
  return serializeOrder(row, (row.items ?? []).map(serializeOrderItem));
}

export async function fetchOrderById(client: pg.PoolClient, id: string) {
  const { rows } = await client.query(`${ORDER_WITH_ITEMS_SQL} WHERE o.id = $1 AND o.deleted_at IS NULL`, [id]);
  return rows[0] ? rowToOrder(rows[0]) : null;
}

const ORDER_FIELD_MAP: Record<string, string> = {
  stage: 'stage',
  paymentStatus: 'payment_status',
  discountType: 'discount_type',
  discountValue: 'discount_value',
};

ordersRouter.get('/', async (req, res) => {
  const orders = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(`${ORDER_WITH_ITEMS_SQL} WHERE o.deleted_at IS NULL ORDER BY o.created_at DESC`);
    return rows;
  });
  res.json(orders.map(rowToOrder));
});

ordersRouter.patch('/:id', async (req, res) => {
  const body = req.body ?? {};

  const order = await withUserTx(req.userId!, async (client) => {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(ORDER_FIELD_MAP)) {
      if (key in body) {
        values.push(body[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw ApiError.badRequest('no updatable fields provided');

    values.push(req.params.id);
    const { rowCount } = await client.query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL`,
      values,
    );
    if (rowCount === 0) throw ApiError.notFound('Order not found');

    return fetchOrderById(client, req.params.id);
  });

  res.json(order);
});
