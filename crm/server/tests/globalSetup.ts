import { buildTestDb } from '../scripts/build-test-db.js';

/** Rebuilds crm_test once per run, so a failure never depends on what ran before it. */
export async function setup() {
  const f = await buildTestDb({ quiet: true });
  console.log(`\n  test fixture: users=${f.users} leads=${f.leads} products=${f.products}\n`);
}
