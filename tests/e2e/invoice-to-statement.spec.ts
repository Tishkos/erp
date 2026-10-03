import { expect, test, type Page } from '@playwright/test';

/**
 * From the invoice to the statement, both sides, in a browser.
 *
 * The sponsor's report (2026-09-22): *"supplier account statement did not show
 * any data even when I created the AP invoice."* Everything between those two
 * facts is configuration — the account, its control designation, the posting
 * mapping — and each piece was provable on its own while the chain was not.
 * This walks it end to end on the screens a person uses:
 *
 *   an account            under Liabilities, approved
 *   a control account     "this account is the supplier subledger"
 *   a posting mapping     "what the company owes the supplier posts here"
 *   an invoice            raised, sent for approval, posted
 *   the statement         the supplier's own account, with the invoice on it
 *
 * Break any link and the statement is empty, which is exactly what was
 * reported — so the test asserts the last screen rather than the first.
 *
 * Requires `npm run db:seed`.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

const RUN = Date.now().toString(36).toUpperCase().slice(-5);

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  expect(['localhost', '127.0.0.1']).toContain(new URL(page.url()).hostname);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/** Clicks, and waits for the page to say the thing that proves it worked. */
async function press(page: Page, name: string, expected: string | RegExp) {
  const done = () =>
    typeof expected === 'string'
      ? page.getByText(expected, { exact: true }).first()
      : page.getByText(expected).first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await done().isVisible().catch(() => false)) return;
    const button = page.getByRole('button', { name, exact: true }).first();
    if ((await button.count()) === 0) break;
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    try {
      await expect(done()).toBeVisible({ timeout: 30_000 });
      return;
    } catch {
      await page.reload();
      await page.waitForTimeout(2_000);
    }
  }
  await expect(done()).toBeVisible({ timeout: 30_000 });
}

/**
 * A postable account under `parent`, approved and designated.
 *
 * Approved by the manager who raised it: the chart's own separation is proved
 * in the 02.1 suites, and re-proving it here would only make this test about
 * something else.
 */
async function controlAccount(
  page: Page,
  parent: RegExp,
  name: string,
  kind: 'Supplier' | 'Customer',
): Promise<string> {
  await page.goto('/master-data/chart-of-accounts');
  await page.getByRole('button', { name: 'New account' }).click();
  const dialog = page.locator('dialog[open], [role="dialog"]').first();
  const under = dialog.getByLabel('Under', { exact: true });
  const parentValue = await under
    .locator('option:not([disabled])')
    .filter({ hasText: parent })
    .first()
    .getAttribute('value');
  await under.selectOption(parentValue!);
  await dialog.getByLabel(/^Name/).fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, { timeout: 60_000 });
  const code = page.url().split('/').pop()!.split('?')[0]!;

  await press(page, 'Submit for approval', 'Pending approval');
  await press(page, 'Approve', 'Approved');

  // The designation is what makes the subledger exist: `writeForJournal` only
  // writes an entry for a line that hits a control account.
  //
  // Scoped to its own panel: the account's record carries several Save
  // buttons, and the first one on the page belongs to the name.
  //
  // The approval left `saved=1` in the address; open the record afresh so the
  // wait below is for this save's own redirect, not the last one's.
  const record = `/master-data/chart-of-accounts/${code}`;
  await page.goto(record);
  const designation = page.locator('form:has(select[name="controlAccount"])').first();
  await designation.locator('select[name="controlAccount"]').selectOption(kind);
  await designation.locator('button[type="submit"]').first().click();
  await page.waitForURL(/[?&]saved=1/, { timeout: 60_000 });
  await page.goto(record);
  await expect(page.locator('select[name="controlAccount"]')).toHaveValue(kind.toLowerCase());

  return code;
}

/**
 * The accounts an item carries itself — where its stock is held, and what it
 * cost when sold. §3.3 maps what is *not* on a record; these are.
 */
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
    await page.waitForLoadState('networkidle');
  }
}

/**
 * A partner, named and saved. Its code is the system's (Critical Rule 1), so
 * it is read off the record the save opens and handed back.
 */
