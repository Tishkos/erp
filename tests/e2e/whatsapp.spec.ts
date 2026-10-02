import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-WA-001 §6 — the WhatsApp screen is in the administration tabs, its
 * windows draw, it reads at mobile RTL, a contact is added from it, and the
 * D-WA-3 rule (questions only for a CEO) is refused on the screen with the
 * existing Flash, not a page of its own.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('REQ-WA-001 · the WhatsApp screen', () => {
  test('opens from the administration tabs with its five windows, in both languages', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADMIN);
    await page.goto('/administration/whatsapp');
    await expect(page.getByRole('heading', { name: 'WhatsApp', level: 1 })).toBeVisible();
    for (const window of ['Bridge', 'Contacts', 'Notifications that reach a phone', 'Settings', 'Messages']) {
      await expect(page.getByRole('heading', { name: window, level: 2 })).toBeVisible();
    }
    // The seeded settings are rows on the screen.
    await expect(page.getByText('Rows shown as text before a file is attached')).toBeVisible();
    await expect(page.getByText('ceo_payable_hold_escalated')).toBeVisible();

    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/administration/whatsapp');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, 'no horizontal scroll at 390px').toBeLessThanOrEqual(390);
    await expect(page.getByRole('heading', { name: 'واتساب', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'جهات الاتصال', level: 2 })).toBeVisible();
  });

  test('a contact is added from the screen; questions for a non-CEO are refused with the Flash', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADMIN);
    await page.goto('/administration/whatsapp');
    const form = page.locator('form:has(input[name="e164"])');
    // The officer does not hold the CEO role: Questions is refused.
    const officer = (await form.locator('select[name="user_id"] option', { hasText: 'officer@example.com' }).first().getAttribute('value'))!;
    await form.locator('select[name="user_id"]').selectOption(officer);
    await form.locator('input[name="e164"]').fill(`07801${String(Date.now()).slice(-6)}`);
    await form.locator('input[name="allow_queries"]').check();
    await form.locator('button[type="submit"]').click();
    await page.waitForURL(/error=/);
    await expect(page.getByText(/only a user holding the ceo role/)).toBeVisible();

    // Without Questions it is saved and listed.
    await page.goto('/administration/whatsapp');
    const again = page.locator('form:has(input[name="e164"])');
    await again.locator('select[name="user_id"]').selectOption(officer);
    const number = `07803${String(Date.now()).slice(-6)}`;
    await again.locator('input[name="e164"]').fill(number);
    await again.locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText(`+964${number.slice(1)}`)).toBeVisible();
  });
});
