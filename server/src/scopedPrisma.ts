import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from './prisma.js';
import { ApiError } from './errors.js';
import {
  applyBeforeWriteRules,
  applyBeforeWriteRulesAsync,
  applyAfterWriteRules,
  applySecurityRules,
  applySecurityAfterRules,
  captureWriteContext,
  type WriteContext,
} from './dbRules.js';
import type { Actor } from './scope.js';
import {
  customerScope,
  followUpScope,
  leadChildScope,
  leadScope,
  notificationScope,
  orderItemScope,
  orderScope,
  renewalScope,
  userScope,
} from './scope.js';

/**
 * The Prisma-side replacement for row-level security.
 *
 * Prisma connects as a BYPASSRLS role, so the database no longer filters anything. Writing
 * the scope filter by hand at each call site works, but it is exactly the kind of thing
 * that silently degrades: forget one `...leadScope(actor)` and that endpoint quietly serves
 * every caller's rows, with nothing failing loudly.
 *
 * This module closes that gap by applying the scope in a Prisma client extension instead —
 * the filter is injected into every query for a scoped model, so a route physically cannot
 * forget it. It is the closest Prisma equivalent to the guarantee RLS used to give:
 * enforcement lives in one place, below the call sites, rather than being re-derived by
 * every developer at every query.
 *
 *   const db = scopedPrisma(req.actor!);
 *   await db.leads.findMany();          // already scoped to this caller
 *
 * Call sites may still pass their own filters — they are AND-ed with the scope, never
 * replace it, so belt-and-braces explicit filters remain correct and are encouraged as
 * documentation of intent.
 *
 * FAIL-CLOSED: every model must be classified below as either scoped or deliberately
 * global. A model that is neither throws on first use, so adding a table forces an explicit
 * decision about who may read it rather than defaulting to "everyone".
 */

type ScopeFn = (actor: Actor) => Record<string, unknown>;

/** Per-user scoped models — the filter is injected into every query touching these. */
const SCOPED_MODELS: Record<string, ScopeFn> = {
  leads: leadScope,
  lead_medicines: leadChildScope,
  lead_activities: leadChildScope,
  orders: orderScope,
  order_items: orderItemScope,
  renewals: renewalScope,
  follow_ups: followUpScope,
  users: userScope,
  notifications: notificationScope,
  customers: customerScope,
  // renewals_view is a view over renewals and carries the same assigned_caller_id, so it
  // scopes identically. It previously relied on `security_invoker = true` (migration 007)
  // to inherit RLS from its base tables — that no longer applies under a BYPASSRLS role,
  // making this entry the only thing scoping it.
  renewals_view: renewalScope,
};

/**
 * Models every authenticated user may read in full. These mirror the RLS policies whose
 * USING clause was just `app_current_role() IS NOT NULL`. Their writes were admin-only and
 * are still guarded explicitly with requireAdmin() at the call sites — an extension cannot
 * scope a create(), which has no `where` to inject into.
 */
const GLOBAL_MODELS = new Set([
  'products',
  'lead_statuses',
  'lead_sources',
  'order_stages',
  'payment_statuses',
  'follow_up_types',
  'follow_up_statuses',
  // Not user-facing: written only by triggers, read only by admin tooling.
  'audit_log',
  'lead_assignments',
  // sessions is deliberately here rather than scoped: requireAuth must read a session
  // *before* an Actor exists, so it uses the unscoped base client by design.
  'sessions',
  // Views that carry no per-user column and so cannot be scoped by a where clause.
  // global_search spans several entity types and used to be scoped by
  // `security_invoker = true` (migration 007); under BYPASSRLS that protection is gone, so
  // /search must filter its results in application code — see routes/misc.ts.
  'global_search',
  'v_lead_count_reconciliation',
]);

/**
 * Tracks whether the current async context is inside withDbSession(), i.e. whether
 * set_app_session() has been applied to the surrounding transaction.
 */
