/**
 * Phase 2 — scope INJECTION, against a real database.
 *
 * Phase 1 proved src/scope.ts computes the right predicate. This proves
 * src/scopedPrisma.ts actually applies it to every query, which is a separate failure
 * mode: a correct predicate that never reaches the `where` clause protects nothing.
 *
 * Prisma's static types are misleading here — the schema contains read-only views, so the
 * `operation` union collapses to read operations only and writes appear impossible. They
 * are not; they arrive at the extension at runtime. That gap is why these assertions exist
 * as tests rather than as type-level guarantees.
 *
 * This suite is designed NOT to mutate the fixture: every write it attempts is one that
 * must be refused. The snapshot canary at the end enforces that.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma.js';
import { scopedPrisma, withDbSession } from '../src/scopedPrisma.js';
import {
  leadScope,
  leadChildScope,
  orderScope,
  orderItemScope,
  renewalScope,
  followUpScope,
  userScope,
  notificationScope,
  customerScope,
  type Actor,
} from '../src/scope.js';
import { getAdmin, getCaller, getOtherCaller, fixtureSnapshot } from './helpers/actors.js';

let admin: Actor;
let caller: Actor;
let other: Actor;
let asAdmin: ReturnType<typeof scopedPrisma>;
let asCaller: ReturnType<typeof scopedPrisma>;
let snapshotBefore: Awaited<ReturnType<typeof fixtureSnapshot>>;

beforeAll(async () => {
  [admin, caller, other] = await Promise.all([getAdmin(), getCaller(), getOtherCaller()]);
  asAdmin = scopedPrisma(admin);
  asCaller = scopedPrisma(caller);
  snapshotBefore = await fixtureSnapshot();
});

/**
 * Every scoped model, paired with its scope function and a way to count it through the
 * raw client. Keeping these together means adding a model to SCOPED_MODELS without adding
 * it here is visible as a gap in the structural test at the bottom.
 */
const SCOPED = [
  { name: 'leads', scope: leadScope, raw: (w?: object) => prisma.leads.count({ where: w }), of: () => asCaller.leads.count(), admin: () => asAdmin.leads.count() },
  { name: 'lead_medicines', scope: leadChildScope, raw: (w?: object) => prisma.lead_medicines.count({ where: w }), of: () => asCaller.lead_medicines.count(), admin: () => asAdmin.lead_medicines.count() },
  { name: 'lead_activities', scope: leadChildScope, raw: (w?: object) => prisma.lead_activities.count({ where: w }), of: () => asCaller.lead_activities.count(), admin: () => asAdmin.lead_activities.count() },
  { name: 'orders', scope: orderScope, raw: (w?: object) => prisma.orders.count({ where: w }), of: () => asCaller.orders.count(), admin: () => asAdmin.orders.count() },
  { name: 'order_items', scope: orderItemScope, raw: (w?: object) => prisma.order_items.count({ where: w }), of: () => asCaller.order_items.count(), admin: () => asAdmin.order_items.count() },
  { name: 'renewals', scope: renewalScope, raw: (w?: object) => prisma.renewals.count({ where: w }), of: () => asCaller.renewals.count(), admin: () => asAdmin.renewals.count() },
  { name: 'follow_ups', scope: followUpScope, raw: (w?: object) => prisma.follow_ups.count({ where: w }), of: () => asCaller.follow_ups.count(), admin: () => asAdmin.follow_ups.count() },
  { name: 'users', scope: userScope, raw: (w?: object) => prisma.users.count({ where: w }), of: () => asCaller.users.count(), admin: () => asAdmin.users.count() },
  { name: 'notifications', scope: notificationScope, raw: (w?: object) => prisma.notifications.count({ where: w }), of: () => asCaller.notifications.count(), admin: () => asAdmin.notifications.count() },
  { name: 'customers', scope: customerScope, raw: (w?: object) => prisma.customers.count({ where: w }), of: () => asCaller.customers.count(), admin: () => asAdmin.customers.count() },
] as const;

describe('scope injection — every scoped model', () => {
  it.each(SCOPED.map((s) => s.name))(
    '%s: a caller sees exactly what the scope predicate selects',
    async (name) => {
      const entry = SCOPED.find((s) => s.name === name)!;
      const viaExtension = await entry.of();
      const viaExplicitFilter = await entry.raw(entry.scope(caller));
      // If the extension failed to inject, viaExtension would equal the unscoped total.
      expect(viaExtension).toBe(viaExplicitFilter);
    },
  );

  it.each(SCOPED.map((s) => s.name))('%s: an admin sees everything', async (name) => {
    const entry = SCOPED.find((s) => s.name === name)!;
    expect(await entry.admin()).toBe(await entry.raw());
  });
});

