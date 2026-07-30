/**
 * Restores the database to a known-clean baseline: removes rows created by automated
 * tests, and puts back the seed rows that tests are known to mutate.
 *
 * Idempotent — safe to run before AND after a test run, and safe to run twice.
 *
 * This is deliberately NOT a rebuild from db/seed.sql. The live database holds real work
 * that the seed does not: seed.sql has 6 products, the catalogue has ~29 (the Ayurvedic
 * range added by hand), plus real leads, orders and user accounts. Dropping and re-seeding
 * would destroy all of it. So this script only touches (a) rows matching known test-data
 * name patterns, and (b) specific seed rows, restored to the literal values in db/seed.sql.
 *
 * Run: npm --prefix server run reset:test-data
 */
import { maintPool } from '../src/db.js';

// Name prefixes used by the automated suites and by earlier manual UAT sessions. Anything
// matching these is disposable; anything else is treated as real data and left alone.
const TEST_NAME_RX = '^(SWEEP|PRISMA |AUTHZ|E2E|LAGCHECK|T3 |T4 |DASH Cache|Source |Test |Offline |Soon Inactive)';

async function main() {
  const client = await maintPool.connect();
  try {
    await client.query('BEGIN');

    // ---- 1. Remove test-created rows, children first (FKs are not ON DELETE CASCADE) ----
    await client.query(`CREATE TEMP TABLE _tl ON COMMIT DROP AS
      SELECT id, customer_id FROM leads WHERE customer_name ~* $1`, [TEST_NAME_RX]);
    await client.query(`CREATE TEMP TABLE _to ON COMMIT DROP AS
      SELECT id FROM orders WHERE lead_id IN (SELECT id FROM _tl)`);

    const counts: Record<string, number> = {};
    const del = async (label: string, sql: string, params: unknown[] = []) => {
      const r = await client.query(sql, params);
      if (r.rowCount) counts[label] = r.rowCount;
    };

    await del('order_items', 'DELETE FROM order_items WHERE order_id IN (SELECT id FROM _to)');
    await del('orders', 'DELETE FROM orders WHERE id IN (SELECT id FROM _to)');
    await del('follow_ups', `DELETE FROM follow_ups
      WHERE lead_id IN (SELECT id FROM _tl) OR customer_name ~* $1 OR notes ~* '^(sweep|e2e)'`, [TEST_NAME_RX]);
    await del('lead_assignments', 'DELETE FROM lead_assignments WHERE lead_id IN (SELECT id FROM _tl)');
    await del('lead_medicines', 'DELETE FROM lead_medicines WHERE lead_id IN (SELECT id FROM _tl)');
    await del('lead_activities', 'DELETE FROM lead_activities WHERE lead_id IN (SELECT id FROM _tl)');
    await del('renewals', `DELETE FROM renewals
      WHERE customer_id IN (SELECT customer_id FROM _tl WHERE customer_id IS NOT NULL)`);
    await del('leads', 'DELETE FROM leads WHERE id IN (SELECT id FROM _tl)');
    await del('customers', `DELETE FROM customers WHERE full_name ~* $1
      AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = customers.id)`, [TEST_NAME_RX]);
    await del('products', 'DELETE FROM products WHERE brand_name ~* $1', [TEST_NAME_RX]);
    await del('users', 'DELETE FROM users WHERE name ~* $1', [TEST_NAME_RX]);

    // ---- 2. Restore seed rows that tests mutate ----
    // Values below are the literal seed values; see db/seed.sql. Renewals: only Meena Joshi
    // (…0004) is renewed in the seed — the rest are NULL. Tests that call POST
    // /renewals/:id/renew or DELETE /renewals/:id leave residue here that no name pattern
    // can find, which is why these are pinned explicitly.
    const restored: Record<string, number> = {};
    const upd = async (label: string, sql: string) => {
      const r = await client.query(sql);
      if (r.rowCount) restored[label] = r.rowCount;
    };

    await upd('renewals.renewed_at', `UPDATE renewals SET renewed_at = NULL
      WHERE id <> '70000000-0000-0000-0000-000000000004' AND renewed_at IS NOT NULL`);
    await upd('renewals.renewed_at(0004)', `UPDATE renewals SET renewed_at = '2026-07-02 09:30:00+05:30'
      WHERE id = '70000000-0000-0000-0000-000000000004' AND renewed_at IS DISTINCT FROM '2026-07-02 09:30:00+05:30'`);
    await upd('renewals.deleted_at', `UPDATE renewals SET deleted_at = NULL
      WHERE id::text LIKE '70000000-%' AND deleted_at IS NOT NULL`);

    // Seed: …0003 and …0004 are read; the other four are unread.
    await upd('notifications.is_read', `UPDATE notifications SET is_read = (id IN (
        '90000000-0000-0000-0000-000000000003','90000000-0000-0000-0000-000000000004'))
      WHERE id::text LIKE '90000000-%' AND is_read IS DISTINCT FROM (id IN (
        '90000000-0000-0000-0000-000000000003','90000000-0000-0000-0000-000000000004'))`);

    // Seed: Kavya Reddy (…0008) is deliberately inactive for negative-login tests; the other
    // seven seed users are active with role unchanged.
    await upd('users.status', `UPDATE users SET status = (CASE
        WHEN id = '10000000-0000-0000-0000-000000000008' THEN 'inactive' ELSE 'active' END)::user_status
      WHERE id::text LIKE '10000000-%' AND status IS DISTINCT FROM (CASE
        WHEN id = '10000000-0000-0000-0000-000000000008' THEN 'inactive' ELSE 'active' END)::user_status`);
    await upd('users.role', `UPDATE users SET role = (CASE
        WHEN id IN ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',
                    '10000000-0000-0000-0000-000000000003') THEN 'admin' ELSE 'caller' END)::user_role
      WHERE id::text LIKE '10000000-%' AND role IS DISTINCT FROM (CASE
        WHEN id IN ('10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',
                    '10000000-0000-0000-0000-000000000003') THEN 'admin' ELSE 'caller' END)::user_role`);

    // Un-soft-delete seed leads (a test that soft-deletes a seed lead leaves no name trace).
    await upd('leads.deleted_at', `UPDATE leads SET deleted_at = NULL
      WHERE id::text LIKE '40000000-%' AND deleted_at IS NOT NULL`);

    await client.query('COMMIT');

    const fmt = (o: Record<string, number>) =>
      Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join('  ') : 'nothing';
    console.log('deleted : ' + fmt(counts));
    console.log('restored: ' + fmt(restored));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Matviews are not transactional and must be refreshed after the data settles.
  await maintPool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lead_status_breakdown');
  await maintPool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_caller_performance');

  const { rows } = await maintPool.query(`SELECT
      (SELECT count(*) FROM leads WHERE deleted_at IS NULL)      AS leads,
      (SELECT count(*) FROM users WHERE deleted_at IS NULL)      AS users,
      (SELECT count(*) FROM orders WHERE deleted_at IS NULL)     AS orders,
      (SELECT count(*) FROM renewals WHERE deleted_at IS NULL)   AS renewals,
      (SELECT count(*) FROM products WHERE deleted_at IS NULL)   AS products,
      (SELECT count(*) FROM follow_ups WHERE deleted_at IS NULL) AS follow_ups`);
  const b = rows[0];
  console.log(
    `baseline: leads=${b.leads} users=${b.users} orders=${b.orders} ` +
      `renewals=${b.renewals} products=${b.products} follow_ups=${b.follow_ups}`,
  );

  await maintPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
