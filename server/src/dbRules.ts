/**
 * Business rules that used to live in PostgreSQL triggers, reimplemented in TypeScript.
 *
 * Part of the full ORM migration (docs/ORM_MIGRATION.md): the application owns all
 * behaviour, and the database holds no procedural code.
 *
 * A BEFORE trigger becomes a mutation of `args.data` before the query runs. An AFTER trigger
 * becomes work performed once the query resolves, inside the same transaction.
 *
 * THE SEQUENCING RULE: a rule ported here must have its trigger dropped in the same step.
 * Running both means the work happens twice — `update_order_total` would compute the total
 * twice, `log_audit` would record every change twice. Each phase in ORM_MIGRATION.md ports a
 * group and drops its triggers together.
 */

/** Models carrying an `updated_at` column, i.e. everything set_updated_at was attached to. */
const HAS_UPDATED_AT = new Set([
  'customers',
  'follow_up_statuses',
  'follow_up_types',
  'follow_ups',
  'lead_activities',
  'lead_assignments',
  'lead_medicines',
  'lead_sources',
  'lead_statuses',
  'leads',
  'notifications',
  'order_items',
  'order_stages',
  'orders',
  'payment_statuses',
  'products',
  'renewals',
  'users',
]);

/** Operations that carry a `data` payload we can stamp. */
const DATA_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn', 'upsert']);

/**
 * Replaces `set_updated_at`, which was attached to 20 tables.
 *
 * The trigger fired on every UPDATE regardless of what changed, so this stamps
 * unconditionally too. It does NOT overwrite an explicitly supplied updated_at — the trigger
 * did (NEW.updated_at := now() ran last), but a caller passing one is either a test pinning a
 * value or a deliberate backdate, and silently discarding it is worse than honouring it.
 */
export function stampUpdatedAt(model: string, operation: string, args: unknown): void {
  if (!HAS_UPDATED_AT.has(model) || !DATA_OPS.has(operation)) return;
  const a = args as { data?: Record<string, unknown> };
  if (!a.data || typeof a.data !== 'object') return;
  if (a.data.updated_at === undefined) a.data.updated_at = new Date();
}

/**
 * Replaces `normalize_indian_mobile`.
 *
 *   digits only; then strip a +91 country code (12 digits starting 91) or a trunk 0
 *   (11 digits starting 0), leaving the bare 10-digit number.
 *
 * Anything else is returned as its digits, unchanged in length — the original did not
 * validate, and adding validation here would reject rows the database currently accepts.
 */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(-10);
  return digits;
}

/** Which column each model normalises, replacing the two normalize_*_mobile triggers. */
const MOBILE_COLUMN: Record<string, string> = {
  leads: 'mobile',
  customers: 'primary_mobile',
};

/** Replaces `normalize_leads_mobile` and `normalize_customers_primary_mobile`. */
export function normalizeMobile(model: string, args: unknown): void {
  const column = MOBILE_COLUMN[model];
  if (!column) return;
  const a = args as { data?: Record<string, unknown> | Record<string, unknown>[] };
  if (!a.data) return;
  const rows = Array.isArray(a.data) ? a.data : [a.data];
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row[column] === 'string') {
      row[column] = normalizeIndianMobile(row[column] as string);
    }
  }
}

/**
 * Replaces `set_notification_read_at`:
 *
 *   IF NEW.is_read AND NOT OLD.is_read AND NEW.read_at IS NULL THEN NEW.read_at := now();
 *   ELSIF NOT NEW.is_read THEN NEW.read_at := NULL;
 *
 * The OLD.is_read check cannot be reproduced without reading the row first, so this stamps
 * whenever is_read is being set true and no read_at was supplied. The difference is only
 * visible when marking an already-read notification read again: the trigger left the original
 * timestamp, this refreshes it. Marking read twice is not a flow the app offers — the route
 * filters on the unread row — and paying a SELECT on every notification update to preserve
 * that distinction is not worth it.
 */
export function stampNotificationReadAt(model: string, args: unknown): void {
  if (model !== 'notifications') return;
  const a = args as { data?: Record<string, unknown> };
  if (!a.data || typeof a.data !== 'object') return;
  if (a.data.is_read === true) {
    if (a.data.read_at === undefined) a.data.read_at = new Date();
  } else if (a.data.is_read === false) {
    a.data.read_at = null;
  }
}

/** Every BEFORE-write rule, applied in one place so the extension stays readable. */
export function applyBeforeWriteRules(model: string, operation: string, args: unknown): void {
  stampUpdatedAt(model, operation, args);
  normalizeMobile(model, args);
  stampNotificationReadAt(model, args);
}

