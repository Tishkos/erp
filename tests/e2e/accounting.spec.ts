import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 1 · the accounting round trip, in a browser.
 *
 * The phase's own expected result, performed: "Finance can create the Chart of
 * Accounts, enter and approve a Journal Entry, post it to the General Ledger,
 * review the Trial Balance and produce the basic financial statements."
 *
 * Serial, and the tests share one journal — the point is the journey.
 *
 * Requires `npm run db:seed`.
 */
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const YEAR = new Date().getFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

let entryNo = '';
let cashAccount = '';
let salesAccount = '';

/**
 * Clicks a button and waits for the page to actually change.
 *
 * A server action submitted in the moment before its chunk has loaded is
 * dropped without a word — no request, no error. On a heavy page that is easy
 * to hit, so this presses again rather than failing on a race that has nothing
 * to do with what is being tested.
 */
async function press(page: Page, name: string, expected: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Already there — a previous press did its work while we were waiting.
    if (await page.getByText(expected, { exact: true }).first().isVisible().catch(() => false)) return;
    const button = page.getByRole('button', { name, exact: true }).first();
    if ((await button.count()) === 0) break;
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    try {
      await expect(page.getByText(expected, { exact: true }).first()).toBeVisible({ timeout: 25_000 });
      return;
    } catch {
      await page.reload();
      await page.waitForTimeout(2_000);
    }
  }
  await expect(page.getByText(expected, { exact: true }).first()).toBeVisible({ timeout: 25_000 });
}

