import type { Prisma } from '@prisma/client';
import type { Tx } from '../db/prisma.js';
import type { Actor } from '../auth/scope.js';

/**
 * Audit logging.
 *
 * Previously a SECURITY DEFINER trigger, which meant the application could not write
 * audit_log at all — only cause rows to appear in it. That made the trail tamper-evident
 * from the application's side, and moving it here gives that up: anything holding the
 * database credentials can now write, alter or omit entries.
 *
 * That is a real loss and worth being clear about. What is gained is that the trail is
 * legible — the diff logic is fifteen lines of TypeScript rather than a PL/pgSQL loop over
 * jsonb keys, it is unit-testable, and it records the actor from the authenticated request
 * rather than a session variable that could be unset.
 *
 * Every call must pass the transaction client, so an audit row lands or rolls back with the
 * change it describes. An audit entry for a write that did not happen is worse than none.
 */

type Row = Record<string, unknown>;

/** Fields never worth recording: noisy, derived, or already implied by the entry itself. */
const IGNORED = new Set(['updatedAt']);

/** Only the fields that actually differ, so an entry shows the change and not the whole row. */
export function diff(before: Row, after: Row): { old: Row; new: Row } | null {
  const oldData: Row = {};
  const newData: Row = {};
  for (const key of Object.keys(after)) {
    if (IGNORED.has(key)) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      oldData[key] = before[key] ?? null;
      newData[key] = after[key] ?? null;
    }
  }
  return Object.keys(newData).length === 0 ? null : { old: oldData, new: newData };
}

/** Dates and Decimals are not JSON — flatten them so the stored payload is readable. */
function serialize(row: Row): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(row, (_k, v) =>
      v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as Prisma.InputJsonValue;
}

export async function auditCreate(tx: Tx, actor: Actor, table: string, row: Row & { id: string }) {
  await tx.auditLog.create({
    data: {
      tableName: table,
      recordId: row.id,
      action: 'INSERT',
      changedBy: actor.userId,
      newData: serialize(row),
    },
  });
}

export async function auditUpdate(
  tx: Tx,
  actor: Actor,
  table: string,
  before: Row & { id: string },
  after: Row & { id: string },
) {
  const changed = diff(before, after);
  if (!changed) return; // nothing actually changed — the trigger logged nothing either
  await tx.auditLog.create({
    data: {
      tableName: table,
      recordId: after.id,
      action: 'UPDATE',
      changedBy: actor.userId,
      oldData: serialize(changed.old),
      newData: serialize(changed.new),
    },
  });
}

export async function auditDelete(tx: Tx, actor: Actor, table: string, row: Row & { id: string }) {
  await tx.auditLog.create({
    data: {
      tableName: table,
      recordId: row.id,
      action: 'DELETE',
      changedBy: actor.userId,
      oldData: serialize(row),
    },
  });
}
