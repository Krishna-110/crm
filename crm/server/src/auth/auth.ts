import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../lib/errors.js';
import { serializeUser } from '../lib/serialize.js';
import type { Actor, ActorRole } from './scope.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS ?? 24);

/**
 * Sessions are opaque random tokens, stored only as a SHA-256 digest.
 *
 * Hashed rather than stored raw so a leaked database does not hand over live sessions.
 * SHA-256 rather than bcrypt because the token is 256 bits of entropy we generated — there
 * is nothing to brute-force, and this runs on every authenticated request.
 */
const hashToken = (token: string): string =>
  'sha256:' + crypto.createHash('sha256').update(token).digest('hex');

/**
 * Resolves the bearer token to an actor.
 *
 * Uses the UNSCOPED client deliberately: scoping needs an actor, and this is the code that
 * establishes one. Everything downstream goes through scopedFor().
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw ApiError.unauthorized();

    const session = await prisma.session.findFirst({
      where: {
        tokenHash: hashToken(token),
        expiresAt: { gt: new Date() },
        // A deactivated or deleted account's existing sessions stop working immediately,
        // rather than lingering until they expire.
        user: { status: 'active', deletedAt: null },
      },
      select: { user: { select: { id: true, role: true } } },
    });
    if (!session) throw ApiError.unauthorized();

    req.actor = { userId: session.user.id, role: session.user.role as ActorRole };
    next();
  } catch (err) {
    next(err);
  }
}

/** Reads the actor a route is running as. Throws rather than returning undefined. */
export function actorOf(req: Request): Actor {
  if (!req.actor) throw ApiError.unauthorized();
  return req.actor;
}

export async function login(req: Request, res: Response) {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!email || !password) throw ApiError.badRequest('email and password are required');

  const user = await prisma.user.findFirst({
    where: { email, status: 'active', deletedAt: null },
  });

  // One message for every failure — unknown email, wrong password, deactivated account.
  // Distinguishing them tells an attacker which addresses are real.
  const ok = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !ok) throw ApiError.unauthorized('Invalid email or password');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3_600_000);

  const [, updated] = await prisma.$transaction([
    prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    }),
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }),
  ]);

  res.json({ token, user: serializeUser(updated) });
}

export async function logout(req: Request, res: Response) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  const actor = actorOf(req);
  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user) throw ApiError.notFound('User not found');
  res.json({ user: serializeUser(user) });
}

export async function changePassword(req: Request, res: Response) {
  const actor = actorOf(req);
  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');

  if (!currentPassword || !newPassword) {
    throw ApiError.badRequest('currentPassword and newPassword are required');
  }
  if (newPassword.length < 6) {
    throw ApiError.badRequest('New password must be at least 6 characters');
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId } });
  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw ApiError.badRequest('Current password is incorrect');
  }

  // Hashed outside any transaction — bcrypt at cost 10 takes ~100ms and holding a database
  // transaction open for it wastes a connection for no reason.
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({ where: { id: actor.userId }, data: { passwordHash } });
  res.status(204).end();
}

export { hashToken };
