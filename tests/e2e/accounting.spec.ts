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
    await page.getByRole('button', { name, exact: true }).first().click();
    try {
      await expect(page.getByText(expected, { exact: true }).first()).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
      await page.reload();
      await page.waitForTimeout(2_000);
    }
  }
  await expect(page.getByText(expected, { exact: true }).first()).toBeVisible();
}

async function signIn(page: Page, user: { email: string; password: string }) {
  // Signing in as somebody else means being somebody else: the sign-in page
  // redirects an already-authenticated visitor to the dashboard, so the old
  // session goes first.
  await page.context().clearCookies();
  await page.goto('/sign-in');
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

    if ((await page.getByRole('cell', { name: 'USD' }).count()) === 0) {
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: 'Publish a rate' }).click();
      await page.waitForTimeout(1200);
      await page.getByRole('spinbutton', { name: 'Rate' }).fill('1310');
      await page.getByRole('textbox', { name: 'Effective from' }).fill(`${YEAR}-01-01`);
      await page.getByRole('button', { name: 'Publish', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Saved');
    }
    await expect(page.getByRole('cell', { name: 'USD' }).first()).toBeVisible();
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

    await page.getByRole('button', { name: 'New journal' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('textbox', { name: 'Posting date', exact: true }).fill(TODAY);
    await page.getByRole('textbox', { name: 'Description', exact: true }).fill(`Sale ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/finance\/journals\/JE-/, { timeout: 60_000 });

    // Requirement 2 — the number is the system's.
    entryNo = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
    expect(entryNo).toMatch(/^JE-\d{4}-\d+$/);
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();

    await expect(page.getByRole('button', { name: 'Add line' })).toBeVisible();
    // A line is typed into the last row of the sheet: an account, and an amount
    // in the debit cell or the credit cell. There is no "side" to choose —
    // which column the figure goes in is the choice.
    for (const [account, side, amount] of [
      [cashAccount, 'Debit', '2400'],
      [salesAccount, 'Credit', '2400'],
    ] as const) {
      // The add-line form is a server action; give the page a moment to bind
      // it, then fill the cells in and check the line actually landed.
      await page.waitForTimeout(2000);
      const picker = page.getByRole('combobox', { name: 'Account' });
      const value = await picker
        .locator('option')
        .filter({ hasText: account })
        .first()
        .getAttribute('value');
      await picker.selectOption(value!);
      await page.getByRole('spinbutton', { name: side, exact: true }).fill(amount);
      await page.getByRole('button', { name: 'Add line' }).click();
      await expect(page.getByRole('cell', { name: new RegExp(account) }).first()).toBeVisible({
        timeout: 15_000,
      });
    }

    // §24's four-part tuple, on screen: what was typed, the IQD the ledger
    // balances in, and the USD equivalent — the two derived columns used to be
    // computed on every line and shown nowhere.
    await expect(page.getByRole('columnheader', { name: /Ledger/ })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Reporting/ })).toBeVisible();

    // Both totals agree, so it can be posted.
    await expect(page.locator('tfoot')).toContainText('2,400');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    // A Finance Manager creates and posts directly (§14.4).
    await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible();
    // And a posted entry stops offering anything that would change it.
    await expect(page.getByRole('button', { name: 'Add line' })).toHaveCount(0);
  });

  test('4 · it appears in the General Ledger and the Trial Balance', async ({ page }) => {
    await signIn(page, MANAGER);

    await page.goto(`/finance/gl-inquiry?account=${cashAccount}&from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('link', { name: entryNo })).toBeVisible();

    await page.goto(`/finance/trial-balance?from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('cell', { name: cashAccount })).toBeVisible();
    // Requirement 4 — the two totals must remain equal.
    await expect(page.locator('tfoot')).toContainText('Debits equal credits');
  });

  test('5 · the financial statements are produced from the same postings', async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto(`/finance/statements?from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');

    const pl = page.locator('section', { hasText: 'Statement of Profit or Loss' }).last();
    await expect(pl).toContainText('Revenue');
    await expect(pl).toContainText('Profit for the period');

    const sfp = page.locator('section', { hasText: 'Statement of Financial Position' }).last();
    await expect(sfp).toContainText('Total assets');
    await expect(sfp).toContainText('Total equity and liabilities');
    await expect(sfp).toContainText('The two sides agree');
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
      await page.getByRole('textbox', { name: 'Why it is being reversed' }).fill('posted twice');
      await page.getByRole('button', { name: 'Reverse', exact: true }).click();
      await page.waitForTimeout(3_000);

      await page.goto(`/finance/journals/${entryNo}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Scoped to the document: the register beside it links every entry, so
      // an unscoped "first JE- link" would find the top of the list instead.
      const link = page
        .locator('#journal-document a[href^="/finance/journals/JE-"]')
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
    await expect(page.locator('tfoot')).toContainText('Debits equal credits');

    await page.goto(`/finance/statements?from=${YEAR}-01-01&to=${YEAR}-12-31`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('section', { hasText: 'Statement of Financial Position' }).last(),
    ).toContainText('The two sides agree');
  });
});
