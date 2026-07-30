/**
 * Rebuilds `medcrm_test` once per `vitest run`, before any worker starts.
 *
 * Phase 3 issues real writes — it creates leads, converts them to orders, deactivates users
 * — so unlike Phase 2 it cannot be made non-mutating. Rebuilding up front means every run
 * starts from an identical fixture regardless of what the previous run did or how it
 * failed, which matters more here than the ~3s it costs: a suite whose starting state
 * depends on the last run's exit path produces failures nobody can reproduce.
 *
 * In watch mode this runs once per session, not per file change.
 */
import { buildTestDb } from '../scripts/build-test-db.js';

export async function setup() {
  const fixture = await buildTestDb({ quiet: true });
  console.log(
    `\n  test fixture rebuilt: leads=${fixture.leads} users=${fixture.users} ` +
      `orders=${fixture.orders} renewals=${fixture.renewals} products=${fixture.products} ` +
      `follow_ups=${fixture.follow_ups}\n`,
  );
}
