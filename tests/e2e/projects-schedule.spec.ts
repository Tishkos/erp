import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PM-001 PM14 `pm-screens`, Stage PM-4 — on the WBS workspace two
 * activities and a progress milestone are added, linked and scheduled, and
 * the critical path is marked; on the Progress workspace a measurement is
 * taken by one person and approved by another, the milestone is reached
 * and approved, and the trend shows the run; all of it reads in Arabic at
 * a phone's width.
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

async function dialogSave(page: Page, fill: (dialog: ReturnType<Page['getByRole']>) => Promise<void>, opener: string) {
  await page.getByRole('button', { name: opener }).first().click();
  const dialog = page.getByRole('dialog');
  await fill(dialog);
  await dialog.locator('button[type="submit"]').first().click();
  await page.waitForURL(/saved=1/);
}

test.describe('REQ-PM-001 Stage PM-4 · schedule and progress', () => {
  test('activities are linked and scheduled; progress and a milestone are approved by somebody else', async ({ page, browser }) => {
    test.setTimeout(420_000);
    await signIn(page, MANAGER);

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const create = page.getByRole('dialog');
    await create.locator('select[name="type_code"]').selectOption('INTERNAL');
    await create.locator('input[name="name"]').fill(`Cold store ${RUN}`);
    await create.locator('input[name="baseline_starts_on"]').fill('2026-09-06');
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

    // The schedule, on the WBS workspace.
    await page.goto(`/projects/wbs?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Schedule', level: 2 })).toBeVisible();
    await dialogSave(page, async (d) => {
      await d.locator('input[name="name"]').fill('Insulation');
      await d.locator('input[name="duration_days"]').fill('3');
    }, 'Add activity');
    await dialogSave(page, async (d) => {
      await d.locator('input[name="name"]').fill('Refrigeration');
      await d.locator('input[name="duration_days"]').fill('2');
    }, 'Add activity');
    await dialogSave(page, async (d) => {
      await d.locator('input[name="name"]').fill('Cold store running');
      await d.locator('select[name="kind"]').selectOption('milestone');
      await d.locator('input[name="duration_days"]').fill('0');
      await d.locator('select[name="milestone_usage"]').selectOption('progress');
      await d.locator('input[name="progress_percent"]').fill('100');
    }, 'Add activity');
    await dialogSave(page, async (d) => {
      await d.locator('select[name="predecessor_code"]').selectOption('A0010');
      await d.locator('select[name="successor_code"]').selectOption('A0020');
    }, 'Link activities');
    await dialogSave(page, async (d) => {
      await d.locator('select[name="predecessor_code"]').selectOption('A0020');
      await d.locator('select[name="successor_code"]').selectOption('A0030');
    }, 'Link activities');
    await dialogSave(page, async (d) => {
      await d.locator('input[name="reason"]').fill('first plan');
    }, 'Schedule');
    await expect(page.getByText(/finishes .* · run 1/)).toBeVisible();
    await expect(page.getByText('Critical', { exact: true }).first()).toBeVisible();

    // Progress: measured by the manager, approved by the administrator.
    await page.goto(`/projects/progress?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Progress', level: 1 })).toBeVisible();
    await dialogSave(page, async (d) => {
      await d.locator('select[name="wbs_code"]').selectOption(`${code}-1`);
      await d.locator('input[name="measured_on"]').fill('2026-09-30');
      await d.locator('input[name="percent_complete"]').fill('25');
    }, 'Measure progress');
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await page.locator('input[name="reached_on"]').first().fill('2026-10-01');
    await page.getByRole('button', { name: 'Reached' }).first().click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('Reached — awaiting approval')).toBeVisible();

    await adminPage.goto(`/projects/progress?project=${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Approve' }).first().click();
    await adminPage.waitForURL(/saved=1/);
    await adminPage.getByRole('button', { name: 'Approve' }).first().click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.getByRole('heading', { name: 'Milestone trend', level: 2 })).toBeVisible();
    await expect(adminPage.getByText('Done', { exact: true }).first()).toBeVisible();
    await other.close();

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of [`/projects/progress?project=${encodeURIComponent(code)}`, `/projects/wbs?project=${encodeURIComponent(code)}`]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
  });
});
