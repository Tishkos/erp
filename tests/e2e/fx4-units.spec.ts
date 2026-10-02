import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-FIX-001 FX10 in a browser — an item gets a box of 24 on its record,
 * and a new purchase invoice offers it on the line, the price following the
 * unit. Requires `npm run db:seed`.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(MANAGER.email);
  await page.locator('input[name="password"]').fill(MANAGER.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test('FX10 · a box of 24 on the item, offered on a purchase invoice line', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto('/inventory/items/ITM-SEED');
  const units = page
    .locator('section, div')
    .filter({ has: page.getByRole('heading', { name: /^Units/ }) })
    .last();
  if ((await page.getByRole('cell', { name: /^BOX · Box/ }).count()) === 0) {
    await page.getByLabel('Add unit').selectOption('BOX');
    await page.getByRole('textbox', { name: 'One unit holds' }).fill('24');
    await page.getByRole('button', { name: 'Add unit' }).click();
    await expect(page.getByRole('status')).toBeVisible();
  }
  await expect(page.getByText('1 BOX = 24 EA')).toBeVisible();
  void units;

  await page.goto('/payables/invoices/new');
  const code = page
    .getByRole('combobox', { name: 'Item Code' })
    .or(page.getByRole('textbox', { name: 'Item Code' }))
    .first();
  await code.fill('ITM-SEED');
  const unit = page.getByRole('combobox', { name: 'Unit' }).first();
  await expect(unit.locator('option', { hasText: 'BOX (24 EA)' })).toHaveCount(1);
  await unit.selectOption('BOX');
  await expect(unit).toHaveValue('BOX');
});
