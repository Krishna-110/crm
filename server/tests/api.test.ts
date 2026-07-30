/**
 * Phase 3 — the HTTP surface, driven in-process with supertest.
 *
 * Phases 1 and 2 cover the authorization core in isolation. This covers what a client
 * actually experiences: status codes, the masked-404 convention, error mapping, and the
 * three privilege holes that were live during the Prisma migration.
 *
 * Two conventions worth knowing before reading the assertions:
 *
 *  - A refused write is asserted BOTH by status code and by re-reading the row. A 403 that
 *    still wrote is the exact failure this suite exists to catch, and status alone cannot
 *    distinguish it.
 *
 *  - Some refusals are 404, not 403, and that is deliberate. Under RLS a caller's UPDATE
 *    simply matched zero rows, so the API answered "Order not found" rather than leaking
 *    the row's existence. That behaviour is documented in docs/TEST_PLAN.md and was
 *    preserved through the migration, so it is pinned here rather than "fixed".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '../src/prisma.js';
import {
  as,
  anon,
  login,
  ADMIN,
  CALLER,
  OTHER_CALLER,
  INACTIVE,
  newLeadPayload,
  newUserPayload,
  tomorrow,
  unique,
  type Session,
} from './helpers/api.js';

let admin: Session;
let caller: Session;
let other: Session;

beforeAll(async () => {
  [admin, caller, other] = await Promise.all([login(ADMIN), login(CALLER), login(OTHER_CALLER)]);
});

// ---------------------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------------------

describe('auth', () => {
  it('logs in an admin and a caller with the right roles', () => {
    expect(admin.role).toBe('admin');
    expect(caller.role).toBe('caller');
  });

  it('rejects a wrong password', async () => {
    const res = await anon.post('/api/auth/login', { ...CALLER, password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects a deactivated user even with correct credentials', async () => {
    // Kavya Reddy is seeded inactive precisely for this case.
    const res = await anon.post('/api/auth/login', INACTIVE);
    expect(res.status).toBe(401);
  });

  it('rejects an unknown email', async () => {
    const res = await anon.post('/api/auth/login', { email: 'nobody@medicrm.in', password: 'x' });
    expect(res.status).toBe(401);
  });

  it('requires a token', async () => {
    expect((await anon.get('/api/leads')).status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const res = await as({ ...caller, token: 'not-a-real-token' }).get('/api/leads');
    expect(res.status).toBe(401);
  });

  it('GET /auth/me returns the current user, nested under `user`', async () => {
    const res = await as(caller).get('/api/auth/me');
    expect(res.status).toBe(200);
    // Note the envelope: /auth/me answers { user: {...} } while /auth/login answers
    // { token, user }. Asserting the shape, not just the id, pins that difference.
    expect(res.body.user.id).toBe(caller.userId);
    expect(res.body.user.role).toBe('caller');
    // A password digest must never reach the client.
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it('PATCH /auth/password returns 204 and rejects a wrong current password', async () => {
    const session = await login(OTHER_CALLER);
    const bad = await as(session).patch('/api/auth/password', {
      currentPassword: 'definitely-wrong',
      newPassword: 'whatever123',
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);

    // Same value in and out, so the fixture's credentials stay usable.
    const ok = await as(session).patch('/api/auth/password', {
      currentPassword: OTHER_CALLER.password,
      newPassword: OTHER_CALLER.password,
    });
    expect(ok.status).toBe(204);
  });

  it('POST /auth/logout invalidates the token', async () => {
    const session = await login(CALLER);
    expect((await as(session).post('/api/auth/logout')).status).toBe(204);
    expect((await as(session).get('/api/leads')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------
// READS — scoping as seen through HTTP
// ---------------------------------------------------------------------------------------

describe('read scoping', () => {
  const SCOPED_LISTS = ['/api/leads', '/api/users', '/api/orders', '/api/renewals', '/api/follow-ups'];

  it.each(SCOPED_LISTS)('%s: a caller sees strictly fewer rows than an admin', async (url) => {
    const [a, c] = await Promise.all([as(admin).get(url), as(caller).get(url)]);
    expect(a.status).toBe(200);
    expect(c.status).toBe(200);
    expect(c.body.length).toBeGreaterThan(0);
    expect(c.body.length).toBeLessThan(a.body.length);
  });

  it('/api/leads: every lead a caller sees is their own', async () => {
    const res = await as(caller).get('/api/leads');
    expect(res.body.every((l: { assignedCaller: string }) => l.assignedCaller === caller.userId)).toBe(true);
  });

  it('/api/users: a caller sees only themselves', async () => {
    const res = await as(caller).get('/api/users');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(caller.userId);
  });

  it('/api/medicines is global — identical for both roles', async () => {
    const [a, c] = await Promise.all([as(admin).get('/api/medicines'), as(caller).get('/api/medicines')]);
    expect(c.body.length).toBe(a.body.length);
    expect(c.body.length).toBeGreaterThan(0);
  });

  it('/api/notifications is a personal inbox, not an admin overview', async () => {
    // notifications_select also allowed admins to read everyone's, but the bell icon this
    // backs is per-user, so the route self-scopes. An admin must NOT see the caller's.
    const res = await as(admin).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(
      res.body.every((n: { recipientUserId?: string }) => !n.recipientUserId || n.recipientUserId === admin.userId),
    ).toBe(true);
  });

  it('/api/dashboard totals differ by role', async () => {
    const [a, c] = await Promise.all([as(admin).get('/api/dashboard'), as(caller).get('/api/dashboard')]);
    expect(a.status).toBe(200);
    expect(c.body.totalLeads).toBeLessThan(a.body.totalLeads);
  });

  it('/api/dashboard: the status breakdown sums to the lead total', async () => {
    const res = await as(admin).get('/api/dashboard');
    const sum = res.body.leadStatusBreakdown.reduce((n: number, r: { count: number }) => n + Number(r.count), 0);
    expect(sum).toBe(res.body.totalLeads);
  });
});

// ---------------------------------------------------------------------------------------
// MUTATIONS — admin happy paths across all 19 endpoints
// ---------------------------------------------------------------------------------------

describe('mutations — admin', () => {
  it('POST /leads then PATCH, activity, follow-up, DELETE', async () => {
    const created = await as(admin).post('/api/leads', newLeadPayload({ assignedCaller: caller.userId }));
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await as(admin).patch(`/api/leads/${id}`, { notes: 'edited' })).status).toBe(200);
    expect(
      (await as(admin).post(`/api/leads/${id}/activities`, { activityType: 'call', description: 'rang' })).status,
    ).toBe(201);
    expect(
      (await as(admin).post(`/api/leads/${id}/follow-ups`, { scheduledDate: tomorrow(), type: 'call' })).status,
    ).toBe(201);
    expect((await as(admin).delete(`/api/leads/${id}`)).status).toBe(204);

    // Soft delete: the row survives with deleted_at set, rather than disappearing.
    const row = await prisma.leads.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.deleted_at).not.toBeNull();
  });

  it('POST /leads/:id/convert produces an order, then PATCH /orders/:id', async () => {
    const lead = await as(admin).post('/api/leads', newLeadPayload({ assignedCaller: caller.userId }));
    const convert = await as(admin).post(`/api/leads/${lead.body.id}/convert`);
    expect([200, 201]).toContain(convert.status);

    const orderId = convert.body.order?.id ?? convert.body.id;
    expect(orderId).toBeTruthy();

    const patched = await as(admin).patch(`/api/orders/${orderId}`, { stage: 'packed' });
    expect(patched.status).toBe(200);
    expect(patched.body.stage).toBe('packed');
  });

  it('medicines: create, patch, adjust stock, delete', async () => {
    const created = await as(admin).post('/api/medicines', {
      name: `T3 Med ${unique()}`,
      unitPrice: 10,
      stockQuantity: 5,
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await as(admin).patch(`/api/medicines/${id}`, { unitPrice: 12 })).status).toBe(200);

    const added = await as(admin).post(`/api/medicines/${id}/stock`, { mode: 'add', quantity: 7 });
    expect(added.status).toBe(200);
    expect(added.body.stockQuantity).toBe(12); // 5 + 7, applied as an atomic increment

    const set = await as(admin).post(`/api/medicines/${id}/stock`, { mode: 'set', quantity: 3 });
    expect(set.body.stockQuantity).toBe(3);

    expect((await as(admin).delete(`/api/medicines/${id}`)).status).toBe(204);
  });

  it('users: create, patch, delete', async () => {
    const created = await as(admin).post('/api/users', newUserPayload());
    expect(created.status).toBe(201);
    const id = created.body.id;

    expect((await as(admin).patch(`/api/users/${id}`, { name: 'T3 Renamed' })).status).toBe(200);
    expect((await as(admin).delete(`/api/users/${id}`)).status).toBe(204);
  });

  it('renewals: remind, renew, stop', async () => {
    const list = await as(admin).get('/api/renewals');
    const open = list.body.find((r: { status: string }) => r.status !== 'renewed');
    expect(open, 'fixture must contain an un-renewed renewal').toBeTruthy();

    expect((await as(admin).post(`/api/renewals/${open.id}/remind`, { notes: 'ping' })).status).toBe(201);
    expect((await as(admin).post(`/api/renewals/${open.id}/renew`)).status).toBe(200);

    const another = list.body.find((r: { id: string }) => r.id !== open.id);
    expect((await as(admin).delete(`/api/renewals/${another.id}`)).status).toBe(204);
  });

  it('follow-ups: patch status', async () => {
    const lead = await as(admin).post('/api/leads', newLeadPayload({ assignedCaller: caller.userId }));
    await as(admin).post(`/api/leads/${lead.body.id}/follow-ups`, { scheduledDate: tomorrow(), type: 'call' });

    const list = await as(admin).get('/api/follow-ups');
    const fu = list.body.find((f: { leadId?: string }) => f.leadId === lead.body.id);
    expect(fu).toBeTruthy();
    expect((await as(admin).patch(`/api/follow-ups/${fu.id}`, { status: 'completed' })).status).toBe(200);
  });

  it('notifications: a caller marks their own read', async () => {
    const list = await as(caller).get('/api/notifications');
    expect(list.body.length).toBeGreaterThan(0);
    const res = await as(caller).patch(`/api/notifications/${list.body[0].id}/read`);
    expect(res.status).toBe(200);
    expect(res.body.isRead ?? res.body.read).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// AUTHZ MATRIX — caller refusals
// ---------------------------------------------------------------------------------------

describe('authz — admin-only endpoints refuse a caller with 403', () => {
  it('POST /medicines', async () => {
    const res = await as(caller).post('/api/medicines', { name: 'nope', unitPrice: 1 });
    expect(res.status).toBe(403);
  });

  it('PATCH /medicines/:id', async () => {
    const med = (await as(admin).get('/api/medicines')).body[0];
    const res = await as(caller).patch(`/api/medicines/${med.id}`, { unitPrice: 999 });
    expect(res.status).toBe(403);

    const after = await prisma.products.findUnique({ where: { id: med.id } });
    expect(Number(after!.unit_price)).not.toBe(999);
  });

  it('POST /medicines/:id/stock', async () => {
    const med = (await as(admin).get('/api/medicines')).body[0];
    const before = med.stockQuantity;
    expect((await as(caller).post(`/api/medicines/${med.id}/stock`, { mode: 'add', quantity: 5 })).status).toBe(403);

    const after = await prisma.products.findUnique({ where: { id: med.id } });
    expect(after!.stock_quantity).toBe(before);
  });

  it('POST /users', async () => {
    const res = await as(caller).post('/api/users', newUserPayload());
    expect(res.status).toBe(403);
  });

  it('DELETE /users/:id (another user)', async () => {
    const res = await as(caller).delete(`/api/users/${other.userId}`);
    expect(res.status).toBe(403);

    const after = await prisma.users.findUnique({ where: { id: other.userId } });
    expect(after!.deleted_at).toBeNull();
  });

  it('PATCH /users/:id (another user)', async () => {
    const res = await as(caller).patch(`/api/users/${other.userId}`, { name: 'hacked' });
    expect(res.status).toBe(403);

    const after = await prisma.users.findUnique({ where: { id: other.userId } });
    expect(after!.name).not.toBe('hacked');
  });

  it('but a caller CAN edit their own account', async () => {
    const res = await as(caller).patch(`/api/users/${caller.userId}`, { phone: '9812345678' });
    expect(res.status).toBe(200);
  });
});

describe('authz — masked 404 rather than 403', () => {
  // These leak nothing about whether the row exists. Preserved from the RLS era, where a
  // caller's query simply matched zero rows.
  let foreignLeadId: string;
  let foreignOrderId: string;

  beforeAll(async () => {
    const lead = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: other.userId },
      select: { id: true },
    });
    foreignLeadId = lead.id;
    const order = await prisma.orders.findFirstOrThrow({ where: { deleted_at: null }, select: { id: true } });
    foreignOrderId = order.id;
  });

  it('GET /leads/:id for another caller\'s lead', async () => {
    expect((await as(caller).get(`/api/leads/${foreignLeadId}`)).status).toBe(404);
  });

  it('PATCH /leads/:id for another caller\'s lead leaves it untouched', async () => {
    const res = await as(caller).patch(`/api/leads/${foreignLeadId}`, { notes: 'BREACH' });
    expect(res.status).toBe(404);

    const after = await prisma.leads.findUniqueOrThrow({ where: { id: foreignLeadId } });
    expect(after.notes).not.toBe('BREACH');
  });

  it('PATCH /orders/:id — admin-only, but masked as not-found', async () => {
    const res = await as(caller).patch(`/api/orders/${foreignOrderId}`, { stage: 'shipped' });
    expect(res.status).toBe(404);
  });

  it('a caller may not reassign their own lead away from themselves', async () => {
    const own = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: caller.userId },
      select: { id: true },
    });
    const res = await as(caller).patch(`/api/leads/${own.id}`, { assignedCaller: other.userId });
    expect(res.status).toBe(403);

    const after = await prisma.leads.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.assigned_caller_id).toBe(caller.userId);
  });

  it('a caller creating a lead has it force-assigned to themselves', async () => {
    const res = await as(caller).post('/api/leads', newLeadPayload({ assignedCaller: other.userId }));
    // Either refused outright or silently reassigned — never assigned to the other caller.
    if (res.status === 201) {
      expect(res.body.assignedCaller).toBe(caller.userId);
    } else {
      expect(res.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------------------
// SECURITY REGRESSIONS — the three holes that were live during the migration
// ---------------------------------------------------------------------------------------

describe('security regressions', () => {
  // All three come from the same root cause: five trigger functions branch on
  // app_current_role() / app_current_user_id(), which are NULL on a bare Prisma connection.
  // `IF app_current_role() = 'caller'` never matched, so the guards silently no-opped.
  // These were reproduced against the running API — a caller really could make themselves
  // an admin (HTTP 200) — before scopedPrisma's fail-closed write guard was added.

  it('a caller cannot escalate their own role to admin', async () => {
    const res = await as(caller).patch(`/api/users/${caller.userId}`, { role: 'admin' });
    expect(res.status).toBe(403);

    const after = await prisma.users.findUniqueOrThrow({ where: { id: caller.userId } });
    expect(after.role).toBe('caller');
  });

  it('a caller cannot change their own status or employee_id', async () => {
    const before = await prisma.users.findUniqueOrThrow({ where: { id: caller.userId } });
    const res = await as(caller).patch(`/api/users/${caller.userId}`, { status: 'inactive' });
    expect(res.status).toBe(403);

    const after = await prisma.users.findUniqueOrThrow({ where: { id: caller.userId } });
    expect(after.status).toBe(before.status);
  });

  it('a caller cannot soft-delete even their OWN lead', async () => {
    const own = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: caller.userId },
      select: { id: true },
    });
    const res = await as(caller).delete(`/api/leads/${own.id}`);
    expect(res.status).toBe(403);

    const after = await prisma.leads.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.deleted_at).toBeNull();
  });

  it('writes are attributed in audit_log rather than recorded as NULL', async () => {
    // audit_log.changed_by comes from app_current_user_id(). Before withDbSession() wrapped
    // every write, this was written NULL for all API traffic — silent loss of attribution
    // that nothing would have surfaced.
    const med = (await as(admin).get('/api/medicines')).body[0];
    await as(admin).patch(`/api/medicines/${med.id}`, { unitPrice: Number(med.unitPrice) || 1 });

    const entry = await prisma.audit_log.findFirst({
      where: { table_name: 'products', record_id: med.id },
      orderBy: { changed_at: 'desc' },
    });
    expect(entry, 'expected an audit_log row for the update').toBeTruthy();
    expect(entry!.changed_by).toBe(admin.userId);
  });
});

// ---------------------------------------------------------------------------------------
// ERROR MAPPING
// ---------------------------------------------------------------------------------------

describe('error mapping', () => {
  it('missing required fields -> 400 naming the field', async () => {
    const res = await as(admin).post('/api/leads', { mobile: '9000000001' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/required/i);
  });

  it('a duplicate unique key -> 409', async () => {
    // P2002 / 23505. The second insert reuses the first's employeeId and email.
    const payload = newUserPayload();
    expect((await as(admin).post('/api/users', payload)).status).toBe(201);

    const dup = await as(admin).post('/api/users', payload);
    expect(dup.status).toBe(409);
  });

  it('an unknown id -> 404', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await as(admin).get(`/api/leads/${missing}`)).status).toBe(404);
    expect((await as(admin).patch(`/api/leads/${missing}`, { notes: 'x' })).status).toBe(404);
    expect((await as(admin).delete(`/api/leads/${missing}`)).status).toBe(404);
  });

  it('an invalid enum value -> 4xx, never 500', async () => {
    const order = await prisma.orders.findFirstOrThrow({ where: { deleted_at: null }, select: { id: true } });
    const res = await as(admin).patch(`/api/orders/${order.id}`, { stage: 'not-a-real-stage' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('a trigger rejection surfaces as 403, not 500', async () => {
    // Prisma 7 wraps PL/pgSQL errors as P2010 with the real SQLSTATE buried at
    // meta.driverAdapterError.cause.code. Without unwrapRawPgError() digging it out, every
    // trigger rejection would surface as a 500.
    const res = await as(caller).patch(`/api/users/${caller.userId}`, { role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.status).not.toBe(500);
    expect(String(res.body.error)).toMatch(/role|status|employee/i);
  });

  it('stock validation rejects nonsense quantities', async () => {
    const med = (await as(admin).get('/api/medicines')).body[0];
    for (const body of [
      { mode: 'add', quantity: 0 },
      { mode: 'add', quantity: -5 },
      { mode: 'set', quantity: -1 },
      { mode: 'sideways', quantity: 5 },
    ]) {
      const res = await as(admin).post(`/api/medicines/${med.id}/stock`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('an unknown route -> 404 JSON, not an HTML error page', async () => {
    const res = await as(admin).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});
