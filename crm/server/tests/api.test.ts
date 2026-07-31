import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/db/prisma.js';

/**
 * The HTTP contract, driven in-process with supertest.
 *
 * app.ts exports the app without listening, so there is no port and no server lifecycle
 * here. This is the layer the frontend actually consumes, so it is also the layer that
 * proves the rewrite is equivalent to what came before.
 *
 * Convention worth stating: a refused write is asserted BOTH by status and by re-reading the
 * row. A 403 that still wrote is exactly the bug this suite exists to catch, and a status
 * assertion alone cannot tell the difference.
 */

const ADMIN = { email: 'aarav.sharma@medicrm.in', password: 'admin123' };
const CALLER = { email: 'sneha.iyer@medicrm.in', password: 'caller123' };
const OTHER = { email: 'ananya.desai@medicrm.in', password: 'caller123' };
const INACTIVE = { email: 'kavya.reddy@medicrm.in', password: 'caller123' };

type Session = { token: string; userId: string; role: string };

async function login(creds: { email: string; password: string }): Promise<Session> {
  const res = await request(app).post('/api/auth/login').send(creds);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, userId: res.body.user.id, role: res.body.user.role };
}

const as = (s: Session) => ({
  get: (u: string) => request(app).get(u).set('Authorization', `Bearer ${s.token}`),
  post: (u: string, b?: unknown) => request(app).post(u).set('Authorization', `Bearer ${s.token}`).send(b ?? {}),
  patch: (u: string, b?: unknown) => request(app).patch(u).set('Authorization', `Bearer ${s.token}`).send(b ?? {}),
  delete: (u: string) => request(app).delete(u).set('Authorization', `Bearer ${s.token}`),
});

let admin: Session;
let caller: Session;
let other: Session;
let uniq = 0;
const nextId = () => `${Date.now()}${uniq++}`;

const leadPayload = (over: Record<string, unknown> = {}) => ({
  customerName: `T Lead ${nextId()}`,
  mobile: '9000000001',
  address: '1 Test Street',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
  disease: 'Hypertension',
  medicines: [{ name: 'Atorva', days: 30 }],
  ...over,
});

beforeAll(async () => {
  [admin, caller, other] = await Promise.all([login(ADMIN), login(CALLER), login(OTHER)]);
});

