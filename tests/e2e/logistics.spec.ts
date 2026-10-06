import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { containerNo } from '../support/container-number';

/**
 * REQ-LOG-001 — the Logistics module on the screens.
 *
 * An import raised and shipped on one B/L with two containers; a declaration
 * raised against it and walked Submitted → Accepted → Assessed → Cleared
 * through its four doors; a port added, renamed and retired on its profile;
 * every register under the four headings opened, EN desktop and AR mobile,
 * and photographed beside the model it copies. /inventory/in-transit
 * redirects to In-Transit Inventory, which says in transit, never on hand.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const SHOTS = process.env.LOGISTICS_SHOTS ?? '/home/claude/shots/logistics';

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function shoot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** The four doors in the title bar, in the standing order: printer, paperclip, notes, clock. */
async function expectFourDoors(page: Page) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  const doors = bar.locator(':scope > button, :scope > a');
  await expect(doors).toHaveCount(4);
  const names = await doors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual(['Print / Export', 'Attachments', 'Notes', 'Audit log']);
}

/** ITM-SEED needs its inventory and COGS accounts before an invoice of it posts. */
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

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const SCREENS = [
  { route: '/logistics/customs-declarations', heading: 'Customs Declarations', model: 'payables/invoices' },
  { route: '/logistics/customs-duties', heading: 'Customs Duties & Taxes', model: 'payables/invoices' },
  { route: '/logistics/customs-documents', heading: 'Customs Documents', model: 'payables/invoices' },
  { route: '/logistics/shipments', heading: 'Shipments', model: 'payables/invoices' },
  { route: '/logistics/ports', heading: 'Ports & Routes', model: 'payables/invoices' },
  { route: '/logistics/freight-costs', heading: 'Freight & Shipping Costs', model: 'payables/invoices' },
  { route: '/logistics/shipment-documents', heading: 'Shipment Documents', model: 'payables/invoices' },
  { route: '/logistics/in-transit', heading: 'In-Transit Inventory', model: 'payables/invoices' },
  { route: '/logistics/shipment-tracking', heading: 'Shipment Tracking', model: 'payables/invoices' },
  { route: '/logistics/landed-costs', heading: 'Landed Costs', model: 'payables/invoices' },
  { route: '/logistics/cost-allocation', heading: 'Cost Allocation', model: 'payables/invoices' },
] as const;

