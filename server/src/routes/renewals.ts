import { Router } from 'express';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { serializeRenewal, serializeFollowUp } from '../serializers.js';

export const renewalsRouter = Router();

// Reads the `renewals` model rather than renewals_view: Prisma 7 forbids @id on views and
// reports every view column as nullable, so renewals_view supports only a bare findMany()
// with no orderBy. serializeRenewal() derives days_remaining/status instead — see the
// comment there for how the view's SQL is mirrored.
renewalsRouter.get('/', async (req, res) => {
  const db = dbFor(req.actor);
  const renewals = await db.renewals.findMany({
    where: { deleted_at: null },
    orderBy: { expiry_date: 'asc' },
  });
  res.json(renewals.map(serializeRenewal));
});

renewalsRouter.post('/:id/renew', async (req, res) => {
  const actor = req.actor!;

  // renewals_update was `is_admin_or_above() OR assigned_caller_id = me` — the scoping
  // extension applies that automatically, so a caller renewing someone else's renewal
  // matches zero rows and gets the same masked 404 RLS used to produce.
  const renewal = await withDbSession(actor, async (tx) => {
    const { count } = await tx.renewals.updateMany({
      where: { id: req.params.id, renewed_at: null, deleted_at: null },
      data: { renewed_at: new Date() },
    });
    if (count === 0) throw ApiError.notFound('Renewal not found');
    return tx.renewals.findUnique({ where: { id: req.params.id } });
  });
  if (!renewal) throw ApiError.notFound('Renewal not found');
  res.json(serializeRenewal(renewal));
});

renewalsRouter.post('/:id/remind', async (req, res) => {
  const actor = req.actor!;

  // Was a single INSERT ... SELECT ... RETURNING: the SELECT both located the renewal and
  // supplied customer_id/customer_name, so a missing (or out-of-scope) renewal inserted
  // nothing and surfaced as a 404. Split into an explicit scoped lookup + create, which
  // reads more clearly and keeps the same 404 semantics.
  const followUp = await withDbSession(actor, async (tx) => {
    const renewal = await tx.renewals.findFirst({
      where: { id: req.params.id, deleted_at: null },
    });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    // assigned_caller_id is left unset deliberately — a DB trigger resolves it from the
    // linked renewal, same as it did for the original INSERT ... SELECT.
    return tx.follow_ups.create({
      data: {
        customer_id: renewal.customer_id,
        customer_name: renewal.customer_name,
        renewal_id: renewal.id,
        scheduled_at: new Date(),
        type: 'reminder',
        status: 'pending',
        notes: req.body?.notes ?? null,
        created_by: actor.userId,
      },
    });
  });

  res.status(201).json(serializeFollowUp(followUp));
});

renewalsRouter.delete('/:id', async (req, res) => {
  // Deliberately NOT requireAdmin: this is a soft delete, i.e. an UPDATE, so it was
  // governed by renewals_update (`admin OR assigned_caller_id = me`) rather than the
  // admin-only renewals_delete policy. A caller can stop their own renewal, which is what
  // the "Stop / Cancel Renewal" button relies on. The scoping extension supplies exactly
  // that filter, so an out-of-scope id matches zero rows and 404s.
  const count = await withDbSession(req.actor!, async (tx) => {
    const r = await tx.renewals.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    return r.count;
  });
  if (count === 0) throw ApiError.notFound('Renewal not found');
  res.status(204).end();
});