describe('scope injection actually narrows', () => {
  // Guards against the degenerate case where scope and total happen to be equal because
  // the fixture gives every row to one caller — that would make the parity tests vacuous.
  it.each(['leads', 'orders', 'order_items', 'renewals', 'follow_ups', 'users'])(
    '%s: caller strictly fewer than admin',
    async (name) => {
      const entry = SCOPED.find((s) => s.name === name)!;
      const [callerCount, adminCount] = await Promise.all([entry.of(), entry.admin()]);
      expect(callerCount).toBeGreaterThan(0);
      expect(callerCount).toBeLessThan(adminCount);
    },
  );

  it('users: a caller sees exactly themselves', async () => {
    const rows = await asCaller.users.findMany({ where: { deleted_at: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(caller.userId);
  });
});

describe('cross-caller isolation', () => {
  let foreignLeadId: string;

  beforeAll(async () => {
    const lead = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: other.userId },
      select: { id: true },
    });
    foreignLeadId = lead.id;
  });

  it('findUnique on another caller\'s lead returns null', async () => {
    expect(await asCaller.leads.findUnique({ where: { id: foreignLeadId } })).toBeNull();
  });

  it('findFirst on another caller\'s lead returns null', async () => {
    expect(await asCaller.leads.findFirst({ where: { id: foreignLeadId } })).toBeNull();
  });

  it('findMany never includes another caller\'s lead', async () => {
    const rows = await asCaller.leads.findMany({ select: { assigned_caller_id: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.assigned_caller_id === caller.userId)).toBe(true);
  });

  it('an admin can see the same lead', async () => {
    expect(await asAdmin.leads.findUnique({ where: { id: foreignLeadId } })).not.toBeNull();
  });

  it('order_items scope holds across a two-level join', async () => {
    const rows = await asCaller.order_items.findMany({
      select: { orders: { select: { leads: { select: { assigned_caller_id: true } } } } },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orders?.leads?.assigned_caller_id === caller.userId)).toBe(true);
  });
});

describe('regression — findUnique survives scope injection', () => {
  // The scope is appended to `where.AND` rather than wrapping the whole clause. Wrapping
  // would be simpler but breaks findUnique/update/delete, whose `where` must still expose a
  // unique field at the top level; Prisma rejects it with "needs at least one of `id`".
  it('a caller can findUnique their OWN lead by id', async () => {
    const own = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: caller.userId },
      select: { id: true },
    });
    const found = await asCaller.leads.findUnique({ where: { id: own.id } });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(own.id);
  });

  it('an existing where.AND is preserved, not replaced', async () => {
    const rows = await asCaller.leads.findMany({
      where: { AND: [{ deleted_at: null }] },
      select: { assigned_caller_id: true, deleted_at: true },
    });
    expect(rows.every((r) => r.deleted_at === null)).toBe(true);
    expect(rows.every((r) => r.assigned_caller_id === caller.userId)).toBe(true);
  });
});

describe('fail-closed guard — writes require withDbSession', () => {
  // Five triggers branch on app_current_role()/app_current_user_id(), which are NULL on a
  // bare Prisma connection. Without a session those guards silently no-op: a caller could
  // set their own role to admin, and audit_log.changed_by was written NULL. Both were
  // reproduced against the running API before this guard existed.
  const outside = /outside withDbSession/;

  it('updateMany outside a session throws', async () => {
    await expect(
      asCaller.leads.updateMany({ where: { id: 'x' }, data: { notes: 'nope' } }),
    ).rejects.toThrow(outside);
  });

  it('create outside a session throws', async () => {
    await expect(
      asAdmin.lead_activities.create({
        data: { lead_id: '00000000-0000-0000-0000-000000000000', activity_type: 'comment', description: 'nope' },
      }),
    ).rejects.toThrow(outside);
  });

  it('deleteMany outside a session throws', async () => {
    await expect(asCaller.leads.deleteMany({ where: { id: 'x' } })).rejects.toThrow(outside);
  });

  it('reads are exempt — no session required', async () => {
    await expect(asCaller.leads.count()).resolves.toBeTypeOf('number');
  });
});

describe('regression — lazy PrismaPromise stays inside the session', () => {
  // Prisma model methods return LAZY promises. An arrow that returns the call directly
  // rather than awaiting it used to escape the AsyncLocalStorage scope: the promise was
  // returned unstarted, the scope exited, and only then did $transaction await it — so a
  // legitimate write tripped the guard. withDbSession now wraps the whole $transaction.
  it('an arrow returning the model call directly still runs with a session', async () => {
    await expect(
      withDbSession(caller, (tx) =>
        // Matches no rows by construction, so nothing is mutated.
        tx.leads.updateMany({ where: { id: '00000000-0000-0000-0000-000000000000' }, data: { notes: 'x' } }),
      ),
    ).resolves.toMatchObject({ count: 0 });
  });

  it('an async callback that awaits also works', async () => {
    const count = await withDbSession(caller, async (tx) => {
      const r = await tx.leads.updateMany({
        where: { id: '00000000-0000-0000-0000-000000000000' },
        data: { notes: 'x' },
      });
      return r.count;
    });
    expect(count).toBe(0);
  });
});