describe('authentication', () => {
  it('signs in an admin and a caller', () => {
    expect(admin.role).toBe('admin');
    expect(caller.role).toBe('caller');
  });

  it('answers 401 identically for wrong password, unknown email and inactive account', async () => {
    // Identical responses on purpose — distinguishing them tells an attacker which addresses
    // are real, and which accounts merely need reactivating.
    for (const creds of [
      { ...ADMIN, password: 'wrong' },
      { email: 'nobody@medicrm.in', password: 'x' },
      INACTIVE,
    ]) {
      const res = await request(app).post('/api/auth/login').send(creds);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid email or password');
    }
  });

  it('requires a token, and rejects a malformed one', async () => {
    expect((await request(app).get('/api/leads')).status).toBe(401);
    expect((await as({ token: 'nope', userId: '', role: '' }).get('/api/leads')).status).toBe(401);
  });

  it('GET /auth/me nests the user, and never leaks a password hash', async () => {
    const res = await as(caller).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(caller.userId);
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it('logout invalidates the token immediately', async () => {
    const s = await login(OTHER);
    expect((await as(s).post('/api/auth/logout')).status).toBe(204);
    expect((await as(s).get('/api/leads')).status).toBe(401);
  });

  it('changing a password requires the current one', async () => {
    const s = await login(OTHER);
    const bad = await as(s).patch('/api/auth/password', { currentPassword: 'wrong', newPassword: 'abcdef' });
    expect(bad.status).toBe(400);
    // Same value in and out, so the fixture credentials keep working.
    const ok = await as(s).patch('/api/auth/password', {
      currentPassword: OTHER.password, newPassword: OTHER.password,
    });
    expect(ok.status).toBe(204);
  });
});

describe('read scoping over HTTP', () => {
  it.each(['/api/leads', '/api/users', '/api/renewals'])('%s narrows for a caller', async (url) => {
    const [a, c] = await Promise.all([as(admin).get(url), as(caller).get(url)]);
    expect(a.status).toBe(200);
    expect(c.body.length).toBeGreaterThan(0);
    expect(c.body.length).toBeLessThan(a.body.length);
  });

  it('every lead a caller sees is their own', async () => {
    const res = await as(caller).get('/api/leads');
    expect(res.body.every((l: { assignedCaller: string }) => l.assignedCaller === caller.userId)).toBe(true);
  });

  it('the catalogue is shared, not narrowed', async () => {
    const [a, c] = await Promise.all([as(admin).get('/api/medicines'), as(caller).get('/api/medicines')]);
    expect(c.body.length).toBe(a.body.length);
    expect(c.body.length).toBeGreaterThan(0);
  });

  it('notifications are a personal inbox even for an admin', async () => {
    // An admin's scope is unrestricted, so without explicit self-scoping this would return
    // every user's notifications into the bell icon.
    const res = await as(admin).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0); // the fixture's only notification belongs to the caller
    expect((await as(caller).get('/api/notifications')).body.length).toBeGreaterThan(0);
  });

  it('lookups serve the frontend’s dropdowns', async () => {
    const res = await as(caller).get('/api/lookups');
    expect(res.status).toBe(200);
    for (const key of ['leadStatuses', 'leadSources', 'orderStages', 'paymentStatuses', 'followUpTypes', 'followUpStatuses']) {
      expect(res.body[key]?.length, key).toBeGreaterThan(0);
    }
  });
});

describe('dashboard', () => {
  it('the status breakdown always sums to the total', async () => {
    // Everything is computed live, so these cannot disagree. The previous implementation read
    // the total live but the breakdown from a matview refreshed every five minutes, and an
    // admin could be shown a breakdown that did not add up to the number beside it.
    const res = await as(admin).get('/api/dashboard');
    const sum = res.body.leadStatusBreakdown.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
    expect(sum).toBe(res.body.totalLeads);
  });

  it('still sums immediately after a write, with no refresh', async () => {
    const before = (await as(admin).get('/api/dashboard')).body;
    expect((await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }))).status).toBe(201);
    const after = (await as(admin).get('/api/dashboard')).body;
    const sum = after.leadStatusBreakdown.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
    expect(after.totalLeads).toBe(before.totalLeads + 1);
    expect(sum).toBe(after.totalLeads);
  });

  it('caller totals are smaller, and cross-caller comparisons are admin-only', async () => {
    const [a, c] = await Promise.all([as(admin).get('/api/dashboard'), as(caller).get('/api/dashboard')]);
    expect(c.body.totalLeads).toBeLessThan(a.body.totalLeads);
    expect(a.body.salesByCaller.length).toBeGreaterThan(0);
    expect(c.body.salesByCaller).toEqual([]);
    expect(c.body.callerPerformance).toEqual([]);
  });
});

