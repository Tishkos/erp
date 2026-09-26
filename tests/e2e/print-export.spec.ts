import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readPdf, readWord, readWorkbook } from '../support/export-files';

/**
 * Print / Export, in a browser, the way a person uses it.
 *
 * A Purchase Invoice is raised, sent for approval and posted by the CEO; a
 * Sales Invoice gives a customer something on their statement. Then, in
 * English and again with the whole application in Arabic, the invoice and the
 * Customer Statement are downloaded from their Print / Export menus as PDF,
 * Excel and Word — and each file is opened and read back: the number is on
 * it, and so is the total.
 *
 * Requires `npm run db:seed` (ITM-SEED in WH-HQ, the CEO, the mappings).
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const CEO = { email: 'ceo@example.com', password: 'Ledger-Trial-Balance-7' };

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = TODAY.slice(0, 4);

let invoiceNo = '';
let customerCode = '';
let salesNo = '';

async function signIn(page: Page, user: { email: string; password: string }, locale: 'en' | 'ar' = 'en') {
  await page.context().clearCookies();
  await page.context().addCookies([{ name: 'erp-locale', value: locale, url: 'http://localhost:3000' }]);
  await page.goto('/sign-in');
  await page.locator('input[type="email"], input[name="email"]').first().fill(user.email);
  await page.locator('input[type="password"]').first().fill(user.password);
  await page.locator('form button[type="submit"]').first().click();
  await page.waitForURL('/', { timeout: 120_000 });
}

async function as(browser: Browser, user: { email: string; password: string }, work: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await signIn(page, user);
    await work(page);
  } finally {
    await context.close();
  }
}

const minted = (page: Page) => decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);

/** A press that waits for the document's status to say it worked. */
async function press(page: Page, name: string, status: string) {
  const done = () => page.getByText(status, { exact: true }).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await done().isVisible().catch(() => false)) return;
    const button = page.getByRole('button', { name, exact: true }).first();
    await expect(button).toBeEnabled({ timeout: 30_000 });
    await button.click();
    try {
      await expect(done()).toBeVisible({ timeout: 45_000 });
      return;
    } catch {
      await page.reload();
    }
  }
  await expect(done()).toBeVisible({ timeout: 30_000 });
}

/** Every format of one menu, in one language, as files read back. */
async function downloadAll(page: Page, key: string, lang: 'en' | 'ar') {
  const menu = page.locator(`[data-export-menu="${key}"]`).first();
  await expect(menu).toBeVisible({ timeout: 60_000 });
  const files: Record<string, { name: string; data: Buffer }> = {};
  for (const format of ['pdf', 'xlsx', 'docx'] as const) {
    if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) {
      await menu.locator('summary').click();
    }
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
      menu.locator(`a[data-format="${format}"][data-lang="${lang}"]`).click(),
    ]);
    files[format] = { name: download.suggestedFilename(), data: readFileSync((await download.path())!) };
  }
  return files as Record<'pdf' | 'xlsx' | 'docx', { name: string; data: Buffer }>;
}

