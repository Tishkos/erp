import { expect, test } from '@playwright/test';

/**
 * Phase 00.5 — end-to-end harness smoke test.
 *
 * Proves the layer runs. Real scenarios arrive from Phase 06 onward:
 * the twelve §26 critical UAT scenarios live in tests/e2e/scenarios/.
 */
test('the application serves a page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sign in');
});

test('the document declares a language and text direction', async ({ page }) => {
  // §25 requires the localisation architecture to allow Arabic and RTL later
  // "without redesign". These attributes are the switch point, so their absence
  // is a defect from day one, not a Phase 20 concern.
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', /.+/);
  await expect(html).toHaveAttribute('dir', /^(ltr|rtl)$/);
  await expect(html).toHaveAttribute('data-theme', 'light');
});
