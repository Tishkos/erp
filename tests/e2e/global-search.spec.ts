import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Global search — Ctrl/⌘ K from anywhere, and "see all" on /search.
 *
 * Runs against the seeded development database: the records it looks for are
 * written below (idempotently, as the owner) and left in place — they are
 * ordinary suppliers and customers. What it proves in the browser:
 *
 *   • the shortcut opens the palette, typing finds records server-side, the
 *     arrows move through groups, Enter opens the record, Escape closes;
 *   • a number typed whole is the first result;
 *   • a person with no grant to see suppliers does not find one;
 *   • Arabic at 390px, right to left, with no sideways scroll.
 */
const SHOTS = '/home/claude/shots/search';
const PASSWORD = 'Ledger-Trial-Balance-7';

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('/');
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (the spec writes its own fixtures).');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const { rows: admin } = await pool.query(`select id from app_user where email = 'admin@example.com'`);
    await pool.query(
      `insert into business_partner (code, legal_name, is_supplier) values ('SUP-GS0001','Gstest Freight Company', true)
       on conflict (code) do nothing`,
    );
    await pool.query(
      `insert into business_partner (code, legal_name, is_customer) values ('CUS-GS0002','شركة الفرات للتجارة', true)
       on conflict (code) do nothing`,
    );
    const { rows: supplier } = await pool.query(`select id from business_partner where code = 'SUP-GS0001'`);
    await pool.query(
      `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
       values ('API-HQ-2026-900001','GST-INV-1',$1,'HQ','2026-09-20','2026-10-20', 2750000, $2, true)
       on conflict (invoice_no) do nothing`,
      [supplier[0].id, admin[0].id],
    );
    await pool.query(
      `insert into doc_number_allocation (sequence_key, scope_key, serial, document_no)
       values ('AP_INVOICE','HQ:2026',900001,'API-HQ-2026-900001') on conflict do nothing`,
    );
  } finally {
    await pool.end();
  }
});

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const options = (page: Page) => palette(page).getByRole('option');

test('Ctrl+K opens the palette; typing finds records, arrows move, Enter opens, Escape closes', async ({ page }) => {
  await signIn(page, 'admin@example.com');

  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await expect(palette(page).getByRole('combobox')).toBeFocused();

  await palette(page).getByRole('combobox').fill('gstest');
  // Master record first, then the document that names it.
  // (The first search of a cold development server compiles the route.)
  const supplier = options(page).filter({ hasText: 'SUP-GS0001' });
  await expect(supplier).toHaveCount(1, { timeout: 45_000 });
  const invoice = options(page).filter({ hasText: 'API-HQ-2026-900001' });
  await expect(invoice).toHaveCount(1);
  const headings = palette(page).getByRole('presentation').filter({ hasText: /^(Suppliers|Purchase invoices)$/ });
  await expect(headings).toHaveText(['Suppliers', 'Purchase invoices']);
  await expect(supplier).toContainText('Gstest Freight Company');
  await expect(invoice).toContainText('2,750,000 IQD');
  await page.screenshot({ path: `${SHOTS}/palette-desktop-en.png` });

  // The first row is highlighted; the arrows move down and back up.
  const all = options(page);
  const first = await all.first().getAttribute('id');
  expect(await all.first().getAttribute('aria-selected')).toBe('true');
  await page.keyboard.press('ArrowDown');
  expect(await all.nth(1).getAttribute('aria-selected')).toBe('true');
  await page.keyboard.press('ArrowUp');
  expect(await all.first().getAttribute('id')).toBe(first);
  expect(await all.first().getAttribute('aria-selected')).toBe('true');

  // Move to the supplier and open it.
  const supplierIndex = await all.evaluateAll((nodes) => nodes.findIndex((node) => node.textContent?.includes('SUP-GS0001')));
  for (let i = 0; i < supplierIndex; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/payables\/suppliers\/SUP-GS0001/);
  await expect(palette(page)).toHaveCount(0);

  // Escape closes it.
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
});

test('a number typed whole is the first result, and a short prefix still finds it', async ({ page }) => {
  await signIn(page, 'admin@example.com');
  await page.keyboard.press('Control+k');
  await palette(page).getByRole('combobox').fill('API-HQ-2026-900001');
  await expect(options(page).first()).toContainText('API-HQ-2026-900001');
  await expect(options(page).first()).toContainText('Gstest Freight Company');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/payables\/invoices\/API-HQ-2026-900001/);

  await page.keyboard.press('Control+k');
  await palette(page).getByRole('combobox').fill('AP-900001');
  await expect(options(page).filter({ hasText: 'API-HQ-2026-900001' })).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/palette-number-desktop-en.png` });
  await page.keyboard.press('Escape');
});

test('"see all" opens the results page, grouped, in the list-screen model', async ({ page }) => {
  await signIn(page, 'admin@example.com');
  await page.goto('/search?q=gstest');
  await expect(page.getByRole('heading', { name: 'Suppliers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Purchase invoices' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'SUP-GS0001' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'API-HQ-2026-900001' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/search-page-desktop-en.png`, fullPage: true });
  await page.goto('/payables/invoices');
  await page.screenshot({ path: `${SHOTS}/model-invoices-desktop-en.png`, fullPage: true });

  // One group, paged.
  await page.goto('/search?q=gstest&type=supplier');
  await expect(page.getByRole('heading', { name: 'Suppliers' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Purchase invoices' })).toHaveCount(0);
});

test('a person who may not view suppliers or purchase invoices does not find them', async ({ page }) => {
  await signIn(page, 'outsider@example.com');
  await page.keyboard.press('Control+k');
  await palette(page).getByRole('combobox').fill('gstest');
  // Wait for the search to have answered, then look. (hasText is case-insensitive:
  // the "See all results for “gstest”" row is not a record, so the names are matched as written.)
  await expect(palette(page).getByText('Nothing found for “gstest”.')).toBeVisible({ timeout: 45_000 });
  await expect(options(page).filter({ hasText: /Gstest Freight|SUP-GS0001|API-HQ-2026-900001/ })).toHaveCount(0);
  await page.goto('/search?q=gstest');
  await expect(page.getByText('Gstest Freight Company')).toHaveCount(0);
});

test.describe('Arabic, 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the palette reads right to left and nothing scrolls sideways', async ({ page, context }) => {
    await signIn(page, 'admin@example.com');
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');

    await page.getByRole('button', { name: 'بحث' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'بحث' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox').fill('الفرات');
    const customer = dialog.getByRole('option').filter({ hasText: 'CUS-GS0002' });
    await expect(customer).toHaveCount(1);
    await expect(customer).toContainText('شركة الفرات للتجارة');
    await expect(dialog.getByRole('presentation').filter({ hasText: 'العملاء' })).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/palette-mobile-ar.png` });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const panel = await dialog.locator('.erp-search__panel').boundingBox();
    expect(panel!.x).toBeGreaterThanOrEqual(0);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(390);

    // Enter opens the customer.
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/sales\/customers\/CUS-GS0002/);

    // "See all" at a phone's width.
    await page.goto('/search?q=%D8%A7%D9%84%D9%81%D8%B1%D8%A7%D8%AA');
    await expect(page.getByRole('link', { name: 'CUS-GS0002' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/search-page-mobile-ar.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.goto('/payables/invoices');
    await page.screenshot({ path: `${SHOTS}/model-invoices-mobile-ar.png`, fullPage: true });
  });
});
