import { Router } from 'express';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeRenewal, serializeFollowUp } from '../serializers.js';

export const renewalsRouter = Router();

renewalsRouter.get('/', async (req, res) => {
  const renewals = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query('SELECT * FROM renewals_view ORDER BY expiry_date ASC');
    return rows;
  });
  res.json(renewals.map(serializeRenewal));
});

renewalsRouter.post('/:id/renew', async (req, res) => {
  const renewal = await withUserTx(req.userId!, async (client) => {
    const { rowCount } = await client.query(
      'UPDATE renewals SET renewed_at = now() WHERE id = $1 AND renewed_at IS NULL AND deleted_at IS NULL',
      [req.params.id],
    );
    if (rowCount === 0) throw ApiError.notFound('Renewal not found');

    const { rows } = await client.query('SELECT * FROM renewals_view WHERE id = $1', [req.params.id]);
    return rows[0];
  });

  res.json(serializeRenewal(renewal));
});

renewalsRouter.post('/:id/remind', async (req, res) => {
  const followUp = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO follow_ups (customer_id, customer_name, renewal_id, scheduled_at, type, status, notes, created_by)
       SELECT r.customer_id, r.customer_name, r.id, now(), 'reminder', 'pending', $2, $3
       FROM renewals r WHERE r.id = $1 AND r.deleted_at IS NULL
       RETURNING *`,
      [req.params.id, req.body?.notes ?? null, req.userId],
    );
    if (!rows[0]) throw ApiError.notFound('Renewal not found');
    return rows[0];
  });

  res.status(201).json(serializeFollowUp(followUp));
});
