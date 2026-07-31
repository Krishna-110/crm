import { test, expect } from '@playwright/test';
import { login, field, fillLeadForm, cleanupE2ELeads, ADMIN, CALLER, FIXTURE } from './helpers';

/**
 * The create-lead flow, driven through the real form.
 *
 * This is the part only a browser can cover: required-field enforcement, the modal opening
 * and closing, and the list updating afterwards. The API suite proves the endpoint behaves;
 * this proves a person can actually reach it.
 */
test.describe('lead creation', () => {
  // Keeps the fixture counts exact for specs that run after this file.
  test.afterAll(async ({}, testInfo) => {
    await cleanupE2ELeads(testInfo.project.use.baseURL!);
  });

  test('an admin can create a lead and see it in the list', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/leads');
    await expect(page.locator('main')).toContainText(`${FIXTURE.admin.leads} total leads`);

    const name = `E2E Form Lead ${Date.now()}`;
    await page.getByRole('button', { name: 'Add Lead' }).click();

    await fillLeadForm(page, { name, mobile: '9000000102' });

    await page.getByRole('button', { name: /^(save|create|add lead)$/i }).last().click();

    // The list should show the new lead without a manual reload.
    await expect(page.locator('main')).toContainText(name);
    await expect(page.locator('main')).toContainText(`${FIXTURE.admin.leads + 1} total leads`);
  });

  test('the medicine picker is exposed correctly to assistive technology', async ({ page }) => {
    // Guards the ARIA combobox work. Every control must carry a real name, and repeated rows
    // must be distinguishable: before this, both rows announced as `combobox "Search
    // medicines..."` — named only by placeholder, which is the last-resort source in the
    // accessible-name algorithm and identical for every row.
    await login(page, ADMIN);
    await page.goto('/leads');
    await page.getByRole('button', { name: 'Add Lead' }).click();
    await page.getByRole('button', { name: /add another medicine/i }).click();
    await page.getByRole('combobox').first().fill('Atorva');
    await page.getByRole('option').first().waitFor();

    await expect(page.locator('[role="group"]').first()).toMatchAriaSnapshot(`
      - group "Medicines Required":
        - combobox "Medicine 1" [expanded]
        - listbox:
          - option /Atorva/
        - spinbutton "Days supply for medicine 1"
        - button "Remove medicine"
        - combobox "Medicine 2"
        - spinbutton "Days supply for medicine 2"
        - button "Remove medicine"
    `);
  });

  test('the form refuses to submit without the required fields', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/leads');
    await page.getByRole('button', { name: 'Add Lead' }).click();

    // Submitting empty must not create anything — the count stays put and the modal stays
    // open. `required` on the inputs means the browser blocks submission natively.
    await page.getByRole('button', { name: /^(save|create|add lead)$/i }).last().click();
    await expect(field(page, 'Customer Name')).toBeVisible();
  });

  test("a caller's new lead is assigned to themselves", async ({ page }) => {
    await login(page, CALLER);
    await page.goto('/leads');

    const name = `E2E Caller Lead ${Date.now()}`;
    await page.getByRole('button', { name: 'Add Lead' }).click();
    await fillLeadForm(page, { name, mobile: '9000000103', city: 'Pune', pincode: '411001', disease: 'Asthma' });
    await page.getByRole('button', { name: /^(save|create|add lead)$/i }).last().click();

    // A caller cannot assign elsewhere, so the row must show their own name.
    const row = page.locator('table tbody tr', { hasText: name });
    await expect(row).toContainText(CALLER.name);
  });
});
