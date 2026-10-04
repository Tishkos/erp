import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Independent review of the owner's rule (2026-10-04): "For every invoice I
 * want notes, attachments, audit, print — after the draft is created. Like
 * Bank Loans: we can directly click the bank or the customer; the parts have
 * profiles." One record per module is raised in the browser and read against
 * the rule from its draft — the four doors in the standing order (printer,
 * paperclip, notes, clock), the parties as links to their profiles — and
 * photographed, desktop in English and a phone in Arabic, to
 * `/home/claude/shots/review/`. The bank loan is the reference the owner
 * named: no print model yet, so three doors, and the bank is a link.
 * Requires `npm run db:seed`.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/review';
const LABELS = { print: 'Print / Export', attachments: 'Attachments', notes: 'Notes', history: 'Audit log' };

async function signIn(page: Page, user = ADMIN) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

function doors(page: Page) {
  return page.locator('[class*="sapTitleActions"]').first().locator(':scope > button, :scope > a');
}

/** The doors in the title bar, by their titles, in the rule's order. */
async function expectDoors(page: Page, titles: readonly string[]) {
  await expect(doors(page)).toHaveCount(titles.length);
  const names = await doors(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual(titles);
}

const FOUR = [LABELS.print, LABELS.attachments, LABELS.notes, LABELS.history] as const;

/** The record, desktop in English and a phone in Arabic, with its doors on both. */
async function photograph(page: Page, record: string, name: string, count: number) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-desktop-en.png`, fullPage: true });
  const phone = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
  const mobile = await phone.newPage();
  await signIn(mobile);
  await mobile.goto(record);
  await expect(mobile.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(doors(mobile)).toHaveCount(count);
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth), 'no sideways scroll at 390px').toBeLessThanOrEqual(390);
  await mobile.screenshot({ path: `${SHOTS}/${name}-mobile-ar.png`, fullPage: true });
  await phone.close();
}

/** The item's accounts, which a sale and an import need; left as they are once set. */
async function itemAccounts(page: Page, code = 'ITM-SEED') {
  await page.goto(`/master-data/items/${code}`);
  const form = page.locator('form:has(select[name="inventoryAccountId"])').first();
  await expect(form).toBeVisible({ timeout: 60_000 });
  let changed = false;
  for (const field of ['inventoryAccountId', 'cogsAccountId']) {
    const select = form.locator(`select[name="${field}"]`);
    if ((await select.inputValue()) !== '') continue;
    const first = await select.locator('option:not([value=""])').first().getAttribute('value');
    if (!first) continue;
    await select.selectOption(first);
    changed = true;
  }
  if (changed) {
    await form.locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/, { timeout: 60_000 });
  }
}

test.describe('Review · four doors from the draft and profile links, one record per module', () => {
  let importNo = '';

  test('payables · a purchase invoice (an import) and its import application', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await itemAccounts(page);
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('500');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'), { timeout: 120_000 });
    const record = page.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;

    // The draft: four doors, the supplier a link, the import a link.
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await expectDoors(page, FOUR);
    await expect(page.locator('a[href^="/payables/suppliers/SUP-00001"]').first()).toBeVisible();

    // Posted: the doors stay, and the lines' item and warehouse open their profiles.
    await page.getByRole('button', { name: 'Send for approval', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Approve and post', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await expectDoors(page, FOUR);
    const lines = page.locator('table[aria-labelledby="ap-invoice-document-lines-heading"]');
    await expect(lines.locator('a[href="/inventory/items/ITM-SEED"]').first()).toBeVisible();
    // An import's goods are booked into the in-process warehouse; whichever it is, it is a link.
    await expect(lines.locator('a[href^="/master-data/warehouses/"]').first()).toBeVisible();
    await photograph(page, record, 'purchase-invoice', 4);

    // The import application: the printer first, then paperclip, notes, clock.
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);
    importNo = decodeURIComponent(page.url().split('/payables/')[1]!.split(/[?#]/)[0]!);
    const names = await doors(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
    expect(names[0]).toBe(LABELS.print);
    expect(names).toHaveLength(4);
    expect(names[3]).toBe(LABELS.history);
    await expect(page.locator('a[href^="/payables/suppliers/SUP-00001"]').first()).toBeVisible();
    await photograph(page, `/payables/${encodeURIComponent(importNo)}`, 'import-application', 4);
  });

  test('receivables · a sales invoice from its draft', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await itemAccounts(page);
    await page.goto('/sales/ar-invoices/new');
    await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Customer Code', { exact: true }).fill('CUS-00001');
    await page.locator('input[name="item_code_0"]').fill('ITM-SEED');
    await page.locator('input[name="quantity_0"]').fill('2');
    await page.locator('input[name="unit_price_0"]').fill('50000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/sales\/ar-invoices\/INV-/, { timeout: 90_000 });
    const record = page.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await expectDoors(page, FOUR);
    await expect(page.locator('a[href^="/sales/customers/CUS-00001"]').first()).toBeVisible();
    await photograph(page, record, 'sales-invoice', 4);
  });

  test('accounting · a journal from its draft', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await page.goto('/finance/journals');
    await expect(page.getByRole('button', { name: 'New journal' })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: 'New journal' }).click();
    await page.waitForURL(/\/finance\/journals\/JE-/, { timeout: 60_000 });
    const record = page.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await expectDoors(page, FOUR);
    await photograph(page, record, 'journal', 4);
  });

  test('logistics · a customs declaration from its draft', async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!importNo, 'needs the import the payables test raised');
    await signIn(page);
    await page.goto('/logistics/customs-declarations');
    await page.getByRole('button', { name: 'New declaration' }).click();
    const dialog = page.getByRole('dialog');
    const option = dialog.locator('select[name="payable_id"] option', { hasText: importNo });
    await dialog.locator('select[name="payable_id"]').selectOption((await option.getAttribute('value'))!);
    await dialog.getByLabel('Declared value').fill('500000');
    await dialog.getByLabel('Declared duty').fill('25000');
    await dialog.getByLabel('Declared taxes').fill('5000');
    await dialog.getByLabel('HS code').fill('8541.43');
    await dialog.getByRole('button', { name: 'New declaration' }).click();
    await page.waitForURL(/\/logistics\/customs-declarations\/CDN-/, { timeout: 60_000 });
    const record = page.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
    await expectDoors(page, FOUR);
    await expect(page.locator('#declaration-document').getByRole('link', { name: new RegExp(importNo) })).toHaveAttribute('href', `/payables/${importNo}`);
    await expect(page.locator('a[href^="/payables/suppliers/SUP-00001"]').first()).toBeVisible();
    await photograph(page, record, 'customs-declaration', 4);
  });

  test('inventory · a stock count from its plan', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await page.goto('/inventory/stock-count');
    await page.getByRole('button', { name: 'Plan a count' }).click();
    const dialog = page.getByRole('dialog', { name: 'Plan a count' });
    await dialog.getByLabel('Warehouse', { exact: true }).selectOption('WH-HQ');
    await dialog.getByLabel('Scope', { exact: true }).selectOption('item');
    await dialog.getByLabel('Item code or category').fill('ITM-SEED');
    await dialog.getByRole('button', { name: 'Plan', exact: true }).click();
    await page.waitForURL(/\/inventory\/stock-count\/CNT-/);
    const record = page.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;
    await expectDoors(page, FOUR);
    await expect(page.locator('a[href="/master-data/warehouses/WH-HQ"]').first()).toBeVisible();
    await expect(page.locator('a[href="/inventory/items/ITM-SEED"]').first()).toBeVisible();
    await photograph(page, record, 'stock-count', 4);
  });

  test('the reference · a bank loan: paperclip, notes, clock; the bank and the account are links', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    // The offer is typed on the new-loan page: the bank, the account, the
    // principal, the commission and the first due date; the rest are defaults.
    await page.goto('/treasury/loans/new');
    await page.locator('select[name="bank_code"]').selectOption({ label: 'Rafidain Bank' });
    await page.locator('select[name="bank_cash_account_id"]').selectOption({ index: 0 });
    await page.getByRole('textbox', { name: 'Principal' }).fill('1000000');
    await page.getByRole('textbox', { name: 'Commission %' }).fill('2');
    await page.getByLabel('First instalment due').fill('2026-12-31');
    await page.getByRole('button', { name: 'Create loan' }).click();
    await page.waitForURL(/\/treasury\/loans\/LOAN-/, { timeout: 60_000 });
    const record = page.url().replace(/^https?:\/\/[^/]+/, '').split('?')[0]!;

    // No print model yet (reported), so three doors: paperclip, notes, clock.
    await expectDoors(page, ['Contract, schedule, bank letters', LABELS.notes, LABELS.history]);
    // "We can directly click the bank": the bank and the account open their profiles.
    const doc = page.locator('#loan-document');
    await expect(doc.locator('a[href^="/master-data/banks/"]').first()).toBeVisible();
    await expect(doc.locator('a[href^="/master-data/bank-accounts/"]').first()).toBeVisible();

    // A note through the shared door is counted and on the clock.
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    const notes = page.getByRole('dialog', { name: 'Notes' });
    await notes.getByRole('textbox', { name: 'Add note' }).fill(`Bank confirmed the offer ${RUN}`);
    await notes.getByRole('button', { name: 'Add note' }).click();
    await page.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Audit log' }).click();
    await expect(page.getByRole('dialog', { name: 'Audit log' }).getByText(/note added/i).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await photograph(page, record, 'bank-loan', 3);

    // The bank's profile is where the link lands.
    await doc.locator('a[href^="/master-data/banks/"]').first().click();
    await page.waitForURL(/\/master-data\/banks\//);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
