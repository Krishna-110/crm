import { describe, it, expect } from 'vitest';
import {
  assertCanChangeLeadLifecycle,
  assertCanEditUser,
  assertFollowUpAssignable,
  assertLeadAssignable,
  assertNoPrivilegeEscalation,
  assertOwnsNotification,
  customerScope,
  followUpScope,
  isAdmin,
  leadChildScope,
  leadScope,
  notificationScope,
  orderItemScope,
  orderScope,
  renewalScope,
  requireAdmin,
  userScope,
  type Actor,
} from '../src/auth/scope.js';

/**
 * The authorization rules, tested without a database.
 *
 * These functions are the entire access-control model, so the assertions pin the EXACT
 * predicate rather than checking for truthiness. That matters more than it looks: an empty
 * object means "unrestricted", so a scope that breaks and returns `{}` for a caller is not a
 * failure that throws — it silently grants access to everything, and a `toBeTruthy` check
 * would pass.
 */

const ADMIN: Actor = { userId: 'admin-1', role: 'admin' };
const CALLER: Actor = { userId: 'caller-1', role: 'caller' };
const OTHER = 'caller-2';

const READ_SCOPES = {
  leadScope, renewalScope, followUpScope, userScope,
  notificationScope, leadChildScope, orderScope, orderItemScope, customerScope,
} as const;

describe('roles', () => {
  it('distinguishes admin from caller', () => {
    expect(isAdmin(ADMIN)).toBe(true);
    expect(isAdmin(CALLER)).toBe(false);
  });

  it('requireAdmin throws 403 for a caller', () => {
    expect(() => requireAdmin(ADMIN)).not.toThrow();
    expect(() => requireAdmin(CALLER)).toThrowError(expect.objectContaining({ statusCode: 403 }));
  });
});

describe('read scopes — an admin is unrestricted', () => {
  it.each(Object.keys(READ_SCOPES))('%s returns exactly {}', (name) => {
    const scope = READ_SCOPES[name as keyof typeof READ_SCOPES](ADMIN);
    expect(scope).toEqual({});
  });
});

describe('read scopes — a caller is narrowed to the exact predicate', () => {
  it('leadScope', () => expect(leadScope(CALLER)).toEqual({ assignedCallerId: CALLER.userId }));
  it('renewalScope', () => expect(renewalScope(CALLER)).toEqual({ assignedCallerId: CALLER.userId }));
  it('followUpScope', () => expect(followUpScope(CALLER)).toEqual({ assignedCallerId: CALLER.userId }));
  it('userScope narrows to self', () => expect(userScope(CALLER)).toEqual({ id: CALLER.userId }));
  it('notificationScope', () =>
    expect(notificationScope(CALLER)).toEqual({ recipientUserId: CALLER.userId }));

  it('leadChildScope filters through the parent lead', () =>
    expect(leadChildScope(CALLER)).toEqual({ lead: { assignedCallerId: CALLER.userId } }));

  it('orderScope requires a lead as well as ownership', () => {
    // The leadId clause is load-bearing: an order with no lead belongs to nobody, and
    // without it such an order neither matches the relation filter nor is excluded — it
    // would leak to every caller.
    expect(orderScope(CALLER)).toEqual({
      leadId: { not: null },
      lead: { assignedCallerId: CALLER.userId },
    });
  });

  it('orderItemScope joins two levels', () =>
    expect(orderItemScope(CALLER)).toEqual({ order: { lead: { assignedCallerId: CALLER.userId } } }));

  it('customerScope keeps all three routes to a customer', () => {
    // Dropping any arm hides customers the caller legitimately works with.
    expect(customerScope(CALLER)).toEqual({
      OR: [
        { leads: { some: { assignedCallerId: CALLER.userId } } },
        { renewals: { some: { assignedCallerId: CALLER.userId } } },
        { followUps: { some: { assignedCallerId: CALLER.userId } } },
      ],
    });
  });
});

describe('a caller scope never embeds another actor', () => {
  it.each(Object.keys(READ_SCOPES))('%s', (name) => {
    const s = JSON.stringify(READ_SCOPES[name as keyof typeof READ_SCOPES](CALLER));
    expect(s).toContain(CALLER.userId);
    expect(s).not.toContain(OTHER);
    expect(s).not.toContain(ADMIN.userId);
  });
});

describe('write guards', () => {
  const forbidden = expect.objectContaining({ statusCode: 403 });

  it('a caller may assign leads only to themselves', () => {
    expect(() => assertLeadAssignable(CALLER, CALLER.userId)).not.toThrow();
    expect(() => assertLeadAssignable(CALLER, OTHER)).toThrowError(forbidden);
    // null must also be refused: unassigning pushes the lead out of the caller's own reach.
    expect(() => assertLeadAssignable(CALLER, null)).toThrowError(forbidden);
    expect(() => assertLeadAssignable(ADMIN, OTHER)).not.toThrow();
    expect(() => assertLeadAssignable(ADMIN, null)).not.toThrow();
  });

  it('the same rule applies to follow-ups', () => {
    expect(() => assertFollowUpAssignable(CALLER, CALLER.userId)).not.toThrow();
    expect(() => assertFollowUpAssignable(CALLER, OTHER)).toThrowError(forbidden);
    expect(() => assertFollowUpAssignable(ADMIN, OTHER)).not.toThrow();
  });

  it('a caller may edit only their own account', () => {
    expect(() => assertCanEditUser(CALLER, CALLER.userId)).not.toThrow();
    expect(() => assertCanEditUser(CALLER, OTHER)).toThrowError(forbidden);
    expect(() => assertCanEditUser(ADMIN, OTHER)).not.toThrow();
  });

  it('a caller may not change role, status or employeeId', () => {
    // This guard once failed OPEN in the previous design, because it read the caller's role
    // from a session variable that was NULL on connections where it had not been set.
    for (const field of ['role', 'status', 'employeeId']) {
      expect(() => assertNoPrivilegeEscalation(CALLER, { [field]: 'x' })).toThrowError(forbidden);
      expect(() => assertNoPrivilegeEscalation(ADMIN, { [field]: 'x' })).not.toThrow();
    }
    // An ordinary self-edit is untouched.
    expect(() => assertNoPrivilegeEscalation(CALLER, { name: 'New Name', phone: '9' })).not.toThrow();
  });

  it('a caller may not soft-delete or restore leads', () => {
    expect(() => assertCanChangeLeadLifecycle(ADMIN)).not.toThrow();
    expect(() => assertCanChangeLeadLifecycle(CALLER)).toThrowError(forbidden);
  });

  it('a caller may act only on their own notifications', () => {
    expect(() => assertOwnsNotification(CALLER, CALLER.userId)).not.toThrow();
    expect(() => assertOwnsNotification(CALLER, OTHER)).toThrowError(forbidden);
    expect(() => assertOwnsNotification(ADMIN, OTHER)).not.toThrow();
  });
});
