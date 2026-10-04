import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-AR-001 — Receivables in a browser (2026-10-04).
 *
 *   The four doors     a draft sales invoice, receipt, credit note and sales
 *                      return each wear Printer, Paperclip, Notes, Clock in
 *                      the title bar from the moment they exist; a file is
 *                      attached to the draft invoice and counted; a note is
 *                      added through the shared Notes door, listed, and on
 *                      the clock.
 *   The money          the invoice is posted, a receipt pays part of it, a
 *                      credit note takes 10 % off, a debit note adds a charge,
 *                      a return is raised against it.
 *   Profiles           the customer's name on every record and register
 *                      opens the customer's profile (Master Data › Customers);
 *                      the receipt's bank/cash account opens its own.
 *   Drill-down         ageing → customer → invoice → receipt → credits →
 *                      statement; statement row → source document; invoice →
 *                      receipts, credit notes, returns, remaining balance.
 *   The new screens    Credits & Advances, Credit / Debit Notes, Customer
 *                      Reconciliation, Receivables Ageing — at desktop width in
 *                      English and at phone width in Arabic, right to left.
 *
 * Codes carry a per-run suffix because the database persists between runs.
 * Requires `npm run db:seed` and the dev server.
 */

const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const CUSTOMER = 'CUS-00001';
const SHOTS = process.env.RECEIVABLES_SHOTS ?? '';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

async function signIn(page: Page) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

/** Clicks a document-row button and waits for the status it should leave behind. */
async function press(page: Page, name: string, status: string) {
  await page.getByRole('button', { name, exact: true }).first().click();
  await expect(page.locator(`[data-status="${status}"]`).first()).toBeVisible({ timeout: 60_000 });
}

/** Printer, paperclip, notes, clock — in the title bar, in that order, and nothing else. */
async function doors(page: Page, documentId: string) {
  const bar = page.locator(`#${documentId}`).locator('[class*="sapTitleActions"]').first();
  const titles = await bar.locator(':scope > button, :scope > a').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('title') ?? ''));
  expect(titles, `${documentId}: ${titles.join(', ')}`).toEqual(['Print / Export', 'Attachments', 'Notes', 'Audit log']);
}

