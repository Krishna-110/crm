import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { serializeFollowUp, serializeRenewal } from '../lib/serialize.js';

export const renewalsRouter = Router();

renewalsRouter.get(
  '/',
  route(async (req, res) => {
    const renewals = await scopedFor(actorOf(req)).renewal.findMany({
      where: { deletedAt: null },
      orderBy: { expiryDate: 'asc' },
    });
    // status and daysRemaining are derived at serialization time — see lib/dates.ts.
    res.json(renewals.map(serializeRenewal));
  }),
);

renewalsRouter.post(
  '/:id/renew',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const id = param(req, 'id');

    // Scoped, so a caller renewing someone else's renewal finds nothing and gets the same
    // 404 as one that does not exist.
    const renewal = await db.renewal.findFirst({
      where: { id, renewedAt: null, deletedAt: null },
    });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    const updated = await prisma.renewal.update({
      where: { id },
      data: { renewedAt: new Date() },
    });
    res.json(serializeRenewal(updated));
  }),
);

renewalsRouter.post(
  '/:id/remind',
  route(async (req, res) => {
    const actor = actorOf(req);
    const db = scopedFor(actor);
    const id = param(req, 'id');

    const renewal = await db.renewal.findFirst({ where: { id, deletedAt: null } });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    const followUp = await prisma.followUp.create({
      data: {
        customerId: renewal.customerId,
        customerName: renewal.customerName,
        renewalId: renewal.id,
        scheduledAt: new Date(),
        type: 'reminder',
        status: 'pending',
        notes: req.body?.notes ?? null,
        // Inherited from the renewal, so the reminder lands with whoever owns it.
        assignedCallerId: renewal.assignedCallerId,
        createdBy: actor.userId,
      },
    });
    res.status(201).json(serializeFollowUp(followUp));
  }),
);

renewalsRouter.delete(
  '/:id',
  route(async (req, res) => {
    const db = scopedFor(actorOf(req));
    const id = param(req, 'id');

    // Deliberately not admin-only: this is the "stop this renewal" action, and a caller
    // needs it for their own. The scope is what limits which ones they can reach.
    const renewal = await db.renewal.findFirst({ where: { id, deletedAt: null } });
    if (!renewal) throw ApiError.notFound('Renewal not found');

    await prisma.renewal.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  }),
);
