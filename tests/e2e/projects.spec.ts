import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-PM-001 PM14 `pm-screens` — the Projects section is in the navbar, a
 * project is created from the master list, its structure is built on the
 * record and on the WBS workspace, it is released by somebody else, and the
 * settings screen shows the seeded masters; all of it reads in Arabic at a
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

test.describe('REQ-PM-001 Stage PM-1 · structure and the master screens', () => {
  test('a project is created, structured, released by another person, and read on every screen', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await signIn(page, MANAGER);

    // The master list and the new-project dialog (an internal project: no customer).
    await page.goto('/projects');
    await expect(page.getByRole('heading', { name: 'Project Master', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('select[name="type_code"]').selectOption('INTERNAL');
    await dialog.locator('input[name="name"]').fill(`Warehouse fit-out ${RUN}`);
    await dialog.locator('input[name="baseline_starts_on"]').fill('2026-10-01');
    await dialog.locator('input[name="baseline_ends_on"]').fill('2026-12-31');
    await dialog.locator('input[name="baseline_budget_iqd"]').fill('5000000');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/PRJ-/);
    const code = decodeURIComponent(page.url().split('/projects/')[1]!.split('?')[0]!);
    expect(code).toMatch(/^PRJ-HQ-2026-\d{6}$/);
    await expect(page.getByRole('heading', { name: new RegExp(`${code} · Warehouse fit-out ${RUN}`) })).toBeVisible();
    // The level-1 element exists with the project's name; the chip says Created.
    await expect(page.getByText(`${code}-1`).first()).toBeVisible();
    await expect(page.getByText('Created', { exact: true }).first()).toBeVisible();

    // A child element from the record, coded by the mask.
    await page.getByRole('button', { name: 'Add element' }).first().click();
    const add = page.getByRole('dialog');
    await add.locator('input[name="name"]').fill('Civil works');
    await add.locator('input[name="planned_starts_on"]').fill('2026-10-05');
    await add.locator('input[name="planned_ends_on"]').fill('2026-11-15');
    await add.locator('button[type="submit"]').click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('cell', { name: `${code}-1.1` }).first()).toBeVisible();

    // The creator cannot release; the administrator can, and the chip moves.
    await expect(page.getByRole('button', { name: 'Release' })).toHaveCount(0);
    const other = await browser.newContext();
    const adminPage = await other.newPage();
    await signIn(adminPage, ADMIN);
    await adminPage.goto(`/projects/${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Release' }).click();
    await adminPage.waitForURL(/saved=1/);
    await expect(adminPage.getByText('Released', { exact: true }).first()).toBeVisible();
    await other.close();

    // The WBS workspace shows the same tree, rolled up.
    await page.goto(`/projects/wbs?project=${encodeURIComponent(code)}`);
    await expect(page.getByRole('heading', { name: 'WBS', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: `${code}-1.1` }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Civil works' }).first()).toBeVisible();

    // Contracts lists customer projects only — the internal one is not there.
    await page.goto('/projects/contracts');
    await expect(page.getByRole('heading', { name: 'Contracts', level: 1 })).toBeVisible();
    await expect(page.getByText(code)).toHaveCount(0);

    // The settings screen shows the seeded masters.
    await page.goto('/administration/project-settings');
    await expect(page.getByRole('heading', { name: 'Project Settings', level: 1 })).toBeVisible();
    await expect(page.getByText('Investment project')).toBeVisible();
    await expect(page.getByText('Subcontract')).toBeVisible();

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/projects', `/projects/${encodeURIComponent(code)}`, '/projects/wbs', '/projects/contracts', '/administration/project-settings']) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'إعدادات المشاريع', level: 1 })).toBeVisible();
  });
});
