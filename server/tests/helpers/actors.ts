/**
 * Shared fixtures for integration suites.
 *
 * Actors are resolved by email rather than hardcoded UUID so the helpers keep working if
 * the seed's ids ever change, and so a missing fixture fails with a clear message.
 */
import { prisma } from '../../src/prisma.js';
import type { Actor } from '../../src/scope.js';

export const ADMIN_EMAIL = 'aarav.sharma@medicrm.in';
export const CALLER_EMAIL = 'sneha.iyer@medicrm.in';
/** A second caller, used to prove one caller cannot reach another's rows. */
export const OTHER_CALLER_EMAIL = 'ananya.desai@medicrm.in';

async function actorByEmail(email: string, role: Actor['role']): Promise<Actor> {
  const user = await prisma.users.findFirst({ where: { email }, select: { id: true, role: true } });
  if (!user) throw new Error(`fixture user ${email} not found — rebuild with: npm run test:db`);
  if (user.role !== role) throw new Error(`fixture user ${email} has role ${user.role}, expected ${role}`);
  return { userId: user.id, role };
}

export const getAdmin = () => actorByEmail(ADMIN_EMAIL, 'admin');
export const getCaller = () => actorByEmail(CALLER_EMAIL, 'caller');
export const getOtherCaller = () => actorByEmail(OTHER_CALLER_EMAIL, 'caller');

/**
 * Counts every scoped table through the raw (unscoped) client. Suites use this as a canary:
 * Phase 2 is designed not to mutate the fixture, so any drift between the start and end of
 * a run means a test wrote something it should not have.
 */
export async function fixtureSnapshot() {
  const [leads, users, orders, order_items, renewals, follow_ups, customers, notifications] =
    await Promise.all([
      prisma.leads.count(),
      prisma.users.count(),
      prisma.orders.count(),
      prisma.order_items.count(),
      prisma.renewals.count(),
      prisma.follow_ups.count(),
      prisma.customers.count(),
      prisma.notifications.count(),
    ]);
  return { leads, users, orders, order_items, renewals, follow_ups, customers, notifications };
}
