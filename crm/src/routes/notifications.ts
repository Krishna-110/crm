import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { serializeNotification } from '../lib/serialize.js';

export const notificationsRouter = Router();

/**
 * Explicitly self-scoped, not left to the scope layer.
 *
 * An admin's scope is unrestricted, which would make this endpoint return every user's
 * notifications — but it backs the bell icon, which is a personal inbox. An admin should see
 * their own, not the system's. The filter here is the whole behaviour, so it is written out
 * rather than inherited.
 */
notificationsRouter.get(
  '/',
  route(async (req, res) => {
    const actor = actorOf(req);
    const notifications = await prisma.notification.findMany({
      where: { recipientUserId: actor.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(notifications.map(serializeNotification));
  }),
);

notificationsRouter.patch(
  '/:id/read',
  route(async (req, res) => {
    const actor = actorOf(req);
    const id = param(req, 'id');

    // Ownership is the where clause: someone else's notification simply is not found.
    const existing = await prisma.notification.findFirst({
      where: { id, recipientUserId: actor.userId },
    });
    if (!existing) throw ApiError.notFound('Notification not found');

    const notification = await prisma.notification.update({
      where: { id },
      // readAt is stamped only on the transition, so it records when it was first read.
      data: { isRead: true, readAt: existing.readAt ?? new Date() },
    });
    res.json(serializeNotification(notification));
  }),
);
