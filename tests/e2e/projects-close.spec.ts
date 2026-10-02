import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PM-001 PM14 `pm-screens`, Stage PM-6 — on the Progress workspace
 * hours are booked by one person, approved by another and withdrawn; on the
 * Close workspace the project is technically completed, its settlement
 * drafted by one person and posted by another, the checklist clears and the
 * project closes; the Reports screen draws each of the four reports with its
 * Print / Export menu; all of it reads in Arabic at a phone's width.
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

test.describe('REQ-PM-001 Stage PM-6 · hours, settlement, close and reports', () => {
  test('hours are approved by somebody else; a settled project closes; the four reports draw', async ({ page, browser }) => {
    test.setTimeout(420_000);
    await signIn(page, MANAGER);

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const create = page.getByRole('dialog');
    await create.locator('select[name="type_code"]').selectOption('INVESTMENT');
    await create.locator('input[name="name"]').fill(`Showroom ${RUN}`);
    await create.locator('input[name="baseline_starts_on"]').fill('2026-09-01');
    await create.locator('input[name="baseline_ends_on"]').fill('2026-12-31');
    await create.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/PRJ-/);
    const code = decodeURIComponent(page.url().split('/projects/')[1]!.split('?')[0]!);
    const other = await browser.newContext();
    const adminPage = await other.newPage();
    await signIn(adminPage, ADMIN);
    await adminPage.goto(`/projects/${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Release' }).click();
    await adminPage.waitForURL(/saved=1/);

    // Hours: booked by the manager, approved by the administrator, then withdrawn.
    await page.goto(`/projects/progress?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Hours', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Book hours' }).click();
    const book = page.getByRole('dialog');
    await book.locator('select[name="employee_id"]').selectOption({ index: 0 });
    await book.locator('input[name="work_date"]').fill('2026-09-15');
    await book.locator('input[name="hours"]').fill('7.5');
    await book.locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('Booked', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('row', { name: /7\.5/ }).getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await adminPage.goto(`/projects/progress?project=${encodeURIComponent(code)}`);
    await adminPage.getByRole('row', { name: /7\.5/ }).getByRole('button', { name: 'Approve' }).click();
    await adminPage.waitForURL(/saved=1/);
    await page.goto(`/projects/progress?project=${encodeURIComponent(code)}`);
    const sheet = page.getByRole('row', { name: /7\.5/ });
    await expect(sheet.getByText('Approved', { exact: true })).toBeVisible();
    await sheet.locator('input[name="reason"]').fill('Booked to the wrong project');
    await sheet.getByRole('button', { name: 'Cancel line' }).click();
    await page.waitForURL(/saved=1/);

    // Close: technical completion, the settlement drafted by one and posted by the other, then the close.
    await page.goto(`/projects/close?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Close', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Technically complete' }).click();
    await page.getByRole('dialog').locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
    await page.getByRole('button', { name: 'Draft settlement' }).click();
    await page.getByRole('dialog').locator('input[name="note"]').fill('Handed to facilities');
    await page.getByRole('dialog').locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('Asset under construction').first()).toBeVisible();
    await expect(page.getByRole('row', { name: /PST-/ }).getByRole('button', { name: 'Post' })).toHaveCount(0);

    await adminPage.goto(`/projects/close?project=${encodeURIComponent(code)}`);
    await adminPage.getByRole('row', { name: /PST-/ }).getByRole('button', { name: 'Post' }).click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.getByText('nothing stands in the way')).toBeVisible();
    await adminPage.getByRole('button', { name: 'Close project' }).click();
    await adminPage.getByRole('dialog').locator('input[name="note"]').fill('Capitalised');
    await adminPage.getByRole('dialog').locator('button[type="submit"]').first().click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.locator('[data-status="closed"]').first()).toBeVisible();
    await other.close();

    // The four reports, each with its Print / Export menu.
    for (const [report, heading] of [
      ['cost', 'Budget'],
      ['lines', 'Amount'],
      ['trend', 'Code'],
      ['ev', 'BCWP'],
    ] as const) {
      await page.goto(`/projects/reports?project=${encodeURIComponent(code)}&report=${report}`);
      await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: heading, exact: false }).first()).toBeVisible();
      await expect(page.getByText('Print / Export').first()).toBeVisible();
    }

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of [`/projects/close?project=${encodeURIComponent(code)}`, `/projects/reports?project=${encodeURIComponent(code)}&report=ev`, `/projects/progress?project=${encodeURIComponent(code)}`]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
  });
});
