import { ApiError } from '../lib/errors.js';

/**
 * Authorization.
 *
 * Two roles. An **admin** sees and manages everything; a **caller** sees and manages only
 * what is assigned to them. Every rule lives in this file, as pure functions returning
 * Prisma `where` fragments — which makes them trivially testable without a database, and
 * means there is exactly one place to read to know what a caller can reach.
 *
 * Each scope returns `{}` for an admin (no narrowing) or a filter for a caller. That
 * asymmetry is the whole model, so it is worth stating plainly: **an empty object means
 * unrestricted**. A scope that accidentally returns `{}` for a caller does not fail loudly,
 * it silently grants access to everything — which is why the tests assert exact predicate
 * shape rather than truthiness.
 */

export type ActorRole = 'admin' | 'caller';

export type Actor = {
  userId: string;
  role: ActorRole;
};

export const isAdmin = (actor: Actor): boolean => actor.role === 'admin';

/** Throws 403 unless the actor is an admin. For admin-only endpoints. */
export function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw ApiError.forbidden('Admins only');
}

// ── read scopes ──────────────────────────────────────────────────────────────────────────

/** Leads a caller owns. */
export const leadScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { assignedCallerId: actor.userId };

export const renewalScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { assignedCallerId: actor.userId };

export const followUpScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { assignedCallerId: actor.userId };

/** A caller may see only their own user record. */
export const userScope = (actor: Actor) => (isAdmin(actor) ? {} : { id: actor.userId });

export const notificationScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { recipientUserId: actor.userId };

/** Children of a lead (medicines, activities, assignments) inherit the lead's scope. */
export const leadChildScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { lead: { assignedCallerId: actor.userId } };

/**
 * Orders reachable through the lead they were converted from.
 *
 * The `leadId: { not: null }` half is load-bearing. An order with no lead belongs to nobody,
 * so it is admin-only; without this clause such an order would not match the relation filter
 * but would also not be excluded, and would leak to every caller.
 */
export const orderScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { leadId: { not: null }, lead: { assignedCallerId: actor.userId } };

/** Order lines, scoped two levels up through their order's lead. */
export const orderItemScope = (actor: Actor) =>
  isAdmin(actor) ? {} : { order: { lead: { assignedCallerId: actor.userId } } };

/**
 * Customers a caller can reach, through any of the three routes that connect them: a lead,
 * a renewal, or a follow-up. Dropping any arm hides customers the caller legitimately works
 * with.
 */
export const customerScope = (actor: Actor) =>
  isAdmin(actor)
    ? {}
    : {
        OR: [
          { leads: { some: { assignedCallerId: actor.userId } } },
          { renewals: { some: { assignedCallerId: actor.userId } } },
          { followUps: { some: { assignedCallerId: actor.userId } } },
        ],
      };

// ── write guards ─────────────────────────────────────────────────────────────────────────
//
// A read scope narrows what is visible; these refuse a write outright. They exist because
// "cannot see it" and "cannot assign it elsewhere" are different questions — a caller can
// see their own lead but must not be able to hand it to someone else.

/** A caller may only create or keep leads assigned to themselves. */
export function assertLeadAssignable(actor: Actor, assignedCallerId: string | null | undefined): void {
  if (isAdmin(actor)) return;
  if (assignedCallerId !== actor.userId) {
    throw ApiError.forbidden('Callers may only assign leads to themselves');
  }
}

export function assertFollowUpAssignable(actor: Actor, assignedCallerId: string | null | undefined): void {
  if (isAdmin(actor)) return;
  if (assignedCallerId !== actor.userId) {
    throw ApiError.forbidden('Callers may only assign follow-ups to themselves');
  }
}

/** A caller may edit only their own account. */
export function assertCanEditUser(actor: Actor, targetUserId: string): void {
  if (isAdmin(actor)) return;
  if (targetUserId !== actor.userId) {
    throw ApiError.forbidden('Callers may only edit their own account');
  }
}

/** Fields a caller must never change on their own account. */
export const CALLER_IMMUTABLE_USER_FIELDS = ['role', 'status', 'employeeId'] as const;

/**
 * Refuses a caller's attempt to change their own role, status or employee ID.
 *
 * This was a database trigger, and it once failed open: it branched on a session variable
 * that was NULL on connections where it had not been set, so the check silently never
 * matched and a caller really could make themselves an admin. Taking the actor straight from
 * the authenticated request removes that failure mode — there is no second source of truth
 * about who is calling.
 */
export function assertNoPrivilegeEscalation(actor: Actor, patch: Record<string, unknown>): void {
  if (isAdmin(actor)) return;
  for (const field of CALLER_IMMUTABLE_USER_FIELDS) {
    if (field in patch) {
      throw ApiError.forbidden('Callers may not modify role, status, or employee_id');
    }
  }
}

/** Callers may not soft-delete or restore leads, even their own. */
export function assertCanChangeLeadLifecycle(actor: Actor): void {
  if (isAdmin(actor)) return;
  throw ApiError.forbidden('Callers may not soft-delete or restore leads');
}

export function assertOwnsNotification(actor: Actor, recipientUserId: string): void {
  if (isAdmin(actor)) return;
  if (recipientUserId !== actor.userId) {
    throw ApiError.forbidden('Not your notification');
  }
}
