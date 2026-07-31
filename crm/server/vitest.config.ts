import 'dotenv/config';
import { defineConfig } from 'vitest/config';

// Every date-derived figure in this app is IST. A UTC runner silently changes what "today"
// means, so a suite that passes locally fails in CI — or worse, passes for the wrong reason.
process.env.TZ = 'Asia/Kolkata';

const TEST_DB = process.env.TEST_PGDATABASE ?? 'crm_test';

/** Rewrites the real DATABASE_URL to the test database rather than keeping a second copy. */
function testDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL must be set (see .env.example)');
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
    // Injected rather than merely set here: src/db/prisma.ts reads DATABASE_URL at import
    // time, and dotenv does not overwrite a variable that is already present.
    env: { TZ: 'Asia/Kolkata', DATABASE_URL: testDatabaseUrl(), TEST_PGDATABASE: TEST_DB },
    // One shared database, so files must not overlap.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
