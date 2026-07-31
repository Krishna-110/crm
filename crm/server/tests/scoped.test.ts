import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { scopedFor } from '../src/db/scoped.js';
import {
  customerScope, followUpScope, leadChildScope, leadScope,
  notificationScope, orderItemScope, orderScope, renewalScope, userScope,
  type Actor,
} from '../src/auth/scope.js';

/**
 * Scope INJECTION, against a real database.
 *
 * scope.test.ts proves the predicates are right. This proves they actually reach the query —
 * a separate failure, because a correct predicate that never gets applied protects nothing.
 *
 * Written to leave the fixture unchanged: every write attempted here is one that must be
 * refused, and the snapshot at the end enforces that.
 */

let admin: Actor;
let caller: Actor;
let other: Actor;
let A: ReturnType<typeof scopedFor>;
let C: ReturnType<typeof scopedFor>;
let snapshotBefore: Record<string, number>;

const counts = async () => ({
  leads: await prisma.lead.count(),
  users: await prisma.user.count(),
  orders: await prisma.order.count(),
  renewals: await prisma.renewal.count(),
  customers: await prisma.customer.count(),
});

beforeAll(async () => {
  const a = await prisma.user.findFirstOrThrow({ where: { role: 'admin' } });
  const c = await prisma.user.findFirstOrThrow({ where: { email: 'sneha.iyer@medicrm.in' } });
  const o = await prisma.user.findFirstOrThrow({ where: { email: 'ananya.desai@medicrm.in' } });
  admin = { userId: a.id, role: 'admin' };
  caller = { userId: c.id, role: 'caller' };
  other = { userId: o.id, role: 'caller' };
  A = scopedFor(admin);
  C = scopedFor(caller);
  snapshotBefore = await counts();
});

/** Each scoped model, with the predicate it should be applying. */
const MODELS = [
  { name: 'lead', scope: leadScope, raw: (w?: object) => prisma.lead.count({ where: w }), a: () => A.lead.count(), c: () => C.lead.count() },
  { name: 'leadMedicine', scope: leadChildScope, raw: (w?: object) => prisma.leadMedicine.count({ where: w }), a: () => A.leadMedicine.count(), c: () => C.leadMedicine.count() },
  { name: 'leadActivity', scope: leadChildScope, raw: (w?: object) => prisma.leadActivity.count({ where: w }), a: () => A.leadActivity.count(), c: () => C.leadActivity.count() },
  { name: 'order', scope: orderScope, raw: (w?: object) => prisma.order.count({ where: w }), a: () => A.order.count(), c: () => C.order.count() },
  { name: 'orderItem', scope: orderItemScope, raw: (w?: object) => prisma.orderItem.count({ where: w }), a: () => A.orderItem.count(), c: () => C.orderItem.count() },
  { name: 'renewal', scope: renewalScope, raw: (w?: object) => prisma.renewal.count({ where: w }), a: () => A.renewal.count(), c: () => C.renewal.count() },
  { name: 'followUp', scope: followUpScope, raw: (w?: object) => prisma.followUp.count({ where: w }), a: () => A.followUp.count(), c: () => C.followUp.count() },
  { name: 'user', scope: userScope, raw: (w?: object) => prisma.user.count({ where: w }), a: () => A.user.count(), c: () => C.user.count() },
  { name: 'notification', scope: notificationScope, raw: (w?: object) => prisma.notification.count({ where: w }), a: () => A.notification.count(), c: () => C.notification.count() },
  { name: 'customer', scope: customerScope, raw: (w?: object) => prisma.customer.count({ where: w }), a: () => A.customer.count(), c: () => C.customer.count() },
] as const;

describe('the extension injects each model’s scope', () => {
  it.each(MODELS.map((m) => m.name))('%s: a caller sees exactly what the predicate selects', async (name) => {
    const m = MODELS.find((x) => x.name === name)!;
    // If injection silently failed, this would equal the unscoped total instead.
    expect(await m.c()).toBe(await m.raw(m.scope(caller)));
  });

  it.each(MODELS.map((m) => m.name))('%s: an admin sees everything', async (name) => {
    const m = MODELS.find((x) => x.name === name)!;
    expect(await m.a()).toBe(await m.raw());
  });
});