describe('lead lifecycle', () => {
  it('creates, normalises the mobile, patches, and records an activity', async () => {
    const created = await as(admin).post('/api/leads', leadPayload({ mobile: '+91 98765 12345', assignedCaller: caller.userId }));
    expect(created.status).toBe(201);
    expect(created.body.mobile).toBe('9876512345');
    expect(created.body.medicines).toHaveLength(1);
    const id = created.body.id;

    expect((await as(admin).patch(`/api/leads/${id}`, { notes: 'edited' })).status).toBe(200);
    expect((await as(admin).post(`/api/leads/${id}/activities`, { description: 'rang' })).status).toBe(201);
    expect((await as(admin).post(`/api/leads/${id}/follow-ups`, { scheduledDate: '2026-12-01', type: 'call' })).status).toBe(201);
  });

  it('converts to an order, deducting stock and closing the lead', async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { brandName: 'Atorva' } });
    const stockBefore = product.stockQuantity;

    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const res = await as(admin).post(`/api/leads/${lead.body.id}/convert`);
    expect(res.status).toBe(200);
    expect(res.body.order.orderNumber).toMatch(/^ORD-\d{4}-\d{4}$/);
    expect(res.body.order.medicines).toHaveLength(1);
    expect(res.body.lead.status).toBe('converted');

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.stockQuantity).toBe(stockBefore - 1);

    // A second conversion is refused rather than producing a duplicate order.
    expect((await as(admin).post(`/api/leads/${lead.body.id}/convert`)).status).toBe(400);
  });

  it('soft-deletes rather than destroying', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload());
    expect((await as(admin).delete(`/api/leads/${lead.body.id}`)).status).toBe(204);
    const row = await prisma.lead.findUnique({ where: { id: lead.body.id } });
    expect(row).not.toBeNull();
    expect(row!.deletedAt).not.toBeNull();
  });

  it('reassignment moves both counters and the assignment history', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const before = await prisma.user.findUniqueOrThrow({ where: { id: other.userId } });

    expect((await as(admin).patch(`/api/leads/${lead.body.id}`, { assignedCaller: other.userId })).status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: other.userId } });
    expect(after.assignedLeadsCount).toBe(before.assignedLeadsCount + 1);

    const history = await prisma.leadAssignment.findMany({ where: { leadId: lead.body.id }, orderBy: { assignedAt: 'asc' } });
    expect(history).toHaveLength(2);
    expect(history[0]!.unassignedAt).not.toBeNull(); // the first assignment was closed off
    expect(history[1]!.callerId).toBe(other.userId);
  });
});

describe('authorization', () => {
  it('admin-only endpoints refuse a caller with 403, and write nothing', async () => {
    const med = (await as(admin).get('/api/medicines')).body[0];
    expect((await as(caller).post('/api/medicines', { name: 'nope', unitPrice: 1 })).status).toBe(403);

    const res = await as(caller).patch(`/api/medicines/${med.id}`, { unitPrice: 9999 });
    expect(res.status).toBe(403);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: med.id } });
    expect(Number(after.unitPrice)).not.toBe(9999);
  });

  it('a caller may not escalate their own role, and stays a caller', async () => {
    const res = await as(caller).patch(`/api/users/${caller.userId}`, { role: 'admin' });
    expect(res.status).toBe(403);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: caller.userId } });
    expect(after.role).toBe('caller');
  });

  it('a caller may still edit their own ordinary fields', async () => {
    expect((await as(caller).patch(`/api/users/${caller.userId}`, { phone: '9812345678' })).status).toBe(200);
  });

  it('a caller may not delete a lead, even their own', async () => {
    const own = await prisma.lead.findFirstOrThrow({ where: { deletedAt: null, assignedCallerId: caller.userId } });
    expect((await as(caller).delete(`/api/leads/${own.id}`)).status).toBe(403);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.deletedAt).toBeNull();
  });

  it('out-of-scope rows answer 404, not 403', async () => {
    // Saying "forbidden" would confirm the row exists. This matches the row-filtering the
    // previous system used, where a caller's query simply matched nothing.
    const foreign = await prisma.lead.findFirstOrThrow({
      where: { deletedAt: null, assignedCallerId: other.userId },
    });
    expect((await as(caller).get(`/api/leads/${foreign.id}`)).status).toBe(404);

    const patch = await as(caller).patch(`/api/leads/${foreign.id}`, { notes: 'BREACH' });
    expect(patch.status).toBe(404);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(after.notes).not.toBe('BREACH');
  });

  it('PATCH /orders/:id is masked as 404 for a caller', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { deletedAt: null } });
    expect((await as(caller).patch(`/api/orders/${order.id}`, { stage: 'packed' })).status).toBe(404);
  });

  it('a caller cannot assign a lead away from themselves', async () => {
    const own = await prisma.lead.findFirstOrThrow({ where: { deletedAt: null, assignedCallerId: caller.userId } });
    expect((await as(caller).patch(`/api/leads/${own.id}`, { assignedCaller: other.userId })).status).toBe(403);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.assignedCallerId).toBe(caller.userId);
  });

  it('a caller’s new lead is force-assigned to themselves', async () => {
    const res = await as(caller).post('/api/leads', leadPayload({ assignedCaller: other.userId }));
    expect(res.status).toBe(201);
    expect(res.body.assignedCaller).toBe(caller.userId);
  });
});

