import { Router } from 'express';
import bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { dbFor, withDbSession } from '../scopedPrisma.js';
import { ApiError } from '../errors.js';
import { assertCanEditUser, requireAdmin, userScope } from '../scope.js';
import { serializeUser } from '../serializers.js';

export const usersRouter = Router();

// API key -> Prisma field. Mirrors the old USER_FIELD_MAP (which mapped to raw columns).
const USER_FIELD_MAP = {
  name: 'name',
  employeeId: 'employee_id',
  phone: 'phone',
  email: 'email',
  role: 'role',
  status: 'status',
  avatar: 'avatar_url',
} as const;

usersRouter.get('/', async (req, res) => {
  const actor = req.actor!;
  const db = dbFor(actor);
  const users = await db.users.findMany({
    where: { deleted_at: null, ...userScope(actor) },
    orderBy: { created_at: 'desc' },
  });
  res.json(users.map(serializeUser));
});

usersRouter.post('/', async (req, res) => {
  // users_insert was admin-only in RLS; with Prisma bypassing RLS this check is what
  // rejects a caller (previously a 42501 -> 403, now an explicit 403).
  const actor = req.actor!;
  requireAdmin(actor);

  const body = req.body ?? {};
  for (const field of ['name', 'employeeId', 'phone', 'email']) {
    if (!body[field]) throw ApiError.badRequest(`${field} is required`);
  }
  const passwordHash = await bcrypt.hash(body.password || 'Welcome123!', 10);

  const user = await withDbSession(actor, (tx) => tx.users.create({
    data: {
      employee_id: body.employeeId,
      name: body.name,
      phone: body.phone,
      email: body.email,
      password_hash: passwordHash,
      role: body.role ?? 'caller',
      status: body.status ?? 'active',
    },
  }));

  res.status(201).json(serializeUser(user));
});

usersRouter.patch('/:id', async (req, res) => {
  const actor = req.actor!;
  // users_update: is_admin_or_above() OR id = app_current_user_id().
  // prevent_privilege_escalation stops a caller changing their own role/status/
  // employee_id. It branches on app_current_role(), so it only fires when the UPDATE runs
  // inside withDbSession — which is why the write below does. Outside a session the GUC is
  // NULL, the branch never matches, and a caller can make themselves an admin.
  assertCanEditUser(actor, req.params.id);
  const db = dbFor(actor);

  const body = req.body ?? {};
  const data: Prisma.usersUpdateInput = {};
  for (const [key, field] of Object.entries(USER_FIELD_MAP)) {
    // `key in body` (not a truthiness check): an explicitly-sent null must still clear the
    // column, which Prisma would ignore if it were passed as undefined.
    if (key in body) (data as Record<string, unknown>)[field] = body[key] ?? null;
  }
  if (body.password) data.password_hash = await bcrypt.hash(body.password, 10);
  if (Object.keys(data).length === 0) throw ApiError.badRequest('no updatable fields provided');

  // withDbSession, not a bare update: prevent_privilege_escalation is a trigger keyed on
  // app_current_role(), so without the session GUC a caller could set their own role to
  // admin. Verified — that exact escalation succeeded before this was added.
  const user = await withDbSession(actor, async (tx) => {
    const { count } = await tx.users.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: data as Prisma.usersUpdateManyMutationInput,
    });
    if (count === 0) throw ApiError.notFound('User not found');
    return tx.users.findUnique({ where: { id: req.params.id } });
  });
  if (!user) throw ApiError.notFound('User not found');
  res.json(serializeUser(user));
});

usersRouter.delete('/:id', async (req, res) => {
  const actor = req.actor!;
  // Soft delete is an UPDATE, so it fell under users_update rather than users_delete —
  // which is why a caller can deactivate their own account but nobody else's. Preserved.
  assertCanEditUser(actor, req.params.id);

  const count = await withDbSession(actor, async (tx) => {
    const result = await tx.users.updateMany({
      where: { id: req.params.id, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    return result.count;
  });
  if (count === 0) throw ApiError.notFound('User not found');
  res.status(204).end();
});
