import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 5 — end-to-end, in a real browser.
 *
 * ISOLATION IS THE WHOLE DESIGN HERE. These tests drive the actual React app, which calls
 * the actual API, which writes to an actual database. Pointed at the development database
 * they would corrupt real work — the thing Phases 0-4 went to some trouble to prevent.
 *
 * So this starts its OWN pair of servers rather than reusing whatever is running:
 *
 *   API   :3002  ->  medcrm_test   (DATABASE_URL overridden below)
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
 * dotenv does not overwrite variables that are already set, so a DATABASE_URL passed to the
 * child process here wins over the one in server/.env. That is what redirects the API to the
 * test database.
 */
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://app_prisma:prismatest123@localhost:5432/medcrm_test?schema=public';

export default defineConfig({
  testDir: './e2e',
  // Rebuilds medcrm_test before anything runs, so the fixture is identical every time
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
