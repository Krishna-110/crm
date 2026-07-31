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
): Promise<void> {
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
