import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * IMPROVEMENT-002 — the inventory screens, in the browser, against the seeded
 * development database (`npm run db:seed`: ITM-SEED, 250 in WH-HQ, batch
 * B-SEED, category CABLES).
 *
 *   * Stock Count: plan a count of the seeded item, record what was found,
 *     approve the variance, adjust the books; the record wears the four doors
 *     from the plan on and prints.
 *   * Stock Receipts and Stock Issues: the two registers over the ledger, the
 *     seeded opening stock as a receipt, the count's shortfall as an issue.
 *   * Availability: on order, unit cost and value, the category and branch
 *     filters, each row opening its ledger.
 *   * Inventory Valuation: today provisional, tomorrow refused, the G/L beside
 *     it, and it prints.
 *   * Warehouses Report: the summary per warehouse and the drill-down.
 *   * Inventory Checks: every check named with a state, and it prints.
 *   * Opening Stock: the record wears the four doors.
 *
 * Each new screen is photographed beside the model it copies, desktop in
 * English and a phone in Arabic, into /home/claude/shots/inventory.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const SHOTS = '/home/claude/shots/inventory';

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(MANAGER.email);
  await page.getByLabel('Password', { exact: true }).fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/** Desktop in English, then a phone in Arabic (no horizontal scroll). */
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
  await page.context().clearCookies({ name: 'erp-locale' });
  await page.setViewportSize({ width: 1366, height: 900 });
  // Back in English, on the same screen, for whatever the test does next.
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

/** What the seeded item holds after the count below: the book quantity less two, at 12.5 a unit. */
let onHand = 0;
const held = () => String(onHand);
const heldValue = () => (onHand * 12.5).toLocaleString('en-US', { minimumFractionDigits: 0 });

