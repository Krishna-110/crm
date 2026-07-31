import { test, expect } from '@playwright/test';
import { login, ADMIN, CALLER, FIXTURE } from './helpers';

/**
 * The authorization boundary, as a user actually experiences it.
 *
 * The API suite already proves the server refuses out-of-scope data. This proves the app
 * renders that correctly — that a caller is not merely blocked from other callers' records
 * but never shown them, and that admin-only navigation is not present to be clicked.
 *
 * This is the checking that was being done by hand, repeatedly, throughout development.
 */

/**
 * Each page prints its own total, e.g. "15 total leads". Asserting that phrase rather than
 * the bare number matters: a page showing 15 leads still contains the character "4"
 * elsewhere (the "New 4" status pill), so `toContainText('4')` passed even with caller
 * scoping removed entirely. Caught by mutation-testing this suite — the assertions were
 * nearly vacuous before.
 */
const PAGES = [
  { path: '/leads', heading: /Lead Management/i, total: (n: number) => `${n} total leads`,
    admin: FIXTURE.admin.leads, caller: FIXTURE.caller.leads },
  { path: '/orders', heading: /Orders/i, total: (n: number) => `${n} total orders`,
    admin: FIXTURE.admin.orders, caller: FIXTURE.caller.orders },
  { path: '/renewals', heading: /Renewals/i, total: (n: number) => `${n} total renewals`,
    admin: FIXTURE.admin.renewals, caller: FIXTURE.caller.renewals },
  { path: '/users', heading: /User Management/i, total: (n: number) => `${n} team members`,
    admin: FIXTURE.admin.users, caller: FIXTURE.caller.users },
] as const;

test.describe('scoping — admin', () => {
  for (const p of PAGES) {
    test(`${p.path} shows all ${p.admin} records`, async ({ page }) => {
      await login(page, ADMIN);
      await page.goto(p.path);
      await expect(page.getByRole('heading', { name: p.heading })).toBeVisible();
      await expect(page.locator('main')).toContainText(p.total(p.admin));
    });
  }

  test('/stock is a shared catalogue', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/stock');
    await expect(page.locator('main')).toContainText(`${FIXTURE.admin.stock} items`);
  });
});

test.describe('scoping — caller', () => {
  for (const p of PAGES) {
    test(`${p.path} is narrowed to ${p.caller}`, async ({ page }) => {
      await login(page, CALLER);
      await page.goto(p.path);
      await expect(page.locator('main')).toContainText(p.total(p.caller));
      // And explicitly NOT the admin's total, so a scoping failure cannot slip through on a
      // page that happens to contain the caller's number somewhere else.
      await expect(page.locator('main')).not.toContainText(p.total(p.admin));
    });
  }

  test('/stock is NOT narrowed — products are global', async ({ page }) => {
    await login(page, CALLER);
    await page.goto('/stock');
    // Same count as the admin sees: proves the caller narrowing is scoped to the right
    // models rather than applied indiscriminately.
    await expect(page.locator('main')).toContainText(`${FIXTURE.caller.stock} items`);
  });

  test('every lead listed belongs to the signed-in caller', async ({ page }) => {
    await login(page, CALLER);
    await page.goto('/leads');
    await expect(page.getByRole('heading', { name: /Lead Management/i })).toBeVisible();

    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(CALLER.name);
    }
  });

  test('/users shows only the caller themselves', async ({ page }) => {
    await login(page, CALLER);
    await page.goto('/users');
    await expect(page.locator('main')).toContainText(CALLER.name);
    await expect(page.locator('main')).not.toContainText(ADMIN.name);
  });

  test('admin-only navigation is absent, not merely disabled', async ({ page }) => {
    await login(page, CALLER);
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: /users/i })).toHaveCount(0);
  });
});