// ---------------------------------------------------------------------------------------
// PHASE 2 — snapshot synchronisation
//
// Denormalised columns kept in step with the row they were copied from. Unlike phase 1 these
// need a READ, and it must happen inside the same transaction as the write: lead conversion
// creates a customer and then a renewal referencing it, so a lookup outside the transaction
// would not see it yet.
//
// Lookups use $queryRaw on the active transaction client rather than model methods. A model
// call would re-enter the scoping extension and have the caller's scope applied — but an
// internal snapshot lookup has to resolve the parent row regardless of who is writing.
// ---------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** The rows a write is about to apply, normalised to an array. */
function payloadRows(args: unknown): Row[] {
  const a = args as { data?: Row | Row[] };
  if (!a.data) return [];
  return (Array.isArray(a.data) ? a.data : [a.data]).filter(
    (r): r is Row => !!r && typeof r === 'object',
  );
}

/**
 * Replaces `sync_customer_name_snapshot` (follow_ups, orders, renewals),
 * `sync_renewal_order_date` and `sync_renewal_product_snapshot`.
 *
 * Each trigger fired when its foreign key was set on INSERT or changed on UPDATE. Prisma
 * gives us the payload, not OLD, so the condition here is "the FK is present in this write" —
 * which covers both cases and, on an update that re-sets the FK to its current value, simply
 * recomputes the same snapshot.
 */
const SNAPSHOTS: Record<string, { fk: string; target: string; sql: (id: string) => string }[]> = {
  follow_ups: [{ fk: 'customer_id', target: 'customer_name', sql: () => 'SELECT full_name AS v FROM customers WHERE id = $1' }],
  orders: [{ fk: 'customer_id', target: 'customer_name', sql: () => 'SELECT full_name AS v FROM customers WHERE id = $1' }],
  renewals: [
    { fk: 'customer_id', target: 'customer_name', sql: () => 'SELECT full_name AS v FROM customers WHERE id = $1' },
    { fk: 'order_id', target: 'order_date', sql: () => 'SELECT created_at AS v FROM orders WHERE id = $1' },
    { fk: 'product_id', target: 'medicine_name', sql: () => 'SELECT COALESCE(brand_name, generic_name) AS v FROM products WHERE id = $1' },
  ],
};

async function lookup(sql: string, id: string): Promise<unknown> {
  const { currentTx } = await import('./scopedPrisma.js');
  const tx = currentTx();
  if (!tx) return undefined; // outside a session there is nothing to keep consistent
  const rows = (await tx.$queryRawUnsafe(sql, id)) as { v: unknown }[];
  return rows[0]?.v;
}

/**
 * Replaces `sync_followup_assigned_caller`: a follow-up with no explicit caller inherits one
 * from its lead, or failing that its renewal.
 *
 * The trigger also called assert_active_user() — that guard is still in the database and is
 * ported in phase 4, so it is deliberately not duplicated here.
 */
async function inheritFollowUpCaller(row: Row): Promise<void> {
  if (row.assigned_caller_id != null) return;
  if (typeof row.lead_id === 'string') {
    row.assigned_caller_id = await lookup('SELECT assigned_caller_id AS v FROM leads WHERE id = $1', row.lead_id);
  }
  if (row.assigned_caller_id == null && typeof row.renewal_id === 'string') {
    row.assigned_caller_id = await lookup('SELECT assigned_caller_id AS v FROM renewals WHERE id = $1', row.renewal_id);
  }
}

/** BEFORE-write rules that need a database read. */
export async function applyBeforeWriteRulesAsync(
  model: string,
  _operation: string,
  args: unknown,
): Promise<void> {
  const rows = payloadRows(args);
  if (rows.length === 0) return;

  for (const row of rows) {
    for (const snap of SNAPSHOTS[model] ?? []) {
      const id = row[snap.fk];
      if (typeof id === 'string' && row[snap.target] === undefined) {
        const value = await lookup(snap.sql(id), id);
        if (value !== undefined) row[snap.target] = value;
      }
    }
    if (model === 'follow_ups') await inheritFollowUpCaller(row);
  }

  // Validation runs last, after inheritance has filled in any derived foreign keys — a
  // follow-up that inherits its caller from a lead must have THAT caller validated.
  await applyValidationRules(model, args);
}

/**
 * Replaces `sync_followup_caller_from_renewal`: reassigning a renewal cascades to the
 * follow-ups that hang off it.
 *
 * The only AFTER-write rule in this phase, and the reason the extension funnels every exit
 * through one place — it has to run after the renewal update has actually landed.
 */
