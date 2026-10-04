import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-ACC-001 Part D — the Accounting screens, in a browser.
 *
 * One serial journey on the seeded database (`npm run db:seed`): a cash float
 * is opened beside the seeded bank, money is moved into it by an Internal
 * Transfer (raised by the manager, agreed by the Super User, posted), and
 * every new screen opens with its doors and its links — Bank Reconciliation
 * (a statement entered and pasted), Payments & Receipts, Cash Forecast,
 * Account Reconciliation, Tax Codes, Period / Year-End Closing and Recurring
 * Journals. Screenshots go to /home/claude/shots/accounting when SHOTS is set.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const SHOTS = process.env.SHOTS ?? '';

let floatCode = '';
let transferNo = '';
let statementNo = '';
let taxCode = '';
let templateNo = '';

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

/** Opens a dialog by its button, waiting for the page to be able to act on it. */
async function openDialog(page: Page, name: string) {
  const button = page.getByRole('button', { name, exact: true }).first();
  await expect(button).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await button.click();
  // The open one: a page holds a dialog per button, and only one is open.
  const dialog = page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name }) });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The four doors in the title bar, in order: printer, paperclip, (notes), clock. */
async function expectDoors(page: Page) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  await expect(bar.getByRole('button', { name: 'Print / Export' })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Attachments/ })).toBeVisible();
  await expect(bar.getByRole('button', { name: /Audit log|History/ })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);
// A control that is not there fails in half a minute, not at the test's end.
test.use({ actionTimeout: 30_000 });

