import { ApiError } from './errors.js';

/**
 * Application-layer authorization — the TypeScript equivalent of the Postgres RLS
 * policies that used to enforce this in the database.
 *
 * WHY THIS FILE EXISTS: Prisma connects as a BYPASSRLS role (see src/prisma.ts), so the
 * 71 RLS policies do not apply to any Prisma-backed query. This module is therefore the
 * ONLY thing standing between a caller and another caller's data. Every Prisma read or
 * write against a user-scoped table must go through a helper here.
 *
 * Each helper below is a direct translation of the policy of the same name; the original
 * Postgres predicate is quoted above it so the two can be diffed. Source of truth is
 * `db/schema.sql` SECTION 9 plus migrations 005/007/012.
 *
 * Note on roles: migration 004 removed `super_admin`, and `is_super_admin()` is now
 * literally `app_current_role() = 'admin'`. So `is_super_admin()` and
 * `is_admin_or_above()` are equivalent today and both translate to `actor.role === 'admin'`.
 */

export type ActorRole = 'admin' | 'caller';

export type Actor = {
  userId: string;
  role: ActorRole;
};

export function isAdmin(actor: Actor): boolean {
  return actor.role === 'admin';
}

/** Throws 403 unless the actor is an admin. Use for admin-only writes. */
export function requireAdmin(actor: Actor): void {
  if (!isAdmin(actor)) throw ApiError.forbidden('Admins only');
}

// ---------------------------------------------------------------------------------------
// READ SCOPES — spread into a Prisma `where` clause.
//
// Each returns `{}` for an admin (unrestricted) or a narrowing filter for a caller, so
// call sites read as:  where: { deleted_at: null, ...leadScope(actor) }
// ---------------------------------------------------------------------------------------

/** leads_select: is_admin_or_above() OR assigned_caller_id = app_current_user_id() */
export function leadScope(actor: Actor) {
  return isAdmin(actor) ? {} : { assigned_caller_id: actor.userId };
}

/** renewals_select: is_admin_or_above() OR assigned_caller_id = app_current_user_id() */
export function renewalScope(actor: Actor) {
  return isAdmin(actor) ? {} : { assigned_caller_id: actor.userId };
}

/** follow_ups_select: is_admin_or_above() OR assigned_caller_id = app_current_user_id() */
export function followUpScope(actor: Actor) {
  return isAdmin(actor) ? {} : { assigned_caller_id: actor.userId };
}

/** users_select: is_admin_or_above() OR id = app_current_user_id() */
export function userScope(actor: Actor) {
  return isAdmin(actor) ? {} : { id: actor.userId };
}

/** notifications_select: is_super_admin() OR recipient_user_id = app_current_user_id() */
export function notificationScope(actor: Actor) {
  return isAdmin(actor) ? {} : { recipient_user_id: actor.userId };
}

/**
 * lead_medicines_select / lead_activities_select:
 *   is_admin_or_above() OR EXISTS (SELECT 1 FROM leads l
 *     WHERE l.id = <tbl>.lead_id AND l.assigned_caller_id = app_current_user_id())
 * Expressed as a relation filter on the parent lead.
 */
export function leadChildScope(actor: Actor) {
  return isAdmin(actor) ? {} : { leads: { assigned_caller_id: actor.userId } };
}

/**
 * orders_select: is_admin_or_above()
 *   OR (lead_id IS NOT NULL AND EXISTS (SELECT 1 FROM leads l
 *       WHERE l.id = orders.lead_id AND l.assigned_caller_id = app_current_user_id()))
 * The lead_id NOT NULL clause matters: an order with no lead is admin-only.
 */
export function orderScope(actor: Actor) {
  return isAdmin(actor) ? {} : { lead_id: { not: null }, leads: { assigned_caller_id: actor.userId } };
}

/**
 * order_items_select: is_admin_or_above() OR EXISTS (
 *   SELECT 1 FROM orders o JOIN leads l ON l.id = o.lead_id
 *   WHERE o.id = order_items.order_id AND l.assigned_caller_id = app_current_user_id())
 */
export function orderItemScope(actor: Actor) {
  return isAdmin(actor) ? {} : { orders: { leads: { assigned_caller_id: actor.userId } } };
}

/**
 * customers_select: is_admin_or_above() OR (caller AND EXISTS(... leads UNION renewals
 *   UNION follow_ups all matching customer_id AND assigned_caller_id = me))
 * The three-way UNION becomes an OR across the three relations.
 */
export function customerScope(actor: Actor) {
  if (isAdmin(actor)) return {};
  return {
    OR: [
      { leads: { some: { assigned_caller_id: actor.userId } } },
      { renewals: { some: { assigned_caller_id: actor.userId } } },
      { follow_ups: { some: { assigned_caller_id: actor.userId } } },
    ],
  };
}

/**
 * Lookup tables (lead_statuses, lead_sources, order_stages, payment_statuses,
 * follow_up_types, follow_up_statuses) and products all share:
 *   SELECT: app_current_role() IS NOT NULL  -> any authenticated user
 *   INSERT/UPDATE/DELETE: is_admin_or_above()
 * There is no read scope to apply; writes must call requireAdmin().
 */

// ---------------------------------------------------------------------------------------
// WRITE GUARDS
//
// RLS enforced these via USING/WITH CHECK; with Prisma they must be asserted explicitly.
// The read scopes above are reused for "can this actor touch this row" — a scoped
// updateMany/deleteMany returning count 0 is the app-layer equivalent of the RLS-era
// `rowCount === 0` → 404.
// ---------------------------------------------------------------------------------------

/**
 * leads_insert / leads_update WITH CHECK:
 *   is_admin_or_above() OR assigned_caller_id = app_current_user_id()
 * A caller may only create/leave a lead assigned to themselves. Mirrors the existing
 * route behaviour where a caller's new lead is force-assigned to them.
 */
export function assertLeadAssignable(actor: Actor, assignedCallerId: string | null | undefined): void {
  if (isAdmin(actor)) return;
  if (assignedCallerId !== actor.userId) {
    throw ApiError.forbidden('Callers may only assign leads to themselves');
  }
}

/** follow_ups_insert/update WITH CHECK: is_admin_or_above() OR assigned_caller_id = me */
export function assertFollowUpAssignable(actor: Actor, assignedCallerId: string | null | undefined): void {
  if (isAdmin(actor)) return;
  if (assignedCallerId !== actor.userId) {
    throw ApiError.forbidden('Callers may only assign follow-ups to themselves');
  }
}

/**
 * users_update USING/WITH CHECK: is_admin_or_above() OR id = app_current_user_id()
 * users_insert / users_delete: admin only.
 * NOTE: the DB additionally has prevent_privilege_escalation, which blocks a caller from
 * changing their own role/status/employee_id. It is NOT duplicated here, but it only fires
 * for writes issued inside withDbSession() — it tests app_current_role(), which is NULL on
 * a connection with no session set. See the write guard in scopedPrisma.ts.
 */
export function assertCanEditUser(actor: Actor, targetUserId: string): void {
  if (isAdmin(actor)) return;
  if (targetUserId !== actor.userId) {
    throw ApiError.forbidden('Callers may only edit their own account');
  }
}

/** notifications_update: is_super_admin() OR recipient_user_id = me */
export function assertOwnsNotification(actor: Actor, recipientUserId: string): void {
  if (isAdmin(actor)) return;
  if (recipientUserId !== actor.userId) {
    throw ApiError.forbidden('Not your notification');
  }
}