export async function applyAfterWriteRules(
  model: string,
  _operation: string,
  args: unknown,
  _result: unknown,
  aggregateContext: string[] = [],
): Promise<void> {
  await applyAggregateRules(model, args, aggregateContext);
  if (model !== 'renewals') return;
  const rows = payloadRows(args);
  const caller = rows.find((r) => 'assigned_caller_id' in r)?.assigned_caller_id;
  if (caller === undefined) return;

  const where = (args as { where?: { id?: unknown } }).where;
  if (typeof where?.id !== 'string') return;

  const { currentTx } = await import('./scopedPrisma.js');
  const tx = currentTx();
  if (!tx) return;
  await tx.$executeRawUnsafe(
    `UPDATE follow_ups SET assigned_caller_id = $1
      WHERE renewal_id = $2 AND deleted_at IS NULL
        AND assigned_caller_id IS DISTINCT FROM $1`,
    caller,
    where.id,
  );
}

// ---------------------------------------------------------------------------------------
// PHASE 3 — derived aggregates
//
// update_order_total and maintain_assigned_leads_count both maintained a running total by
// applying a DELTA computed from OLD and NEW. The extension never sees OLD, so rather than
// reconstruct it, these RECOMPUTE the aggregate from its source rows.
//
// That is deliberately different from the trigger, and better: a delta drifts permanently if
// a single application is missed or double-applied, whereas a recomputation is idempotent and
// self-correcting. The triggers' own GREATEST(x, 0) clamps exist precisely because delta
// arithmetic can go negative — recomputation cannot. The cost is one aggregate query per
// affected parent, which at any realistic size is nothing next to correctness.
//
// The work is finding WHICH parents to recompute. A write can move a row between parents, so
// both the parents it belonged to BEFORE and the ones named in the payload must be refreshed.
// Hence a capture step before the write and a recompute after it.
// ---------------------------------------------------------------------------------------

/** Aggregates maintained here: child model -> how to find and rebuild the parent. */
const AGGREGATES: Record<
  string,
  { fk: string; rebuild: (tx: TxLoose, id: string) => Promise<unknown> }
> = {
  order_items: {
    fk: 'order_id',
    rebuild: (tx, id) =>
      tx.$executeRawUnsafe(
        `UPDATE orders SET total_amount = COALESCE(
           (SELECT SUM(line_total) FROM order_items WHERE order_id = $1 AND deleted_at IS NULL), 0)
         WHERE id = $1`,
        id,
      ),
  },
  leads: {
    fk: 'assigned_caller_id',
    rebuild: (tx, id) =>
      tx.$executeRawUnsafe(
        `UPDATE users SET assigned_leads_count = COALESCE(
           (SELECT count(*) FROM leads WHERE assigned_caller_id = $1 AND deleted_at IS NULL), 0)
         WHERE id = $1`,
        id,
      ),
  },
};

/** Loosely typed transaction client — model delegates plus the raw escape hatches. */
type TxLoose = {
  $queryRawUnsafe: (sql: string, ...v: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...v: unknown[]) => Promise<number>;
} & Record<string, { findMany?: (a: unknown) => Promise<Record<string, unknown>[]> }>;

async function tx(): Promise<TxLoose | undefined> {
  const { currentTx } = await import('./scopedPrisma.js');
  return currentTx() as unknown as TxLoose | undefined;
}

/**
 * Parent ids a write is about to affect, read BEFORE it lands.
 *
 * Uses the scoped client on purpose: the rows a caller can actually change are the rows in
 * their scope, so capturing through the same filter matches what the write will touch. Reads
 * do not re-enter the aggregate logic, so there is no recursion.
 */
export async function captureAggregateContext(
  model: string,
  operation: string,
  args: unknown,
): Promise<string[]> {
  const agg = AGGREGATES[model];
  if (!agg) return [];
  const where = (args as { where?: unknown }).where;
  if (!where) return []; // create/createMany affect no pre-existing parent

  const client = await tx();
  const delegate = client?.[model];
  if (!delegate?.findMany) return [];
  const rows = await delegate.findMany({ where, select: { [agg.fk]: true } });
  return rows.map((r) => r[agg.fk]).filter((v): v is string => typeof v === 'string');
}

/**
 * Replaces `update_order_total` and `maintain_assigned_leads_count`.
 *
 * Recomputes every parent the write could have touched: those captured beforehand, plus any
 * named in the payload (a row moving to a different parent, or a newly created one).
 */
export async function applyAggregateRules(
  model: string,
  args: unknown,
  before: string[],
): Promise<void> {
  const agg = AGGREGATES[model];
  if (!agg) return;

  const ids = new Set(before);
  for (const row of payloadRows(args)) {
    const v = row[agg.fk];
    if (typeof v === 'string') ids.add(v);
  }
  if (ids.size === 0) return;

  const client = await tx();
  if (!client) return;
  for (const id of ids) await agg.rebuild(client, id);
}