describe('fail-closed guard — scoped writes cannot reach another caller\'s row', () => {
  let foreignLeadId: string;
  let originalNotes: string | null;

  beforeAll(async () => {
    const lead = await prisma.leads.findFirstOrThrow({
      where: { deleted_at: null, assigned_caller_id: other.userId },
      select: { id: true, notes: true },
    });
    foreignLeadId = lead.id;
    originalNotes = lead.notes;
  });

  it('updateMany inside a session still matches zero foreign rows', async () => {
    const count = await withDbSession(caller, async (tx) => {
      const r = await tx.leads.updateMany({ where: { id: foreignLeadId }, data: { notes: 'BREACH' } });
      return r.count;
    });
    expect(count).toBe(0);
    const after = await prisma.leads.findUniqueOrThrow({ where: { id: foreignLeadId } });
    expect(after.notes).toBe(originalNotes);
  });

  it('update() on a foreign row throws rather than succeeding', async () => {
    await expect(
      withDbSession(caller, (tx) =>
        tx.leads.update({ where: { id: foreignLeadId }, data: { notes: 'BREACH' } }),
      ),
    ).rejects.toThrow(); // P2025 — filtered out, so "record not found"
    const after = await prisma.leads.findUniqueOrThrow({ where: { id: foreignLeadId } });
    expect(after.notes).toBe(originalNotes);
  });

  it('deleteMany on a foreign row deletes nothing', async () => {
    const count = await withDbSession(caller, async (tx) => {
      const r = await tx.leads.deleteMany({ where: { id: foreignLeadId } });
      return r.count;
    });
    expect(count).toBe(0);
    expect(await prisma.leads.findUnique({ where: { id: foreignLeadId } })).not.toBeNull();
  });
});

describe('fail-closed guard — upsert is refused on scoped models', () => {
  // upsert's `where` decides update-vs-create, so narrowing it would silently turn a
  // forbidden update into a create. The extension refuses rather than guessing.
  it('throws instead of guessing', async () => {
    await expect(
      withDbSession(caller, (tx) =>
        tx.leads.upsert({
          where: { id: '00000000-0000-0000-0000-000000000000' },
          update: {},
          create: {} as never,
        }),
      ),
    ).rejects.toThrow(/upsert is not supported/);
  });
});

describe('global models are not scoped', () => {
  it('products: identical for caller and admin', async () => {
    const [c, a, raw] = await Promise.all([
      asCaller.products.count(),
      asAdmin.products.count(),
      prisma.products.count(),
    ]);
    expect(c).toBe(raw);
    expect(a).toBe(raw);
  });

  it('lookup tables are readable in full by a caller', async () => {
    const [scoped, raw] = await Promise.all([
      asCaller.lead_statuses.count(),
      prisma.lead_statuses.count(),
    ]);
    expect(scoped).toBe(raw);
  });
});

describe('structural — every model is classified', () => {
  // The extension throws for a model in neither SCOPED_MODELS nor GLOBAL_MODELS, so that a
  // newly introspected table can never be served unscoped by accident. That guarantee is
  // only useful if the failure shows up in CI rather than in production, so this walks
  // every model the client knows about and drives the real code path for each.
  const modelNames: string[] = ((Prisma as unknown as {
    dmmf: { datamodel: { models: { name: string }[] } };
  }).dmmf.datamodel.models ?? []).map((m) => m.name);

  it('the client exposes models to check', () => {
    expect(modelNames.length).toBeGreaterThan(15);
  });

  it.each(modelNames)('%s is classified (does not throw "not classified")', async (name) => {
    const delegate = (asCaller as unknown as Record<string, { count: () => Promise<number> } | undefined>)[name];
    expect(delegate, `no delegate for ${name}`).toBeDefined();
    if (!delegate) return;
    // Any error other than the classification error is fine here — this asserts the model
    // is known to scopedPrisma, not that the query itself is meaningful.
    try {
      await delegate.count();
    } catch (err) {
      expect(String((err as Error).message)).not.toMatch(/is not classified/);
    }
  });
});

describe('fixture integrity', () => {
  // Phase 2 asserts only refused writes, so the fixture must be byte-for-byte unchanged.
  // Drift here means a test mutated data and every later assertion is suspect.
  it('no test mutated the fixture', async () => {
    expect(await fixtureSnapshot()).toEqual(snapshotBefore);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
