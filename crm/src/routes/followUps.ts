import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { serializeFollowUp } from '../lib/serialize.js';

export const followUpsRouter = Router();

followUpsRouter.get(
  '/',
  route(async (req, res) => {
    const followUps = await scopedFor(actorOf(req)).followUp.findMany({
      where: { deletedAt: null },
      orderBy: { scheduledAt: 'asc' },
    });
    res.json(followUps.map(serializeFollowUp));
  }),
);

followUpsRouter.patch(
  '/:id',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const id = param(req, 'id');
    const body = req.body ?? {};

    const before = await db.followUp.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('Follow-up not found');

    const data: Record<string, unknown> = {};
    if ('status' in body) data.status = body.status;
    if ('notes' in body) data.notes = body.notes ?? null;
    if ('scheduledDate' in body) data.scheduledAt = new Date(body.scheduledDate);
    if ('type' in body) data.type = body.type;
    if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

    const followUp = await prisma.$transaction(async (tx) => {
      const updated = await tx.followUp.update({ where: { id }, data });
      // Completing a follow-up advances the lead's last-contacted marker, which is what the
      // list view sorts and filters on.
      if (body.status === 'completed' && updated.leadId) {
        await tx.lead.update({
          where: { id: updated.leadId },
          data: { lastFollowUpAt: new Date() },
        });
      }
      return updated;
    });

    res.json(serializeFollowUp(followUp));
  }),
);
