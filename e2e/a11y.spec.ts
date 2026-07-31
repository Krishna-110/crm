import { test, expect } from '@playwright/test';
import { login, ADMIN, CALLER } from './helpers';

/**
 * Accessibility audit, run against the live accessibility tree rather than the JSX.
 *
 * That distinction is the point. Two accessibility fixes in this app looked complete in the
 * source and were not: adding `role="combobox"` made the medicine picker announce as a
 * combobox while leaving it with no usable name, and every form label looked correct on
 * screen while being associated with nothing. Neither was visible by reading components —
 * only by asking the browser what it actually exposes.
 *
 * Two checks, both cheap enough to keep permanently:
 *   1. no interactive control is unnamed
 *   2. no control is named ONLY by its placeholder
 *
 * The second is the one that catches real regressions. A placeholder satisfies the
 * accessible-name algorithm, so an unlabelled field looks fine to check (1) — but placeholder
 * is the last-resort source, reads as an instruction rather than a name, and is frequently
 * identical across repeated rows. That is exactly how two medicine rows both ended up
 * announcing as `combobox "Search medicines..."`.
 */

const ROUTES = ['/', '/leads', '/orders', '/renewals', '/stock', '/users', '/calendar'] as const;

/**
 * Reports controls whose accessible name comes from a weak source, evaluated in the page.
 * Ordered by the accessible-name algorithm's own precedence.
 */
const WEAKLY_NAMED = `(() => {
  const sel = 'input:not([type=hidden]), select, textarea, [role=combobox], [role=listbox]';
  const source = (el) => {
    if (el.getAttribute('aria-label')) return 'aria-label';
    if (el.getAttribute('aria-labelledby')) return 'aria-labelledby';
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return 'label[for]';
    if (el.closest('label')) return 'wrapping-label';
    if (el.getAttribute('title')) return 'title';
    if (el.placeholder) return 'placeholder';
    return 'NONE';
  };
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;   // not rendered
    const s = source(el);
    if (s === 'placeholder' || s === 'NONE') {
      out.push(s + ' -> <' + el.tagName.toLowerCase() + (el.type ? ' type=' + el.type : '') + '> "' +
               (el.placeholder || el.name || '') + '"');
    }
  }
  return out;
})()`;

/** In an aria snapshot a named control is `- button "Save"`; an unnamed one has no quotes. */
const INTERACTIVE = 'button|link|textbox|combobox|checkbox|spinbutton|radio|switch|searchbox|menuitem|tab|option';
const UNNAMED = new RegExp(`^\\s*-\\s+(${INTERACTIVE})\\s*:?\\s*$`);

test.describe('accessibility — every control is properly named', () => {
  for (const route of ROUTES) {
    test(`${route} (admin)`, async ({ page }) => {
      await login(page, ADMIN);
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      // Wait for the data fetch to settle. Without this the snapshot can be taken before
      // table rows render, and the audit passes because there is nothing to audit — which is
      // exactly what happened on the first run of this probe (/users reported 0 unnamed
      // controls when it in fact had 18).
      await page.waitForLoadState('networkidle');

      const weak = (await page.evaluate(WEAKLY_NAMED)) as string[];
      expect(weak, `controls named only by placeholder on ${route}`).toEqual([]);

      const snapshot = await page.locator('body').ariaSnapshot();
      const unnamed = snapshot.split('\n').filter((l) => UNNAMED.test(l)).map((l) => l.trim());
      expect(unnamed, `unnamed interactive controls on ${route}`).toEqual([]);
    });
  }

  test('caller-visible pages are equally covered', async ({ page }) => {
    // A caller sees a different subset — fewer nav items, different tables — so the same
    // pages can render different controls.
    await login(page, CALLER);
    for (const route of ['/', '/leads', '/orders', '/renewals', '/stock'] as const) {
      await page.goto(route);
      await expect(page.locator('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const weak = (await page.evaluate(WEAKLY_NAMED)) as string[];
      expect(weak, `weakly named controls on ${route} as caller`).toEqual([]);
    }
  });
});

test.describe('accessibility — dynamic routes', () => {
  // /leads/:id is not in the static route list, and it had an unnamed back button — the kind
  // of gap a route-list audit misses entirely.
  test('lead detail page', async ({ page }) => {
    await login(page, ADMIN);
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    await page.locator('table tbody tr').first().click();
    await expect(page.getByRole('button', { name: 'Back to leads' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    const weak = (await page.evaluate(WEAKLY_NAMED)) as string[];
    expect(weak, 'weakly named controls on the lead detail page').toEqual([]);

    const snapshot = await page.locator('body').ariaSnapshot();
    const unnamed = snapshot.split('\n').filter((l) => UNNAMED.test(l)).map((l) => l.trim());
    expect(unnamed, 'unnamed interactive controls on the lead detail page').toEqual([]);
  });
});

test.describe('accessibility — modal forms', () => {
  // Modal fields are where the label association actually matters, and they are invisible to
  // a page-level audit because nothing renders until the modal opens.
  const MODALS = [
    { route: '/leads', open: /^add lead$/i, name: 'Add Lead' },
    { route: '/users', open: /add user/i, name: 'Add User' },
    { route: '/stock', open: /add medicine/i, name: 'Add Medicine' },
  ] as const;

  for (const modal of MODALS) {
    test(`${modal.name} form`, async ({ page }) => {
      await login(page, ADMIN);
      await page.goto(modal.route);
      await page.getByRole('button', { name: modal.open }).first().click();

      const weak = (await page.evaluate(WEAKLY_NAMED)) as string[];
      expect(weak, `weakly named fields in ${modal.name}`).toEqual([]);
    });
  }
});
