import dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// The server's configuration lives in server/.env. Plain `dotenv/config` reads ./.env relative
// to the working directory, which here is the workspace root — a file that does not exist — so
// it loaded nothing at all and DATABASE_URL stayed undefined. Real environment variables still
// win over both files, which is what lets CI supply its own.
dotenv.config({ path: ['.env', 'server/.env'], quiet: true });

/**
 * Phase 5 — end-to-end, in a real browser.
 *
 * ISOLATION IS THE WHOLE DESIGN HERE. These tests drive the actual React app, which calls
 * the actual API, which writes to an actual database. Pointed at the development database
 * they would corrupt real work — the thing Phases 0-4 went to some trouble to prevent.
 *
 * So this starts its OWN pair of servers rather than reusing whatever is running:
 *
 *   API   :3002  ->  crm_test   (DATABASE_URL overridden below)
 *   Vite  :5174  ->  proxies /api to :3002 (API_PROXY_TARGET)
 *
 * Both differ from the development ports (3001 / 5173), so a dev session can stay running
 * untouched while the suite executes. reuseExistingServer is OFF deliberately: reusing a
 * server would silently reconnect these tests to the development database.
 */
const API_PORT = 3002;
const WEB_PORT = 5174;
const BASE_URL = `http://localhost:${WEB_PORT}`;

/**
 * Where the API is pointed. dotenv does not overwrite variables that are already set, so a
 * DATABASE_URL passed to the child process below wins over the one in server/.env — that is
 * what redirects the API away from the development database.
 *
 * Derived from DATABASE_URL by swapping in the test database name, the same derivation
 * build-test-db.ts and vitest.config.ts already perform, so all three agree by construction.
 *
 * This used to be a hardcoded fallback carrying one machine's credentials. It made the suite
 * pass here and fail anywhere else, and the failure was mute: the API could not connect, so
 * /api/health never answered and the run died on a readiness timeout naming no cause.
 */
const TEST_DB = process.env.TEST_PGDATABASE ?? 'crm_test';

const TEST_DATABASE_URL = (() => {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      'DATABASE_URL is not set, so the test database URL cannot be derived. Set it in ' +
        'server/.env, or pass E2E_DATABASE_URL to override. Refusing to guess: a wrong guess ' +
        'here points a destructive rebuild at the wrong database.',
    );
  }
  const url = new URL(raw);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
})();

export default defineConfig({
  testDir: './e2e',
  // Rebuilds crm_test before anything runs, so the fixture is identical every time
  // regardless of what a previous run (or the vitest suite) left behind.
  globalSetup: './e2e/globalSetup.ts',
  // The suites share one database and one server pair, so they must not overlap.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // Almost every date-derived figure in this app is IST. A UTC browser would shift what
    // "today" means on the dashboard, exactly as it would on the server.
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npx tsx src/index.ts',
      cwd: 'server',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: TEST_DATABASE_URL,
        TZ: 'Asia/Kolkata',
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      // Must run from client/: that is where vite.config.ts and index.html live. Started
      // from the workspace root Vite finds no config, serves the wrong directory, and the
      // readiness check below times out with both servers apparently "up".
      cwd: 'client',
      url: BASE_URL,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
      env: {
        API_PROXY_TARGET: `http://localhost:${API_PORT}`,
        TZ: 'Asia/Kolkata',
      },
    },
  ],
});