/**
 * The session store also carries the active transaction client.
 *
 * Ported trigger rules need to READ inside the same transaction as the write that triggered
 * them — resolving a customer's name for a snapshot column, for instance. Reading through
 * the module-level `prisma` client instead would miss rows created earlier in the same
 * transaction, which is exactly what lead conversion does (create a customer, then a
 * renewal referencing it).
 *
 * The stored client is the EXTENDED one, so rule lookups use `$queryRaw` rather than model
 * methods: model calls would re-enter this extension and get the caller's scope applied,
 * and an internal lookup must see the row regardless of who is asking.
 */
type TxClient = {
  $queryRawUnsafe: (sql: string, ...values: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
};
const sessionStore = new AsyncLocalStorage<{ userId: string; tx?: TxClient }>();

/** The active transaction client, for ported rules that must read or write alongside. */
export function currentTx(): TxClient | undefined {
  return sessionStore.getStore()?.tx;
}

/**
 * Write operations. These MUST run with a session GUC established, because several
 * triggers derive their behaviour from it — see the guard in the extension below.
 */
const WRITE_OPS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

/** Operations that accept a `where` we can narrow. `create`/`createMany` have none. */
const WHERE_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

export function scopedPrisma(actor: Actor) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Prisma types `operation` as the intersection of operations across ALL models,
          // and this schema contains read-only views, so the static type collapses to just
          // the read operations. Writes really do arrive here at runtime, hence the widen.
          const op: string = operation;

          // Writes must carry a session GUC, and this is fail-closed rather than a
          // convention, because forgetting it fails SILENTLY and dangerously.
          //
          // Five trigger functions branch on app_current_role()/app_current_user_id():
          // prevent_privilege_escalation, prevent_caller_lead_lifecycle_changes,
          // check_caller_lead_customer_link, sync_lead_assignment_history and log_audit.
          // On a plain Prisma connection those GUCs are unset, so app_current_role()
          // returns NULL — and `IF app_current_role() = 'caller'` is never true for NULL.
          // Every one of those guards therefore becomes a no-op: a caller could set their
          // own role to admin, and audit_log.changed_by was written NULL.
          //
          // Reads are exempt: no trigger fires, and the scope filter below is what
          // protects them.
          if (WRITE_OPS.has(op) && !sessionStore.getStore()) {
            throw new Error(
              `scopedPrisma: ${model}.${op}() attempted outside withDbSession(). ` +
                'Writes must run through withDbSession(actor, ...) so set_app_session() is ' +
                'applied — several triggers silently no-op without it.',
            );
          }

          // Rules ported out of PostgreSQL triggers (see src/dbRules.ts). Applied to every
          // write regardless of scoping, exactly as a BEFORE trigger fired for every row.
          // Every exit below goes through `run`, so an AFTER-write rule cannot be skipped by
          // adding another early return — the mistake a chain of `return query(args)` invites.
          // Parents an aggregate write is about to affect, read BEFORE it lands — a row can
          // move between parents, so the old one needs recomputing too and is unfindable
          // afterwards.
          let ctx: WriteContext = { aggregateIds: [], before: new Map() };

          const run = async (a: unknown) => {
            const result = await query(a as never);
            if (WRITE_OPS.has(op)) {
              await applyAfterWriteRules(model, op, a, result, ctx.aggregateIds);
              await applySecurityAfterRules(model, op, actor, ctx, a, result);
            }
            return result;
          };

          if (WRITE_OPS.has(op)) {
            applyBeforeWriteRules(model, op, args);
            await applyBeforeWriteRulesAsync(model, op, args);
            // Privilege guards run before anything is written, as the BEFORE triggers did.
            await applySecurityRules(model, actor, args);
            ctx = await captureWriteContext(model, op, args);
          }

          if (GLOBAL_MODELS.has(model)) return run(args);

          const scopeFor = SCOPED_MODELS[model];
          if (!scopeFor) {
            // Fail closed rather than silently serving an unclassified table.
            throw new Error(
              `scopedPrisma: model "${model}" is not classified in SCOPED_MODELS or GLOBAL_MODELS. ` +
                'Add it to src/scopedPrisma.ts before querying it.',
            );
          }

          // upsert's `where` decides update-vs-create; narrowing it would silently turn a
          // forbidden update into a create. We don't use it, so refuse rather than guess.
          if (op === 'upsert') {
            throw new Error(`scopedPrisma: upsert is not supported on scoped model "${model}"`);
          }

          if (!WHERE_OPS.has(op)) return run(args);

          const scope = scopeFor(actor);
          // An admin scope is `{}` — nothing to inject, so leave args untouched.
          if (Object.keys(scope).length === 0) return run(args);

          // Append the scope to `where.AND` while leaving the caller's own top-level keys
          // in place. Wrapping the whole thing as `{ AND: [where, scope] }` would be
          // simpler but breaks findUnique/update/delete, whose `where` must still expose a
          // unique field (e.g. `id`) at the top level — Prisma rejects it otherwise with
          // "needs at least one of `id` arguments".
          const typed = args as { where?: Record<string, unknown> };
          const prev = typed.where ?? {};
          const prevAnd = Array.isArray(prev.AND) ? prev.AND : prev.AND ? [prev.AND] : [];
          typed.where = { ...prev, AND: [...prevAnd, scope] };
          return run(args);
        },
      },
    },
  });
}

