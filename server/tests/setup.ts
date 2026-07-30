/**
 * Runs before every test file.
 *
 * Its whole job is to make it impossible for a suite to touch the development database.
 * Phase 2 onward issues real writes, and the difference between `medcrm` and `medcrm_test`
 * is one character in a connection string — an accident there would silently corrupt real
 * work rather than fail loudly.
 */
import { beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/prisma.js';

const EXPECTED = process.env.TEST_PGDATABASE ?? 'medcrm_test';

beforeAll(async () => {
  // Belt: the URL vitest.config.ts injected must name a test database.
  const url = process.env.DATABASE_URL ?? '';
  const named = new URL(url).pathname.replace(/^\//, '');
  if (named !== EXPECTED || !/_test$/.test(named)) {
    throw new Error(
      `refusing to run: DATABASE_URL points at "${named}", expected "${EXPECTED}". ` +
        'Tests must never run against the development database.',
    );
  }

  // Braces: ask the server what it actually connected to. The URL could be right while
  // something else (a stale env var, a pooler) redirects the connection.
  const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  const db = rows[0]?.db;
  if (db !== EXPECTED) {
    throw new Error(`refusing to run: connected to "${db}", expected "${EXPECTED}"`);
  }

  // Fail with an actionable message rather than a confusing empty-fixture failure.
  const users = await prisma.users.count();
  if (users === 0) {
    throw new Error(`"${db}" is empty — run: npm --prefix server run test:db`);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
