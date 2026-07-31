import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

/**
 * Builds `crm_test` from scratch: drop, create, migrate, seed.
 *
 * Isolation comes from a dedicated database rather than per-test rollback. Wrapping each
 * test in a transaction does not work here because services open their own interactive
 * transactions, and Prisma has no nested ones.
 *
 * Far simpler than the previous project's equivalent, which had to replay 22 hand-written
 * SQL files in a documented order and then slide every seed timestamp to keep date-derived
 * assertions honest. `prisma migrate deploy` handles the schema, and the seed is already
 * relative to now().
 */
const TEST_DB = process.env.TEST_PGDATABASE ?? 'crm_test';

export async function buildTestDb({ quiet = false } = {}) {
  const say = (m: string) => { if (!quiet) console.log(m); };

  const url = new URL(process.env.DATABASE_URL!);
  if (url.pathname.replace(/^\//, '') === TEST_DB) {
    throw new Error(`refusing to build: DATABASE_URL already points at ${TEST_DB}`);
  }
  const testUrl = new URL(url.toString());
  testUrl.pathname = `/${TEST_DB}`;

  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const root = new pg.Client({ connectionString: admin.toString() });
  await root.connect();
  try {
    // FORCE disconnects anything still attached — a watch-mode run, a stray psql.
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${TEST_DB}`);
    say(`  ok  dropped + created ${TEST_DB}`);
  } finally {
    await root.end();
  }

  const env = { ...process.env, DATABASE_URL: testUrl.toString() };
  const run = (args: string[]) =>
    execFileSync('npx', args, { env, stdio: quiet ? 'pipe' : 'inherit', shell: process.platform === 'win32' });

  run(['prisma', 'migrate', 'deploy']);
  say('  ok  migrations applied');
  execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
    env, stdio: quiet ? 'pipe' : 'inherit', shell: process.platform === 'win32',
  });
  say('  ok  seeded');

  const check = new pg.Client({ connectionString: testUrl.toString() });
  await check.connect();
  const { rows } = await check.query(`
    SELECT (SELECT count(*) FROM users)    AS users,
           (SELECT count(*) FROM leads)    AS leads,
           (SELECT count(*) FROM products) AS products,
           (SELECT count(*) FROM pg_proc p
              JOIN pg_language l ON l.oid = p.prolang
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE l.lanname = 'plpgsql' AND n.nspname = 'public') AS plpgsql`);
  await check.end();
  const b = rows[0];

  // The whole point of this rebuild is a database with no procedural code. If any appears,
  // something has reintroduced it and the suite's assumptions no longer hold.
  if (Number(b.plpgsql) !== 0) {
    throw new Error(`expected zero plpgsql functions, found ${b.plpgsql}`);
  }
  say(`  fixture: users=${b.users} leads=${b.leads} products=${b.products} plpgsql=0`);
  return b;
}

if (process.argv[1]?.includes('build-test-db')) {
  buildTestDb().catch((e) => { console.error(e); process.exit(1); });
}
