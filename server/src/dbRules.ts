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
