import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { keepEnglish } from './support/locale';

/**
 * The two record pages Inventory did not have — a Transfer and an Item
 * Reconciliation — in the browser, against the seeded development database
 * (`npm run db:seed`: ITM-SEED, 250 in WH-HQ, batch B-SEED).
 *
 *   * the list's number opens the record; the record wears the four doors in
 *     their order (printer, paperclip, notes, clock) and prints;
 *   * the header carries the item, both warehouses and the branch as links to
 *     their own pages; the status chip says the ledger holds what it moved;
 *   * the lines are the FIFO layers the document carried; stacked under them
 *     the Stock Ledger's position before and after, in the warehouse(s) it
 *     touched; a reconciliation also shows the journal it posted;
 *   * the printed copy (PDF) comes.
 *
 * Each page is photographed beside the model it copies — a planned Stock
 * Count's record — desktop in English and a phone in Arabic, into
 * `SHOTS_DIR` (default /home/claude/shots/inventory-finish).
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/inventory-finish';

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(MANAGER.email);
  await page.getByLabel('Password', { exact: true }).fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/** Desktop in English, then a phone in Arabic (no horizontal scroll), then back. */
async function photograph(page: Page, route: string, name: string) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(route);
  await page.screenshot({ path: `${SHOTS}/${name}-desktop-en.png`, fullPage: true });
  await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(route);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/${name}-mobile-ar.png`, fullPage: true });
  await keepEnglish(page.context());
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(route);
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
}

/** The printer door offers the record's own copies, and the PDF comes. */
async function expectPrints(page: Page, exportKey: string, id: string) {
  await page.getByRole('button', { name: 'Print / Export' }).click();
  const copies = page.locator(`[data-export-menu="${exportKey}"]`);
  await expect(copies.locator('a[data-format="pdf"][data-lang="en"]')).toHaveAttribute('href', `/export/${exportKey}/${encodeURIComponent(id)}?format=pdf&lang=en`);
  const pdf = await page.request.get(`/export/${exportKey}/${encodeURIComponent(id)}?format=pdf&lang=en`);
  expect(pdf.status(), `${exportKey} ${id} prints`).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  await page.keyboard.press('Escape');
}

const doors = (page: Page) => page.locator('[class*="sapTitleActions"]').first().locator(':scope > button, :scope > a');
const numberOf = (page: Page) => decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);

test.describe('Inventory finish · the Transfer and Item Reconciliation records', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
  });

  test('the model: a planned Stock Count, photographed to stand beside the two new pages', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/inventory/stock-count');
    await page.getByRole('button', { name: 'Plan a count' }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan a count' });
    await dialog.getByLabel('Warehouse', { exact: true }).selectOption('WH-HQ');
    await dialog.getByLabel('Scope', { exact: true }).selectOption('item');
    await dialog.getByLabel('Item code or category').fill('ITM-SEED');
    await dialog.getByRole('button', { name: 'Plan', exact: true }).click();
    await page.waitForURL(/\/inventory\/stock-count\/CNT-/);
    await photograph(page, `/inventory/stock-count/${encodeURIComponent(numberOf(page))}`, 'model-stock-count-record');
  });

  test('Transfer: created on its form, its number opens the record — four doors, layers, both warehouses before and after, and it prints', async ({ page }) => {
    test.setTimeout(240_000);
    // The seed has one main warehouse; a transfer needs a second, which the system names.
    await page.goto('/master-data/warehouses');
    await page.getByRole('button', { name: 'New warehouse' }).click();
    const depotName = `Inventory Finish Depot ${Date.now().toString().slice(-6)}`;
    await page.locator('dialog[open], [role="dialog"]').first().getByLabel(/Warehouse Name/).fill(depotName);
    await page.locator('dialog[open], [role="dialog"]').first().getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/warehouses(\?|$)/, { timeout: 60_000 });
    const depotRow = page.getByRole('row').filter({ hasText: depotName });
    await expect(depotRow).toBeVisible({ timeout: 30_000 });
    const depot = (await depotRow.getByRole('link').first().innerText()).trim();
    expect(depot).toMatch(/^WH-\d{4}$/);

    await page.goto('/inventory/transfers');
    await page.getByRole('button', { name: 'New transfer' }).click();
    const dialog = page.getByRole('dialog', { name: 'New transfer' });
    await dialog.getByLabel('Item Name').fill('Seed Cable 2m');
    await dialog.getByLabel('From Warehouse').selectOption('WH-HQ');
    await dialog.getByLabel('To Warehouse').selectOption(depot);
    await dialog.getByLabel('Quantity').fill('3');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    // The list's number opens the record.
    const link = page.locator('a[href^="/inventory/transfers/"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/inventory\/transfers\/.+/);
    const transferNo = numberOf(page);
    await expect(page.getByRole('heading', { name: transferNo, level: 1 })).toBeVisible();

    // Printer, paperclip, notes, clock — in that order, and nothing else.
    await expect(doors(page)).toHaveCount(4);
    await expect(doors(page).nth(0)).toHaveAccessibleName('Print / Export');
    await expect(doors(page).nth(1)).toHaveAccessibleName(/Attachments/);
    await expect(doors(page).nth(2)).toHaveAccessibleName(/Notes/);
    await expect(doors(page).nth(3)).toHaveAccessibleName('Audit log');

    // The status chip: the ledger holds what the document says it moved.
    await expect(page.locator('[data-status="posted"]').first()).toContainText('Recorded');
    // The item, both warehouses and the branch are links to their own pages.
    for (const href of ['/inventory/items/ITM-SEED', '/master-data/warehouses/WH-HQ', `/master-data/warehouses/${depot}`, '/master-data/branches/HQ']) {
      await expect(page.locator(`a[href="${href}"]`).first(), href).toBeVisible();
    }

    // The layers it carried: the seed's batch, 3 units.
    const layers = page.locator('table[aria-labelledby="transfer-lines-heading"] tbody tr');
    await expect(layers.first()).toContainText('B-SEED');
    await expect(layers.first()).toContainText('3');
    // Both warehouses, before and after, as the Stock Ledger carries them: the depot gains the 3.
    const positions = page.locator('table[aria-labelledby="transfer-positions-title"] tbody tr');
    await expect(positions).toHaveCount(2);
    await expect(positions.filter({ hasText: 'WH-HQ' })).toContainText('-3');
    await expect(positions.filter({ hasText: depot })).toContainText('+3');

    await expectPrints(page, 'transfer', transferNo);
    await photograph(page, `/inventory/transfers/${encodeURIComponent(transferNo)}`, 'transfer-record');
  });

  test('Item Reconciliation: created on its form, its number opens the record — four doors, the layers, the position, the journal, and it prints', async ({ page }) => {
    test.setTimeout(240_000);
    // The dev seed leaves ITM-SEED's accounts to the mappings; a reconciliation
    // posts to the item's own inventory account, so it is named on the item's page first.
    await page.goto('/inventory/items/ITM-SEED');
    const accounts = page.locator('form').filter({ has: page.locator('select[name="inventoryAccountId"]') });
    if (!(await accounts.locator('select[name="inventoryAccountId"]').inputValue())) {
      await accounts.locator('select[name="inventoryAccountId"]').selectOption({ label: 'A100010 · Inventory' });
      await accounts.locator('select[name="cogsAccountId"]').selectOption({ index: 1 });
      await accounts.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('select[name="inventoryAccountId"]')).toHaveValue(/.+/);
    }

    await page.goto('/inventory/stock-reconciliation');
    await page.getByRole('button', { name: 'New reconciliation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New reconciliation' });
    await dialog.getByLabel('Item Code').fill('ITM-SEED');
    await dialog.getByLabel('Warehouse', { exact: true }).selectOption('WH-HQ');
    await dialog.getByLabel('In/Out').selectOption('out');
    await dialog.getByLabel('Adjustment Quantity').fill('1');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    const link = page.locator('a[href^="/inventory/stock-reconciliation/"]').first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/inventory\/stock-reconciliation\/.+/);
    const adjustmentNo = numberOf(page);
    await expect(page.getByRole('heading', { name: adjustmentNo, level: 1 })).toBeVisible();

    await expect(doors(page)).toHaveCount(4);
    await expect(doors(page).nth(0)).toHaveAccessibleName('Print / Export');
    await expect(doors(page).nth(1)).toHaveAccessibleName(/Attachments/);
    await expect(doors(page).nth(2)).toHaveAccessibleName(/Notes/);
    await expect(doors(page).nth(3)).toHaveAccessibleName('Audit log');

    await expect(page.locator('[data-status]').first()).toBeVisible();
    for (const href of ['/inventory/items/ITM-SEED', '/master-data/warehouses/WH-HQ', '/master-data/branches/HQ']) {
      await expect(page.locator(`a[href="${href}"]`).first(), href).toBeVisible();
    }
    // The layer it took out, and the one position it moved: one fewer than before.
    await expect(page.locator('table[aria-labelledby="reconciliation-lines-heading"] tbody tr').first()).toContainText('B-SEED');
    const position = page.locator('table[aria-labelledby="reconciliation-positions-title"] tbody tr');
    await expect(position).toHaveCount(1);
    await expect(position).toContainText('-1');

    await expectPrints(page, 'item_reconciliation', adjustmentNo);
    await photograph(page, `/inventory/stock-reconciliation/${encodeURIComponent(adjustmentNo)}`, 'reconciliation-record');
  });
});
