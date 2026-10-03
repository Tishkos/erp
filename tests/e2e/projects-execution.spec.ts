import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PM-001 PM14 `pm-screens`, Stage PM-3 — the line items, the
 * procurement register and the Material Issues document: a draft issue is
 * raised from the dialog with its one-time id, read on its record, and
 * cancelled with a reason; the purchase invoice form offers the project
 * element; all of it reads in Arabic at a phone's width.
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

test.describe('REQ-PM-001 Stage PM-3 · execution screens', () => {
  test('a material issue is raised, read and cancelled; the registers and the invoice form carry the project', async ({ page, browser }) => {
    test.setTimeout(360_000);
    await signIn(page, MANAGER);

    // A released internal project with one child element, so the dialog has something to offer.
    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="type_code"]').selectOption('INTERNAL');
    await dialog.locator('input[name="name"]').fill(`Yard paving ${RUN}`);
    await dialog.locator('input[name="baseline_starts_on"]').fill('2026-10-01');
    await dialog.locator('input[name="baseline_ends_on"]').fill('2027-01-31');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/PRJ-/);
    const code = decodeURIComponent(page.url().split('/projects/')[1]!.split('?')[0]!);
    await page.getByRole('button', { name: 'Add element' }).first().click();
    const add = page.getByRole('dialog');
    await add.locator('input[name="name"]').fill('Paving');
    await add.locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    const other = await browser.newContext();
    const adminPage = await other.newPage();
    await signIn(adminPage, ADMIN);
    await adminPage.goto(`/projects/${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Release' }).click();
    await adminPage.waitForURL(/saved=1/);
    await other.close();

    // The Material Issues register and its dialog.
    await page.goto('/projects/material-issues');
    await expect(page.getByRole('heading', { name: 'Material Issues', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New material issue' }).click();
    const issue = page.getByRole('dialog');
    await expect(issue.locator('input[name="document_id"]')).toHaveCount(1);
    await issue.locator('select[name="element"]').selectOption(`${code}|${code}-1.1`);
    await issue.locator('select[name="cost_code"]').selectOption('MAT');
    await issue.locator('select[name="kind"]').selectOption('issue');
    const warehouse = await issue.locator('select[name="warehouse_code"] option:not([value=""])').first().getAttribute('value');
    await issue.locator('select[name="warehouse_code"]').selectOption(warehouse!);
    const itemPicker = issue.locator('input[list]').first();
    const firstItem = await issue.locator('datalist option').first().getAttribute('value');
    await itemPicker.fill(firstItem!);
    await issue.locator('input[name="quantity"]').fill('1');
    await issue.locator('input[name="batch_number"]').fill('B-E2E');
    await issue.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/material-issues\/PMI-/);
    const issueNo = decodeURIComponent(page.url().split('/projects/material-issues/')[1]!.split('?')[0]!);
    expect(issueNo).toMatch(/^PMI-HQ-2026-\d{6}$/);
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Post' })).toBeVisible();
    await page.locator('input[name="reason"]').fill('raised for the test');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();

    // The line items and the procurement register.
    await page.goto(`/projects/costs?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'Project Costs', level: 1 })).toBeVisible();
    await expect(page.getByText(/Line items .* journal lines with the dimension/)).toBeVisible();
    await page.goto('/projects/procurement');
    await expect(page.getByRole('heading', { name: 'Procurement', level: 1 })).toBeVisible();

    // The purchase invoice form offers the element and the cost code.
    await page.goto('/payables/invoices/new');
    await expect(page.locator('select[name="project_element"] option', { hasText: `${code}-1.1` })).toHaveCount(1);
    await expect(page.locator('select[name="project_cost_code"]')).toBeVisible();

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/projects/material-issues', `/projects/material-issues/${encodeURIComponent(issueNo)}`, '/projects/costs', '/projects/procurement']) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
  });
});
