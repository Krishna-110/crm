import { beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db/prisma.js';

/**
 * Refuses to run anywhere but the test database.
 *
 * One character separates `crm` from `crm_test`, and the suite writes freely. Checked twice:
 * the URL must name a *_test database, and the server must agree about what it connected to
 * — the URL can be right while a stale environment variable or a pooler sends the connection
 * elsewhere.
 */
const EXPECTED = process.env.TEST_PGDATABASE ?? 'crm_test';

beforeAll(async () => {
  const named = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  if (named !== EXPECTED || !/_test$/.test(named)) {
    throw new Error(`refusing to run: DATABASE_URL points at "${named}", expected "${EXPECTED}"`);
  }
  const rows = await prisma.$queryRaw<{ db: string }[]>`SELECT current_database() AS db`;
  if (rows[0]?.db !== EXPECTED) {
    throw new Error(`refusing to run: connected to "${rows[0]?.db}", expected "${EXPECTED}"`);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});
