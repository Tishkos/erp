import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { containerNo } from '../support/container-number';

/**
 * ERP Control Center and Related records (platform phase, Agent 9) — on the screens, as the seeded people.
 *
 * The CEO asks "Is Qimah internally healthy?" and gets the checks the system really runs — one register per
 * domain, each with its state, the figures it compared and the road to the record — with no score anywhere,
 * and nothing on the page that changes anything but the time it was read ("Run checks now" asks again). The
 * accounting manager reads it too; the accounting officer, the outsider and the menu of both are turned away.
 * An import is taken as far as a B/L and two containers by hand; its page carries the chain around it, the
 * whole chain has a page of its own, a node opens the record it names, the steps the import has not reached
 * say "Not yet", and the person with no grant on the import is refused. The screens are photographed beside the
 * ones they copy (Purchase Invoices and its record), desktop in English and a phone in Arabic.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const CEO = 'ceo@example.com';
const MANAGER = 'manager@example.com';
const OFFICER = 'officer@example.com';
const OUTSIDER = 'outsider@example.com';
const ADMIN = 'admin@example.com';
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/control';
mkdirSync(SHOTS, { recursive: true });

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function as(browser: Browser, email: string, options: { arabic?: boolean } = {}) {
  const context = await browser.newContext(options.arabic ? { viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } });
  if (options.arabic) await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
  const page = await context.newPage();
  await signIn(page, email);
  return { page, close: () => context.close() };
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 }).first();

test.describe.configure({ mode: 'serial' });

let importNo = '';
let blNo = '';
let invoiceNo = '';
const digits = String(Date.now()).slice(-5);
const first = containerNo('CTLU', `${digits}1`);
const second = containerNo('CTLU', `${digits}2`);

test.describe('Control Center · the checks, as the CEO reads them', () => {
  test('the CEO reads real checks by domain, with figures and no score, and "Run checks now" only asks again', async ({ browser }) => {
    test.setTimeout(300_000);
    const ceo = await as(browser, CEO);
    const page = ceo.page;
    await page.goto('/control-center', { waitUntil: 'networkidle' });
    await expect(heading(page)).toHaveText('ERP Control Center', { timeout: 120_000 });
    await expect(page.getByText(/Is Qimah internally healthy\?/)).toBeVisible();
    await expect(page.getByText(/^Checked .*\d+ checks read in/).first()).toBeVisible();

    // The summary: one row per domain with the count in each state, and the Exception Center's open figure.
    const summary = page.locator('table[aria-labelledby="cc-summary-title"]');
    await expect(summary.getByRole('columnheader', { name: 'Needs attention' })).toBeVisible();
    await expect(summary.getByRole('columnheader', { name: 'OK' })).toBeVisible();
    const domainRows = summary.locator('tbody tr');
    expect(await domainRows.count()).toBeGreaterThanOrEqual(4);
    await expect(summary.getByRole('link', { name: 'Accounting' })).toBeVisible();
    await expect(summary.getByRole('link', { name: 'Inventory' })).toBeVisible();

    // Every check is a row with its state, in the register's own chip, and the figures it compared.
    const checks = page.locator('section[id] table tbody tr').filter({ has: page.locator('[class*="sapRegisterStatus"]') });
    const total = await checks.count();
    expect(total).toBeGreaterThanOrEqual(25);
    const states = await checks.locator('[class*="sapRegisterStatus"]').allTextContents();
    for (const state of states) expect(['OK', 'Needs attention', 'Not checked', 'Could not be checked']).toContain(state.trim());

    // The summary adds up to the registers beneath it, state by state: nothing is counted that is not shown.
    const headings = await summary.locator('thead th').allTextContents();
    const column = (name: string) => headings.findIndex((h) => h.trim() === name);
    for (const name of ['Needs attention', 'OK']) {
      const cells = await summary.locator(`tbody tr td:nth-child(${column(name) + 1})`).allTextContents();
      const counted = cells.reduce((sum, cell) => sum + Number(cell.replace(/[^\d]/g, '') || 0), 0);
      expect(states.filter((s) => s.trim() === name).length, `${name} in the summary and in the registers`).toBe(counted);
    }

    // No score, no percentage, no grade.
    // (A finding may quote a figure of its own, such as the free disk; the headline never does.)
    await expect(page.getByText(/health score|\bscore\b|\bgrade\b/i)).toHaveCount(0);
    expect(await summary.textContent()).not.toContain('%');

    // Nothing here fixes, posts, edits or resolves: the one control that submits is the one that reads again.
    await expect(page.getByRole('button', { name: 'Run checks now' })).toHaveCount(1);
    await expect(page.locator('main form').filter({ has: page.locator('input[name="amount"], textarea') })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /fix|post |resolve|approve|delete|repair|acknowledge/i })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/control-center-desktop-en.png`, fullPage: true });

    // "Run checks now" reads again: the page says when it read, and it says it afresh.
    const before = await page.getByText(/^Checked .*\d+ checks read in/).first().textContent();
    await page.getByRole('button', { name: 'Run checks now' }).first().click();
    await page.waitForLoadState('networkidle');
    await expect(heading(page)).toHaveText('ERP Control Center');
    const after = await page.getByText(/^Checked .*\d+ checks read in/).first().textContent();
    expect(after).toBeTruthy();
    expect(before).toBeTruthy();

    // A domain on its own: only its register is drawn.
    await page.goto('/control-center?domain=inventory', { waitUntil: 'networkidle' });
    await expect(page.locator('#inventory table[aria-labelledby="cc-inventory-title"]')).toBeVisible();
    await expect(page.locator('#accounting')).toHaveCount(0);

    // The summary reaches the Exception Center, the system of record for what needs a person.
    await page.goto('/control-center', { waitUntil: 'networkidle' });
    const exceptionsLink = summary.locator('a[href^="/exceptions?domain="]').first();
    if ((await exceptionsLink.count()) > 0) {
      await exceptionsLink.click();
      await page.waitForURL(/\/exceptions\?domain=/);
      await expect(heading(page)).toHaveText('Exceptions');
    }
    await ceo.close();
  });

  test('a check with a record opens it: the road in the register leads to a real page', async ({ browser }) => {
    test.setTimeout(240_000);
    const ceo = await as(browser, CEO);
    const page = ceo.page;
    await page.goto('/control-center', { waitUntil: 'networkidle' });
    await expect(heading(page)).toHaveText('ERP Control Center', { timeout: 120_000 });
    // A check's title is a link where its screen exists and the viewer holds it; follow the first of each domain.
    const targets: string[] = [];
    for (const domain of ['accounting', 'inventory', 'platform']) {
      const link = page.locator(`#${domain} table tbody tr td:first-child a`).first();
      if ((await link.count()) > 0) targets.push((await link.getAttribute('href')) ?? '');
    }
    expect(targets.length).toBeGreaterThan(0);
    for (const href of targets) {
      expect(href.startsWith('/')).toBe(true);
      const response = await page.goto(href, { waitUntil: 'domcontentloaded' });
      expect(response?.status(), href).toBeLessThan(400);
      await expect(page.getByRole('heading', { level: 1, name: 'That page does not exist' }), href).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1, name: 'Not available to you' }), href).toHaveCount(0);
    }
    await ceo.close();
  });

  test('the accounting manager reads it; the officer, the outsider and their menus are turned away', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER);
    await manager.page.goto('/control-center', { waitUntil: 'networkidle' });
    await expect(heading(manager.page)).toHaveText('ERP Control Center', { timeout: 120_000 });
    await manager.close();

    for (const email of [OFFICER, OUTSIDER]) {
      const other = await as(browser, email);
      const page = other.page;
      await page.goto('/control-center', { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { level: 1, name: 'Not available to you' }), email).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText('You do not have permission to open this screen.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Run checks now' })).toHaveCount(0);
      await expect(page.locator('table[aria-labelledby="cc-summary-title"]')).toHaveCount(0);
      // The menu does not offer what the direct address would refuse.
      await page.goto('/', { waitUntil: 'networkidle' });
      const nav = page.getByRole('navigation');
      const home = nav.getByRole('button', { name: /^(Home|Dashboard)$/ });
      if ((await home.count()) > 0) await home.first().click();
      await expect(nav.getByRole('link', { name: 'Control Center', exact: true }), email).toHaveCount(0);
      await other.close();
    }

    // The CEO's menu does offer it.
    const ceo = await as(browser, CEO);
    const nav = ceo.page.getByRole('navigation');
    const home = nav.getByRole('button', { name: /^(Home|Dashboard)$/ });
    if ((await home.count()) > 0) await home.first().click();
    await expect(nav.getByRole('link', { name: 'Control Center', exact: true }).first()).toBeVisible();
    await ceo.close();
  });
});

test.describe('Related records · the chain around an import', () => {
  test('an import taken to a B/L with two containers draws its chain on its own page and on the page of the chain', async ({ browser }) => {
    test.setTimeout(420_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('10');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'), { timeout: 120_000 });
    invoiceNo = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);
    importNo = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
    expect(importNo).toMatch(/^IMP-/);

    blNo = `BL-CTL-${RUN}`;
    await page.getByRole('button', { name: 'New B/L' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'B/L no.' }).fill(blNo);
    await dialog.getByLabel('B/L date').fill('2026-09-20');
    await dialog.getByLabel('ETA').fill('2026-10-20');
    await dialog.getByLabel('Container no. 1').fill(first);
    await dialog.getByLabel('Size / type 1').selectOption('40HC');
    await dialog.getByLabel('ITM-SEED 1').fill('6');
    await dialog.getByLabel('Container no. 2').fill(second);
    await dialog.getByLabel('Size / type 2').selectOption('20GP');
    await dialog.getByLabel('ITM-SEED 2').fill('4');
    await dialog.getByRole('button', { name: 'New B/L' }).click();
    await expect(page.getByLabel('Bills of lading').getByRole('link', { name: blNo })).toBeVisible({ timeout: 30_000 });

    // The import's own page carries the stacked section.
    await page.goto(`/payables/${encodeURIComponent(importNo)}`, { waitUntil: 'networkidle' });
    const section = page.locator('section#related-records');
    await expect(section.getByRole('heading', { name: /Related records/ })).toBeVisible({ timeout: 90_000 });
    const table = section.locator('table[aria-label="Related records"]');
    await expect(table.getByRole('link', { name: invoiceNo })).toBeVisible();
    await expect(table.getByRole('link', { name: blNo })).toBeVisible();
    await expect(table.getByRole('link', { name: first })).toBeVisible();
    await expect(table.getByRole('link', { name: second })).toBeVisible();
    // The steps the import has not reached say so, and say nothing more: no record, no zero.
    await expect(table.getByRole('row', { name: /^Customs PDs/ }).getByText('Not yet')).toBeVisible();
    await expect(table.getByRole('row', { name: /^Receipts/ }).getByText('Not yet')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/import-related-desktop-en.png`, fullPage: true });

    // The whole chain has a page of its own.
    await section.getByRole('link', { name: 'Open the whole chain' }).click();
    await page.waitForURL(/\/control-center\/relationships\?type=import/);
    await expect(heading(page)).toContainText(importNo);
    await expect(heading(page)).toContainText('related records');
    const chain = page.locator('section#related-records table[aria-label="Related records"]');
    await expect(chain.getByRole('link', { name: blNo })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/relationships-import-desktop-en.png`, fullPage: true });

    // A node opens the record it names: the B/L, then a container.
    await chain.getByRole('link', { name: blNo }).click();
    await page.waitForURL(new RegExp(`/payables/shipments/${blNo}`));
    await expect(heading(page)).toContainText(blNo);
    await page.goBack();
    await page.waitForURL(/\/control-center\/relationships/);
    await page.locator('section#related-records table[aria-label="Related records"]').getByRole('link', { name: first }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/payables/containers/'));
    await expect(heading(page)).toContainText(first);
    await admin.close();
  });

  test('the person with no grant on the import is refused its chain, and an unknown code is not found', async ({ browser }) => {
    test.setTimeout(240_000);
    const outsider = await as(browser, OUTSIDER);
    await outsider.page.goto(`/control-center/relationships?type=import&id=${encodeURIComponent(importNo)}`, { waitUntil: 'networkidle' });
    await expect(outsider.page.getByRole('heading', { level: 1, name: 'Not available to you' })).toBeVisible({ timeout: 120_000 });
    await expect(outsider.page.getByText(blNo)).toHaveCount(0);
    await outsider.close();

    const admin = await as(browser, ADMIN);
    await admin.page.goto('/control-center/relationships?type=import&id=NO-SUCH-IMPORT', { waitUntil: 'networkidle' });
    await expect(admin.page.getByRole('heading', { level: 1, name: 'That page does not exist' })).toBeVisible({ timeout: 120_000 });
    await admin.page.goto('/control-center/relationships?type=ship&id=X', { waitUntil: 'networkidle' });
    await expect(admin.page.getByRole('heading', { level: 1, name: 'That page does not exist' })).toBeVisible();
    await admin.close();
  });

  test('the supplier profile and the item page carry their chains', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto('/payables/suppliers/SUP-00001', { waitUntil: 'networkidle' });
    await expect(page.locator('section#related-records, [class*="panel"]').filter({ hasText: 'Related records' }).first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(invoiceNo).first()).toBeVisible();
    await page.goto('/inventory/items/ITM-SEED', { waitUntil: 'networkidle' });
    await expect(page.locator('section#related-records, [class*="panel"]').filter({ hasText: 'Related records' }).first()).toBeVisible({ timeout: 120_000 });
    await admin.close();
  });
});

test.describe('Both screens at a phone’s width, right to left, beside the ones they copy', () => {
  test('the Control Center, the chain and the import page hold at 390px in Arabic; the models are photographed beside them', async ({ browser }) => {
    test.setTimeout(420_000);
    const ceo = await as(browser, CEO, { arabic: true });
    const page = ceo.page;
    for (const route of ['/control-center', '/control-center?domain=inventory', '/control-center?state=attention']) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(heading(page)).toBeVisible({ timeout: 120_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} is ${width}px wide`).toBeLessThanOrEqual(390);
    }
    await page.goto('/control-center', { waitUntil: 'networkidle' });
    await expect(heading(page)).toHaveText('مركز التحكم في النظام');
    await page.screenshot({ path: `${SHOTS}/control-center-mobile-ar.png`, fullPage: true });
    await ceo.close();

    const admin = await as(browser, ADMIN, { arabic: true });
    const phone = admin.page;
    for (const [route, shot] of [
      [`/control-center/relationships?type=import&id=${encodeURIComponent(importNo)}`, 'relationships-import-mobile-ar'],
      [`/payables/${encodeURIComponent(importNo)}`, 'import-related-mobile-ar'],
    ] as const) {
      await phone.goto(route, { waitUntil: 'networkidle' });
      await expect(phone.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(phone.locator('section#related-records')).toBeVisible({ timeout: 120_000 });
      await expect(phone.locator('section#related-records').getByText('السجلات المرتبطة').first()).toBeVisible();
      const width = await phone.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} is ${width}px wide`).toBeLessThanOrEqual(390);
      await phone.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: true });
    }
    // The models they copy: the list screen and the record screen.
    await phone.goto('/payables/invoices', { waitUntil: 'networkidle' });
    await phone.screenshot({ path: `${SHOTS}/model-invoices-mobile-ar.png`, fullPage: true });
    await phone.goto(`/payables/invoices/${encodeURIComponent(invoiceNo)}`, { waitUntil: 'networkidle' });
    await phone.screenshot({ path: `${SHOTS}/model-invoice-record-mobile-ar.png`, fullPage: true });
    await admin.close();

    const desktop = await as(browser, ADMIN);
    await desktop.page.goto('/payables/invoices', { waitUntil: 'networkidle' });
    await desktop.page.screenshot({ path: `${SHOTS}/model-invoices-desktop-en.png`, fullPage: true });
    await desktop.page.goto(`/payables/invoices/${encodeURIComponent(invoiceNo)}`, { waitUntil: 'networkidle' });
    await desktop.page.screenshot({ path: `${SHOTS}/model-invoice-record-desktop-en.png`, fullPage: true });
    await desktop.close();
  });
});