async function createPartner(page: Page, screen: string, button: string, name: string) {
  await page.goto(screen);
  await page.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.locator('dialog[open], [role="dialog"]').first();
  await dialog.getByLabel(/^Legal name/).fill(`${name} Limited`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/(?:payables\/suppliers|sales\/customers)\/[^/?]+/, { timeout: 60_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
}

/** The statement's own figures, read from the screen a person opens. */
const STATEMENT = {
  supplier: '/payables/supplier-statements',
  customer: '/sales/customer-statements',
} as const;

async function statementOf(page: Page, code: string, side: 'supplier' | 'customer') {
  await page.goto(`${STATEMENT[side]}?code=${code}`);
  await expect(page.getByRole('heading', { name: new RegExp(code) }).first()).toBeVisible({
    timeout: 60_000,
  });
  return page.locator('table tbody tr');
}

test.describe('a purchase invoice reaches the supplier statement', () => {
  let supplierCode = '';
  let payableCode = '';

  test('the payable account is designated as the supplier subledger', async ({ page }) => {
    await signIn(page, MANAGER);
    payableCode = await controlAccount(
      page,
      /Liabilit/,
      `E2E Trade Payables ${RUN}`,
      'Supplier',
    );
    expect(payableCode).toMatch(/^L\d+$/);
  });

  test('the invoice posts, and the supplier statement shows it', async ({ page }) => {
    await signIn(page, ADMIN);
    supplierCode = await createPartner(page, '/master-data/suppliers', 'New supplier', `E2E Supplier ${RUN}`);

    // The item holds its own inventory account — the direct route debits it
    // rather than a mapping (§3.3 answers what is *not* on a record).
    await page.goto('/master-data/items/ITM-SEED');
    await itemAccounts(page);

    await page.goto('/payables/invoices/new');
    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByLabel('Supplier Code', { exact: true }).fill(supplierCode);

    // The account this invoice keeps the supplier's balance on — chosen here,
    // on the form that raises it (by direction, 2026-09-23).
    const payable = page.locator('select[name="payable_account_id"]');
    await payable.selectOption(
      (await payable
        .locator('option')
        .filter({ hasText: payableCode })
        .first()
        .getAttribute('value'))!,
    );

    // The grid names its item in a picker on one screen and a list on the
    // other; the test types where it can and chooses where it must.
    const itemField = page.locator('select[name="item_code_0"], input[name="item_code_0"]').first();
    if ((await itemField.evaluate((node) => node.tagName)) === 'SELECT') {
      await itemField.selectOption('ITM-SEED');
    } else {
      await itemField.fill('ITM-SEED');
    }
    await page.locator('input[name="quantity_0"]').fill('3');
    await page.locator('input[name="unit_price_0"]').fill('2500');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    // A local purchase: the Import box starts ticked since 2026-10-03.
    await page.locator('input[name="is_import"]').uncheck();
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/payables\/invoices\/API-/, { timeout: 90_000 });

    // Exact status words: the record page carries "Posted by" and
    // "Waiting for approval" as labels, and a loose match on those would
    // report success without pressing anything.
    await press(page, 'Send for approval', 'Pending approval');
    await press(page, 'Approve and post', 'Posted');

    // The whole point: the supplier's own account, with the invoice on it.
    const rows = await statementOf(page, supplierCode, 'supplier');
    await expect(rows).not.toHaveCount(1);
    await expect(rows.filter({ hasText: '7,500' })).not.toHaveCount(0);

    // And the same figure where the reports read it: one posting, one ledger.
    const year = new Date().getFullYear();
    await page.goto(`/finance/trial-balance?from=${year}-01-01&to=${year}-12-31`);
    await expect(page.getByRole('cell', { name: payableCode }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByRole('row').filter({ hasText: payableCode }).first(),
    ).toContainText('7,500');
  });
});

test.describe('a sales invoice reaches the customer statement', () => {
  let customerCode = '';
  let receivableCode = '';

  test('the receivable account is designated as the customer subledger', async ({ page }) => {
    await signIn(page, MANAGER);
    receivableCode = await controlAccount(
      page,
      /Asset/,
      `E2E Trade Receivables ${RUN}`,
      'Customer',
    );
    expect(receivableCode).toMatch(/^A\d+$/);
  });

  test('the invoice posts with no Business Line, and the statement shows it', async ({ page }) => {
    await signIn(page, ADMIN);
    customerCode = await createPartner(page, '/master-data/customers', 'New customer', `E2E Customer ${RUN}`);
    await itemAccounts(page);

    await page.goto('/sales/ar-invoices/new');
    await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });

    // The header the sponsor listed, and nothing else on it.
    await expect(page.locator('select[name="business_line_code"]')).toHaveCount(0);
    await expect(page.locator('select[name="department_code"]')).toHaveCount(0);

    await page.getByLabel('Customer Code', { exact: true }).fill(customerCode);

    // Both accounts, chosen on the form that raises the invoice.
    const receivable = page.locator('select[name="receivable_account_id"]');
    await receivable.selectOption(
      (await receivable
        .locator('option')
        .filter({ hasText: receivableCode })
        .first()
        .getAttribute('value'))!,
    );
    const revenue = page.locator('select[name="revenue_account_id"]');
    const revenueOption = await revenue
      .locator('option:not([value=""])')
      .first()
      .getAttribute('value');
    await revenue.selectOption(revenueOption!);

    await page.locator('input[name="item_code_0"]').fill('ITM-SEED');
    await page.locator('input[name="quantity_0"]').fill('1');
    await page.locator('input[name="unit_price_0"]').fill('4000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/sales\/ar-invoices\/INV-/, { timeout: 90_000 });

    await press(page, 'Approve', 'Approved');
    await press(page, 'Post', 'Posted');

    const rows = await statementOf(page, customerCode, 'customer');
    await expect(rows).not.toHaveCount(1);
    await expect(rows.filter({ hasText: '4,000' })).not.toHaveCount(0);

    const year = new Date().getFullYear();
    await page.goto(`/finance/trial-balance?from=${year}-01-01&to=${year}-12-31`);
    await expect(page.getByRole('cell', { name: receivableCode }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByRole('row').filter({ hasText: receivableCode }).first(),
    ).toContainText('4,000');
  });
});
