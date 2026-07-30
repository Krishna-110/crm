/**
 * Verifies that scopedPrisma() actually enforces per-caller scoping — including on write
 * operations, where Prisma's static types are misleading (see the comment in
 * scopedPrisma.ts about the operation type collapsing to read-only ops).
 *
 * Run: npx tsx scripts/verify_scoped_prisma.ts
 */
import { prisma } from '../src/prisma.js';
import { scopedPrisma, withDbSession } from '../src/scopedPrisma.js';
import type { Actor } from '../src/scope.js';

const results: { label: string; pass: boolean; detail: string }[] = [];
function check(label: string, pass: boolean, detail = '') {
  results.push({ label, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  const admin = await prisma.users.findFirstOrThrow({ where: { role: 'admin', deleted_at: null } });
  const caller = await prisma.users.findFirstOrThrow({
    where: { email: 'sneha.iyer@medicrm.in' },
  });
  const adminActor: Actor = { userId: admin.id, role: 'admin' };
  const callerActor: Actor = { userId: caller.id, role: 'caller' };

  const asAdmin = scopedPrisma(adminActor);
  const asCaller = scopedPrisma(callerActor);

  // ---- READS: scope injected with no explicit filter at the call site ----
  const allLeads = await prisma.leads.count({ where: { deleted_at: null } });
  const adminLeads = await asAdmin.leads.count({ where: { deleted_at: null } });
  const callerLeads = await asCaller.leads.count({ where: { deleted_at: null } });
  check('admin sees all leads', adminLeads === allLeads, `${adminLeads}/${allLeads}`);
  check('caller sees only own leads', callerLeads < allLeads && callerLeads > 0, `${callerLeads}/${allLeads}`);

  const callerOrders = await asCaller.orders.count();
  const allOrders = await prisma.orders.count();
  check('caller orders scoped via lead join', callerOrders < allOrders, `${callerOrders}/${allOrders}`);

  const callerItems = await asCaller.order_items.count();
  const allItems = await prisma.order_items.count();
  check('caller order_items scoped 2 levels deep', callerItems < allItems, `${callerItems}/${allItems}`);

  const callerUsers = await asCaller.users.count({ where: { deleted_at: null } });
  check('caller sees only self in users', callerUsers === 1, `${callerUsers}`);

  // ---- CROSS-CALLER READ: fetching another caller's lead by its exact id ----
  const foreignLead = await prisma.leads.findFirstOrThrow({
    where: {
      deleted_at: null,
      AND: [{ assigned_caller_id: { not: null } }, { assigned_caller_id: { not: caller.id } }],
    },
  });
  const leakedFind = await asCaller.leads.findUnique({ where: { id: foreignLead.id } });
  check("caller cannot findUnique another's lead", leakedFind === null, leakedFind ? 'LEAKED' : 'null');

  const leakedFirst = await asCaller.leads.findFirst({ where: { id: foreignLead.id } });
  check("caller cannot findFirst another's lead", leakedFirst === null, leakedFirst ? 'LEAKED' : 'null');

  // ---- WRITE GUARD: a write outside withDbSession must fail closed ----
  // Without this, the five triggers that branch on app_current_role() silently no-op.
  let guardFired = false;
  try {
    await asCaller.leads.updateMany({ where: { id: foreignLead.id }, data: { notes: 'NO SESSION' } });
  } catch (err) {
    guardFired = String((err as Error).message).includes('outside withDbSession');
  }
  check('write outside withDbSession is refused', guardFired, `threw=${guardFired}`);

  // Also verify it fires for a lazily-returned PrismaPromise, i.e. an arrow that returns the
  // model call directly instead of awaiting it — that shape previously escaped the ALS scope.
  const lazyOk = await withDbSession(callerActor, (tx) =>
    tx.leads.updateMany({ where: { id: '00000000-0000-0000-0000-000000000000' }, data: { notes: 'x' } }),
  )
    .then(() => true)
    .catch(() => false);
  check('lazy PrismaPromise still runs inside the session', lazyOk, `ok=${lazyOk}`);

  // ---- WRITES: the part Prisma's types do not describe ----
  // Run through withDbSession exactly as a route does, so what blocks these is the injected
  // scope, not the guard above.
  const before = foreignLead.notes;
  const updated = await withDbSession(callerActor, async (tx) => {
    const r = await tx.leads.updateMany({ where: { id: foreignLead.id }, data: { notes: 'SCOPE BREACH' } });
    return r.count;
  });
  const after = await prisma.leads.findUniqueOrThrow({ where: { id: foreignLead.id } });
  check("caller updateMany cannot touch another's lead", updated === 0 && after.notes === before, `count=${updated}`);

  const updateBlocked = await withDbSession(callerActor, (tx) =>
    tx.leads.update({ where: { id: foreignLead.id }, data: { notes: 'SCOPE BREACH 2' } }),
  )
    .then(() => false)
    .catch(() => true); // P2025: filtered out, so "record not found"
  const after2 = await prisma.leads.findUniqueOrThrow({ where: { id: foreignLead.id } });
  check("caller update() cannot touch another's lead", updateBlocked && after2.notes === before, `threw=${updateBlocked}`);

  const deleted = await withDbSession(callerActor, async (tx) => {
    const r = await tx.leads.deleteMany({ where: { id: foreignLead.id } });
    return r.count;
  });
  const stillThere = await prisma.leads.findUnique({ where: { id: foreignLead.id } });
  check("caller deleteMany cannot delete another's lead", deleted === 0 && stillThere !== null, `count=${deleted}`);

  // ---- FAIL-CLOSED: unclassified model must throw ----
  // products is classified GLOBAL, so it should pass through untouched.
  const products = await asCaller.products.count();
  const allProducts = await prisma.products.count();
  check('global model (products) not scoped', products === allProducts, `${products}/${allProducts}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await prisma.$disconnect();
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
