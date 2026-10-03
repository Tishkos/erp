import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * IMPROVEMENT-002 — a supplier's bank accounts, set up on its profile.
 *
 * The accounting officer adds a dollar account to SUP-00001: a SWIFT code of
 * the wrong shape is refused and the dialog comes back open; corrected, the
 * account opens in draft and is sent for verification — the officer cannot
 * verify it. The accounting manager verifies it; it is in use (the default,
 * being the first). A second account is added, verified, made the default, and
 * the first taken out of use with its reason. The profile holds at mobile
 * width in Arabic.
 *
 * The rules behind each step are tests/integration/im2-04-supplier-banks.test.ts.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const OFFICER = 'officer@example.com';
const MANAGER = 'manager@example.com';
const RUN = Date.now().toString().slice(-8);
const PROFILE = '/payables/suppliers/SUP-00001?role=supplier';

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function as(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { page, close: () => context.close() };
}

async function addAccount(page: Page, input: { bank: string; account: string; swift: string; currency: string }) {
  await page.goto(PROFILE);
  await page.getByRole('button', { name: 'Add bank account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Bank name' }).fill(input.bank);
  await dialog.getByLabel('Currency').selectOption(input.currency);
  await dialog.getByRole('textbox', { name: 'Account number' }).fill(input.account);
  await dialog.getByRole('textbox', { name: 'SWIFT / BIC', exact: true }).fill(input.swift);
  await dialog.getByRole('button', { name: 'Add bank account' }).click();
}

async function sendAndVerify(browser: Browser, page: Page) {
  await page.getByRole('button', { name: 'Send for verification' }).click();
  await page.waitForURL(/saved=1/);
  const url = page.url().replace(/[?&]saved=1/, '');
  const manager = await as(browser, MANAGER);
  await manager.page.goto(url);
  await manager.page.getByRole('button', { name: 'Verify' }).click();
  await manager.page.waitForURL(/saved=1/);
  await manager.close();
  return url;
}

test.describe('IM2 · supplier bank accounts on the profile', () => {
  test.describe.configure({ mode: 'serial' });

  test('added in full, refused when wrong, verified by a second person, one default, one out of use', async ({ browser }) => {
    test.setTimeout(300_000);
    const officer = await as(browser, OFFICER);
    const page = officer.page;

    // A SWIFT code of the wrong shape is refused; the dialog comes back open.
    await addAccount(page, { bank: 'Bank of China', account: `6222${RUN}`, swift: 'BKCHCNB', currency: 'USD' });
    await expect(page.getByText(/BKCHCNB is not a SWIFT\/BIC code/)).toBeVisible();
    await expect(page.getByRole('dialog')).toBeVisible();

    // Corrected: it opens in draft, and the officer cannot verify it.
    await addAccount(page, { bank: 'Bank of China', account: `6222${RUN}`, swift: 'BKCHCNBJ300', currency: 'USD' });
    await page.waitForURL(/account=/);
    const firstPanel = page.getByRole('region', { name: /Bank of China/ });
    await expect(firstPanel.getByText('Draft', { exact: true })).toBeVisible();
    await expect(firstPanel).toContainText('BKCHCNBJ300');
    await page.getByRole('button', { name: 'Send for verification' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('region', { name: /Bank of China/ }).getByText('Awaiting verification', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify' })).toHaveCount(0);
    const firstUrl = page.url().replace(/[?&]saved=1/, '');

    // The manager verifies it: in use, the default (the first).
    const manager = await as(browser, MANAGER);
    await manager.page.goto(firstUrl);
    await manager.page.getByRole('button', { name: 'Verify' }).click();
    await manager.page.waitForURL(/saved=1/);
    const verified = manager.page.getByRole('region', { name: /Bank of China/ });
    await expect(verified.getByText('Verified', { exact: true })).toBeVisible();
    await expect(verified).toContainText('Default');
    await manager.close();

    // A second account, verified and made the default; the first taken out of use.
    await addAccount(page, { bank: `Trade Bank of Iraq ${RUN}`, account: `0011${RUN}`, swift: 'TRIQIQBA', currency: 'IQD' });
    await page.waitForURL(/account=/);
    const secondUrl = await sendAndVerify(browser, page);
    await page.goto(secondUrl);
    await page.getByRole('button', { name: 'Make default' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(firstUrl);
    await page.getByRole('textbox', { name: 'Why it is taken out of use' }).fill('Supplier moved its dollar account');
    await page.getByRole('button', { name: 'Take out of use' }).click();
    await page.waitForURL(/saved=1/);

    const table = page.getByRole('table', { name: 'Bank accounts' });
    await expect(table.getByRole('row', { name: new RegExp(`0011${RUN}`) })).toContainText('Default');
    await expect(table.getByRole('row', { name: new RegExp(`6222${RUN}`) })).toContainText('Out of use');
    await officer.close();
  });

  test('the profile holds at mobile width, in Arabic', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', url: 'http://localhost:3000' }]);
    const page = await context.newPage();
    await signIn(page, OFFICER);
    await page.goto(PROFILE);
    await expect(page.getByRole('table', { name: 'الحسابات المصرفية' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});
