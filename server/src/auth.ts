import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { appPool, withUserTx } from './db.js';
import { ApiError } from './errors.js';
import { config } from './config.js';
import { serializeUser } from './serializers.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

// Resolves a bearer token to req.userId via the SECURITY DEFINER auth_session_lookup
// bootstrap (no app.current_user_id/app.current_role exists yet at this point, so a
// plain-rights query against sessions/users would be filtered to zero rows by RLS).
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw ApiError.unauthorized();
  const token = header.slice('Bearer '.length).trim();
  if (!token) throw ApiError.unauthorized();

  const { rows } = await appPool.query<{ user_id: string }>(
    'SELECT user_id FROM auth_session_lookup($1)',
    [hashToken(token)],
  );
  if (!rows[0]) throw ApiError.unauthorized();

  req.userId = rows[0].user_id;
  next();
}

export async function login(req: Request, res: Response) {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw ApiError.badRequest('email and password are required');
  }

  const { rows } = await appPool.query<{ user_id: string; password_hash: string }>(
    'SELECT user_id, password_hash FROM auth_login_lookup($1)',
    [email],
  );
  const row = rows[0];
  // Same message whether the email doesn't exist, the account is inactive, or the
  // password is wrong — auth_login_lookup already filters to active+non-deleted, so a
  // NOT FOUND here is indistinguishable from a wrong password to the caller.
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.tokenTtlHours * 60 * 60 * 1000);

  const user = await withUserTx(row.user_id, async (client) => {
    await client.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [row.user_id, tokenHash, expiresAt],
    );
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [row.user_id]);
    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1', [row.user_id]);
    return userRows[0];
  });

  res.json({ token, user: serializeUser(user) });
}

export async function logout(req: Request, res: Response) {
  const token = req.headers.authorization!.slice('Bearer '.length).trim();
  await withUserTx(req.userId!, async (client) => {
    await client.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  });
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  const user = await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    return rows[0];
  });
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

  await withUserTx(req.userId!, async (client) => {
    const { rows } = await client.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    const row = rows[0];
    // 400, not 401: the session itself is valid (requireAuth already passed) — this is
    // the user mistyping a separate credential, not their session expiring. A 401 here
    // would trip the client's session-expired auto-logout for the wrong reason.
    if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
      throw ApiError.badRequest('Current password is incorrect');
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId]);
  });

  res.status(204).end();
}
