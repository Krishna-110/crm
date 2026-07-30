import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Pinned before anything else loads. Almost every date-derived value in this app is IST:
// renewal status, follow-up buckets, and the dashboard's period boundaries all go through
// Asia/Kolkata. A runner in UTC silently changes those answers, so a suite that passes
// locally would fail in CI (or worse, pass in CI for the wrong reason).
process.env.TZ = 'Asia/Kolkata';

// Point Prisma at the test database by rewriting the database name in the real
// DATABASE_URL, rather than keeping a second connection string in sync by hand.
//
// This must be injected via `env` below, not just set here: src/prisma.ts reads
// DATABASE_URL at import time. dotenv does not overwrite variables that are already set,
// so a value present before `import 'dotenv/config'` runs wins over server/.env.
const TEST_DB = process.env.TEST_PGDATABASE ?? 'medcrm_test';

function testDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL must be set (see server/.env.example)');
  const url = new URL(raw);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
    env: {
      TZ: 'Asia/Kolkata',
      DATABASE_URL: testDatabaseUrl(),
      TEST_PGDATABASE: TEST_DB,
    },
    // Integration suites share the single `medcrm_test` database, so files must not run
    // concurrently even though they are written to avoid mutating the fixture.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
