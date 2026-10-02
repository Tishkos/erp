import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-FIX-001 FIX-5 — HR structure and the user link, on the screens.
 *
 *   A new user is an employee (the tick is on by default): the account page
 *   names the employee, the employee page has the hired history.
 *   The HR tabs are the sponsor's thirteen, in his order.
 *   A position is made from HR → Positions (its code minted), and its
 *   department's record lists it as a seat.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7);

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('FIX-5 · HR structure and the user link', () => {
  test('a new user is also an employee, unless unticked', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADMIN);
    await page.goto('/administration/users');
    await page.getByRole('button', { name: 'New user' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Also an employee' })).toBeChecked();
    await dialog.getByRole('textbox', { name: 'Email', exact: true }).fill(`staff.${RUN}@example.com`);
    await dialog.getByRole('textbox', { name: 'Display name', exact: true }).fill(`Staff ${RUN}`);
    await dialog.getByRole('checkbox', { name: /^HQ ·/ }).check();
    const department = dialog.locator('select[name="employeeDepartmentCode"]');
    await department.selectOption({ index: 1 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/administration\/users\/[a-f0-9-]+\?saved=1/, { timeout: 60_000 });

    const link = page.getByRole('link', { name: /EMP-HQ-\d{4}$/ });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/hr\/employees\/EMP-HQ-/);
    await expect(page.getByRole('heading', { name: new RegExp(`Staff ${RUN}`), level: 1 })).toBeVisible();
    await expect(page.getByText('Hired', { exact: true })).toBeVisible();
    await expect(page.getByText(`staff.${RUN}@example.com`).first()).toBeVisible();
  });

  test('the HR tabs follow the sponsor’s order, and a position is made and seated in its department', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, MANAGER);
    await page.goto('/hr/positions');
    const tabs = page.getByRole('navigation', { name: 'Positions' });
    // The tabs are the section's built screens, in the menu's order; the
    // whole thirteen are held by tests/unit/fx5-hr-menu.test.ts.
    await expect(tabs.getByRole('link')).toHaveText(['Employees', 'Departments', 'Positions', 'Attendance', 'Leave Management']);

    await page.getByRole('button', { name: 'New position' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[name="title_en"]').fill(`Planner ${RUN}`);
    const department = dialog.locator('select[name="department_code"]');
    await department.selectOption({ index: 1 });
    const departmentCode = (await department.inputValue()).trim();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/positions\/POS-\d{4}\?saved=1/);
    const code = decodeURIComponent(page.url().split('/hr/positions/')[1]!.split('?')[0]!);
    await expect(page.getByRole('heading', { name: `${code} · Planner ${RUN}`, level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog');
    await edit.locator('input[name="title_ar"]').fill(`مخطط ${RUN}`);
    await edit.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByText(`مخطط ${RUN}`)).toBeVisible();

    await page.goto(`/hr/departments/${encodeURIComponent(departmentCode)}`);
    await expect(page.getByRole('link', { name: `Planner ${RUN}` })).toBeVisible();
    await page.goto('/hr/departments');
    await expect(page.getByRole('link', { name: new RegExp(`${departmentCode}$`) })).toBeVisible();
  });
});