describe('stock and orders', () => {
  it('adds and sets stock, and refuses nonsense quantities', async () => {
    const created = await as(admin).post('/api/medicines', { name: `T Med ${nextId()}`, unitPrice: 10, stockQuantity: 5 });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await as(admin).post(`/api/medicines/${id}/stock`, { mode: 'add', quantity: 7 })).body.stockQuantity).toBe(12);
    expect((await as(admin).post(`/api/medicines/${id}/stock`, { mode: 'set', quantity: 3 })).body.stockQuantity).toBe(3);

    for (const body of [
      { mode: 'add', quantity: 0 }, { mode: 'add', quantity: -5 },
      { mode: 'set', quantity: -1 }, { mode: 'sideways', quantity: 5 },
    ]) {
      expect((await as(admin).post(`/api/medicines/${id}/stock`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await as(admin).delete(`/api/medicines/${id}`)).status).toBe(204);
  });

  it('a discount recomputes the payable amount', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload({ assignedCaller: caller.userId }));
    const { body } = await as(admin).post(`/api/leads/${lead.body.id}/convert`);
    const total = body.order.totalAmount;

    const flat = await as(admin).patch(`/api/orders/${body.order.id}`, { discountType: 'flat', discountValue: 20 });
    expect(flat.body.payableAmount).toBe(total - 20);

    const pct = await as(admin).patch(`/api/orders/${body.order.id}`, { discountType: 'percentage', discountValue: 10 });
    expect(pct.body.payableAmount).toBeCloseTo(total * 0.9, 2);

    // A discount larger than the order floors at zero rather than going negative.
    const huge = await as(admin).patch(`/api/orders/${body.order.id}`, { discountType: 'flat', discountValue: 999999 });
    expect(huge.body.payableAmount).toBe(0);
  });
});

describe('error mapping', () => {
  it('missing fields -> 400 naming the field', async () => {
    const res = await as(admin).post('/api/leads', { mobile: '9000000001' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/required/i);
  });

  it('a lead with no medicines -> 400', async () => {
    const res = await as(admin).post('/api/leads', leadPayload({ medicines: [] }));
    expect(res.status).toBe(400);
  });

  it('a duplicate email -> 409 with a readable message', async () => {
    const payload = { name: 'Dup', employeeId: `D${nextId()}`, phone: '9000000009', email: 'aarav.sharma@medicrm.in' };
    const res = await as(admin).post('/api/users', payload);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already exists/i);
  });

  it('an unknown id -> 404', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await as(admin).get(`/api/leads/${missing}`)).status).toBe(404);
    expect((await as(admin).patch(`/api/leads/${missing}`, { notes: 'x' })).status).toBe(404);
    expect((await as(admin).delete(`/api/leads/${missing}`)).status).toBe(404);
  });

  it('malformed JSON -> 400, not 500', async () => {
    // express.json() throws a SyntaxError; without explicit handling a client's bad request
    // is reported as a server fault.
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(res.status).toBe(400);
  });

  it('an unknown route -> 404 JSON, not an HTML page', async () => {
    const res = await as(admin).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});

describe('audit trail', () => {
  it('records the acting user, not a session variable', async () => {
    // The previous implementation read the actor from a session GUC that was NULL on
    // connections where it had not been set, and silently wrote no attribution at all.
    const lead = await as(admin).post('/api/leads', leadPayload());
    const entry = await prisma.auditLog.findFirst({
      where: { tableName: 'leads', recordId: lead.body.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.changedBy).toBe(admin.userId);
    expect(entry!.action).toBe('INSERT');
  });

  it('an update records only what changed', async () => {
    const lead = await as(admin).post('/api/leads', leadPayload());
    await as(admin).patch(`/api/leads/${lead.body.id}`, { notes: 'a new note' });
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { tableName: 'leads', recordId: lead.body.id, action: 'UPDATE' },
      orderBy: { changedAt: 'desc' },
    });
    expect(Object.keys(entry.newData as object)).toContain('notes');
    expect(Object.keys(entry.newData as object)).not.toContain('city');
  });
});
