import { expect, type Page } from '@playwright/test';

export const ADMIN = { email: 'aarav.sharma@medicrm.in', password: 'admin123', name: 'Aarav Sharma' };
export const CALLER = { email: 'sneha.iyer@medicrm.in', password: 'caller123', name: 'Sneha Iyer' };
/** Seeded deliberately inactive, for the negative-login case. */
export const INACTIVE = { email: 'kavya.reddy@medicrm.in', password: 'caller123' };

/**
 * Counts in the `crm_test` fixture, rebuilt by e2e/globalSetup.ts before every run.
 *
 * Read straight from the database rather than guessed. Where admin and caller are equal the
 * assertion is weak by nature — orders and stock below — so scoping.spec.ts asserts the
 * caller does NOT see the admin's total as well, which keeps it meaningful.
 */
export const FIXTURE = {
  admin: { leads: 9, users: 7, orders: 2, renewals: 2, stock: 25 },
  caller: { leads: 3, users: 1, orders: 1, renewals: 1, stock: 25 },
} as const;

/**
 * Logs in through the real form — typing, not a seeded token.
 *
 * Uses Playwright's fill(), which dispatches the events React's controlled inputs listen
 * for. (Setting .value directly does not, which is why the in-app browser pane could not
 * drive this form earlier in development.)
 */
export async function login(page: Page, user: { email: string; password: string }) {
  await page.goto('/');
  await page.getByPlaceholder('you@company.com').fill(user.email);
  await page.getByPlaceholder('••••••••').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // The dashboard heading is the signal that auth succeeded and the app hydrated.
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** Reads a dashboard stat tile by its label, e.g. statValue(page, 'Total Leads'). */
export async function statValue(page: Page, label: string): Promise<number> {
  const text = await page.locator('main').innerText();
  // Tiles render the number above the label, with a percentage delta above that.
  const match = new RegExp(`(\\d[\\d,]*)\\s*\\n\\s*${label}`).exec(text);
  if (!match) throw new Error(`stat "${label}" not found in dashboard`);
  return Number(match[1]!.replace(/,/g, ''));
}

/**
 * Every count rendered in the lead-status breakdown, for summing against the total.
 *
 * Targets the DOM rather than parsing innerText: each row renders the count in a
 * `<span class="w-6 ...">`, so the values can be read exactly instead of inferred from
 * whitespace, which is brittle and silently returned nothing on the first attempt.
 */
export async function breakdownCounts(page: Page): Promise<number[]> {
  const card = page
    .getByRole('heading', { name: 'Lead Status Breakdown' })
    .locator('xpath=ancestor::*[contains(@class,"col-span")][1]');
  await card.waitFor();
  const values = await card.locator('span.w-6').allInnerTexts();
  return values.map((v) => Number(v.trim())).filter((n) => Number.isFinite(n));
}

/**
 * Fills a field in the lead form by its visible label.
 *
 * This used to walk the DOM (label -> following-sibling input) because nothing associated
 * the two: the labels were plain `<label class="field-label">` with no htmlFor, and the
 * inputs had no id. getByLabel() found nothing, which is the same reason a screen reader
 * announced nothing. The labels now carry htmlFor/id, so the standard accessible query
 * works — and using it here means these tests would fail if that association regressed.
 */
export function field(page: Page, label: string) {
  return page.getByLabel(label, { exact: true });
}

/**
 * Picks the first medicine row, which is `required` when creating a lead.
 *
 * Easy to miss when writing a test against this form — but NOT a UX gap: the browser blocks
 * submission and shows its native "Please fill out this field." bubble on the visible,
 * in-viewport medicine input. Verified by reading `validationMessage` and the element's
 * bounding box after a submit attempt.
 *
 * It looks silent from a test's perspective only because native validation bubbles are
 * rendered by browser chrome, not the DOM, so they never appear in innerText. The modal
 * staying open with no error text in the markup is expected, not a defect. The API enforces
 * the same rule ("at least one medicine is required").
 */
export async function selectMedicine(page: Page, name: string, days = 30) {
  // SearchableSelect now implements the ARIA combobox pattern, so this can be driven the
  // way assistive technology sees it. Previously the options were bare <button> elements
  // with no roles and getByRole('option') matched nothing — the test had to reach past the
  // accessibility tree into CSS classes. Querying by role keeps that regression covered.
  await page.getByRole('combobox').first().fill(name);
  await page.getByRole('option', { name: new RegExp(name, 'i') }).first().click();
  await page.getByPlaceholder('Days').first().fill(String(days));
}

/** Fills every required field of the new-lead form. */
export async function fillLeadForm(
  page: Page,
  values: { name: string; mobile: string; city?: string; state?: string; pincode?: string; disease?: string },
) {
  await field(page, 'Customer Name').fill(values.name);
  await field(page, 'Mobile Number').fill(values.mobile);
  await field(page, 'Address').fill('221B Test Street');
  await field(page, 'City').fill(values.city ?? 'Mumbai');
  await field(page, 'State').fill(values.state ?? 'Maharashtra');
  await field(page, 'Pincode').fill(values.pincode ?? '400001');
  await page.getByPlaceholder('e.g. Diabetes Type 2').fill(values.disease ?? 'Hypertension');
  await selectMedicine(page, 'Atorva');
}

/**
 * Soft-deletes every lead these tests created.
 *
 * The browser suite shares one database, and Playwright runs spec files in alphabetical
 * order — so leads created by dashboard.spec.ts and leads.spec.ts were still present when
 * scoping.spec.ts asserted the fixture's counts, and it failed. Rather than weaken those
 * assertions to ranges, the mutating specs clean up after themselves and the fixture counts
 * stay exact.
 *
 * Runs as an admin: a caller is deliberately forbidden from deleting even their own lead.
 */
export async function cleanupE2ELeads(baseURL: string) {
  const { request } = await import('@playwright/test');
  const ctx = await request.newContext({ baseURL });
  try {
    const res = await ctx.post('/api/auth/login', { data: { email: ADMIN.email, password: ADMIN.password } });
    const { token } = await res.json();
    const auth = { Authorization: `Bearer ${token}` };
    const leads = (await (await ctx.get('/api/leads', { headers: auth })).json()) as {
      id: string;
      customerName: string;
    }[];
    for (const lead of leads.filter((l) => /^E2E /.test(l.customerName))) {
      await ctx.delete(`/api/leads/${lead.id}`, { headers: auth });
    }
  } finally {
    await ctx.dispose();
  }
}
