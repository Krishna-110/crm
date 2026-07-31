import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { requireAdmin } from '../scope.js';
import { serializeMedicine } from '../serializers.js';

export const medicinesRouter = Router();

// products_select is `app_current_role() IS NOT NULL` — every authenticated user reads the
// full catalogue, so there is no read scope here. All writes were admin-only.
medicinesRouter.get('/', async (req, res) => {
  const db = dbFor(req.actor);
  const medicines = await db.products.findMany({
    where: { deleted_at: null },
    orderBy: { created_at: 'desc' },
  });
  res.json(medicines.map(serializeMedicine));
});

medicinesRouter.post('/', async (req, res) => {
  const actor = req.actor!;
  requireAdmin(actor);
  const db = dbFor(actor);

  const body = req.body ?? {};
  if (!body.name) throw ApiError.badRequest('name is required');

  const openingStock = body.stockQuantity === undefined ? 0 : Number(body.stockQuantity);
  if (!Number.isInteger(openingStock) || openingStock < 0) {
    throw ApiError.badRequest('Opening stock must be a whole number of 0 or more');
  }

  // SKUs come from a Postgres sequence, which Prisma cannot express in a create() — pull
  // the next value first, then create. Sequences don't roll back, so a failed create just
  // burns a number, same as the previous single-statement INSERT would on constraint error.
  const skuRows = await db.$queryRaw<{ sku: string }[]>`
    SELECT 'MED-' || lpad(nextval('product_sku_seq')::text, 5, '0') AS sku
  `;
  const sku = skuRows[0]?.sku;
  if (!sku) throw new Error('Failed to generate product SKU');

  const medicine = await withDbSession(actor, (tx) => tx.products.create({
    data: {
      sku,
      generic_name: body.genericName || body.name,
      brand_name: body.name,
      dosage_form: body.dosageForm ?? null,
      unit_price: Number(body.unitPrice) || 0,
      stock_quantity: openingStock,
      is_active: body.isActive ?? true,
      created_by: actor.userId,
    },
  }));

  res.status(201).json(serializeMedicine(medicine));
});

const MEDICINE_FIELD_MAP = {
  name: 'brand_name',
  genericName: 'generic_name',
  dosageForm: 'dosage_form',
  unitPrice: 'unit_price',
  isActive: 'is_active',
} as const;

medicinesRouter.patch('/:id', async (req, res) => {
  const actor = req.actor!;
  requireAdmin(actor);

  const body = req.body ?? {};
  const data: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(MEDICINE_FIELD_MAP)) {
    // Note: no `?? null` here — the original medicines builder pushed body[key] verbatim,
    // unlike users.ts which coerced undefined to null. Behaviour preserved as-is.
    if (key in body) data[field] = body[key];
  }
  if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

  const medicine = await withDbSession(actor, async (tx) => {
    const { count } = await tx.products.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: data as Prisma.productsUpdateManyMutationInput,
    });
    if (count === 0) throw ApiError.notFound('Medicine not found');
    return tx.products.findUnique({ where: { id: req.params.id } });
  });
  if (!medicine) throw ApiError.notFound('Medicine not found');
  res.json(serializeMedicine(medicine));
});

medicinesRouter.post('/:id/stock', async (req, res) => {
  const actor = req.actor!;
  requireAdmin(actor);

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

  // `add` is a read-modify-write in SQL (stock_quantity = stock_quantity + $1); Prisma
  // expresses that atomically as { increment }, so it stays a single UPDATE.
  const medicine = await withDbSession(actor, async (tx) => {
    const { count } = await tx.products.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: {
        stock_quantity: mode === 'add' ? { increment: quantity } : quantity,
        updated_by: actor.userId,
      },
    });
    if (count === 0) throw ApiError.notFound('Medicine not found');
    return tx.products.findUnique({ where: { id: req.params.id } });
  });
  if (!medicine) throw ApiError.notFound('Medicine not found');
  res.json(serializeMedicine(medicine));
});

medicinesRouter.delete('/:id', async (req, res) => {
  const actor = req.actor!;
  requireAdmin(actor);

  const count = await withDbSession(actor, async (tx) => {
    const r = await tx.products.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    return r.count;
  });
  if (count === 0) throw ApiError.notFound('Medicine not found');
  res.status(204).end();
});
