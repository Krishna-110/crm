import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma.js';
import { withDbSession } from './scopedPrisma.js';
import { ApiError } from './errors.js';
import type { Actor } from './scope.js';
import { config } from './config.js';
import { serializeUser } from './serializers.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      // Set alongside userId by requireAuth. Prisma-backed routes authorize off this
      // (see src/scope.ts). userId is kept for convenience/back-compat.
      actor?: Actor;
    }
  }
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

// Resolves a bearer token to req.userId + req.actor.
//
// This used to go through the SECURITY DEFINER auth_session_lookup() helper, which existed
// purely to escape a chicken-and-egg problem: RLS needs app.current_user_id set, but you
// can't know the user until you've read the session. Prisma connects as a BYPASSRLS role,
// so that bootstrap is no longer needed and the same rules are expressed directly as a
// single query — the where clause below is a literal translation of that function's body
// (matching token, unexpired, user active and not soft-deleted).
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized();
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw ApiError.unauthorized();

  const session = await prisma.sessions.findFirst({
    where: {
      token_hash: hashToken(token),
      expires_at: { gt: new Date() },
      users: { status: 'active', deleted_at: null },
    },
    select: { users: { select: { id: true, role: true } } },
  });
  if (!session) throw ApiError.unauthorized();

  req.userId = session.users.id;
  req.actor = { userId: session.users.id, role: session.users.role as Actor['role'] };
  next();
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw ApiError.badRequest('email and password are required');
  }

  // Replaces the SECURITY DEFINER auth_login_lookup(), which existed only to read
  // users before an RLS session could be established. The filters are the same:
  // active and not soft-deleted. email is citext, so the match stays case-insensitive.
  const row = await prisma.users.findFirst({
    where: { email, status: 'active', deleted_at: null },
    select: { id: true, password_hash: true, role: true },
  });
  // Same message whether the email doesn't exist, the account is inactive, or the
  // password is wrong — the lookup above already filters to active+non-deleted, so a
  // NOT FOUND here is indistinguishable from a wrong password to the caller.
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + config.tokenTtlHours * 60 * 60 * 1000);

  // withDbSession so log_audit's changed_by is attributed to this user rather than NULL —
  // the trigger reads app_current_user_id(), which is unset on a bare Prisma connection.
  const user = await withDbSession({ userId: row.id, role: row.role as Actor['role'] }, async (tx) => {
    await tx.sessions.create({
      data: { user_id: row.id, token_hash: hashToken(token), expires_at: expiresAt },
    });
    return tx.users.update({ where: { id: row.id }, data: { last_login_at: new Date() } });
  });

  res.json({ token, user: serializeUser(user) });
}

export async function logout(req: Request, res: Response) {
  const token = req.headers.authorization!.slice('Bearer '.length).trim();
  await withDbSession(req.actor!, (tx) => tx.sessions.deleteMany({ where: { token_hash: hashToken(token) } }));
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  const user = await prisma.users.findUnique({ where: { id: req.userId! } });
  if (!user) throw ApiError.notFound('User not found');
  res.json({ user: serializeUser(user) });
}

export async function changePassword(req: Request, res: Response) {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword) {
    throw ApiError.badRequest('currentPassword and newPassword are required');
  }
  if (newPassword.length < 6) {
    throw ApiError.badRequest('New password must be at least 6 characters');
  }

  const row = await prisma.users.findUnique({
    where: { id: req.userId! },
    select: { password_hash: true },
  });
  // 400, not 401: the session itself is valid (requireAuth already passed) — this is
  // the user mistyping a separate credential, not their session expiring. A 401 here
  // would trip the client's session-expired auto-logout for the wrong reason.
  //
  // The bcrypt hash below is ~100ms of CPU; it deliberately runs OUTSIDE a transaction,
  // unlike the previous withUserTx version which held one open across it.
  if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
    throw ApiError.badRequest('Current password is incorrect');
  }
  const newHash = await bcrypt.hash(newPassword, 10);
  await withDbSession(req.actor!, (tx) =>
    tx.users.update({ where: { id: req.userId! }, data: { password_hash: newHash } }),
  );

  res.status(204).end();
}
