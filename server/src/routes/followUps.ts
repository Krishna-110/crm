import { Router } from 'express';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeFollowUp } from '../serializers.js';
import { fetchLeadById } from './leads.js';

export const followUpsRouter = Router();

followUpsRouter.get('/', async (req, res) => {
  const followUps = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM follow_ups WHERE deleted_at IS NULL ORDER BY scheduled_at ASC',
    );
    return rows;
  });
  res.json(followUps.map(serializeFollowUp));
});

followUpsRouter.patch('/:id', async (req, res) => {
  const status = req.body?.status;
  if (!status) throw ApiError.badRequest('status is required');

  const result = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      'UPDATE follow_ups SET status = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING *',
      [status, req.params.id],
    );
    const followUp = rows[0];
    if (!followUp) throw ApiError.notFound('Follow-up not found');

    let lead = null;
    if (status === 'completed' && followUp.lead_id) {
      await client.query('UPDATE leads SET last_follow_up_at = now() WHERE id = $1', [followUp.lead_id]);
      lead = await fetchLeadById(client, followUp.lead_id);
    }

    return { followUp: serializeFollowUp(followUp), lead };
  });

  res.json(result);
});
