/**
 * Builds the `medcrm_test` database from scratch: schema -> seed -> migrations -> date shift.
 *
 * Drops and recreates every time, so tests always start from a known fixture. This is the
 * isolation mechanism — per-test transaction rollback is NOT available here, because
 * withDbSession() opens its own $transaction and Prisma has no nested interactive
 * transactions. See docs/TEST_STRATEGY.md.
 *
 * Roles are cluster-wide, not per-database: app_user and app_prisma already exist and both
 * CREATE ROLE sites are IF NOT EXISTS-guarded, so replaying schema.sql and migration 016
 * against a new database re-applies the per-database GRANTs without touching the roles.
 *
 * Run: npm --prefix server run test:db
 */
import 'dotenv/config';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DB = process.env.TEST_PGDATABASE ?? 'medcrm_test';
const DB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');

/** Credentials the API suite logs in with. Mirrors scripts/dev-setup.ts. */
export const TEST_PASSWORDS = { admin: 'admin123', caller: 'caller123' } as const;

const admin = {
  host: process.env.MAINT_PGHOST ?? 'localhost',
  port: Number(process.env.MAINT_PGPORT ?? 5432),
  user: process.env.MAINT_PGUSER,
  password: process.env.MAINT_PGPASSWORD,
};

let log: (m: string) => void = console.log;

async function run(database: string, label: string, sql: string) {
  const client = new pg.Client({ ...admin, database });
  await client.connect();
  try {
    // Files are executed whole via the simple query protocol, which allows multiple
    // statements per call. None of them use psql meta-commands (\i, \set, \gexec), so no
    // psql binary is needed and the build stays portable.
    await client.query(sql);
    log(`  ok  ${label}`);
  } catch (err) {
    console.error(`  FAIL ${label}`);
    throw err;
  } finally {
    await client.end();
  }
}

export async function buildTestDb({ quiet = false } = {}) {
  const say = (m: string) => { if (!quiet) console.log(m); };
  if (!admin.user || !admin.password) {
    throw new Error('MAINT_PGUSER / MAINT_PGPASSWORD must be set (see server/.env.example)');
  }
  // Guard against ever pointing this at the real database.
  if (TEST_DB === process.env.PGDATABASE || TEST_DB === process.env.MAINT_PGDATABASE) {
    throw new Error(`refusing to rebuild "${TEST_DB}": that is the development database`);
  }

  log = say;
  say(`Building ${TEST_DB} ...`);

  const root = new pg.Client({ ...admin, database: 'postgres' });
  await root.connect();
  try {
    // FORCE terminates any lingering connections (a watch-mode test run, an open psql).
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${TEST_DB}`);
    say(`  ok  dropped + created ${TEST_DB}`);
  } finally {
    await root.end();
  }

  // Order matters and is the one documented in db/README.md: migrations run AFTER seed.
  // 001 initialises the order-number sequence past the seeded orders, and 002 carries the
  // seed's enum values over into the lookup tables. Loading the seed later would break both.
  await run(TEST_DB, 'schema.sql', await readFile(path.join(DB_DIR, 'schema.sql'), 'utf8'));
  await run(TEST_DB, 'seed.sql', await readFile(path.join(DB_DIR, 'seed.sql'), 'utf8'));

  const migrationsDir = path.join(DB_DIR, 'migrations');
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await run(TEST_DB, `migrations/${file}`, await readFile(path.join(migrationsDir, file), 'utf8'));
  }

  // Last, so it slides the fully-migrated data.
  await run(TEST_DB, 'seed.test-shift.sql', await readFile(path.join(DB_DIR, 'seed.test-shift.sql'), 'utf8'));

  const client = new pg.Client({ ...admin, database: TEST_DB });
  await client.connect();

  // db/seed.sql now carries REAL bcrypt digests of the demo credentials, so the fixture is
  // logged into straight out of the seed. This VERIFIES rather than overwrites: overwriting
  // would mean the passwords lived in two places and could drift apart silently. If the
  // seed's hashes ever stop matching, the build fails here with a clear reason instead of
  // 50 API tests failing with an unexplained 401.
  for (const [role, password] of [['admin', TEST_PASSWORDS.admin], ['caller', TEST_PASSWORDS.caller]] as const) {
    const { rows: users } = await client.query(
      'SELECT email, password_hash FROM users WHERE role = $1 LIMIT 1',
      [role],
    );
    const user = users[0];
    if (!user) throw new Error(`no seeded ${role} user found`);
    if (!(await bcrypt.compare(password, user.password_hash))) {
      throw new Error(
        `db/seed.sql password hash for ${role} (${user.email}) is not a bcrypt digest of ` +
          `"${password}". Regenerate it, or the API suite cannot log in.`,
      );
    }
  }
  say('  ok  seed credentials verified');
  const { rows } = await client.query(`SELECT
      (SELECT count(*) FROM leads      WHERE deleted_at IS NULL) AS leads,
      (SELECT count(*) FROM users      WHERE deleted_at IS NULL) AS users,
      (SELECT count(*) FROM orders     WHERE deleted_at IS NULL) AS orders,
      (SELECT count(*) FROM renewals   WHERE deleted_at IS NULL) AS renewals,
      (SELECT count(*) FROM products   WHERE deleted_at IS NULL) AS products,
      (SELECT count(*) FROM follow_ups WHERE deleted_at IS NULL) AS follow_ups,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity)          AS rls_tables`);
  await client.end();

  const b = rows[0];
  say(
    `fixture: leads=${b.leads} users=${b.users} orders=${b.orders} renewals=${b.renewals} ` +
      `products=${b.products} follow_ups=${b.follow_ups}`,
  );
  // Migration 017 must have applied: a test DB with RLS still on would behave differently
  // from production and mask exactly the bugs this suite exists to catch.
  if (Number(b.rls_tables) !== 0) {
    throw new Error(`expected RLS disabled on all tables, found ${b.rls_tables} still enabled`);
  }
  say('rls: disabled on all tables (migration 017 applied)');
  return b;
}

// Only self-executes when run directly (npm run test:db); importing it does nothing.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  buildTestDb().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
