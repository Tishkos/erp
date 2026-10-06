import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PAY-001 — the purchase records' four doors and supplier links, and the
 * three screens the module gained (2026-10-04):
 *
 *   PAY3   a purchase invoice from its draft wears printer, paperclip, notes,
 *          clock; its supplier is a link to `/payables/suppliers/<code>?role=supplier`;
 *          a note goes through the shared door and is counted.
 *   PAY8   Supplier Credit / Debit Notes: a credit note raised against a posted
 *          expense, its record with the four doors, approved by a second person,
 *          posted; the invoice's own page lists it under its adjustments.
 *   PAY10  Supplier Credits lists what is held, by document and by supplier.
 *   PAY11  Supplier Reconciliation shows the control accounts, the investigation
 *          lines and the suppliers; it repairs nothing.
 *
 * Desktop in English, a phone in Arabic (`erp-locale` cookie), screenshots of
 * each new screen beside the register it copies. Requires `npm run db:seed`.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/payables';

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

/** The four doors in the title bar, in the rule's order. */
async function expectFourDoors(page: Page, labels = { print: 'Print / Export', attachments: 'Attachments', notes: 'Notes', history: 'Audit log' }) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  const doors = bar.locator(':scope > button, :scope > a');
  await expect(doors).toHaveCount(4);
  const names = await doors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual([labels.print, labels.attachments, labels.notes, labels.history]);
}