test.describe('REQ-ACC-001 · the Accounting screens', () => {
  test('1 · a cash float is opened beside the seeded bank', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/master-data/cash-accounts');
    const dialog = await openDialog(page, 'New cash account');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Petty cash ${RUN}`);
    const gl = dialog.getByLabel('G/L account');
    // A free asset account that is not the stock's — the seed's inventory
    // account would be a float that moves the inventory figure.
    const free = await gl.locator('option').filter({ hasText: /^A/ }).filter({ hasNotText: /Inventory/ }).first().getAttribute('value');
    test.skip(!free, 'no free asset account on the chart for a second float');
    await gl.selectOption(free!);
    await dialog.getByLabel('Custodian').selectOption({ index: 0 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/cash-accounts\/CASH-/, { timeout: 60_000 });
    floatCode = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
    // Its G/L account opens its own record.
    await expect(page.getByRole('link', { name: /A\d+ · / }).first()).toHaveAttribute('href', /\/master-data\/chart-of-accounts\/A\d+/);
  });

  test('2 · an internal transfer is raised, agreed by somebody else, posted, and wears its doors', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/treasury/transfers');
    await expect(page.getByRole('heading', { name: 'Internal Transfers', level: 1 })).toBeVisible({ timeout: 60_000 });
    await shot(page, 'transfers-list-en');
    const dialog = await openDialog(page, 'New transfer');
    const from = await dialog.getByLabel('From account').locator('option').filter({ hasText: 'CASH-HQ' }).first().getAttribute('value');
    await dialog.getByLabel('From account').selectOption(from!);
    const to = await dialog.getByLabel('To account').locator('option').filter({ hasText: `Petty cash ${RUN}` }).first().getAttribute('value');
    await dialog.getByLabel('To account').selectOption(to!);
    await dialog.getByRole('textbox', { name: 'Amount sent', exact: true }).fill('125000');
    await dialog.getByRole('textbox', { name: 'Bank reference', exact: true }).fill(`E2E-${RUN}`);
    await dialog.getByRole('button', { name: 'Create transfer' }).click();
    await page.waitForURL(/\/treasury\/transfers\/BTR-/, { timeout: 60_000 });
    transferNo = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
    expect(transferNo).toMatch(/^BTR-/);
    await expectDoors(page);
    // The manager raised it, so the manager is not offered Approve.
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    // The accounts are links to their profiles.
    await expect(page.getByRole('link', { name: /CASH-HQ/ }).first()).toHaveAttribute('href', /\/master-data\/bank-accounts\/CASH-HQ/);
    await shot(page, 'transfer-record-en');

    await signIn(page, ADMIN);
    await page.goto(`/treasury/transfers/${transferNo}`);
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    // The journal it posted is a link.
    await expect(page.getByRole('link', { name: /JE-/ }).first()).toBeVisible();
  });

  test('3 · a bank statement is entered, pasted into, closed and reconciled', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/treasury/bank-reconciliation');
    await expect(page.getByRole('heading', { name: 'Bank Reconciliation', level: 1 })).toBeVisible({ timeout: 60_000 });
    const dialog = await openDialog(page, 'New statement');
    const bank = await dialog.getByLabel('Bank account').locator('option').filter({ hasText: 'CASH-HQ' }).first().getAttribute('value');
    await dialog.getByLabel('Bank account').selectOption(bank!);
    // A period of its own each run, so a second run does not meet the first.
    const day = String((parseInt(RUN, 36) % 27) + 1).padStart(2, '0');
    await dialog.getByRole('textbox', { name: 'Period from', exact: true }).fill(`2026-03-${day}`);
    await dialog.getByRole('textbox', { name: 'Period to', exact: true }).fill(`2026-03-${day}`);
    await dialog.getByRole('textbox', { name: 'Opening balance', exact: true }).fill('0');
    await dialog.getByRole('textbox', { name: 'Closing balance', exact: true }).fill('-125000');
    await dialog.getByRole('button', { name: 'Create statement' }).click();
    await page.waitForURL(/\/treasury\/bank-reconciliation\/BST-/, { timeout: 60_000 });
    statementNo = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
    await expectDoors(page);

    const paste = await openDialog(page, 'Paste lines');
    await paste.getByRole('textbox', { name: 'Statement lines', exact: true }).fill(`booking_date,amount_iqd,reference\n2026-03-${day},-125000,E2E-${RUN}\nnot-a-date,5,BAD`);
    await paste.getByRole('button', { name: 'Paste lines' }).click();
    await expect(page.getByText('Rows that could not be read')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Close statement' }).click();
    await expect(page.getByText('Ready to reconcile').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Start reconciliation' }).click();
    await expect(page.getByRole('heading', { name: 'Still unmatched' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: /CASH-HQ/ }).first()).toBeVisible();
    await shot(page, 'reconciliation-record-en');
  });

  test('4 · the three reads open, each with its links', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/treasury/payments-receipts?from=2026-01-01&to=2026-12-31');
    await expect(page.getByRole('heading', { name: 'Payments & Receipts', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('link', { name: transferNo }).first()).toBeVisible();
    await shot(page, 'payments-receipts-en');

    await page.goto('/treasury/cash-forecast');
    await expect(page.getByRole('heading', { name: 'Cash Forecast', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'What the forecast draws on' })).toBeVisible();
    await shot(page, 'cash-forecast-en');

    await page.goto('/finance/account-reconciliation');
    await expect(page.getByRole('heading', { name: 'Account Reconciliation', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Inventory value' })).toBeVisible();
    await shot(page, 'account-reconciliation-en');
  });

  test('5 · a tax code is created with its first rate and wears its doors', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/master-data/tax-codes');
    await expect(page.getByRole('heading', { name: 'Tax Codes', level: 1 })).toBeVisible({ timeout: 60_000 });
    const dialog = await openDialog(page, 'New tax code');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Output VAT ${RUN}`);
    await dialog.getByLabel('Treatment').selectOption('output');
    await dialog.getByLabel('Recoverable').selectOption('yes');
    // A liability account the seed carries; its own run's, so recoverability never clashes.
    const account = dialog.getByLabel('G/L account');
    const option = await account.locator('option').filter({ hasText: /^L/ }).first().getAttribute('value');
    await account.selectOption(option!);
    await dialog.getByRole('textbox', { name: 'Rate', exact: true }).fill('15');
    await dialog.getByRole('button', { name: 'Create tax code' }).click();
    await page.waitForURL(/\/master-data\/tax-codes\/TAX-/, { timeout: 60_000 });
    taxCode = page.url().split('/').pop()!;
    await expectDoors(page);
    await expect(page.getByText('15%').first()).toBeVisible();
    await shot(page, 'tax-code-record-en');
  });

  test('6 · the close checklist and its history', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/finance/closing');
    await expect(page.getByRole('heading', { name: 'Period / Year-End Closing', level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Close history' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sub-ledgers equal their control accounts' })).toBeVisible();
    await shot(page, 'closing-en');
  });

  test('7 · a recurring journal is written, agreed by somebody else, and wears its doors', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/finance/recurring-journals');
    await expect(page.getByRole('heading', { name: 'Recurring Journals', level: 1 })).toBeVisible({ timeout: 60_000 });
    const dialog = await openDialog(page, 'New recurring journal');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Rent ${RUN}`);
    await dialog.getByLabel('Frequency').selectOption('monthly');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/finance\/recurring-journals\/RJ-/, { timeout: 60_000 });
    templateNo = page.url().split('/').pop()!;
    await expectDoors(page);

    for (const [side, prefix] of [
      ['debit', /^X/],
      ['credit', /^L/],
    ] as const) {
      const line = await openDialog(page, 'Add line');
      const account = line.getByLabel('Account', { exact: true });
      const value = await account.locator('option').filter({ hasText: prefix }).first().getAttribute('value');
      await account.selectOption(value!);
      await line.getByLabel('Side').selectOption(side);
      await line.getByRole('textbox', { name: 'Amount', exact: true }).fill('1000');
      await line.getByRole('button', { name: 'Add line' }).click();
      await expect(page.getByRole('status')).toContainText('Saved', { timeout: 30_000 });
    }
    await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
    // Written by the manager, so the manager is not offered to agree to it.
    await expect(page.getByRole('button', { name: 'Agree and start' })).toHaveCount(0);
    await shot(page, 'recurring-record-en');

    await signIn(page, ADMIN);
    await page.goto(`/finance/recurring-journals/${templateNo}`);
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'Agree and start' }).click();
    await expect(page.getByText('Active', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('8 · the journal record wears its doors', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto('/finance/journals/OPEN-DEV-2026');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await expectDoors(page);
  });

  test('9 · every new screen reads right to left at a phone’s width with no sideways scroll', async ({ page, context }) => {
    await signIn(page, ADMIN);
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    const routes: [string, string][] = [
      ['/treasury/transfers', 'transfers-list-ar-mobile'],
      [`/treasury/transfers/${transferNo}`, 'transfer-record-ar-mobile'],
      ['/treasury/bank-reconciliation', 'reconciliation-list-ar-mobile'],
      [`/treasury/bank-reconciliation/${statementNo}`, 'reconciliation-record-ar-mobile'],
      ['/treasury/payments-receipts', 'payments-receipts-ar-mobile'],
      ['/treasury/cash-forecast', 'cash-forecast-ar-mobile'],
      ['/finance/account-reconciliation', 'account-reconciliation-ar-mobile'],
      ['/master-data/tax-codes', 'tax-codes-ar-mobile'],
      ...(taxCode ? ([[`/master-data/tax-codes/${taxCode}`, 'tax-code-record-ar-mobile']] as [string, string][]) : []),
      ['/finance/closing', 'closing-ar-mobile'],
      ['/finance/recurring-journals', 'recurring-list-ar-mobile'],
      [`/finance/recurring-journals/${templateNo}`, 'recurring-record-ar-mobile'],
    ];
    const wide: string[] = [];
    for (const [route, name] of routes) {
      const response = await page.goto(route, { waitUntil: 'networkidle' });
      expect(response?.status(), route).toBeLessThan(400);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 }).first(), route).toBeVisible({ timeout: 45_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 390) wide.push(`${route}: ${width}px`);
      await shot(page, name);
    }
    expect(wide, 'screens wider than the phone').toEqual([]);
  });

  // The float sorts ahead of the seeded bank (CASH-0… < CASH-HQ), and other
  // journeys pay from the first account offered — so it is taken out of use.
  test('10 · the float is taken out of use, so other journeys pay from the bank', async ({ page }) => {
    test.skip(!floatCode, 'no float was opened');
    await signIn(page, ADMIN);
    await page.goto(`/master-data/cash-accounts/${encodeURIComponent(floatCode)}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('textbox', { name: /^Reason/ }).fill('E2E float closed');
    await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reactivate', exact: true })).toBeVisible({ timeout: 30_000 });
  });
});
