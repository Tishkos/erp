import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PM-001 PM14 `pm-screens`, Stage PM-2 — a project's original budget is
 * typed on the new-document page, submitted, and approved by somebody else;
 * a change order is raised and approved twice and raises its supplement;
 * the cost plan gets a version and a spread; all of it reads in Arabic at a
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

test.describe('REQ-PM-001 Stage PM-2 · budget documents, change orders and the plan', () => {
  test('an original budget, a supplement through a change order, and a plan version', async ({ page, browser }) => {
    test.setTimeout(420_000);
    await signIn(page, MANAGER);

    // A released internal project with one child element.
    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="type_code"]').selectOption('INTERNAL');
    await dialog.locator('input[name="name"]').fill(`Depot extension ${RUN}`);
    await dialog.locator('input[name="baseline_starts_on"]').fill('2026-11-01');
    await dialog.locator('input[name="baseline_ends_on"]').fill('2027-04-30');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/PRJ-/);
    const code = decodeURIComponent(page.url().split('/projects/')[1]!.split('?')[0]!);
    await page.getByRole('button', { name: 'Add element' }).first().click();
    const add = page.getByRole('dialog');
    await add.locator('input[name="name"]').fill('Steel frame');
    await add.locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    const other = await browser.newContext();
    const adminPage = await other.newPage();
    await signIn(adminPage, ADMIN);
    await adminPage.goto(`/projects/${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Release' }).click();
    await adminPage.waitForURL(/saved=1/);

    // The original budget: the project named, one amount per element and cost code.
    await page.goto('/projects/budgets');
    await expect(page.getByRole('heading', { name: 'Budgets', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'New budget document' }).click();
    await page.waitForURL(/\/projects\/budgets\/new/);
    await page.locator('input[name="project"]').fill(code);
    await page.getByRole('button', { name: 'Choose' }).click();
    await page.waitForURL(new RegExp(`project=${code}`));
    await page.locator('input[name="description"]').fill('Tender budget');
    await page.locator('input[name="amount_0_MAT"]').fill('3000000');
    await page.locator('input[name="amount_1_MAT"]').fill('2000000');
    await page.locator('input[name="amount_1_LAB"]').fill('1000000');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/budgets\/PBD-/);
    const budgetNo = decodeURIComponent(page.url().split('/projects/budgets/')[1]!.split('?')[0]!);
    expect(budgetNo).toMatch(/^PBD-HQ-2026-\d{6}$/);
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await page.waitForURL(/saved=1/);
    // The raiser sees no Approve; the administrator approves.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await adminPage.goto(`/projects/budgets/${encodeURIComponent(budgetNo)}`);
    await adminPage.getByRole('button', { name: 'Approve' }).click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.getByText('Approved', { exact: true }).first()).toBeVisible();
    // The record's budget by element adds up.
    await page.goto(`/projects/${encodeURIComponent(code)}`);
    await expect(page.getByRole('cell', { name: /6,000,000 IQD/ }).first()).toBeVisible();

    // A change order with a supplement on the child: the two approvals, neither the raiser's, and the supplement it raises.
    await page.goto('/projects/change-orders/new');
    await page.locator('input[name="project"]').fill(code);
    await page.getByRole('button', { name: 'Choose' }).click();
    await page.waitForURL(new RegExp(`project=${code}`));
    await page.locator('input[name="description"]').fill('Second bay');
    await page.locator('input[name="schedule_delta_days"]').fill('14');
    await page.locator('input[name="amount_1_MAT"]').fill('500000');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/change-orders\/PVR-/);
    const coNo = decodeURIComponent(page.url().split('/projects/change-orders/')[1]!.split('?')[0]!);
    await adminPage.goto(`/projects/change-orders/${encodeURIComponent(coNo)}`);
    await adminPage.getByRole('button', { name: 'Approve commercially' }).click();
    await adminPage.waitForURL(/saved=1/);
    await adminPage.getByRole('button', { name: 'Approve budget' }).click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.getByText('Approved', { exact: true }).first()).toBeVisible();
    await expect(adminPage.getByRole('link', { name: /PBD-HQ-2026-\d{6}/ })).toBeVisible();
    await other.close();

    // The cost plan: a first version and a spread over the project's months.
    await page.goto(`/projects/plan?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Cost Plan', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New version' }).click();
    await page.getByRole('dialog').locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    await page.getByRole('button', { name: 'Spread over months' }).click();
    const spread = page.getByRole('dialog');
    await spread.locator('select[name="cost_code"]').selectOption('MAT');
    await spread.locator('input[name="total_iqd"]').fill('3000000');
    await spread.locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('cell', { name: /3,000,000 IQD/ }).first()).toBeVisible();

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/projects/budgets', `/projects/budgets/${encodeURIComponent(budgetNo)}`, '/projects/change-orders', `/projects/change-orders/${encodeURIComponent(coNo)}`, `/projects/plan?project=${encodeURIComponent(code)}`]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'خطة التكاليف', level: 1 })).toBeVisible();
  });
});