test.describe('IMPROVEMENT-002 · the inventory screens', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await signIn(page);
  });

  test('the models the screens copy are photographed too', async ({ page }) => {
    await photograph(page, '/payables/invoices', 'model-purchase-invoices-list');
  });

  test('the seeded item names its inventory and cost of sales accounts, on its profile (block 1)', async ({ page }) => {
    // The dev seed leaves ITM-SEED's accounts to the mappings; a count's
    // adjustment debits the item's own inventory account, so it is named
    // here the way a person would — on the item's page, which wears the
    // notes and clock doors.
    await page.goto('/inventory/items/ITM-SEED');
    await expect(page.getByRole('heading', { name: /ITM-SEED/, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Audit log' })).toBeVisible();
    const form = page.locator('form').filter({ has: page.locator('select[name="inventoryAccountId"]') });
    await form.locator('select[name="inventoryAccountId"]').selectOption({ label: 'A100010 · Inventory' });
    await form.locator('select[name="cogsAccountId"]').selectOption({ index: 1 });
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('select[name="inventoryAccountId"]')).toHaveValue(/.+/);
    await photograph(page, '/inventory/items/ITM-SEED', 'item-profile');
  });

  test('Stock Count: planned, counted, the variance approved, the books adjusted — four doors from the plan, and it prints', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/inventory/stock-count');
    await expect(page.getByRole('heading', { name: 'Stock Count', level: 1 })).toBeVisible();
    // The section's own tabs — the screen is one of Inventory's.
    await expect(page.getByRole('navigation', { name: 'Stock Count' }).getByRole('link', { name: 'Stock Receipts' })).toBeVisible();

    // Plan: the seeded item in the seeded warehouse.
    await page.getByRole('button', { name: 'Plan a count' }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan a count' });
    await dialog.getByLabel('Warehouse', { exact: true }).selectOption('WH-HQ');
    await dialog.getByLabel('Scope', { exact: true }).selectOption('item');
    await dialog.getByLabel('Item code or category').fill('ITM-SEED');
    await dialog.getByRole('button', { name: 'Plan', exact: true }).click();
    await page.waitForURL(/\/inventory\/stock-count\/CNT-/);
    const countNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);
    await expect(page.getByRole('heading', { name: countNo, level: 1 })).toBeVisible();
    // Four doors from the plan on: printer, paperclip, notes, clock.
    await expect(doors(page)).toHaveCount(4);
    await expectPrints(page, 'stock_count', countNo);
    await photograph(page, `/inventory/stock-count/${encodeURIComponent(countNo)}`, 'stock-count-record-planned');

    // Count: two short of the book (the seed's 250, less what earlier runs took).
    const bookCell = page.locator('table[aria-labelledby="stock-count-lines-heading"] tbody tr').first().locator('td').nth(4);
    const book = Number((await bookCell.innerText()).replace(/[^\d.]/g, ''));
    expect(book).toBeGreaterThan(2);
    onHand = book - 2;
    await page.getByLabel('Counted 1').fill(String(onHand));
    await page.getByLabel('Note 1').fill('Two damaged in the rack');
    await page.getByRole('button', { name: 'Record the count' }).click();
    await expect(page.locator('[data-status="counted"]').first()).toBeVisible();
    await expect(page.locator('table[aria-labelledby="stock-count-lines-heading"] tbody tr').first().locator('td').nth(7)).toContainText('-2');

    // Approve the variance, then adjust: the books lose two.
    await page.getByPlaceholder('Why the variance is accepted').fill('Damaged units written down after inspection');
    await page.getByRole('button', { name: 'Approve the variance' }).click();
    await expect(page.locator('[data-status="pending_approval"]').first()).toBeVisible();
    await page.getByLabel('Department', { exact: true }).selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Adjust the books' }).click();
    await expect(page.locator('[data-status="adjusted"]').first()).toBeVisible();
    await photograph(page, `/inventory/stock-count/${encodeURIComponent(countNo)}`, 'stock-count-record');
    await photograph(page, '/inventory/stock-count', 'stock-count-list');

    // The list shows it adjusted with its one variance.
    await page.goto('/inventory/stock-count');
    const row = page.locator('table[aria-labelledby="stock-count-title"] tbody tr', { hasText: countNo });
    await expect(row).toContainText('Adjusted');
    await expect(row.locator('td').nth(6)).toContainText('1');
  });

  test('Stock Receipts and Stock Issues read the ledger: the opening stock came in, the count took two out', async ({ page }) => {
    await page.goto('/inventory/stock-receipts');
    await expect(page.getByRole('heading', { name: 'Stock Receipts', level: 1 })).toBeVisible();
    const receipts = page.locator('table[aria-labelledby="stock_receipts-title"]');
    await expect(receipts.locator('tbody tr', { hasText: 'ITM-SEED' }).filter({ hasText: 'Opening stock' }).first()).toBeVisible();
    await photograph(page, '/inventory/stock-receipts', 'stock-receipts');

    await page.goto('/inventory/stock-issues');
    await expect(page.getByRole('heading', { name: 'Stock Issues', level: 1 })).toBeVisible();
    const issues = page.locator('table[aria-labelledby="stock_issues-title"]');
    const counted = issues.locator('tbody tr', { hasText: 'Count / reconciliation' }).first();
    await expect(counted).toBeVisible();
    await expect(counted).toContainText('2 EA');
    // The row opens the count that moved it.
    await expect(counted.locator('a[href^="/inventory/stock-count/"]')).toHaveCount(1);
    // The kind filter narrows, and the search finds the item.
    await page.goto('/inventory/stock-issues?kind=delivery');
    await expect(issues.locator('tbody tr', { hasText: 'Count / reconciliation' })).toHaveCount(0);
    await photograph(page, '/inventory/stock-issues', 'stock-issues');
  });

  test('Availability shows on order, unit cost and value, filters by category and branch, and opens the ledger', async ({ page }) => {
    await page.goto('/inventory/availability?category=CABLES&branch=HQ');
    const table = page.locator('table[aria-labelledby="availability-title"]');
    for (const header of ['On order', 'Unit cost (IQD)', 'Value (IQD)', 'Ledger']) await expect(table.locator('th', { hasText: header })).toBeVisible();
    const row = table.locator('tbody tr', { hasText: 'ITM-SEED' }).first();
    await expect(row).toBeVisible();
    // What is left at 12.5 a unit.
    await expect(row).toContainText(held());
    await expect(row).toContainText(heldValue());
    await expect(row.locator('a[href^="/inventory/stock-ledger?item=ITM-SEED"]')).toHaveCount(1);
    // A category nothing is in.
    await page.goto('/inventory/availability?category=NO-SUCH');
    await expect(table.locator('tbody tr', { hasText: 'ITM-SEED' })).toHaveCount(0);
    await photograph(page, '/inventory/availability', 'availability');
  });

  test('Inventory Valuation: today provisional with the G/L beside it, tomorrow refused, and it prints', async ({ page }) => {
    await page.goto('/inventory/valuation');
    await expect(page.getByRole('heading', { name: 'Inventory Valuation', level: 1 })).toBeVisible();
    await expect(page.locator('[data-status="draft"]', { hasText: 'Provisional' }).first()).toBeVisible();
    const table = page.locator('table[aria-labelledby="valuation-title"]');
    const row = table.locator('tbody tr', { hasText: 'ITM-SEED' }).first();
    await expect(row).toContainText(held());
    await expect(row).toContainText(heldValue());
    await expect(page.locator('table[aria-labelledby="valuation-gl-title"] tbody tr').first()).toBeVisible();
    // The copies: the menu is offered, and the PDF comes with the screen's own filters.
    await expect(page.locator('[data-export-menu="inventory_valuation"]')).toBeVisible();
    const pdf = await page.request.get('/export/inventory_valuation?format=pdf&lang=en');
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    // Tomorrow is refused in a sentence.
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await page.goto(`/inventory/valuation?as_of=${tomorrow}`);
    await expect(page.getByText(/has not come/)).toBeVisible();
    // A past date before the seed: nothing, and the ledger says nothing too.
    await page.goto('/inventory/valuation?as_of=2025-12-31');
    await expect(table.locator('tbody tr', { hasText: 'ITM-SEED' })).toHaveCount(0);
    await photograph(page, '/inventory/valuation', 'inventory-valuation');
  });

  test('Warehouses Report: the summary per warehouse, drilling down to its items and their movements', async ({ page }) => {
    await page.goto('/inventory/fifo-valuation');
    const summary = page.locator('table[aria-label="By warehouse"]');
    await expect(summary).toBeVisible();
    const hq = summary.locator('tbody tr', { hasText: 'WH-HQ' }).first();
    await expect(hq).toContainText('1'); // one item
    await expect(hq).toContainText(held());
    await hq.locator('a[href="/inventory/fifo-valuation?warehouse=WH-HQ"]').click();
    await page.waitForURL(/warehouse=WH-HQ/);
    // Narrowed to the warehouse: the items, each opening its movements.
    await expect(page.locator('table[aria-label="By warehouse"]')).toHaveCount(0);
    await expect(page.locator('a[href^="/inventory/stock-ledger?item=ITM-SEED&warehouse=WH-HQ"]').first()).toBeVisible();
    await photograph(page, '/inventory/fifo-valuation', 'warehouses-report');
  });

  test('Inventory Checks: every check named with a state and a source, nothing repaired, and it prints', async ({ page }) => {
    await page.goto('/inventory/checks');
    await expect(page.getByRole('heading', { name: 'Inventory Checks', level: 1 })).toBeVisible();
    const table = page.locator('table[aria-labelledby="inventory-checks-title"]');
    await expect(table.locator('tbody tr')).toHaveCount(12);
    for (const name of ['Ledger quantity against FIFO layers', 'FIFO layers: remaining = original − consumed', 'Landed-cost locks fully accounted for', "Layers' value against the inventory accounts"]) {
      await expect(table.locator('tbody tr', { hasText: name }).first()).toBeVisible();
    }
    // The seeded books are whole: the structural checks are healthy.
    await expect(table.locator('tbody tr', { hasText: 'Ledger quantity against FIFO layers' }).locator('[data-status="posted"]')).toHaveCount(1);
    const pdf = await page.request.get('/export/inventory_checks?format=pdf&lang=en');
    expect(pdf.status()).toBe(200);
    await photograph(page, '/inventory/checks', 'inventory-checks');
  });

  test('Opening Stock: the record wears the four doors and prints', async ({ page }) => {
    await page.goto('/inventory/opening-stock');
    const first = page.locator('a[href^="/inventory/opening-stock/"]').first();
    if ((await first.count()) === 0) test.skip(true, 'no opening stock document in the seed');
    await first.click();
    await page.waitForURL(/\/inventory\/opening-stock\/.+/);
    await expect(doors(page)).toHaveCount(4);
    const documentNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);
    await expectPrints(page, 'opening_stock', documentNo);
    await photograph(page, `/inventory/opening-stock/${encodeURIComponent(documentNo)}`, 'opening-stock-record');
  });
});
