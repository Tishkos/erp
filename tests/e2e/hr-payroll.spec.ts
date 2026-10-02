import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-HR-001 Stage HR-3 — payroll on the screens.
 *
 * The seed gives the accounting manager the HR manager's hat
 * (scripts/seed-dev.ts): the manager reads compensation, so prepares a run.
 * A run is cancelled at the end, so the month is free for the next run of
 * this file; posting, paying and reversing are held by
 * tests/integration/hr03-payroll.test.ts.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('REQ-HR-001 Stage HR-3 · payroll', () => {
  test('a month is computed for a branch, typed on, and cancelled with its reason', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    await page.goto('/hr/payroll');
    await expect(page.getByRole('heading', { name: 'Payroll', level: 1 })).toBeVisible();

    // The current month: whatever an earlier run of this file left is cancelled first.
    const month = (await page.evaluate(() => new Date().toISOString().slice(0, 7))) as string;
    await page.goto(`/hr/payroll?q=${month}&view=draft`);
    for (const stale of await page.locator('table a[href^="/hr/payroll/PAY-"]').all()) {
      const href = await stale.getAttribute('href');
      const other = await page.context().newPage();
      await other.goto(href!);
      await other.locator('input[name="reason"]').last().fill('Left by an earlier test run');
      await other.getByRole('button', { name: 'Cancel', exact: true }).click();
      await other.waitForURL(/saved=1|error=/);
      await other.close();
    }

    await page.goto('/hr/payroll');
    await page.getByRole('button', { name: 'New payroll run' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="branch"]').selectOption('HQ');
    await dialog.locator('select[name="month"]').selectOption(month);
    await dialog.getByRole('button', { name: 'Compute the run' }).click();
    await page.waitForURL(/\/hr\/payroll\/PAY-HQ-/);
    const runNo = decodeURIComponent(page.url().split('/hr/payroll/')[1]!.split('?')[0]!);
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: new RegExp(runNo) }).first()).toBeVisible();
    // The record without the creation's flag, so each save below is waited for by its own.
    await page.goto(`/hr/payroll/${encodeURIComponent(runNo)}`);

    // The figures typed on the run, each with its note; the line follows.
    const typed = page.locator('section[aria-labelledby="payroll-typed-title"]');
    await typed.locator('input[name="OVERTIME_0"]').fill('25000');
    await typed.locator('input[name="note_0"]').fill('Stock count');
    await typed.getByRole('button', { name: 'Save the typed figures' }).click();
    await page.waitForURL(/saved=1/);
    // Read afresh: React resets a submitted form once its action settles.
    await page.goto(`/hr/payroll/${encodeURIComponent(runNo)}`);
    await expect(page.locator('input[name="OVERTIME_0"]')).toHaveValue('25000');
    await expect(page.locator('input[name="note_0"]')).toHaveValue('Stock count');
    await expect(page.locator('section[aria-labelledby="payroll-components-title"]')).toContainText('Overtime');

    // A typed figure without its note is refused, naming why.
    await page.locator('input[name="OVERTIME_0"]').fill('30000');
    await page.locator('input[name="note_0"]').fill('');
    await page.getByRole('button', { name: 'Save the typed figures' }).click();
    await page.waitForURL(/error=/);
    await expect(page.getByText(/needs its note/).first()).toBeVisible();
    await page.goto(`/hr/payroll/${encodeURIComponent(runNo)}`);

    await page.locator('input[name="reason"]').last().fill('Prepared by the end-to-end test');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('[data-status="cancelled"]').first()).toBeVisible();
  });

  test('the components carry their accounts, and a person’s page shows their figures and payslips', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, MANAGER);
    await page.goto('/administration/hr-settings');
    const components = page.locator('section[aria-labelledby="hrs-components-title"]');
    await expect(components.getByRole('columnheader', { name: 'Posts to' })).toBeVisible();
    await expect(components.getByRole('cell', { name: 'The salary in force' })).toBeVisible();
    await expect(components.getByRole('cell', { name: 'Absences from the day sheet' })).toBeVisible();

    await page.goto('/hr/employees');
    await page.locator('table a[href^="/hr/employees/EMP-"]').first().click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    await expect(page.getByRole('heading', { name: 'Pay components', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Payslips', level: 2 })).toBeVisible();
  });
});