async function signIn(page: Page, user: { email: string; password: string }) {
  // Signing in as somebody else means being somebody else: the sign-in page
  // redirects an already-authenticated visitor to the dashboard, so the old
  // session goes first.
  await page.context().clearCookies();
  await page.goto('/sign-in');
  expect(['localhost', '127.0.0.1']).toContain(new URL(page.url()).hostname);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test.describe('Phase 1 · from the chart of accounts to the financial statements', () => {
  test('1 · the year is opened, so there is somewhere to post', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/finance/periods');
    await page.waitForLoadState('networkidle');

    if ((await page.getByRole('cell', { name: `FY${YEAR}` }).count()) === 0) {
      await page.getByRole('button', { name: 'Open a year' }).click();
      await page.waitForTimeout(1200);
      await page.getByRole('textbox', { name: 'Year', exact: true }).fill(`FY${YEAR}`);
      await page.getByRole('textbox', { name: 'Starts', exact: true }).fill(`${YEAR}-01-01`);
      await page.getByRole('textbox', { name: 'Ends', exact: true }).fill(`${YEAR}-12-31`);
      await page.getByRole('button', { name: 'Create' }).click();
      await expect(page.getByRole('status')).toContainText('Saved');
    }

    // Twelve monthly periods, and the calendar says which are open.
    await expect(page.getByRole('cell', { name: `FY${YEAR}` }).first()).toBeVisible();
  });

  test('1b · a rate is published, so postings can be measured', async ({ page }) => {
    // Every line is measured in the ledger currency and in USD; without a rate
    // in force the ledger refuses the entry outright.
    await signIn(page, MANAGER);
    await page.goto('/master-data/exchange-rates');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The currency master lists USD from the seed; what has to exist is a
    // *rate* for it, which is the figure on the page.
    if ((await page.getByText('1,310').count()) === 0) {
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Publish a rate' }).click();
      await page.waitForTimeout(1200);
      await page.getByRole('spinbutton', { name: 'Rate' }).fill('1310');
      await page.getByRole('textbox', { name: 'Effective from' }).fill(`${YEAR}-01-01`);
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Saved');
    }
    await expect(page.getByText('1,310').first()).toBeVisible();
  });

  test('2 · an account is raised by one person and approved by another', async ({ page }) => {
    await signIn(page, OFFICER);
    await page.goto('/master-data/chart-of-accounts');
    await expect(page.getByRole('button', { name: 'New account' })).toBeVisible();

    for (const [under, name, holder] of [
      ['Assets', `Cash ${RUN}`, 'cash'],
      ['Revenue', `Sales ${RUN}`, 'sales'],
    ] as const) {
      await page.goto('/master-data/chart-of-accounts');
      await expect(page.getByRole('button', { name: 'New account' })).toBeVisible();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'New account' }).click();
      await page.waitForTimeout(1200);
      const parent = page.getByRole('combobox', { name: 'Under' });
      const option = await parent
        .locator('option')
        .filter({ hasText: under })
        .first()
        .getAttribute('value');
      await parent.selectOption(option!);
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
      await page.getByRole('button', { name: 'Create' }).click();
      await page.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, { timeout: 60_000 });

      const code = page.url().split('/').pop()!;
      if (holder === 'cash') cashAccount = code;
      else salesAccount = code;

      // An account posts only once it has been approved (§14.4).
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(2000);
      await press(page, 'Submit for approval', 'Pending approval');
    }

    // The Accounting Manager approves. Since 0168 the raiser could approve
    // their own account too, but keeping two people here exercises the handover
    // — the case where the approver is looking at somebody else's work.
    await signIn(page, MANAGER);
    for (const code of [cashAccount, salesAccount]) {
      await page.goto(`/master-data/chart-of-accounts/${code}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(2000);
      await press(page, 'Approve', 'Approved');
    }

    expect(cashAccount).toMatch(/^A\d+$/);
    expect(salesAccount).toMatch(/^R\d+$/);
  });

  test('3 · a journal is entered, balanced, and posted', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/finance/journals');
    await page.waitForLoadState('networkidle');

    // One press: the entry opens at once, numbered and dated today. The
    // button is disabled until the page can act on it, so a press is never
    // dropped silently.
    await expect(page.getByRole('button', { name: 'New journal' })).toBeEnabled({ timeout: 30_000 });
    await page.getByRole('button', { name: 'New journal' }).click();
    await page.waitForURL(/\/finance\/journals\/JE-/, { timeout: 60_000 });

    // Requirement 2 — the number is the system's.
    entryNo = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
    expect(entryNo).toMatch(/^JE-\d{4}-\d+$/);
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Posting date', exact: true })).toHaveValue(TODAY);

    // The description is typed on the document and saved when the box is left.
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill(`Sale ${RUN}`);
    await page.getByRole('textbox', { name: 'Description', exact: true }).press('Tab');

    // A line is typed into the last row of the grid: an account, and an amount
    // in the debit cell or the credit cell. There is no "side" to choose —
    // which column the figure goes in is the choice — and no button: leaving
    // the row saves it, and the next row is already there.
    for (const [index, [account, side, amount]] of (
      [
        [cashAccount, 'Debit', '2400'],
        [salesAccount, 'Credit', '2400'],
      ] as const
    ).entries()) {
      // The row being typed is the last one; once it is saved the grid opens
      // another beneath it, so the check is on the row by its position.
      const picker = page.getByRole('combobox', { name: 'Account' }).last();
      const value = await picker.locator('option').filter({ hasText: account }).first().getAttribute('value');
      await picker.selectOption(value!);
      const cell = page.getByRole('spinbutton', { name: side, exact: true }).last();
      await cell.fill(amount);
      await cell.press('Enter');
      await expect(page.getByRole('combobox', { name: 'Account' }).nth(index)).toHaveValue(value!, { timeout: 15_000 });
      await expect(page.getByRole('combobox', { name: 'Account' })).toHaveCount(index + 2, { timeout: 15_000 });
    }

    // The balance is summed on screen as it is typed: both sides agree, so
    // it can be posted.
    await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
    await expect(page.locator('tfoot')).toContainText('2,400');
    await expect(page.getByRole('combobox', { name: 'Account' })).toHaveCount(3);
    // The button cannot be pressed until it can act, so no press is dropped.
    await expect(page.getByRole('button', { name: 'Submit', exact: true })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved', { timeout: 30_000 });

    // A Finance Manager creates and posts directly (§14.4).
    await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible();
    // And a posted entry stops offering anything that would change it.
    await expect(page.getByRole('combobox', { name: 'Account' })).toHaveCount(0);
    // The audit log is one press away from the entry.
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible();
  });

  test('4 · it appears in the General Ledger and the Trial Balance', async ({ page }) => {
    await signIn(page, MANAGER);

    // The ledger opens on every account and its balance; the account is
    // pressed, not chosen from a list.
    await page.goto('/finance/gl-inquiry');
    await page.waitForLoadState('networkidle');
    // The link carries the drill-down arrow before the code, so match on the code.
    await page.getByRole('link', { name: new RegExp(`${cashAccount}$`) }).first().click();
    await page.waitForURL(new RegExp(`/finance/gl-inquiry/${cashAccount}`));
    await expect(page.getByRole('link', { name: entryNo })).toBeVisible();

    await page.goto(`/finance/trial-balance?from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('cell', { name: cashAccount })).toBeVisible();
    // Requirement 4 — the two totals must remain equal.
    await expect(page.getByText('Debits equal credits', { exact: true })).toBeVisible();

    await page.goto(`/master-data/chart-of-accounts/${salesAccount}`);
    await expect(page.getByRole('link', { name: entryNo })).toBeVisible();
    await expect(page.getByText(/Approved by /)).toBeVisible();
    await expect(page.getByText('No approval decisions are available for this record.')).toHaveCount(0);
    await expect(page.getByText('This document has not posted to the General Ledger.')).toHaveCount(0);
    await expect(
      page.getByText(
        'When transactions post to this account, they appear in Recent Journals and the General Ledger. The account master itself does not create a journal.',
      ),
    ).toBeVisible();
  });

  test('5 · the financial statements are produced from the same postings', async ({ page }) => {
    await signIn(page, MANAGER);
    // Each statement is its own page.
    await page.goto(`/finance/income-statement?from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    const pl = page.locator('section', { hasText: 'Income Statement' }).last();
    await expect(pl).toContainText('Revenue');
    await expect(pl).toContainText('Net profit');

    await page.goto(`/finance/balance-sheet?to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    const sfp = page.locator('section', { hasText: 'Balance Sheet' }).last();
    await expect(sfp).toContainText('Total assets');
    await expect(sfp).toContainText('Total equity and liabilities');
    // The revenue is on the balance sheet — under Equity, as the result.
    await expect(sfp).toContainText('Result to date');
    await expect(sfp).toContainText('The two sides agree');

    // Level 1 shows only the headers; the account is not on the page.
    await page.goto(`/finance/balance-sheet?to=${YEAR}-12-31&level=1`);
    await expect(page.locator('section', { hasText: 'Balance Sheet' }).last()).not.toContainText(
      cashAccount,
    );
  });

  test('6 · a posted entry is corrected by a linked reversal', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto(`/finance/journals/${entryNo}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Reverse it, and confirm by what happened rather than by where the browser
    // went: a form submitted in the moment before its action binds is dropped
    // silently, and pressing again is the honest way through that.
    let reversalNo = '';
    for (let attempt = 0; attempt < 4 && !reversalNo; attempt += 1) {
      await page.waitForTimeout(2_500);
      // The reason is typed beside the button, in the document's own foot.
      await page.getByRole('textbox', { name: 'Why it is being reversed' }).fill('posted twice');
      await page.getByRole('button', { name: 'Reverse', exact: true }).click();
      await page.waitForTimeout(3_000);

      await page.goto(`/finance/journals/${entryNo}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const link = page
        .locator('#journal-document a[href^="/finance/journals/JE-"]:not([href$="/audit"]):not([href$="/print"])')
        .first();
      if (await link.count()) reversalNo = (await link.innerText()).trim();
    }
    expect(reversalNo).toMatch(/^JE-\d{4}-\d+$/);
    expect(reversalNo).not.toBe(entryNo);

    // The original is closed, and says what closed it.
    await expect(page.getByText('Reversed', { exact: true }).first()).toBeVisible();

    // The reversal points back, posted, for the same money.
    await page.goto(`/finance/journals/${reversalNo}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(reversalNo);
    await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible();
    await expect(
      page.locator('#journal-document').getByRole('link', { name: entryNo }),
    ).toBeVisible();

    // And the register lists the pair with its reason.
    await page.goto('/finance/reversals');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(entryNo) });
    await expect(row).toContainText('posted twice');
  });

  test('7 · the ledger is flat again, and the statements agree', async ({ page }) => {
    await signIn(page, ADMIN);
    await page.goto(`/finance/trial-balance?from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Debits equal credits', { exact: true })).toBeVisible();

    await page.goto(`/finance/balance-sheet?to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('section', { hasText: 'Balance Sheet' }).last(),
    ).toContainText('The two sides agree');
  });
});

test('supplier statement keeps its side when filters run', async ({ page, baseURL }) => {
  expect(['localhost', '127.0.0.1']).toContain(new URL(baseURL!).hostname);
  await signIn(page, ADMIN);
  const stamp = Date.now().toString(36).toUpperCase();
  const createPartner = async (kind: 'supplier' | 'customer') => {
    const code = `E2E-STMT-${kind === 'supplier' ? 'S' : 'C'}-${stamp}`;
    await page.goto(`/master-data/${kind}s`);
    await page.getByRole('button', { name: `New ${kind}`, exact: true }).click();
    const dialog = page.locator('dialog[open], [role="dialog"]').first();
    await dialog.getByLabel('Code', { exact: true }).fill(code);
    await dialog.getByLabel(/^Legal name/).fill(`Statement ${kind} ${stamp}`);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(new RegExp(`/master-data/business-partners/${code}(?:\\?|$)`), {
      timeout: 60_000,
    });
    return `/master-data/business-partners/${code}/statement`;
  };
  const supplierStatement = await createPartner('supplier');
  for (const side of ['supplier', 'customer'] as const) {
    await page.goto(`${supplierStatement}?side=${side}`);
    const filter = page.locator('form[method="get"]');
    await filter.locator('input[name="from"]').fill(`${YEAR}-02-01`);
    await filter.locator('input[name="to"]').fill(`${YEAR}-12-31`);
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('from') === `${YEAR}-02-01`),
      filter.locator('button[type="submit"]').click(),
    ]);
    expect(new URL(page.url()).searchParams.get('side')).toBe(side);
    await expect(page.locator('input[name="side"]')).toHaveValue(side);
  }
  await page.goto(supplierStatement);
  await expect(page.locator('input[name="side"]')).toHaveValue('supplier');
  await page.goto(`${supplierStatement}?side=unknown`);
  await expect(page.locator('input[name="side"]')).toHaveValue('supplier');
  const customerStatement = await createPartner('customer');
  await page.goto(customerStatement);
  await expect(page.locator('input[name="side"]')).toHaveValue('customer');
});
test('item sales account appears in invoice account selection', async ({ page }) => {
  const stamp = Date.now().toString(36).toUpperCase();
  await signIn(page, MANAGER);
  await page.goto('/master-data/chart-of-accounts');
  await page.getByRole('button', { name: 'New account' }).click();
  const accountDialog = page.locator('dialog[open], [role="dialog"]').first();
  const under = accountDialog.getByLabel('Under', { exact: true });
  const revenueParent = await under
    .locator('option:not([disabled])')
    .filter({ hasText: 'Revenue' })
    .first()
    .getAttribute('value');
  await under.selectOption(revenueParent!);
  await accountDialog.getByLabel(/^Name/).fill(`E2E Item Revenue ${stamp}`);
  await accountDialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, { timeout: 60_000 });
  const itemSalesAccount = page.url().split('/').pop()!;
  await press(page, 'Submit for approval', 'Pending approval');
  await press(page, 'Approve', 'Approved');

  await signIn(page, ADMIN);
  const itemCode = `E2E-ITEM-${stamp}`;
  await page.goto('/master-data/items');
  await page.getByRole('button', { name: 'New item' }).click();
  const itemDialog = page.locator('dialog[open], [role="dialog"]').first();
  await itemDialog.getByLabel('Code', { exact: true }).fill(itemCode);
  await itemDialog.getByLabel(/^Name/).fill(`E2E Routed Item ${stamp}`);
  await itemDialog.getByLabel('Base unit', { exact: true }).selectOption('EA');
  await itemDialog.getByLabel('Tracking', { exact: true }).selectOption('batch');
  await itemDialog.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(new RegExp(`/master-data/items/${itemCode}`), { timeout: 60_000 });
  const salesAccount = page.getByLabel('Sales account', { exact: true });
  const salesAccountId = await salesAccount
    .locator('option')
    .filter({ hasText: itemSalesAccount })
    .first()
    .getAttribute('value');
  await salesAccount.selectOption(salesAccountId!);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const customerCode = `E2E-CUST-${stamp}`;
  await page.goto('/master-data/customers');
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  const customerDialog = page.locator('dialog[open], [role="dialog"]').first();
  await customerDialog.getByLabel('Code', { exact: true }).fill(customerCode);
  await customerDialog.getByLabel(/^Legal name/).fill(`E2E Routed Customer ${stamp}`);
  await customerDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(new RegExp(`/master-data/business-partners/${customerCode}`), {
    timeout: 60_000,
  });

  await page.goto('/sales/ar-invoices/new');
  await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Customer Code', { exact: true }).fill(customerCode);
  await page.locator('input[name="item_code_0"]').fill(itemCode);
  await page.locator('input[name="quantity_0"]').fill('1');
  await page.locator('input[name="unit_price_0"]').fill('100');
  await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/sales\/ar-invoices\/INV-/);

  const revenueAccounts = page.locator('section', { hasText: 'Revenue accounts' }).last();
  await expect(
    revenueAccounts.getByRole('link', { name: new RegExp(itemSalesAccount) }),
  ).toBeVisible();
  await expect(revenueAccounts).toContainText('Item sales account');
});

test('a sales invoice header carries block 5 fields, and approves without dimensions', async ({
  page,
  baseURL,
}) => {
  /*
   * The two accounting dimensions came off the document by direction
   * (2026-09-22): block 5's header is the invoice number, the two dates and
   * the customer, and Business Line was neither on it nor wanted. What matters
   * now is that their absence costs nothing — the invoice still approves, and
   * the revenue still posts, because the document type no longer asks the
   * lines for a dimension the screen cannot supply.
   */
  expect(['localhost', '127.0.0.1']).toContain(new URL(baseURL!).hostname);
  await signIn(page, ADMIN);

  const stamp = Date.now().toString(36).toUpperCase();
  const customerCode = `E2E-DIM-${stamp}`;
  await page.goto('/master-data/customers');
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  const dialog = page.locator('dialog[open], [role="dialog"]').first();
  await dialog.getByLabel('Code', { exact: true }).fill(customerCode);
  await dialog.getByLabel(/^Legal name/).fill(`Dimension Customer ${stamp}`);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(new RegExp(`/master-data/business-partners/${customerCode}(?:\?saved=1)?$`), {
    timeout: 60_000,
  });

  await page.goto('/sales/ar-invoices/new');
  await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });

  // Not on the form, on either side of saving it.
  await expect(page.locator('select[name="business_line_code"]')).toHaveCount(0);
  await expect(page.locator('select[name="department_code"]')).toHaveCount(0);

  await page.getByLabel('Customer Code', { exact: true }).fill(customerCode);
  await page.locator('input[name="item_code_0"]').fill('ITM-SEED');
  await page.locator('input[name="quantity_0"]').fill('1');
  await page.locator('input[name="unit_price_0"]').fill('100');
  await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForURL(/\/sales\/ar-invoices\/INV-/);

  await expect(page.locator('select[name="business_line_code"]')).toHaveCount(0);
  await expect(page.locator('select[name="department_code"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
});
