import { test, type Page } from '@playwright/test';

/** Screenshots of the two documents, for looking at them side by side. */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(MANAGER.email);
  await page.getByLabel('Password', { exact: true }).fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test('shots', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await signIn(page);

  await page.goto('/finance/journals');
  await page.getByRole('link', { name: /JE-/ }).first().click();
  await page.waitForURL(/\/finance\/journals\/JE-/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/journal.png', fullPage: true });

  await page.goto('/purchasing/ap-invoices');
  await page
    .locator('a[href^="/purchasing/ap-invoices/"]:not([href$="/new"])')
    .first()
    .click();
  await page.waitForURL(/\/purchasing\/ap-invoices\/.+/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'shots/invoice.png', fullPage: true });
});
