import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-HR-001 H7 — the HR section is in the navbar, its screens open, they
 * are translated, and they read at mobile RTL.
 *
 * The seed gives the accounting manager the HR manager's hat and the
 * officer the HR officer's (scripts/seed-dev.ts), so the compensation
 * window is seen by one and not the other.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7);

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('REQ-HR-001 Stage HR-1 · people and organisation', () => {
  test('the section is in the navbar and every screen opens, in both languages', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, MANAGER);

    await page.goto('/hr/employees');
    await expect(page.getByRole('heading', { name: 'Employees', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Organisation' })).toBeVisible();

    await page.goto('/hr/organisation');
    await expect(page.getByRole('heading', { name: 'Organisation', level: 1 })).toBeVisible();

    await page.goto('/administration/hr-settings');
    await expect(page.getByRole('heading', { name: 'HR Settings', level: 1 })).toBeVisible();
    // The seeded masters (D-HR-3) are rows on the screen.
    await expect(page.getByText('Social security — employee share')).toBeVisible();
    await expect(page.getByText('Annual leave')).toBeVisible();

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/hr/employees', '/hr/organisation', '/administration/hr-settings']) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'إعدادات الموارد البشرية', level: 1 })).toBeVisible();
  });

  test('an employee is created from the list, moved on the record, and the officer sees no salary', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    await page.goto('/hr/employees');
    await page.getByRole('button', { name: 'New employee' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="full_name_en"]').fill(`E2E Person ${RUN}`);
    await dialog.locator('input[name="hire_date"]').fill('2026-02-01');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    const employeeNo = decodeURIComponent(page.url().split('/hr/employees/')[1]!.split('?')[0]!);
    expect(employeeNo).toMatch(/^EMP-HQ-\d{4}$/);
    await expect(page.getByRole('heading', { name: new RegExp(`${employeeNo} · E2E Person ${RUN}`) })).toBeVisible();
    // The first history rows are there, and the compensation window is drawn for the HR manager.
    await expect(page.getByText('Hired', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Compensation' })).toBeVisible();

    // A compensation row, then a move.
    await page.locator('input[name="base_salary_iqd"]').fill('1250000');
    await page.locator('select[name="pay_method"]').selectOption('cash');
    await page.locator('form:has(input[name="base_salary_iqd"]) button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('1,250,000 IQD')).toBeVisible();

    await page.getByRole('button', { name: 'Move' }).click();
    const move = page.getByRole('dialog');
    await expect(move).toBeVisible();
    await move.locator('select[name="employment_kind"]').selectOption('contract');
    await move.locator('input[name="reason"]').fill('E2E move');
    await move.locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('E2E move').first()).toBeVisible();

    // The officer opens the same record: identity and history, no compensation.
    const other = await browser.newContext();
    const officerPage = await other.newPage();
    await signIn(officerPage, OFFICER);
    await officerPage.goto(`/hr/employees/${encodeURIComponent(employeeNo)}`);
    await expect(officerPage.getByRole('heading', { name: new RegExp(employeeNo) })).toBeVisible();
    await expect(officerPage.getByText('E2E move').first()).toBeVisible();
    await expect(officerPage.getByRole('heading', { name: 'Compensation' })).toHaveCount(0);
    await expect(officerPage.getByText('1,250,000 IQD')).toHaveCount(0);
    await other.close();
  });
});
