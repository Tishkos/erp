import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PM-001 PM14 `pm-screens`, Stage PM-5 — on the Billing workspace a
 * date line of the billing plan is added and, being due, raises a
 * certificate; the certificate is approved by somebody other than its
 * raiser and posts; the recognition window shows what would post while the
 * method is not ratified; on the Forecast report an estimate to complete is
 * typed and shown as the element's source; all of it reads in Arabic at a
 * phone's width.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('REQ-PM-001 Stage PM-5 · billing, recognition and forecast', () => {
  test('a due plan line raises a certificate approved by somebody else; an estimate to complete is typed', async ({ page, browser }) => {
    test.setTimeout(420_000);
    await signIn(page, MANAGER);

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const create = page.getByRole('dialog');
    await create.locator('select[name="type_code"]').selectOption('CUSTOMER');
    await create.locator('select[name="customer_id"]').selectOption({ index: 1 });
    await create.locator('input[name="name"]').fill(`Solar farm ${RUN}`);
    await create.locator('input[name="baseline_starts_on"]').fill('2026-09-01');
    await create.locator('input[name="baseline_ends_on"]').fill('2026-12-31');
    await create.locator('input[name="contract_value_iqd"]').fill('1000000');
    await create.locator('input[name="baseline_budget_iqd"]').fill('800000');
    await create.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/PRJ-/);
    const code = decodeURIComponent(page.url().split('/projects/')[1]!.split('?')[0]!);
    const other = await browser.newContext();
    const adminPage = await other.newPage();
    await signIn(adminPage, ADMIN);
    await adminPage.goto(`/projects/${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Release' }).click();
    await adminPage.waitForURL(/saved=1/);

    // The billing plan: a line on 15 September is due at once.
    await page.goto(`/projects/billing?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Billing', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Add billing line' }).click();
    const add = page.getByRole('dialog');
    await add.locator('input[name="description"]').fill('Mobilisation');
    await add.locator('select[name="due_trigger"]').selectOption('date');
    await add.locator('input[name="due_on"]').fill('2026-09-15');
    await add.locator('select[name="basis"]').selectOption('amount');
    await add.locator('input[name="value"]').fill('250000');
    await add.locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('cell', { name: 'Mobilisation' })).toBeVisible();
    await expect(page.getByText('Due', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/not yet ratified by Finance/)).toBeVisible();

    const line = page.getByRole('row', { name: /Mobilisation/ });
    await line.locator('input[name="certified_on"]').fill('2026-09-20');
    await line.getByRole('button', { name: 'Raise certificate' }).click();
    await page.waitForURL(/\/projects\/billing\/PCT-/);
    const certificateNo = decodeURIComponent(page.url().split('/projects/billing/')[1]!.split('?')[0]!);
    // Its raiser has no Approve.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    await adminPage.goto(`/projects/billing/${encodeURIComponent(certificateNo)}`);
    await adminPage.getByRole('button', { name: 'Approve' }).click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.locator('[data-status="posted"]').first()).toBeVisible();
    await other.close();

    await page.goto(`/projects/billing?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('link', { name: certificateNo }).first()).toBeVisible();
    await expect(page.getByText('Billed', { exact: true }).first()).toBeVisible();

    // The forecast: an estimate typed for the root replaces the formula.
    await page.goto(`/projects/forecast?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Forecast', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Set ETC' }).click();
    const etc = page.getByRole('dialog');
    await etc.locator('input[name="etc"]').fill('500000');
    await etc.locator('input[name="reason"]').fill('Panels quoted higher');
    await etc.locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText(/^Typed, /).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Panels quoted higher' })).toBeVisible();

    await page.goto('/administration/project-settings');
    await expect(page.getByRole('heading', { name: 'Revenue recognition', level: 2 })).toBeVisible();

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of [`/projects/billing?project=${encodeURIComponent(code)}`, `/projects/billing/${encodeURIComponent(certificateNo)}`, `/projects/forecast?project=${encodeURIComponent(code)}`]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
  });
});