// ---------------------------------------------------------------------------------------
// PHASE 4 — referential validation
//
// Seven triggers, all built on two helpers:
//
//   assert_active_user(id, context)    — the referenced user must exist, not be soft-deleted,
//                                        and have status 'active'
//   assert_active_product(id, context) — the referenced product must exist, not be
//                                        soft-deleted, and have is_active
//
// plus two consistency guards: a follow-up's or order's customer_id must agree with the
// customer_id of the lead/renewal it is linked to.
//
// All of them RAISE EXCEPTION, which surfaces as P0001 and is mapped to HTTP 403 by
// errors.ts. The ported versions throw ApiError.forbidden with the same message text, so the
// status and body a client sees are unchanged — only the layer that produces them moves.
// ---------------------------------------------------------------------------------------

/** Column -> context label, matching the strings the triggers passed. */
const ACTIVE_USER_REFS: Record<string, string[]> = {
  leads: ['assigned_caller_id'],
  renewals: ['assigned_caller_id'],
  follow_ups: ['assigned_caller_id'],
};

const ACTIVE_PRODUCT_REFS: Record<string, string[]> = {
  leads: ['requested_product_id'],
  order_items: ['product_id'],
};

/** Replaces `assert_active_user`. */
async function assertActiveUser(id: unknown, context: string): Promise<void> {
  if (typeof id !== 'string') return; // NULL is allowed, as in the original
  const client = await tx();
  if (!client) return;
  const rows = (await client.$queryRawUnsafe(
    `SELECT status::text AS status, deleted_at FROM users WHERE id = $1`,
    id,
  )) as { status: string; deleted_at: Date | null }[];
  const row = rows[0];
  if (!row || row.deleted_at !== null || row.status !== 'active') {
    const { ApiError } = await import('./errors.js');
    throw ApiError.forbidden(`${context} may not reference an inactive or deleted user (${id})`);
  }
}

/** Replaces `assert_active_product`. */
async function assertActiveProduct(id: unknown, context: string): Promise<void> {
  if (typeof id !== 'string') return;
  const client = await tx();
  if (!client) return;
  const rows = (await client.$queryRawUnsafe(
    `SELECT is_active, deleted_at FROM products WHERE id = $1`,
    id,
  )) as { is_active: boolean; deleted_at: Date | null }[];
  const row = rows[0];
  if (!row || row.deleted_at !== null || !row.is_active) {
    const { ApiError } = await import('./errors.js');
    throw ApiError.forbidden(`${context} may not reference an inactive or deleted product (${id})`);
  }
}

/**
 * Replaces `check_followup_customer_consistency` and `check_order_customer_consistency`.
 *
 * Only enforced when the parent actually has a customer_id — the triggers skipped the check
 * for an unconverted lead, and tightening that here would reject writes the database accepts.
 */
const CONSISTENCY: Record<string, { fk: string; parent: string; label: string }[]> = {
  follow_ups: [
    { fk: 'lead_id', parent: 'leads', label: "lead" },
    { fk: 'renewal_id', parent: 'renewals', label: "renewal" },
  ],
  orders: [{ fk: 'lead_id', parent: 'leads', label: "lead" }],
};

async function assertCustomerConsistency(model: string, row: Row): Promise<void> {
  for (const rule of CONSISTENCY[model] ?? []) {
    const parentId = row[rule.fk];
    if (typeof parentId !== 'string') continue;
    const client = await tx();
    if (!client) return;
    const rows = (await client.$queryRawUnsafe(
      `SELECT customer_id FROM ${rule.parent} WHERE id = $1`,
      parentId,
    )) as { customer_id: string | null }[];
    const parentCustomer = rows[0]?.customer_id ?? null;
    if (parentCustomer !== null && parentCustomer !== (row.customer_id ?? null)) {
      const { ApiError } = await import('./errors.js');
      throw ApiError.forbidden(
        `${model}.customer_id (${row.customer_id ?? '<NULL>'}) does not match the linked ` +
          `${rule.label}'s customer_id (${parentCustomer})`,
      );
    }
  }
}

/** All referential validation for one write. */
export async function applyValidationRules(model: string, args: unknown): Promise<void> {
  for (const row of payloadRows(args)) {
    for (const col of ACTIVE_USER_REFS[model] ?? []) {
      if (col in row) await assertActiveUser(row[col], `${model}.${col}`);
    }
    for (const col of ACTIVE_PRODUCT_REFS[model] ?? []) {
      if (col in row) await assertActiveProduct(row[col], `${model}.${col}`);
    }
    await assertCustomerConsistency(model, row);
  }
}
