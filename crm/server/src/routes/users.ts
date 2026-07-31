import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma.js';
import { scopedFor } from '../db/scoped.js';
import { actorOf } from '../auth/auth.js';
import { ApiError, param, route } from '../lib/errors.js';
import { assertCanEditUser, assertNoPrivilegeEscalation, requireAdmin } from '../auth/scope.js';
import { serializeUser } from '../lib/serialize.js';
import { auditCreate, auditUpdate } from '../services/audit.js';

export const usersRouter = Router();

const EDITABLE = ['name', 'phone', 'email', 'role', 'status', 'employeeId', 'avatarUrl'] as const;

usersRouter.get(
  '/',
  route(async (req, res) => {
    // A caller's scope narrows this to themselves, so the same query serves both roles.
    const users = await scopedFor(actorOf(req)).user.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users.map(serializeUser));
  }),
);

usersRouter.post(
  '/',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const body = req.body ?? {};
    for (const f of ['name', 'employeeId', 'phone', 'email']) {
      if (!body[f]) throw ApiError.badRequest(`${f} is required`);
    }

    const passwordHash = await bcrypt.hash(body.password || 'Welcome123!', 10);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: body.name,
          employeeId: body.employeeId,
          phone: body.phone,
          // Lowercased on write — the unique index then gives case-insensitive uniqueness
          // without needing the citext extension.
          email: String(body.email).trim().toLowerCase(),
          role: body.role === 'admin' ? 'admin' : 'caller',
          passwordHash,
        },
      });
      await auditCreate(tx, actor, 'users', created);
      return created;
    });
    res.status(201).json(serializeUser(user));
  }),
);

usersRouter.patch(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    const id = param(req, 'id');
    const body = req.body ?? {};

    assertCanEditUser(actor, id);
    // Refused before any read, so the answer cannot depend on what the caller can see.
    assertNoPrivilegeEscalation(actor, body);

    const before = await scopedFor(actor).user.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('User not found');

    const data: Record<string, unknown> = {};
    for (const f of EDITABLE) if (f in body) data[f] = body[f] ?? null;
    if (typeof data.email === 'string') data.email = data.email.trim().toLowerCase();

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data });
      await auditUpdate(tx, actor, 'users', before, updated);
      return updated;
    });
    res.json(serializeUser(user));
  }),
);

usersRouter.delete(
  '/:id',
  route(async (req, res) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const id = param(req, 'id');

    const before = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw ApiError.notFound('User not found');

    await prisma.$transaction(async (tx) => {
      const deleted = await tx.user.update({ where: { id }, data: { deletedAt: new Date() } });
      // Existing sessions stop working immediately rather than lingering until they expire.
      await tx.session.deleteMany({ where: { userId: id } });
      await auditUpdate(tx, actor, 'users', before, deleted);
    });
    res.status(204).end();
  }),
);
