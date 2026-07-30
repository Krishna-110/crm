import { Router } from 'express';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { followUpScope } from '../scope.js';
import { serializeFollowUp } from '../serializers.js';
import { fetchLeadById } from './leads.js';

export const followUpsRouter = Router();

followUpsRouter.get('/', async (req, res) => {
  const actor = req.actor!;
  const db = dbFor(actor);
  const followUps = await db.follow_ups.findMany({
    where: { deleted_at: null, ...followUpScope(actor) },
    orderBy: { scheduled_at: 'asc' },
  });
  res.json(followUps.map(serializeFollowUp));
});

followUpsRouter.patch('/:id', async (req, res) => {
  const actor = req.actor!;
  const db = dbFor(actor);
  const status = req.body?.status;
  if (!status) throw ApiError.badRequest('status is required');

  // Scoped update: a caller may only touch their own follow-ups (follow_ups_update was
  // `is_admin_or_above() OR assigned_caller_id = me`). count === 0 covers both "no such
  // row" and "not yours", matching the previous RLS-masked 404.
  const result = await withDbSession(actor, async (tx) => {
    const { count } = await tx.follow_ups.updateMany({
      where: { id: req.params.id, deleted_at: null, ...followUpScope(actor) },
      data: { status },
    });
    if (count === 0) throw ApiError.notFound('Follow-up not found');

    const followUp = await tx.follow_ups.findUnique({ where: { id: req.params.id } });
    if (!followUp) throw ApiError.notFound('Follow-up not found');

    let lead = null;
    if (status === 'completed' && followUp.lead_id) {
      await tx.leads.update({
        where: { id: followUp.lead_id },
        data: { last_follow_up_at: new Date() },
      });
      lead = await fetchLeadById(tx as never, followUp.lead_id);
    }
    return { followUp: serializeFollowUp(followUp), lead };
  });

  res.json(result);
});
