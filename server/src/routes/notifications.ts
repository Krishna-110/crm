import { Router } from 'express';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { serializeNotification } from '../serializers.js';

export const notificationsRouter = Router();

// Explicitly self-scoped rather than relying only on RLS: notifications_select also
// lets any admin see every user's notifications (a support/oversight feature), but the
// bell icon this backs is a personal inbox — an admin's own bell should show only
// their own notifications, not the whole system's.
//
// That self-scoping is now the ONLY thing enforcing this: Prisma bypasses RLS, so the
// recipient_user_id filter below is load-bearing, not belt-and-braces.
notificationsRouter.get('/', async (req, res) => {
  const actor = req.actor!;
  const db = dbFor(actor);
  const notifications = await db.notifications.findMany({
    where: { recipient_user_id: actor.userId, deleted_at: null },
    orderBy: { created_at: 'desc' },
    take: 50,
  });
  res.json(notifications.map(serializeNotification));
});

notificationsRouter.patch('/:id/read', async (req, res) => {
  const actor = req.actor!;

  // notifications is a partitioned table with a composite PK (id, created_at), so there
  // is no single-column unique key for Prisma's `update` to target — updateMany scoped by
  // recipient is both the ownership check and the write, and count === 0 reproduces the
  // old `rowCount === 0` → 404.
  const notification = await withDbSession(actor, async (tx) => {
    const { count } = await tx.notifications.updateMany({
      where: { id: req.params.id, recipient_user_id: actor.userId },
      data: { is_read: true },
    });
    if (count === 0) throw ApiError.notFound('Notification not found');
    return tx.notifications.findFirst({ where: { id: req.params.id } });
  });
  if (!notification) throw ApiError.notFound('Notification not found');

  res.json(serializeNotification(notification));
});
