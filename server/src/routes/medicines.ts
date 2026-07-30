import { Router } from 'express';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeMedicine } from '../serializers.js';

export const medicinesRouter = Router();

medicinesRouter.get('/', async (req, res) => {
  const medicines = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query('SELECT * FROM products WHERE deleted_at IS NULL ORDER BY created_at DESC');
    return rows;
  });
  res.json(medicines.map(serializeMedicine));
});

medicinesRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!body.name) throw ApiError.badRequest('name is required');

  const openingStock = body.stockQuantity === undefined ? 0 : Number(body.stockQuantity);
  if (!Number.isInteger(openingStock) || openingStock < 0) {
    throw ApiError.badRequest('Opening stock must be a whole number of 0 or more');
  }

  const medicine = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products (sku, generic_name, brand_name, dosage_form, unit_price, stock_quantity, is_active, created_by)
       VALUES ('MED-' || lpad(nextval('product_sku_seq')::text, 5, '0'), $1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        body.genericName || body.name,
        body.name,
        body.dosageForm ?? null,
        Number(body.unitPrice) || 0,
        openingStock,
        body.isActive ?? true,
        req.userId,
      ],
    );
    return rows[0];
  });

  res.status(201).json(serializeMedicine(medicine));
});

const MEDICINE_FIELD_MAP: Record<string, string> = {
  name: 'brand_name',
  genericName: 'generic_name',
  dosageForm: 'dosage_form',
  unitPrice: 'unit_price',
  isActive: 'is_active',
};

medicinesRouter.patch('/:id', async (req, res) => {
  const body = req.body ?? {};

  const medicine = await withUserTx(req.userId!, async (client) => {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(MEDICINE_FIELD_MAP)) {
      if (key in body) {
        values.push(body[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) throw ApiError.badRequest('no updatable fields provided');

    values.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!rows[0]) throw ApiError.notFound('Medicine not found');
    return rows[0];
  });

  res.json(serializeMedicine(medicine));
});

medicinesRouter.post('/:id/stock', async (req, res) => {
  const body = req.body ?? {};
  const { mode, quantity } = body;

  if (mode !== 'add' && mode !== 'set') {
    throw ApiError.badRequest("mode must be 'add' or 'set'");
  }
  if (!Number.isInteger(quantity) || (mode === 'add' && quantity <= 0) || (mode === 'set' && quantity < 0)) {
    throw ApiError.badRequest(
      mode === 'add' ? 'Quantity to add must be a whole number greater than 0' : 'Stock quantity must be a whole number of 0 or more',
    );
  }

  const medicine = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      mode === 'add'
        ? `UPDATE products SET stock_quantity = stock_quantity + $1, updated_by = $2
           WHERE id = $3 AND deleted_at IS NULL RETURNING *`
        : `UPDATE products SET stock_quantity = $1, updated_by = $2
           WHERE id = $3 AND deleted_at IS NULL RETURNING *`,
      [quantity, req.userId, req.params.id],
    );
    if (!rows[0]) throw ApiError.notFound('Medicine not found');
    return rows[0];
  });

  res.json(serializeMedicine(medicine));
});

medicinesRouter.delete('/:id', async (req, res) => {
  await withUserTx(req.userId!, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE products SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
      [req.params.id],
    );
    if (rowCount === 0) throw ApiError.notFound('Medicine not found');
  });
  res.status(204).end();
});
