import type { Tx } from '../db/prisma.js';
import type { Actor } from '../auth/scope.js';

/**
 * Lead bookkeeping that used to be trigger work.
 *
 * Both functions RECOMPUTE rather than adjust. The triggers they replace kept running totals
 * by applying deltas, which drift permanently the moment one is missed or applied twice —
 * and carried GREATEST(x, 0) clamps to hide the symptom when they did. Recomputation is
 * idempotent and repairs existing drift on the next write.
 */

/**
 * Rebuilds each user's assigned-lead counter from the leads themselves.
 *
 * Called with every user a change could have affected — on a reassignment that is both the
 * old and the new owner, since the old one's count drops.
 */
export async function recountAssignedLeads(tx: Tx, userIds: string[]): Promise<void> {
  for (const id of new Set(userIds)) {
    const assignedLeadsCount = await tx.lead.count({
      where: { assignedCallerId: id, deletedAt: null },
    });
    await tx.user.update({ where: { id }, data: { assignedLeadsCount } });
  }
}

/**
 * Records a reassignment in the lead's assignment history, and keeps the follow-ups hanging
 * off that lead pointing at whoever now owns it.
 *
 * The follow-up cascade matters: a follow-up's caller is what scopes it, so leaving it
 * behind would hide the work from the lead's new owner and keep it visible to someone who no
 * longer has the lead.
 */
export async function recordAssignment(
  tx: Tx,
  actor: Actor,
  leadId: string,
  from: string | null,
  to: string | null,
): Promise<void> {
  if (from === to) return;

  if (from) {
    await tx.leadAssignment.updateMany({
      where: { leadId, callerId: from, unassignedAt: null },
      data: { unassignedAt: new Date() },
    });
  }
  if (to) {
    await tx.leadAssignment.create({
      data: { leadId, callerId: to, assignedBy: actor.userId },
    });
  }
  await tx.followUp.updateMany({
    where: { leadId, deletedAt: null },
    data: { assignedCallerId: to },
  });
}
