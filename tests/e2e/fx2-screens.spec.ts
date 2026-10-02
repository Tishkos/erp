import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-FIX-001 FX5 — the password screen is a form in the centre, like
 * sign-in (the sponsor, 2026-10-02: "left, not centre"). Measured, at the
 * desktop and the phone width, in both directions.
 *
 * Requires `npm run db:seed`.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

for (const { width, locale } of [
  { width: 1366, locale: 'en' },
  { width: 390, locale: 'ar' },
]) {
  test(`FX5 · the password form is centred at ${width}px (${locale})`, async ({ page, context }) => {
    if (locale === 'ar') await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    await page.goto('/password');
    const form = page.locator('form').filter({ has: page.locator('input[name="newPassword"]') });
    await expect(form).toBeVisible();
    const box = (await form.boundingBox())!;
    const centre = box.x + box.width / 2;
    // Within 2% of the page's own centre — not pushed to one side.
    expect(Math.abs(centre - width / 2)).toBeLessThan(width * 0.02);
    // The three fields under their own names, and no application menu around them.
    for (const name of ['currentPassword', 'newPassword', 'confirm']) await expect(page.locator(`input[name="${name}"]`)).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scroll).toBeLessThanOrEqual(width);
  });
}
