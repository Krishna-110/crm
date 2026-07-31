import { test, expect } from '@playwright/test';
import { login, ADMIN, CALLER, INACTIVE } from './helpers';

test.describe('authentication', () => {
  test('an unauthenticated visitor is shown the login page, not the app', async ({ page }) => {
    await page.goto('/leads');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lead Management' })).toHaveCount(0);
  });

  test('an admin can sign in', async ({ page }) => {
    await login(page, ADMIN);
    await expect(page.locator('main')).toContainText('Total Leads');
  });

  test('a caller can sign in', async ({ page }) => {
    await login(page, CALLER);
    await expect(page.locator('main')).toContainText('Total Leads');
  });

  test('a wrong password is rejected and keeps the user on the login page', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('you@company.com').fill(ADMIN.email);
    await page.getByPlaceholder('••••••••').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
  });

  test('a deactivated account cannot sign in even with the right password', async ({ page }) => {
    // Kavya Reddy is seeded inactive precisely so this path is exercised.
    await page.goto('/');
    await page.getByPlaceholder('you@company.com').fill(INACTIVE.email);
    await page.getByPlaceholder('••••••••').fill(INACTIVE.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
  });

  test('a session survives a full page reload', async ({ page }) => {
    await login(page, ADMIN);
    await page.reload();
    // Regression guard: the token lives in localStorage, so a reload must not bounce to login.
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  });
});