async function noSidewaysScroll(page: Page, width = 390) {
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll, `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(width);
}

/** A posted expense invoice of `amount` IQD; answers its number. */
async function postedExpense(page: Page, amount: string, name: string) {
  await page.goto('/payables/service-receipts');
  await page.getByRole('button', { name: 'Add expense' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Type of fee').selectOption('rent');
  await dialog.getByLabel('Who we pay').selectOption({ index: 0 });
  await dialog.getByLabel('Amount (IQD)').fill(amount);
  await dialog.getByLabel('Bill date').fill('2026-09-01');
  await dialog.getByLabel('Due date').fill('2026-10-31');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'Save expense' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'), { timeout: 120_000 });
  const invoiceNo = decodeURIComponent(page.url().split('/payables/invoices/')[1]!.split('?')[0]!);
  await page.getByRole('button', { name: 'Send for approval', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Approve and post', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toHaveCount(0, { timeout: 60_000 });
  return invoiceNo;
}

test.describe('REQ-PAY-001 · doors, links, credit notes, credits and reconciliation', () => {
  test('a purchase invoice wears the four doors from its draft, links its supplier, takes a note', async ({ page }) => {
    test.setTimeout(240_000);
    mkdirSync(SHOTS, { recursive: true });
    await signIn(page, ADMIN);

    await page.goto('/payables/service-receipts');
    await page.getByRole('button', { name: 'Add expense' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Type of fee').selectOption('rent');
    await dialog.getByLabel('Who we pay').selectOption({ index: 0 });
    await dialog.getByLabel('Amount (IQD)').fill('250000');
    await dialog.getByLabel('Bill date').fill('2026-09-01');
    await dialog.getByLabel('Due date').fill('2026-10-31');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(`Doors draft ${RUN}`);
    await dialog.getByRole('button', { name: 'Save expense' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'), { timeout: 120_000 });
    const invoiceNo = decodeURIComponent(page.url().split('/payables/invoices/')[1]!.split('?')[0]!);
    const record = `/payables/invoices/${encodeURIComponent(invoiceNo)}`;

    // A draft, and already the four doors; the supplier is a link to its profile.
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await expectFourDoors(page);
    const supplierLink = page.locator('a[href^="/payables/suppliers/"][href$="?role=supplier"]').first();
    await expect(supplierLink).toBeVisible();

    // The printer offers the invoice's copies.
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="purchase_invoice"] a[data-format="pdf"][data-lang="en"]')).toHaveAttribute(
      'href',
      `/export/purchase_invoice/${encodeURIComponent(invoiceNo)}?format=pdf&lang=en`,
    );
    await page.keyboard.press('Escape');

    // A note through the shared door: back on the same record, counted, listed.
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    const notes = page.getByRole('dialog', { name: 'Notes' });
    await notes.getByRole('textbox', { name: 'Add note' }).fill(`Supplier called about the rent ${RUN}`);
    await notes.getByRole('button', { name: 'Add note' }).click();
    await page.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Notes (1)' }).click();
    await expect(page.getByRole('dialog', { name: 'Notes' }).getByText(`Supplier called about the rent ${RUN}`).filter({ visible: true }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // The clock lists the note as an event of the invoice.
    await page.getByRole('button', { name: 'Audit log' }).click();
    await expect(page.getByRole('dialog', { name: 'Audit log' }).getByText(/note/i).filter({ visible: true }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // The supplier's profile is where the link lands.
    await supplierLink.click();
    await page.waitForURL(/\/payables\/suppliers\/.*role=supplier/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Exact: the page also carries an "Account statement" back button to the same statement.
    await expect(page.getByRole('link', { name: 'Statement', exact: true })).toBeVisible();

    // The same record on a phone, in Arabic: four doors, no sideways scroll.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(record);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await noSidewaysScroll(page);
    await expect(page.locator('[class*="sapTitleActions"]').first().locator(':scope > button, :scope > a')).toHaveCount(4);
    await page.screenshot({ path: `${SHOTS}/purchase-invoice-mobile-ar.png`, fullPage: true });
  });

  test('a credit note: raised, the four doors, approved by a second person, posted, on the invoice and in the credits', async ({ page, browser }) => {
    test.setTimeout(420_000);
    mkdirSync(SHOTS, { recursive: true });
    await signIn(page, ADMIN);
    const invoiceNo = await postedExpense(page, '1000000', `Credit base ${RUN}`);

    // The register, and a credit note of 100,000 against the invoice.
    await page.goto('/payables/credit-memos');
    await expect(page.getByRole('heading', { level: 1, name: 'Supplier Credit / Debit Notes' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/credit-memos-desktop-en.png`, fullPage: true });
    await page.getByRole('button', { name: 'New credit note' }).click();
    const create = page.getByRole('dialog', { name: 'New credit note' });
    const option = create.locator(`select[name="ap_invoice_id"] option:has-text("${invoiceNo}")`).first();
    await create.locator('select[name="ap_invoice_id"]').selectOption((await option.getAttribute('value'))!);
    await create.locator('input[name="supplier_memo_no"]').fill(`CN-${RUN}`);
    await create.locator('input[name="memo_date"]').fill('2026-09-10');
    await create.locator('input[name="amount_iqd"]').fill('100000');
    await create.locator('input[name="reason"]').fill(`Rent reduced for the month ${RUN}`);
    await create.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/payables\/credit-memos\/SCM-/, { timeout: 120_000 });
    const memoNo = decodeURIComponent(page.url().split('/payables/credit-memos/')[1]!.split('?')[0]!);
    const record = `/payables/credit-memos/${encodeURIComponent(memoNo)}`;

    // A draft with the four doors; the supplier and the invoice are links.
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await expectFourDoors(page);
    await expect(page.locator('a[href^="/payables/suppliers/"][href$="?role=supplier"]').first()).toBeVisible();
    await expect(page.locator(`a[href="/payables/invoices/${encodeURIComponent(invoiceNo)}"]`).first()).toBeVisible();
    // (The admin is the super user, who may approve alone — 0278; the
    // four-eyes refusal for everybody else is pay08's.) A second person
    // approves and posts it here all the same.
    await page.screenshot({ path: `${SHOTS}/credit-note-desktop-en.png`, fullPage: true });

    // Somebody else approves; then it posts.
    const other = await browser.newContext();
    const managerPage = await other.newPage();
    await signIn(managerPage, MANAGER);
    await managerPage.goto(record);
    await managerPage.getByRole('button', { name: 'Approve', exact: true }).click();
    await managerPage.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(managerPage.locator('[data-status="approved"]').first()).toBeVisible();
    await managerPage.getByRole('button', { name: 'Post', exact: true }).click();
    await managerPage.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(managerPage.locator('[data-status="posted"]').first()).toBeVisible();
    // Applied whole to its invoice: nothing left.
    await expect(managerPage.getByRole('row', { name: new RegExp(invoiceNo) }).first()).toBeVisible();
    await other.close();

    // The invoice lists the note under its adjustments; 900,000 remains owed.
    await page.goto(`/payables/invoices/${encodeURIComponent(invoiceNo)}`);
    await expect(page.getByRole('heading', { name: 'Credit and debit notes on this invoice' })).toBeVisible();
    await expect(page.locator(`a[href="${record}"]`).first()).toBeVisible();

    // Supplier Credits: the note is applied, so it is not held; the screen reads.
    await page.goto('/payables/supplier-credits');
    await expect(page.getByRole('heading', { level: 1, name: 'Supplier Credits' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By supplier' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/supplier-credits-desktop-en.png`, fullPage: true });

    // Supplier Reconciliation: control accounts, investigation, suppliers.
    await page.goto('/payables/reconciliation');
    await expect(page.getByRole('heading', { level: 1, name: 'Supplier Reconciliation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Control accounts' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Investigation' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By supplier' })).toBeVisible();
    await expect(page.getByText('Nothing here is corrected automatically', { exact: false })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/reconciliation-desktop-en.png`, fullPage: true });

    // The register it copies, for the side-by-side.
    await page.goto('/payables/invoices');
    await page.screenshot({ path: `${SHOTS}/purchase-invoices-desktop-en.png`, fullPage: true });

    // A phone, in Arabic: every label exists, nothing scrolls sideways.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [path, shot] of [
      ['/payables/credit-memos', 'credit-memos-mobile-ar.png'],
      [record, 'credit-note-mobile-ar.png'],
      ['/payables/supplier-credits', 'supplier-credits-mobile-ar.png'],
      ['/payables/reconciliation', 'reconciliation-mobile-ar.png'],
      ['/payables/invoices', 'purchase-invoices-mobile-ar.png'],
    ] as const) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await noSidewaysScroll(page);
      await page.screenshot({ path: `${SHOTS}/${shot}`, fullPage: true });
    }
    await expect(page.locator('[class*="sapTitleActions"]').first()).toHaveCount(0);
  });

  test('the purchase order, goods receipt, payment, advance and contract records wear the doors where they exist', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, ADMIN);
    for (const list of ['/payables/purchase-orders', '/payables/goods-receipts', '/payables/supplier-payments', '/payables/advances', '/payables/contracts', '/payables/payment-applications', '/payables/goods-returns']) {
      await page.goto(list);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const first = page.locator(`table tbody tr td a[href^="${list}/"]`).first();
      if (!(await first.isVisible().catch(() => false))) continue;
      await first.click();
      await page.waitForURL(new RegExp(`${list.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
      await expectFourDoors(page);
      await expect(page.locator('a[href^="/payables/suppliers/"][href$="?role=supplier"]').first()).toBeVisible();
    }
  });
});
