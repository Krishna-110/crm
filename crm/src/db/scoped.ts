import { prisma } from './prisma.js';
import {
  type Actor,
  customerScope,
  followUpScope,
  leadChildScope,
  leadScope,
  notificationScope,
  orderItemScope,
  orderScope,
  renewalScope,
  userScope,
} from '../auth/scope.js';

/**
 * A Prisma client that applies the caller's authorization scope to every query.
 *
 * This exists so a route cannot forget. Writing `where` filters by hand at each call site
 * works right up until someone adds an endpoint and omits one, and that omission looks like
 * working code. Here the filter is applied beneath the route, and a model nobody has
 * classified refuses to be queried at all.
 */

type ScopeFn = (actor: Actor) => Record<string, unknown>;

/** Models narrowed per caller. Keys are Prisma model names as the extension sees them. */
const SCOPED: Record<string, ScopeFn> = {
  lead: leadScope,
  leadMedicine: leadChildScope,
  leadActivity: leadChildScope,
  leadAssignment: leadChildScope,
  order: orderScope,
  orderItem: orderItemScope,
  renewal: renewalScope,
  followUp: followUpScope,
  user: userScope,
  notification: notificationScope,
  customer: customerScope,
};

/**
 * Models every authenticated user may read in full.
 *
 * The catalogue and the lookup tables are reference data. `auditLog` is admin tooling and is
 * gated at the route. `session` is here because authentication has to resolve a session
 * *before* an actor exists — scoping it would be circular.
 */
const GLOBAL = new Set([
  'product',
  'leadStatus',
  'leadSource',
  'orderStage',
  'paymentStatus',
  'followUpType',
  'followUpStatus',
  'auditLog',
  'session',
]);

/** Operations that accept a `where` we can narrow. Creates have none. */
const NARROWABLE = new Set([
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

export function scopedFor(actor: Actor) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const name = model.charAt(0).toLowerCase() + model.slice(1);

          if (GLOBAL.has(name)) return query(args);

          const scopeFor = SCOPED[name];
          if (!scopeFor) {
            // Fail closed. A newly added model is unreachable until somebody decides whether
            // it is per-caller or shared — the alternative is serving it unscoped by default,
            // which is a silent data leak that looks like it works.
            throw new Error(
              `scopedFor: model "${name}" is classified in neither SCOPED nor GLOBAL. ` +
                'Add it to src/db/scoped.ts before querying it.',
            );
          }

          // `upsert`'s where decides update-versus-create, so narrowing it could silently turn
          // a forbidden update into a create. Refuse rather than guess.
          if (operation === 'upsert') {
            throw new Error(`scopedFor: upsert is not supported on scoped model "${name}"`);
          }

          if (!NARROWABLE.has(operation)) return query(args);

          const scope = scopeFor(actor);
          if (Object.keys(scope).length === 0) return query(args); // admin

          // Appended to `where.AND` rather than wrapping the whole clause. Wrapping reads more
          // cleanly but breaks findUnique/update/delete, whose `where` must still expose a
          // unique field at the top level — Prisma rejects it with "needs at least one of `id`".
          const a = args as { where?: Record<string, unknown> };
          const prev = a.where ?? {};
          const prevAnd = Array.isArray(prev.AND) ? prev.AND : prev.AND ? [prev.AND] : [];
          a.where = { ...prev, AND: [...prevAnd, scope] };
          return query(args);
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof scopedFor>;
