/**
 * Phase 1 — authorization units. No database, no HTTP.
 *
 * src/scope.ts is the TypeScript replacement for 71 Postgres RLS policies. Prisma connects
 * as a BYPASSRLS role and migration 017 disabled RLS outright, so these functions are the
 * ONLY thing separating one caller's data from another's. They are pure, which makes them
 * the highest value-per-millisecond target in the codebase.
 *
 * Each assertion pins the exact predicate shape rather than just "is truthy" — the failure
 * mode that matters is a scope that silently narrows to the wrong column or stops narrowing
 * at all, and both of those still return an object.
 */
import { describe, it, expect } from 'vitest';
import {
  isAdmin,
  requireAdmin,
  leadScope,
  renewalScope,
  followUpScope,
  userScope,
  notificationScope,
  leadChildScope,
  orderScope,
  orderItemScope,
  customerScope,
  assertLeadAssignable,
  assertFollowUpAssignable,
  assertCanEditUser,
  assertOwnsNotification,
  type Actor,
} from '../src/scope.js';

const ADMIN: Actor = { userId: 'admin-1111', role: 'admin' };
const CALLER: Actor = { userId: 'caller-2222', role: 'caller' };
const OTHER = 'caller-9999';

/** Every read scope, so structural rules can be asserted across all of them at once. */
const READ_SCOPES = {
  leadScope,
  renewalScope,
  followUpScope,
  userScope,
  notificationScope,
  leadChildScope,
  orderScope,
  orderItemScope,
  customerScope,
} as const;

describe('role predicates', () => {
  it('isAdmin distinguishes the two roles', () => {
    expect(isAdmin(ADMIN)).toBe(true);
    expect(isAdmin(CALLER)).toBe(false);
  });

  it('requireAdmin throws 403 for a caller and passes an admin', () => {
    expect(() => requireAdmin(ADMIN)).not.toThrow();
    expect(() => requireAdmin(CALLER)).toThrowError(
      expect.objectContaining({ statusCode: 403 }),
    );
  });
});

describe('read scopes — admin is unrestricted', () => {
  // An admin scope must be exactly {}. Anything else would be spread into a Prisma `where`
  // and silently filter rows an admin is entitled to see.
  it.each(Object.keys(READ_SCOPES))('%s returns {} for an admin', (name) => {
    const scope = READ_SCOPES[name as keyof typeof READ_SCOPES](ADMIN);
    expect(scope).toEqual({});
    expect(Object.keys(scope)).toHaveLength(0);
  });
});

describe('read scopes — caller is narrowed to exactly the RLS predicate', () => {
  it('leadScope: assigned_caller_id = me', () => {
    expect(leadScope(CALLER)).toEqual({ assigned_caller_id: CALLER.userId });
  });

  it('renewalScope: assigned_caller_id = me', () => {
    expect(renewalScope(CALLER)).toEqual({ assigned_caller_id: CALLER.userId });
  });

  it('followUpScope: assigned_caller_id = me', () => {
    expect(followUpScope(CALLER)).toEqual({ assigned_caller_id: CALLER.userId });
  });

  it('userScope: id = me — a caller sees only themselves', () => {
    expect(userScope(CALLER)).toEqual({ id: CALLER.userId });
  });

  it('notificationScope: recipient_user_id = me', () => {
    expect(notificationScope(CALLER)).toEqual({ recipient_user_id: CALLER.userId });
  });

  it('leadChildScope: filters through the parent lead relation', () => {
    expect(leadChildScope(CALLER)).toEqual({ leads: { assigned_caller_id: CALLER.userId } });
  });

  it('orderScope: requires lead_id NOT NULL as well as the lead join', () => {
    // The NOT NULL half is load-bearing: an order with no lead is admin-only. Dropping it
    // would expose unlinked orders to every caller, because a null relation would not match
    // the join filter but also would not be excluded.
    expect(orderScope(CALLER)).toEqual({
      lead_id: { not: null },
      leads: { assigned_caller_id: CALLER.userId },
    });
  });

  it('orderItemScope: joins two levels, order -> lead', () => {
    expect(orderItemScope(CALLER)).toEqual({
      orders: { leads: { assigned_caller_id: CALLER.userId } },
    });
  });

  it('customerScope: OR across leads, renewals and follow_ups', () => {
    // The original policy was a three-way UNION; each arm must survive translation, or a
    // caller loses sight of customers they reach through only one of the three.
    expect(customerScope(CALLER)).toEqual({
      OR: [
        { leads: { some: { assigned_caller_id: CALLER.userId } } },
        { renewals: { some: { assigned_caller_id: CALLER.userId } } },
        { follow_ups: { some: { assigned_caller_id: CALLER.userId } } },
      ],
    });
  });
});

describe('read scopes — a caller scope never leaks another actor id', () => {
  it.each(Object.keys(READ_SCOPES))('%s embeds only the calling caller id', (name) => {
    const scope = READ_SCOPES[name as keyof typeof READ_SCOPES](CALLER);
    const serialized = JSON.stringify(scope);
    expect(serialized).toContain(CALLER.userId);
    expect(serialized).not.toContain(OTHER);
    expect(serialized).not.toContain(ADMIN.userId);
  });
});

describe('write guards', () => {
  const forbidden = expect.objectContaining({ statusCode: 403 });

  describe('assertLeadAssignable', () => {
    it('admin may assign to anyone, including nobody', () => {
      expect(() => assertLeadAssignable(ADMIN, OTHER)).not.toThrow();
      expect(() => assertLeadAssignable(ADMIN, null)).not.toThrow();
      expect(() => assertLeadAssignable(ADMIN, undefined)).not.toThrow();
    });

    it('caller may assign to themselves', () => {
      expect(() => assertLeadAssignable(CALLER, CALLER.userId)).not.toThrow();
    });

    it('caller may not assign to another caller, or leave it unassigned', () => {
      expect(() => assertLeadAssignable(CALLER, OTHER)).toThrowError(forbidden);
      // null/undefined must also be refused: an unassigned lead is one the caller has
      // effectively pushed out of their own scope, which RLS's WITH CHECK forbade.
      expect(() => assertLeadAssignable(CALLER, null)).toThrowError(forbidden);
      expect(() => assertLeadAssignable(CALLER, undefined)).toThrowError(forbidden);
    });
  });

  describe('assertFollowUpAssignable', () => {
    it('admin unrestricted; caller self-only', () => {
      expect(() => assertFollowUpAssignable(ADMIN, OTHER)).not.toThrow();
      expect(() => assertFollowUpAssignable(CALLER, CALLER.userId)).not.toThrow();
      expect(() => assertFollowUpAssignable(CALLER, OTHER)).toThrowError(forbidden);
      expect(() => assertFollowUpAssignable(CALLER, null)).toThrowError(forbidden);
    });
  });

  describe('assertCanEditUser', () => {
    it('admin may edit anyone', () => {
      expect(() => assertCanEditUser(ADMIN, OTHER)).not.toThrow();
    });

    it('caller may edit only their own account', () => {
      expect(() => assertCanEditUser(CALLER, CALLER.userId)).not.toThrow();
      expect(() => assertCanEditUser(CALLER, OTHER)).toThrowError(forbidden);
    });
  });

  describe('assertOwnsNotification', () => {
    it('admin may act on any notification', () => {
      expect(() => assertOwnsNotification(ADMIN, OTHER)).not.toThrow();
    });

    it('caller may act only on their own', () => {
      expect(() => assertOwnsNotification(CALLER, CALLER.userId)).not.toThrow();
      expect(() => assertOwnsNotification(CALLER, OTHER)).toThrowError(forbidden);
    });
  });
});