test('a Purchase Invoice is raised, sent for approval, and posted by the CEO', async ({ browser }) => {
  let supplierCode = '';
  await as(browser, MANAGER, async (page) => {
    await page.goto('/master-data/suppliers');
    await page.getByRole('button', { name: 'New supplier' }).click();
    const dialog = page.locator('dialog[open], [role="dialog"]').first();
    await dialog.getByLabel(/^Legal name/).fill(`Print Supplier ${RUN}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/business-partners\/[^/?]+/, { timeout: 60_000 });
    supplierCode = minted(page);

    await page.goto('/purchasing/ap-invoices/new');
    await page.getByLabel('Supplier Code').fill(supplierCode);
    const due = page.locator('input[name="due_date"]');
    if (!(await due.inputValue())) await due.fill(TODAY);
    await page.locator('select[name="item_code_0"]').selectOption('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('3');
    await page.getByLabel('Unit Price').first().fill('2500');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL((url) => /\/purchasing\/ap-invoices\/(?!new$)[^/]+$/.test(url.pathname) && url.search === '', {
      timeout: 120_000,
    });
    invoiceNo = minted(page);
    await press(page, 'Send for approval', 'Pending approval');
  });

  await as(browser, CEO, async (page) => {
    await page.goto(`/purchasing/ap-invoices/${encodeURIComponent(invoiceNo)}`);
    await press(page, 'Approve and post', 'Posted');
  });
  expect(invoiceNo).toMatch(/^API-/);
});

test('a Sales Invoice puts something on the customer’s statement', async ({ browser }) => {
  await as(browser, MANAGER, async (page) => {
    await page.goto('/master-data/customers');
    await page.getByRole('button', { name: 'New customer' }).click();
    const dialog = page.locator('dialog[open], [role="dialog"]').first();
    await dialog.getByLabel(/^Legal name/).fill(`Print Customer ${RUN}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/business-partners\/[^/?]+/, { timeout: 60_000 });
    customerCode = minted(page);

    await page.goto('/sales/ar-invoices/new');
    await page.getByLabel('Customer Code').fill(customerCode);
    const due = page.locator('input[name="due_date"]');
    if (!(await due.inputValue())) await due.fill(TODAY);
    await page.locator('input[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('1');
    await page.getByLabel('Unit Price').first().fill('9000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL((url) => /\/sales\/ar-invoices\/(?!new$)[^/]+$/.test(url.pathname) && url.search === '', {
      timeout: 120_000,
    });
    salesNo = minted(page);
  });

  await as(browser, CEO, async (page) => {
    await page.goto(`/sales/ar-invoices/${encodeURIComponent(salesNo)}`);
    await press(page, 'Approve', 'Approved');
    await press(page, 'Post', 'Posted');
  });
  expect(salesNo).toMatch(/^INV-/);
});

for (const lang of ['en', 'ar'] as const) {
  test(`${lang} · the posted Purchase Invoice downloads as PDF, Excel and Word, each with its number and total`, async ({
    page,
  }) => {
    await signIn(page, MANAGER, lang);
    await page.goto(`/purchasing/ap-invoices/${encodeURIComponent(invoiceNo)}`);
    const files = await downloadAll(page, 'purchase_invoice', lang);

    expect(files.pdf.name).toBe(`${invoiceNo}.pdf`);
    expect(files.xlsx.name).toBe(`${invoiceNo}.xlsx`);
    expect(files.docx.name).toBe(`${invoiceNo}.docx`);

    // 3 × 2,500.
    const pdf = readPdf(files.pdf.data);
    expect(pdf.text).toContain(invoiceNo);
    expect(pdf.text).toContain('7,500');
    expect(pdf.unmappedGlyphs).toBe(0);
    expect(pdf.text).not.toContain(lang === 'ar' ? [...'مسودة'].reverse().join('') : 'DRAFT');

    const book = readWorkbook(files.xlsx.data);
    expect(book.strings).toContain(invoiceNo);
    expect([...book.cells.values()].some((cell) => cell.formula && cell.number === 7_500)).toBe(true);
    expect(book.rightToLeft).toBe(lang === 'ar');

    const word = readWord(files.docx.data);
    expect(word.text).toContain(invoiceNo);
    expect(word.text).toContain('7,500');
    expect(/<w:bidiVisual\/>/.test(word.body)).toBe(lang === 'ar');
  });

  test(`${lang} · the Customer Statement downloads with the filters on screen, its document and its closing balance`, async ({
    page,
  }) => {
    await signIn(page, MANAGER, lang);
    await page.goto(`/sales/customer-statements?code=${encodeURIComponent(customerCode)}&from=${YEAR}-01-01&to=${YEAR}-12-31&currency=IQD`);
    const files = await downloadAll(page, 'customer_statement', lang);

    for (const file of Object.values(files)) expect(file.name).toContain(customerCode);

    const pdf = readPdf(files.pdf.data);
    expect(pdf.text).toContain(salesNo);
    expect(pdf.text).toContain('9,000');
    expect(pdf.text).toContain(customerCode);
    expect(pdf.unmappedGlyphs).toBe(0);

    const book = readWorkbook(files.xlsx.data);
    expect(book.strings).toContain(salesNo);
    expect([...book.cells.values()].some((cell) => cell.number === 9_000)).toBe(true);

    const word = readWord(files.docx.data);
    expect(word.text).toContain(salesNo);
    expect(word.text).toContain('9,000');
  });
}
