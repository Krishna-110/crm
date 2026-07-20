import { Router } from 'express';
import { withUserTx } from '../db.js';
import { ApiError } from '../errors.js';
import { serializeNotification } from '../serializers.js';

export const notificationsRouter = Router();

// Explicitly self-scoped rather than relying only on RLS: notifications_select also
// lets any admin see every user's notifications (a support/oversight feature), but the
// bell icon this backs is a personal inbox — an admin's own bell should show only
// their own notifications, not the whole system's.
notificationsRouter.get('/', async (req, res) => {
  const notifications = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM notifications
       WHERE recipient_user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId],
    );
    return rows;
  });
  res.json(notifications.map(serializeNotification));
});

notificationsRouter.patch('/:id/read', async (req, res) => {
  const notification = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND recipient_user_id = $2 RETURNING *',
      [req.params.id, req.userId],
    );
    if (!rows[0]) throw ApiError.notFound('Notification not found');
    return rows[0];
  });

  res.json(serializeNotification(notification));
});
