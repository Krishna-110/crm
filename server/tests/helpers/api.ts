/**
 * supertest helpers for the Phase 3 API suite.
 *
 * src/app.ts exports `app` while src/index.ts owns the listen(), so the Express app can be
 * driven in-process with no port, no server lifecycle and no scheduler running in the
 * background. Importing app.ts has no side effects beyond constructing the Prisma client.
 */
import request from 'supertest';
import { app } from '../../src/app.js';

export const ADMIN = { email: 'aarav.sharma@medicrm.in', password: 'admin123' };
export const CALLER = { email: 'sneha.iyer@medicrm.in', password: 'caller123' };
/** A second caller, for proving one caller cannot reach another's rows. */
export const OTHER_CALLER = { email: 'ananya.desai@medicrm.in', password: 'caller123' };
/** Seeded deliberately inactive, for negative-login assertions. */
export const INACTIVE = { email: 'kavya.reddy@medicrm.in', password: 'caller123' };

export type Session = { token: string; userId: string; role: string; name: string };

export async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await request(app).post('/api/auth/login').send(creds);
  if (res.status !== 200) {
    throw new Error(`login failed for ${creds.email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    token: res.body.token,
    userId: res.body.user.id,
    role: res.body.user.role,
    name: res.body.user.name,
  };
}

/** Bound request helpers so tests read as `as(admin).get('/api/leads')`. */
export function as(session: Session) {
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${session.token}`);
  return {
    get: (url: string) => auth(request(app).get(url)),
    post: (url: string, body?: unknown) => auth(request(app).post(url).send(body ?? {})),
    patch: (url: string, body?: unknown) => auth(request(app).patch(url).send(body ?? {})),
    delete: (url: string) => auth(request(app).delete(url)),
  };
}

/** Unauthenticated request, for 401 assertions. */
export const anon = {
  get: (url: string) => request(app).get(url),
  post: (url: string, body?: unknown) => request(app).post(url).send(body ?? {}),
};

/**
 * Field names that are easy to get wrong and that produce a misleading 400 rather than an
 * obvious failure. Each of these cost a real debugging cycle, so they are centralised here
 * rather than repeated inline: POST /users wants `name`/`phone` (not `fullName`), and
 * POST /leads/:id/follow-ups wants `scheduledDate` (not `scheduledAt`).
 */
export function newLeadPayload(over: Record<string, unknown> = {}) {
  return {
    customerName: `T3 Lead ${unique()}`,
    mobile: '9000000001',
    address: '1 Test Street',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400001',
    disease: 'Hypertension',
    medicines: [{ name: 'Atorva', days: 30 }],
    ...over,
  };
}

export function newUserPayload(over: Record<string, unknown> = {}) {
  const u = unique();
  return {
    name: `T3 User ${u}`,
    email: `t3user${u}@medicrm.in`,
    phone: '9000000009',
    employeeId: `T3${u}`,
    password: 'testpass123',
    role: 'caller',
    ...over,
  };
}

let counter = 0;
/** Collision-free suffix so repeated runs and parallel cases never clash on unique keys. */
export function unique(): string {
  counter += 1;
  return `${Date.now().toString().slice(-7)}${counter}`;
}

export function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}
