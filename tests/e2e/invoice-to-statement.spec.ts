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
  const designation = page.locator('form:has(select[name="controlAccount"])').first();
  await designation.locator('select[name="controlAccount"]').selectOption(kind);
  await designation.locator('button[type="submit"]').first().click();
  await page.waitForLoadState('networkidle');
  await page.reload();
  await expect(page.locator('select[name="controlAccount"]')).toHaveValue(kind.toLowerCase());

  return code;
}

/** Points one line of one document at an account, on the Posting Mappings row. */
async function mapLine(page: Page, line: string, accountCode: string) {
  await page.goto('/finance/posting-mappings');
  const row = page.getByRole('row').filter({ hasText: line }).first();
  const chooser = row.getByRole('combobox');
  const option = await chooser
    .locator('option')
    .filter({ hasText: accountCode })
    .first()
    .getAttribute('value');
  await chooser.selectOption(option!);
  await row.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/posting-mappings/, { timeout: 60_000 });
  await expect(
    page.getByRole('row').filter({ hasText: line }).first().getByRole('combobox'),
  ).toHaveValue(option!);
}

/**
 * The accounts an item carries itself — §3.3 maps what is *not* on a record,
 * and stock answers for its own: where it is held, and what it cost when sold.
 *
 * Set here rather than assumed, because the message a person gets when one is
 * missing ("names no COGS account, so its cost has nowhere to go") is the
 * product working, not the test failing.
 */
async function itemAccounts(page: Page, code = 'ITM-SEED') {
  await page.goto(`/master-data/items/${code}`);
  // By field name rather than by label: the record page carries several forms,
  // and this one is identified by the fields being set.
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

async function createPartner(page: Page, screen: string, button: string, code: string) {
  await page.goto(screen);
  await page.getByRole('button', { name: button, exact: true }).click();
  const dialog = page.locator('dialog[open], [role="dialog"]').first();
  await dialog.getByLabel('Code', { exact: true }).fill(code);
  await dialog.getByLabel(/^Legal name/).fill(`${code} Limited`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(new RegExp(`/master-data/business-partners/${code}`), { timeout: 60_000 });
}

/** The statement's own figures, read from the screen a person opens. */
async function statementOf(page: Page, code: string, side: 'supplier' | 'customer') {
  await page.goto(`/master-data/business-partners/${code}/statement?side=${side}`);
  await expect(page.getByRole('heading', { name: new RegExp(code) }).first()).toBeVisible({
    timeout: 60_000,
  });
  return page.locator('table tbody tr');
}

test.describe('a purchase invoice reaches the supplier statement', () => {
  const supplierCode = `E2E-SUP-${RUN}`;
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

  test('the mapping sends what is owed to it', async ({ page }) => {
    await signIn(page, MANAGER);
    await mapLine(page, 'What the company owes the supplier', payableCode);
  });

  test('the invoice posts, and the supplier statement shows it', async ({ page }) => {
    await signIn(page, ADMIN);
    await createPartner(page, '/master-data/suppliers', 'New supplier', supplierCode);

    // The item holds its own inventory account — the direct route debits it
    // rather than a mapping (§3.3 answers what is *not* on a record).
    await page.goto('/master-data/items/ITM-SEED');
    await itemAccounts(page);

    await page.goto('/purchasing/ap-invoices/new');
    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByLabel('Supplier Code', { exact: true }).fill(supplierCode);

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
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/purchasing\/ap-invoices\/API-/, { timeout: 90_000 });

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
  const customerCode = `E2E-CUS-${RUN}`;
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

  test('the mappings send the sale and the debt to their accounts', async ({ page }) => {
    await signIn(page, MANAGER);
    await mapLine(page, 'What the customer owes the company', receivableCode);

    // Revenue needs somewhere to go too, and any approved revenue account will
    // do for the purpose of this test — which is the statement, not the chart.
    await page.goto('/finance/posting-mappings');
    const revenue = page.getByRole('row').filter({ hasText: 'The sale' }).first();
    const chooser = revenue.getByRole('combobox');
    if ((await chooser.inputValue()) === '') {
      const first = await chooser
        .locator('option:not([value=""])')
        .filter({ hasText: /^R/ })
        .first()
        .getAttribute('value');
      await chooser.selectOption(first!);
      await revenue.getByRole('button', { name: 'Save' }).click();
      await page.waitForURL(/posting-mappings/, { timeout: 60_000 });
    }
  });

  test('the invoice posts with no Business Line, and the statement shows it', async ({ page }) => {
    await signIn(page, ADMIN);
    await createPartner(page, '/master-data/customers', 'New customer', customerCode);
    await itemAccounts(page);

    await page.goto('/sales/ar-invoices/new');
    await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });

    // The header the sponsor listed, and nothing else on it.
    await expect(page.locator('select[name="business_line_code"]')).toHaveCount(0);
    await expect(page.locator('select[name="department_code"]')).toHaveCount(0);

    await page.getByLabel('Customer Code', { exact: true }).fill(customerCode);
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
