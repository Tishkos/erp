import { expect, test, type Page } from '@playwright/test';
import { keepEnglish } from './support/locale';

/**
 * Manual Stock Addition in the browser (2026-10-06), against the seeded
 * development database (`npm run db:seed`: ITM-SEED, WH-HQ):
 *
 *   * the Warehouses Report carries Add items manually and Manually added
 *     items; filtered to WH-HQ, the first opens the sheet with WH-HQ chosen;
 *   * the officer fills the sheet (item, unit, quantity, unit price — the line
 *     value and the total follow), saves it as a draft and sends it;
 *   * the manager approves and posts it: the status, the FIFO layer and the
 *     journal show on the record, and the register lists it;
 *   * the record's four doors are there in their order and the printer prints.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';

async function signIn(page: Page, email: string) {
  await page.context().clearCookies();
  await keepEnglish(page.context());
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

const doors = (page: Page) => page.locator('[class*="sapTitleActions"]').first().locator(':scope > button, :scope > a');

test.describe('Manual Stock Addition', () => {
  test.describe.configure({ mode: 'serial' });
  let additionNo = '';

  test('the officer adds items from the Warehouses Report, saves a draft and sends it', async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page, 'officer@example.com');

    await page.goto('/inventory/fifo-valuation?warehouse=WH-HQ');
    await expect(page.getByRole('link', { name: 'Manually added items' })).toHaveAttribute('href', '/inventory/manual-additions');
    await page.getByRole('link', { name: 'Add items manually' }).click();
    await page.waitForURL(/\/inventory\/manual-additions\/new\?warehouse=WH-HQ/);
    await expect(page.getByLabel('Warehouse', { exact: true })).toHaveValue('WH-HQ');

    await page.getByLabel('Note / reason').fill('Found on the top shelf during the e2e walk-round');
    // The development books' inventory adjustment account asks for a department.
    await page.getByLabel('Department', { exact: true }).selectOption('FIN');
    await page.getByLabel('Item 1', { exact: true }).selectOption('ITM-SEED');
    await expect(page.getByLabel('Quantity 1', { exact: true })).toHaveValue('1');
    await page.getByLabel('Quantity 1', { exact: true }).fill('3');
    await page.getByLabel('Unit price (IQD) 1', { exact: true }).fill('1250.5');
    await expect(page.getByLabel('Line value 1', { exact: true })).toHaveText('3,751.5');
    // Choosing the item opened the next row.
    await expect(page.getByLabel('Item 2', { exact: true })).toBeAttached();
    await expect(page.locator('[data-total]')).toContainText('3,751.5 IQD');

    await page.getByRole('button', { name: 'Save as draft' }).click();
    await page.waitForURL(/\/inventory\/manual-additions\/MSA-/);
    additionNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();

    // Printer, paperclip, notes, clock — in that order, from the draft on.
    await expect(doors(page)).toHaveCount(4);
    await expect(doors(page).nth(0)).toHaveAccessibleName('Print / Export');
    const pdf = await page.request.get(`/export/manual_stock_addition/${encodeURIComponent(additionNo)}?format=pdf&lang=en`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');

    await page.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page.locator('[data-status="submitted"]').first()).toBeVisible();
    // The officer holds no approve.
    await expect(page.getByRole('button', { name: 'Approve and post' })).toHaveCount(0);
  });

  test('the manager approves and posts it; the record shows the layer and the journal; the register lists it', async ({ page }) => {
    test.setTimeout(240_000);
    expect(additionNo).toMatch(/^MSA-/);
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page, 'manager@example.com');
    await page.goto(`/inventory/manual-additions/${encodeURIComponent(additionNo)}`);
    await page.getByRole('button', { name: 'Approve and post' }).click();
    // The posting's first run compiles the engine on the dev server: wait for the answer, not five seconds.
    await page.waitForURL(/[?&](saved|error)=/, { timeout: 120_000 });
    expect(page.url()).toContain('saved=1');
    await expect(page.locator('[data-status="approved"]').first()).toBeVisible();

    const layers = page.getByRole('table', { name: /FIFO layers created/ });
    await expect(layers.getByRole('row')).toHaveCount(3);
    await expect(layers).toContainText('ITM-SEED');
    await expect(layers).toContainText('3,751.5');
    const entries = page.getByRole('table', { name: /Journal entries/ });
    await expect(entries).toContainText('3,751.5');

    await page.goto('/inventory/manual-additions');
    const row = page.getByRole('row').filter({ hasText: additionNo });
    await expect(row).toContainText('Approved');
    await expect(row).toContainText('WH-HQ');
  });
});
