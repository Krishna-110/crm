import { test, expect } from '@playwright/test';
import { login, statValue, breakdownCounts, cleanupE2ELeads, ADMIN, CALLER, FIXTURE } from './helpers';

test.describe('dashboard', () => {
  test.afterAll(async ({}, testInfo) => {
    await cleanupE2ELeads(testInfo.project.use.baseURL!);
  });

  test('admin sees whole-pipeline figures', async ({ page }) => {
    await login(page, ADMIN);
    expect(await statValue(page, 'Total Leads')).toBe(FIXTURE.admin.leads);
    expect(await statValue(page, 'Converted Orders')).toBe(FIXTURE.admin.orders);
  });

  test('caller sees only their own figures', async ({ page }) => {
    await login(page, CALLER);
    expect(await statValue(page, 'Total Leads')).toBe(FIXTURE.caller.leads);
    expect(await statValue(page, 'Converted Orders')).toBe(FIXTURE.caller.orders);
  });

  test('REGRESSION: the breakdown sums to the total immediately after a write', async ({ page }) => {
    // This is the defect fixed by moving leadStatusBreakdown off mv_lead_status_breakdown.
    // totalLeads was counted live while the breakdown came from a matview refreshed every
    // 5 minutes, so an admin could be shown a breakdown that did not add up to the total
    // printed beside it. Nothing errored; the numbers were simply inconsistent.
    //
    // The browser is the only place this was ever visible, which is why it is asserted here
    // as well as in the API suite.
    await login(page, ADMIN);

    const before = await statValue(page, 'Total Leads');
    const sumBefore = (await breakdownCounts(page)).reduce((a, b) => a + b, 0);
    expect(sumBefore).toBe(before);

    // Create a lead via the API, using the session the browser already holds. The subject of
    // this test is dashboard CONSISTENCY, not the lead form — driving the whole form here
    // would couple it to unrelated markup. The form itself is covered in leads.spec.ts.
    const token = await page.evaluate(() => localStorage.getItem('medcrm_token'));
    const created = await page.request.post('/api/leads', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        customerName: `E2E Consistency ${Date.now()}`,
        mobile: '9000000101',
        address: '1 Test Street',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
        disease: 'Hypertension',
        medicines: [{ name: 'Atorva', days: 30 }],
      },
    });
    expect(created.status()).toBe(201);

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    const after = await statValue(page, 'Total Leads');
    const sumAfter = (await breakdownCounts(page)).reduce((a, b) => a + b, 0);

    expect(after).toBe(before + 1);
    expect(sumAfter, 'breakdown must track the live total with no refresh').toBe(after);
  });

  test('sales-by-caller is admin-only', async ({ page }) => {
    await login(page, ADMIN);
    await expect(page.locator('main')).toContainText('Sales by Caller');
    await expect(page.locator('main')).not.toContainText('Visible to admins only');
  });

  test('a caller sees the admin-only placeholder instead of the chart', async ({ page }) => {
    await login(page, CALLER);
    await expect(page.locator('main')).toContainText('Visible to admins only');
  });
});