/**
 * Convenience for routes: resolve the request's scoped client, or 401 if requireAuth
 * somehow did not run. Keeps `req.actor!` non-null assertions out of route bodies.
 */
export function dbFor(actor: Actor | undefined) {
  if (!actor) throw ApiError.unauthorized();
  return scopedPrisma(actor);
}

/**
 * Runs `fn` in a transaction that has `set_app_session()` applied first.
 *
 * Required whenever a SECURITY DEFINER routine is invoked — convert_lead_to_order() and
 * resolve_or_create_customer_for_lead() both do their OWN ownership check with
 * `IF app_current_role() = 'caller' AND v_lead.assigned_caller_id IS DISTINCT FROM v_actor`,
 * and both stamp created_by from `app_current_user_id()`.
 *
 * Those GUCs are unset on a plain Prisma connection, so app_current_role() returns NULL.
 * NULL never equals 'caller', which means the guard silently passes for everyone and
 * created_by is written as NULL. Setting the session restores both.
 *
 * This does not re-enable RLS — app_prisma still has BYPASSRLS, so row filtering continues
 * to come from the scoping extension. Only the functions' explicit checks read these GUCs.
 */
export async function withDbSession<T>(
  actor: Actor,
  fn: (tx: Omit<ReturnType<typeof scopedPrisma>, '$transaction' | '$connect' | '$disconnect'>) => Promise<T>,
): Promise<T> {
  // The ALS scope wraps the WHOLE $transaction, not just the callback body. It cannot wrap
  // only `fn(tx)`: Prisma's model methods return LAZY PrismaPromises that do not run until
  // awaited, so `withDbSession(actor, (tx) => tx.products.create(...))` would return an
  // unstarted promise, exit the ALS scope, and only then have $transaction await it — the
  // write would execute with no store and trip the guard. Wrapping the outer call means
  // every operation the transaction issues, eager or lazy, resolves inside the scope.
  //
  // set_app_session sets its GUCs with is_local=true, so they last exactly as long as this
  // transaction — which is why the store is scoped here and not to the whole request.
  const store: { userId: string; tx?: TxClient } = { userId: actor.userId };
  return sessionStore.run(store, () =>
    scopedPrisma(actor).$transaction(async (tx) => {
      // Published before any rule runs, so ported triggers can read within this transaction.
      store.tx = tx as unknown as TxClient;
      await tx.$executeRaw`SELECT set_app_session(${actor.userId}::uuid)`;
      return fn(tx as never);
    }),
  );
}
