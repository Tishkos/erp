import { expect, test, type Page } from '@playwright/test';

/**
 * Moving between section tabs does not reload the page.
 *
 * The sponsor reports a "hard refresh" when clicking from Suppliers to A/P
 * Invoices. Whether that is a real document load or a slow server round trip
 * looks identical from the outside, and the fix is different for each — so this
 * measures it rather than describing it.
 *
 * A value is written onto `window`. A client-side transition keeps it; a
 * document load throws it away with the rest of the JavaScript context.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(MANAGER.email);
  await page.getByLabel('Password', { exact: true }).fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe('section tabs navigate without reloading', () => {
  test('keeps the JavaScript context when moving between tabs', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);

    await page.goto('/master-data/suppliers');
    await expect(page.getByRole('link', { name: 'A/P Invoices' })).toBeVisible({ timeout: 60_000 });

    await page.evaluate(() => {
      (window as unknown as { marker?: string }).marker = 'same-document';
    });

    await page.getByRole('link', { name: 'A/P Invoices' }).click();
    await page.waitForURL(/\/purchasing\/ap-invoices/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Purchase Invoices' }).first()).toBeVisible({
      timeout: 60_000,
    });

    const survived = await page.evaluate(
      () => (window as unknown as { marker?: string }).marker ?? null,
    );

    expect(survived).toBe('same-document');

    // How long the transition takes, and whether anything is shown meanwhile.
    // A second of blank screen reads as a reload even when the context proves
    // it was not one.
    await page.goto('/master-data/suppliers');
    await expect(page.getByRole('link', { name: 'A/P Invoices' })).toBeVisible({ timeout: 60_000 });

    const started = Date.now();
    await page.getByRole('link', { name: 'A/P Invoices' }).click();
    await expect(page.getByRole('heading', { name: 'Purchase Invoices' }).first()).toBeVisible({
      timeout: 60_000,
    });
    // eslint-disable-next-line no-console
    console.log(`TRANSITION_MS=${Date.now() - started}`);
  });
});