test.describe('REQ-LOG-001 · the Logistics module', () => {
  test.describe.configure({ mode: 'serial' });
  const blNo = `BL-LOG-${RUN}`;
  const digits = String(Date.now()).slice(-5);
  const first = containerNo('LOGU', `${digits}1`);
  const second = containerNo('LOGU', `${digits}2`);
  let importNo = '';
  let declarationNo = '';
  let portCode = '';

  test('the four headings are the navbar, and an import is shipped on a B/L', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    // The module's dropdown: four headings, fifteen items, in the owner's order.
    await page.goto('/logistics/shipments');
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Logistics' }).click();
    for (const heading of ['Customs — ASYCUDA', 'Shipping', 'In Transit', 'Landed Costs']) {
      await expect(nav.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    const items = ['Customs Pre-Declarations', 'Customs Declarations', 'Update from ASYCUDA', 'Customs Duties & Taxes', 'Customs Documents', 'Shipments', 'Bills of Lading', 'Containers', 'Ports & Routes', 'Freight & Shipping Costs', 'Shipment Documents', 'In-Transit Inventory', 'Shipment Tracking', 'Landed Costs', 'Cost Allocation'];
    for (const item of items) await expect(nav.getByRole('link', { name: item, exact: true })).toBeVisible();
    const order = await nav.getByRole('link').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ''));
    expect(order.filter((name) => items.includes(name))).toEqual(items);
    await page.keyboard.press('Escape');

    // The import of 500, born at its invoice and posted — its goods land in transit.
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
    await page.getByRole('button', { name: 'Send for approval', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Approve and post', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);
    importNo = decodeURIComponent(page.url().split('/payables/')[1]!.split(/[?#]/)[0]!);

    await page.getByRole('link', { name: 'New B/L' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'B/L no.' }).fill(blNo);
    await dialog.getByLabel('B/L date').fill('2026-09-20');
    await dialog.getByLabel('ETA').fill('2026-10-20');
    await dialog.locator('select[name="port_of_discharge"]').selectOption('PRT-0001');
    await dialog.getByLabel('Container no. 1').fill(first);
    await dialog.getByLabel('ITM-SEED 1').fill('300');
    await dialog.getByLabel('Container no. 2').fill(second);
    await dialog.getByLabel('ITM-SEED 2').fill('200');
    await dialog.getByRole('button', { name: 'New B/L' }).click();
    await expect(page.getByRole('link', { name: blNo }).first()).toBeVisible({ timeout: 30_000 });

    // The Shipments register: one row per import, its B/L, 0 of 2 received.
    await page.goto('/logistics/shipments');
    const row = page.getByRole('row', { name: new RegExp(importNo) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(blNo);
    await expect(row).toContainText('0 / 2');
    // Shipment Tracking: both containers, waiting to load.
    await page.goto('/logistics/shipment-tracking');
    await expect(page.getByRole('row', { name: new RegExp(first) })).toContainText('Load and sail');
    await expect(page.getByRole('row', { name: new RegExp(second) })).toBeVisible();
  });

  test('a declaration is raised, wears its four doors from the draft, and walks to cleared', async ({ page }) => {
    test.setTimeout(300_000);
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
    declarationNo = decodeURIComponent(page.url().split('/customs-declarations/')[1]!.split('?')[0]!);
    expect(declarationNo).toMatch(/^CDN-/);

    // Four doors, in the standing order, from the draft.
    await expectFourDoors(page);
    // The parties link to their profiles.
    await expect(page.locator('#declaration-document').getByRole('link', { name: new RegExp(importNo) })).toHaveAttribute('href', `/payables/${importNo}`);
    await expect(page.locator('#declaration-document').getByRole('link', { name: /SUP-00001/ })).toHaveAttribute('href', /\/payables\/suppliers\/SUP-00001/);
    await shoot(page, 'customs-declaration-record-en-desktop');

    // A note through the shared door.
    await page.getByRole('button', { name: /^Notes/ }).click();
    const notes = page.getByRole('dialog', { name: 'Notes' });
    await notes.getByLabel('Add note').fill(`Broker promised the assessment Thursday ${RUN}`);
    await notes.getByRole('button', { name: 'Add note' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();

    // Submitted → Accepted (with customs' number) → Assessed → Cleared.
    const step = async (label: string, fill?: () => Promise<void>) => {
      await page.getByRole('button', { name: label, exact: true }).click();
      const box = page.getByRole('dialog', { name: label });
      if (fill) await fill();
      await box.getByRole('button', { name: label }).click();
      await page.waitForURL(/saved=1/);
    };
    await step('Submit to customs');
    await expect(page.locator('#declaration-document')).toContainText('Submitted');
    await step('Mark accepted', async () => {
      await page.getByRole('dialog', { name: 'Mark accepted' }).getByLabel('Customs reference').fill(`BG-${RUN}`);
    });
    await step('Mark assessed');
    await step('Mark cleared');
    await expect(page.locator('#declaration-document')).toContainText('Cleared');
    await expect(page.locator('#declaration-document')).toContainText(`BG-${RUN}`);
    // Final: nothing moves it again — no step buttons left.
    await expect(page.getByRole('button', { name: 'Submit to customs' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel declaration' })).toHaveCount(0);
    await expect(page.getByText(/what it declared is the record/)).toBeVisible();

    // The register lists it as cleared; the PD page shows the import's B/L and containers.
    await page.goto('/logistics/customs-declarations?view=cleared');
    await expect(page.getByRole('row', { name: new RegExp(declarationNo) })).toContainText('Cleared');
    await shoot(page, 'customs-declarations-list-en-desktop');
    await page.goto('/logistics/customs-documents');
    await expect(page.getByRole('heading', { level: 1, name: 'Customs Documents' })).toBeVisible();
  });

  test('a port is added, renamed and retired on its profile; routes read from the B/Ls', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await page.goto('/logistics/ports');
    await expect(page.getByRole('row', { name: /PRT-0001/ }).first()).toBeVisible();
    await page.getByRole('button', { name: 'New port' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill(`Jebel Ali ${RUN}`);
    await dialog.getByLabel('Country').fill('AE');
    await dialog.getByRole('button', { name: 'New port' }).click();
    await page.waitForURL(/\/logistics\/ports\/PRT-/, { timeout: 60_000 });
    portCode = decodeURIComponent(page.url().split('/ports/')[1]!.split('?')[0]!);
    expect(portCode).toMatch(/^PRT-\d{4}$/);
    await expectFourDoors(page);
    await shoot(page, 'port-profile-en-desktop');

    await page.getByRole('button', { name: 'Edit port' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill(`Jebel Ali DP ${RUN}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('#port-document')).toContainText(`Jebel Ali DP ${RUN}`);
    await page.getByRole('textbox', { name: 'Why the port is retired' }).fill('Line no longer calls there');
    await page.getByRole('button', { name: 'Retire port' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('This port is retired')).toBeVisible();
    await page.goto('/logistics/ports?view=retired');
    await expect(page.getByRole('row', { name: new RegExp(portCode) })).toContainText('Retired');
    // Routes in use: the B/L above named Umm Qasr, so a route reaches it.
    await page.goto('/logistics/ports');
    await expect(page.getByRole('heading', { name: 'Routes in use' })).toBeVisible();
    await shoot(page, 'ports-list-en-desktop');
    // The B/L's port of discharge links to the port's profile.
    await page.goto(`/payables/shipments/${encodeURIComponent(blNo)}`);
    await expect(page.locator('#bl-document').getByRole('link', { name: 'Umm Qasr' })).toHaveAttribute('href', '/logistics/ports/PRT-0001');
  });

  test('In-Transit Inventory says in transit, never on hand; the old address redirects', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await page.goto('/inventory/in-transit');
    await expect(page).toHaveURL(/\/logistics\/in-transit/);
    await expect(page.getByRole('heading', { level: 1, name: 'In-Transit Inventory' })).toBeVisible();
    await expect(page.getByText('How to read the figures')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Transit warehouses/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Invoice Status Tracking/ })).toBeVisible();
    // The column heads make the four figures unmistakable.
    const table = page.locator('table').first();
    for (const head of ['Ordered', 'In containers', 'In transit', 'Received', 'On hand']) {
      await expect(table.getByRole('columnheader', { name: head })).toBeVisible();
    }
    // The posted import: 500 ordered, 500 in containers, 500 in transit (in the In Process warehouse), nothing received.
    const row = table.getByRole('row', { name: new RegExp(importNo) });
    await expect(row).toBeVisible();
    const cells = await row.getByRole('cell').allTextContents();
    expect(cells.slice(3, 9).map((cell) => cell.replace(/[\s,]/g, ''))).toEqual(['500', '500', '500WH-INPROC500', '500000IQD', '0', '0']);
    // The ledger's own transit balance says the same, and nothing of it is available.
    const ledger = page.getByRole('heading', { name: /Transit warehouses/ }).locator('..').locator('table');
    const ledgerRow = ledger.getByRole('row', { name: /WH-INPROC/ }).first();
    await expect(ledgerRow).toBeVisible();
    await expect(ledgerRow).toContainText('In Process');
    await expect(page.getByText('Every unit in a transit warehouse is accounted for')).toBeVisible();
    await shoot(page, 'in-transit-en-desktop');
    for (const screen of SCREENS) {
      await page.goto(screen.route);
      await expect(page.getByRole('heading', { level: 1, name: screen.heading })).toBeVisible();
      await expect(page.locator('table').first()).toBeVisible();
      if (!['/logistics/in-transit', '/logistics/customs-declarations', '/logistics/ports'].includes(screen.route)) {
        await shoot(page, `${screen.route.split('/').pop()}-en-desktop`);
      }
    }
    // The model the lists copy, for the side-by-side.
    await page.goto('/payables/invoices');
    await shoot(page, 'model-payables-invoices-en-desktop');
  });

  test('every Logistics screen holds at mobile width, in Arabic, right to left', async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    const page = await context.newPage();
    await signIn(page);
    for (const screen of SCREENS) {
      await page.goto(screen.route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.locator('table').first()).toBeVisible();
      await noSidewaysScroll(page);
      await shoot(page, `${screen.route.split('/').pop()}-ar-mobile`);
    }
    await page.goto(`/logistics/customs-declarations/${encodeURIComponent(declarationNo)}`);
    await expect(page.locator('#declaration-document')).toBeVisible();
    await noSidewaysScroll(page);
    await shoot(page, 'customs-declaration-record-ar-mobile');
    await page.goto(`/logistics/ports/${encodeURIComponent(portCode)}`);
    await expect(page.locator('#port-document')).toBeVisible();
    await noSidewaysScroll(page);
    await shoot(page, 'port-profile-ar-mobile');
    await page.goto('/payables/invoices');
    await shoot(page, 'model-payables-invoices-ar-mobile');
    await context.close();
  });
});