/** A note through the shared door: back on the same record, listed, counted, and on the clock. */
async function note(page: Page, body: string) {
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Notes' });
  await expect(dialog.getByText('No notes yet.')).toBeVisible();
  await dialog.locator('input[name="note"]').fill(body);
  await dialog.getByRole('button', { name: 'Add note' }).click();
  await page.waitForURL(/saved=1/, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
  await page.getByRole('button', { name: 'Notes (1)' }).click();
  await expect(page.getByRole('dialog', { name: 'Notes' }).getByRole('cell', { name: body })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Audit log' }).click();
  await expect(page.getByRole('dialog', { name: 'Audit log' }).getByText(/note added/i).filter({ visible: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** The item carries its own stock and cost accounts — a posted sale needs them. */
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

/** As theme-readability.spec.ts: is this surface dark, and is the ink readable on it? */
function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((n) => {
    const c = color.startsWith('color(srgb') ? n : n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

let invoiceNo = '';
let receiptNo = '';
let creditNo = '';
let debitNo = '';
let returnNo = '';
let memoNo = '';

test.describe('REQ-AR-001 · receivables in a browser', () => {
  test('a draft sales invoice wears its doors and takes a file; posted, it owes', async ({ page }) => {
    await signIn(page);
    await itemAccounts(page);

    await page.goto('/sales/ar-invoices/new');
    await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });
    await page.getByLabel('Customer Code', { exact: true }).fill(CUSTOMER);
    await page.locator('input[name="item_code_0"]').fill('ITM-SEED');
    await page.locator('input[name="quantity_0"]').fill('2');
    await page.locator('input[name="unit_price_0"]').fill('50000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/sales\/ar-invoices\/INV-/, { timeout: 90_000 });
    invoiceNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);

    // Draft: the doors are there already.
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await doors(page, 'ar-invoice-document');
    await page.getByRole('button', { name: 'Attachments' }).click();
    await page.locator('dialog[open] input[name="file"]').setInputFiles({
      name: `order-${RUN}.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% customer order\n%%EOF\n'),
    });
    await page.locator('dialog[open]').getByRole('button', { name: 'Attach' }).click();
    await page.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Attachments (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="sales_invoice"] a[data-format="pdf"]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await note(page, `Customer asked for thirty days ${RUN}`);

    await press(page, 'Approve', 'approved');
    await press(page, 'Post', 'posted');
    await shoot(page, 'ar-invoice-desktop-en');
  });

  test('a draft receipt wears its doors; posted, it pays part of the invoice', async ({ page }) => {
    await signIn(page);
    await page.goto('/sales/customer-receipts/new');
    await page.getByLabel('Customer Code', { exact: true }).fill(CUSTOMER);
    await page.getByLabel('Bank/Cash Code', { exact: true }).fill('CASH-HQ');
    await page.getByLabel('Amount (IQD)', { exact: true }).fill('40000');
    await page.getByLabel('Reference', { exact: true }).fill(`TT-${RUN}`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/sales\/customer-receipts\/RCT-/, { timeout: 90_000 });
    receiptNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);

    await doors(page, 'receipt-document');
    // The bank/cash account is a link to its own profile (bank or cash, by the account's own type).
    const account = page.locator('#receipt-document a[href^="/master-data/"][href$="-accounts/CASH-HQ"]').first();
    await expect(account).toHaveAttribute('href', /\/master-data\/(bank|cash)-accounts\/CASH-HQ$/);
    await note(page, `Transfer slip on file ${RUN}`);

    await press(page, 'Approve', 'approved');
    await press(page, 'Post', 'posted');
    const row = page.locator('#receipt-document tbody tr', { hasText: invoiceNo });
    await row.locator('input[name="amount_iqd"]').fill('40000');
    await row.getByRole('button', { name: 'Allocate' }).click();
    await page.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(page.getByRole('link', { name: invoiceNo }).first()).toBeVisible();
    await shoot(page, 'customer-receipt-desktop-en');
  });

  test('a credit note takes 10,000 off the invoice; a debit note adds a charge', async ({ page }) => {
    await signIn(page);
    await page.goto(`/sales/credit-notes/new?kind=credit&customer=${CUSTOMER}`);
    const invoiceOption = await page.locator('select[name="ar_invoice_id"] option', { hasText: invoiceNo }).first().getAttribute('value');
    await page.locator('select[name="ar_invoice_id"]').selectOption(invoiceOption!);
    await page.locator('input[name="amount_iqd"]').fill('10000');
    await page.locator('input[name="reason"]').fill(`Allowance ${RUN}`);
    await page.getByRole('button', { name: 'Raise credit note' }).click();
    await page.waitForURL(/\/sales\/credit-notes\/CRN-/, { timeout: 90_000 });
    creditNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await doors(page, 'note-document');
    await note(page, `Agreed with the customer by phone ${RUN}`);
    await press(page, 'Approve', 'approved');
    // Posting applies it to the invoice in full (D-AR-7), so it is settled at once.
    await press(page, 'Post', 'settled');
    await expect(page.locator('#note-document').getByRole('link', { name: invoiceNo }).first()).toBeVisible();
    await shoot(page, 'credit-note-desktop-en');

    await page.goto(`/sales/credit-notes/new?kind=debit&customer=${CUSTOMER}`);
    await page.locator('input[name="amount_iqd"]').fill('3000');
    await page.locator('input[name="reason"]').fill(`Freight ${RUN}`);
    await page.getByRole('button', { name: 'Raise debit note' }).click();
    await page.waitForURL(/\/sales\/credit-notes\/DBN-/, { timeout: 90_000 });
    debitNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);
    await press(page, 'Approve', 'approved');
    await press(page, 'Post', 'posted');
  });

  test('a sales return wears its doors from the moment it is raised', async ({ page }) => {
    await signIn(page);
    await page.goto(`/sales/sales-returns/new?invoice=${encodeURIComponent(invoiceNo)}`);
    const quantity = page.locator('input[name^="quantity_"]').first();
    await expect(quantity).toBeVisible({ timeout: 60_000 });
    await quantity.fill('1');
    await page.locator('input[name="reason"]').fill(`One unit cracked ${RUN}`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/sales\/sales-returns\/SRN-/, { timeout: 90_000 });
    returnNo = decodeURIComponent(page.url().split('/').pop()!.split('?')[0]!);
    await doors(page, 'sales-return-document');
    await note(page, `Goods back in the yard ${RUN}`);
    await shoot(page, 'sales-return-desktop-en');
  });

  test('the invoice shows its receipts, credit notes, return and what is left', async ({ page }) => {
    await signIn(page);
    await page.goto(`/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`);
    const activity = page.locator('section[aria-labelledby="invoice-activity-title"]');
    await expect(activity.getByRole('link', { name: receiptNo })).toBeVisible();
    await expect(activity.getByRole('link', { name: creditNo })).toBeVisible();
    await expect(activity.getByRole('link', { name: returnNo })).toBeVisible();
    // 100,000 − 40,000 received − 10,000 credited = 50,000 left.
    await expect(activity.locator('tfoot')).toContainText('50,000');

    await activity.getByRole('link', { name: receiptNo }).click();
    await page.waitForURL(new RegExp(`/sales/customer-receipts/${receiptNo}`));
    await page.goto(`/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`);
    await page.locator('section[aria-labelledby="invoice-activity-title"]').getByRole('link', { name: returnNo }).click();
    await page.waitForURL(new RegExp(`/sales/sales-returns/${returnNo}`));
  });

  test('ageing → customer → invoice → receipt → credits → statement → source document', async ({ page }) => {
    await signIn(page);
    await page.goto('/sales/receivables');
    for (const label of ['Gross receivables', 'Not yet due', 'Overdue', 'Unapplied credits', 'Net position']) {
      await expect(page.getByText(label, { exact: false }).filter({ visible: true }).first()).toBeVisible();
    }
    await shoot(page, 'receivables-ageing-desktop-en');

    // The customer narrows the ageing to their own items.
    const row = page.locator('tr', { hasText: invoiceNo }).first();
    await row.getByRole('link').first().click();
    await page.waitForURL(/\/sales\/receivables\?.*code=CUS-00001/);
    await expect(page.getByRole('link', { name: invoiceNo }).first()).toBeVisible();

    // The customer's profile, statement and credits are a click away.
    await expect(page.locator('a[href*="/sales/customers/CUS-00001"]').first()).toBeVisible();
    await page.getByRole('link', { name: invoiceNo }).first().click();
    await page.waitForURL(new RegExp(`/sales/ar-invoices/${invoiceNo}`));

    await page.goto(`/sales/receivables?code=${CUSTOMER}`);
    await page.getByRole('link', { name: receiptNo }).first().click();
    await page.waitForURL(new RegExp(`/sales/customer-receipts/${receiptNo}`));

    await page.goto(`/sales/customer-credits?code=${CUSTOMER}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shoot(page, 'customer-credits-desktop-en');

    await page.goto(`/sales/customer-statements?code=${CUSTOMER}`);
    const statement = page.locator('table').first();
    await expect(statement.getByRole('link', { name: creditNo })).toBeVisible({ timeout: 60_000 });
    await expect(statement.getByRole('link', { name: debitNo })).toBeVisible();
    await statement.getByRole('link', { name: creditNo }).click();
    await page.waitForURL(new RegExp(`/sales/credit-notes/${creditNo}`));
  });

  test('credit / debit notes and the reconciliation read the same subledger', async ({ page }) => {
    await signIn(page);
    await page.goto('/sales/credit-notes');
    await expect(page.getByRole('link', { name: creditNo })).toBeVisible();
    await expect(page.getByRole('link', { name: debitNo })).toBeVisible();
    await shoot(page, 'credit-notes-desktop-en');

    await page.goto('/sales/customer-reconciliation');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shoot(page, 'customer-reconciliation-desktop-en');
  });

  test('an accepted return settles into a credit memo that wears the doors and names its customer', async ({ page }) => {
    await signIn(page);
    await page.goto(`/sales/sales-returns/${encodeURIComponent(returnNo)}`);
    // One press: received, inspected as saleable, accepted, the memo raised,
    // posted and applied to the invoice (block 9's journal is one act).
    await press(page, 'Accept', 'approved');

    // The register lists the memo beside the notes, against its invoice.
    await page.goto('/sales/credit-notes');
    const row = page.locator('tr', { hasText: 'Credit memo (sales return)' }).filter({ hasText: invoiceNo }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    memoNo = (await row.locator('a[href^="/sales/credit-notes/CCM-"]').first().textContent())!.trim();
    await row.locator('a[href^="/sales/credit-notes/CCM-"]').first().click();
    await page.waitForURL(new RegExp(`/sales/credit-notes/${memoNo}`));

    // Read-only, but with the four doors, a note, and its parties linked.
    await doors(page, 'memo-document');
    await note(page, `Memo checked against the return ${RUN}`);
    const memo = page.locator('#memo-document');
    await expect(memo.locator(`a[href="/sales/customers/${CUSTOMER}?role=customer"]`).first()).toBeVisible();
    // The invoice twice: as the header's field and as the line the memo was applied to.
    await expect(memo.getByRole('link', { name: invoiceNo })).toHaveCount(2);
    await expect(memo.getByRole('link', { name: returnNo })).toBeVisible();
    await shoot(page, 'credit-memo-desktop-en');

    // And the invoice lists the memo among what was credited against it.
    await page.goto(`/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`);
    await expect(page.locator('section[aria-labelledby="invoice-activity-title"]').getByRole('link', { name: memoNo })).toBeVisible();
  });

  test('status chips on the receivables screens follow the palette into the dark', async ({ page }) => {
    await signIn(page);
    for (const route of [
      '/sales/receivables',
      '/sales/customer-credits?show=all',
      '/sales/credit-notes',
      `/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`,
      `/sales/customer-receipts/${encodeURIComponent(receiptNo)}`,
      `/sales/credit-notes/${encodeURIComponent(creditNo)}`,
      `/sales/sales-returns/${encodeURIComponent(returnNo)}`,
    ]) {
      await page.goto(route);
      await page.locator('.erp-root').evaluate((root) => {
        (root as HTMLElement).dataset.palette = 'midnight';
        (root as HTMLElement).dataset.accent = 'gold';
      });
      const chips = await page.locator('[data-status]').evaluateAll((els) =>
        els
          .filter((el) => (el.textContent?.trim().length ?? 0) > 0)
          .map((el) => ({ text: el.textContent!.trim(), background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color })),
      );
      expect(chips.length, `${route} draws a status`).toBeGreaterThan(0);
      for (const chip of chips) {
        expect(luminance(chip.background), `${route} · ${chip.text} background is dark`).toBeLessThan(0.35);
        expect(contrast(chip.color, chip.background), `${route} · ${chip.text} is readable`).toBeGreaterThan(4.5);
      }
    }
  });

  test('the customer on every record and register opens the customer’s profile', async ({ page }) => {
    await signIn(page);
    const profile = new RegExp(`/sales/customers/${CUSTOMER}\\?role=customer`);
    for (const [route, scope] of [
      [`/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`, '#ar-invoice-document'],
      [`/sales/customer-receipts/${encodeURIComponent(receiptNo)}`, '#receipt-document'],
      [`/sales/credit-notes/${encodeURIComponent(creditNo)}`, '#note-document'],
      [`/sales/sales-returns/${encodeURIComponent(returnNo)}`, '#sales-return-document'],
      ['/sales/ar-invoices', 'main'],
      ['/sales/customer-receipts', 'main'],
      ['/sales/credit-notes', 'main'],
      ['/sales/sales-returns', 'main'],
      [`/sales/customer-credits?code=${CUSTOMER}`, 'main'],
      [`/sales/receivables?code=${CUSTOMER}`, 'main'],
      ['/sales/customer-reconciliation', 'main'],
      ['/sales/customer-statements', 'main'],
    ] as const) {
      await page.goto(route);
      const link = page.locator(scope).locator(`a[href*="/sales/customers/${CUSTOMER}"]`).first();
      await expect(link, route).toHaveAttribute('href', profile);
    }
    // The return names its invoice, and the receipt its bank/cash account.
    await page.goto(`/sales/sales-returns/${encodeURIComponent(returnNo)}`);
    await expect(page.locator('#sales-return-document').getByRole('link', { name: invoiceNo })).toBeVisible();
    await page.locator(`a[href*="/sales/customers/${CUSTOMER}"]`).first().click();
    await page.waitForURL(profile);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(CUSTOMER);
  });

  test('holds the line at phone width, in Arabic, right to left', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await context.addCookies([{ name: 'erp-locale', value: 'ar', url: page.url() }]);
    for (const [route, name] of [
      ['/sales/receivables', 'receivables-ageing'],
      ['/sales/customer-credits', 'customer-credits'],
      ['/sales/credit-notes', 'credit-notes'],
      ['/sales/customer-reconciliation', 'customer-reconciliation'],
      [`/sales/ar-invoices/${encodeURIComponent(invoiceNo)}`, 'ar-invoice'],
      [`/sales/customer-receipts/${encodeURIComponent(receiptNo)}`, 'customer-receipt'],
      [`/sales/credit-notes/${encodeURIComponent(creditNo)}`, 'credit-note'],
      [`/sales/sales-returns/${encodeURIComponent(returnNo)}`, 'sales-return'],
      [`/sales/credit-notes/${encodeURIComponent(memoNo)}`, 'credit-memo'],
    ] as const) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await noSidewaysScroll(page);
      await shoot(page, `${name}-mobile-ar`);
    }
  });
});