describe('the scope actually narrows', () => {
  // Without this, the parity assertions above could pass vacuously on a fixture where one
  // caller happens to own every row.
  it.each(['lead', 'user'])('%s: caller sees some, but fewer than admin', async (name) => {
    const m = MODELS.find((x) => x.name === name)!;
    const [c, a] = [await m.c(), await m.a()];
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(a);
  });
});

describe('cross-caller isolation', () => {
  let foreignLeadId: string;

  beforeAll(async () => {
    const lead = await prisma.lead.findFirstOrThrow({
      where: { deletedAt: null, assignedCallerId: other.userId },
    });
    foreignLeadId = lead.id;
  });

  it('findUnique on another caller’s lead returns null', async () => {
    expect(await C.lead.findUnique({ where: { id: foreignLeadId } })).toBeNull();
  });

  it('findFirst likewise', async () => {
    expect(await C.lead.findFirst({ where: { id: foreignLeadId } })).toBeNull();
  });

  it('an admin can see the same row', async () => {
    expect(await A.lead.findUnique({ where: { id: foreignLeadId } })).not.toBeNull();
  });

  it('findMany returns only the caller’s own', async () => {
    const rows = await C.lead.findMany({ select: { assignedCallerId: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.assignedCallerId === caller.userId)).toBe(true);
  });

  it('a scoped write matches zero foreign rows', async () => {
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: foreignLeadId } });
    const { count } = await C.lead.updateMany({ where: { id: foreignLeadId }, data: { notes: 'BREACH' } });
    expect(count).toBe(0);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: foreignLeadId } });
    expect(after.notes).toBe(before.notes);
  });
});

describe('regression — findUnique survives injection', () => {
  // The scope is appended to where.AND rather than wrapping the clause. Wrapping reads more
  // cleanly but breaks findUnique, whose where must still expose a unique field at the top
  // level; Prisma rejects it with "needs at least one of `id`".
  it('a caller can fetch their OWN lead by id', async () => {
    const own = await prisma.lead.findFirstOrThrow({
      where: { deletedAt: null, assignedCallerId: caller.userId },
    });
    const found = await C.lead.findUnique({ where: { id: own.id } });
    expect(found?.id).toBe(own.id);
  });

  it('an existing where.AND is preserved rather than replaced', async () => {
    const rows = await C.lead.findMany({
      where: { AND: [{ deletedAt: null }] },
      select: { assignedCallerId: true, deletedAt: true },
    });
    expect(rows.every((r) => r.deletedAt === null && r.assignedCallerId === caller.userId)).toBe(true);
  });
});

describe('fail-closed behaviour', () => {
  it('refuses upsert on a scoped model', async () => {
    // Narrowing an upsert's where could turn a forbidden update into a create.
    await expect(
      C.lead.upsert({ where: { id: '00000000-0000-0000-0000-000000000000' }, update: {}, create: {} as never }),
    ).rejects.toThrow(/upsert is not supported/);
  });

  it('every model the client exposes is classified', async () => {
    // An unclassified model throws rather than being served unscoped, so a newly introduced
    // table fails here instead of quietly leaking in production.
    const { Prisma } = await import('@prisma/client');
    const models = (Prisma as unknown as { dmmf: { datamodel: { models: { name: string }[] } } })
      .dmmf.datamodel.models;
    expect(models.length).toBeGreaterThan(15);

    for (const { name } of models) {
      const key = name.charAt(0).toLowerCase() + name.slice(1);
      const delegate = (C as unknown as Record<string, { count?: () => Promise<number> }>)[key];
      if (!delegate?.count) continue;
      try {
        await delegate.count();
      } catch (err) {
        expect(String((err as Error).message), `model ${key}`).not.toMatch(/classified in neither/);
      }
    }
  });
});

describe('fixture integrity', () => {
  it('no test in this file mutated the data', async () => {
    expect(await counts()).toEqual(snapshotBefore);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
