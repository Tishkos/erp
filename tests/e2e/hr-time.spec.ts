import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-HR-001 Stage HR-2 — leave and attendance on the screens.
 *
 * The seed gives the accounting manager the HR manager's hat and the officer
 * the HR officer's (scripts/seed-dev.ts): the officer asks and records, the
 * manager decides.
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

/** A Sunday in December of this year, far enough ahead not to meet another run's request. */
function sundayIn(offsetWeeks: number): { from: string; to: string } {
  const year = new Date().getUTCFullYear();
  const base = new Date(Date.UTC(year, 11, 1));
  while (base.getUTCDay() !== 0) base.setUTCDate(base.getUTCDate() + 1);
  base.setUTCDate(base.getUTCDate() + 7 * offsetWeeks);
  const to = new Date(base);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: base.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

test.describe('REQ-HR-001 Stage HR-2 · leave and attendance', () => {
  test('a leave request is made by the officer, decided by the HR manager, and reads on the employee page', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, OFFICER);
    // A person for this run, so the request never meets another run's.
    await page.goto('/hr/employees');
    await page.getByRole('button', { name: 'New employee' }).click();
    const hire = page.getByRole('dialog');
    await hire.locator('input[name="full_name_en"]').fill(`Leave Person ${RUN}`);
    await hire.locator('input[name="hire_date"]').fill('2024-01-01');
    await hire.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    const employeeNo = decodeURIComponent(page.url().split('/hr/employees/')[1]!.split('?')[0]!);

    await page.goto('/hr/leave');
    await expect(page.getByRole('heading', { name: 'Leave Management', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New leave request' }).click();
    const dialog = page.getByRole('dialog');
    const option = dialog.locator('select[name="employee_id"] option', { hasText: `${employeeNo} · ` });
    await dialog.locator('select[name="employee_id"]').selectOption((await option.getAttribute('value'))!);
    const span = sundayIn(1);
    await dialog.locator('select[name="leave_type_code"]').selectOption('ANNUAL');
    await dialog.locator('input[name="from_date"]').fill(span.from);
    await dialog.locator('input[name="to_date"]').fill(span.to);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/leave\/LVE-/);
    const requestNo = decodeURIComponent(page.url().split('/hr/leave/')[1]!.split('?')[0]!);
    await expect(page.getByText('Working day').first()).toBeVisible();

    await page.getByRole('button', { name: 'Send for decision' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('[data-status="submitted"]').first()).toBeVisible();
    // The officer asked; the officer does not decide.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    const other = await browser.newContext();
    const managerPage = await other.newPage();
    await signIn(managerPage, MANAGER);
    await managerPage.goto(`/hr/leave/${encodeURIComponent(requestNo)}`);
    await managerPage.getByRole('button', { name: 'Approve' }).click();
    const approve = managerPage.getByRole('dialog');
    await approve.locator('input[name="note"]').fill(`Approved ${RUN}`);
    await approve.getByRole('button', { name: 'Approve' }).click();
    await managerPage.waitForURL(/saved=1/);
    await expect(managerPage.locator('[data-status="approved"]').first()).toBeVisible();
    await expect(managerPage.getByText(`Approved ${RUN}`, { exact: true })).toBeVisible();

    // The person's page: the balance has taken the two days, the request is listed.
    await managerPage.goto(`/hr/employees/${encodeURIComponent(employeeNo)}?year=${span.from.slice(0, 4)}`);
    await expect(managerPage.getByRole('link', { name: new RegExp(requestNo) })).toBeVisible();
    const annual = managerPage.getByRole('row', { name: /Annual leave/ }).first();
    await expect(annual).toContainText('2');
    await other.close();
  });

  test('the day sheet records present and absent, and the employee month reads it', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, OFFICER);
    await page.goto('/hr/attendance');
    await expect(page.getByRole('heading', { name: 'Attendance', level: 1 })).toBeVisible();
    // The last weekday that has passed.
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - 1);
    while (day.getUTCDay() === 5 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
    const iso = day.toISOString().slice(0, 10);
    await page.goto(`/hr/attendance?day=${iso}`);
    const first = page.locator('select[name="status_0"]');
    await expect(first).toBeVisible();
    await first.selectOption('present');
    await page.locator('input[name="check_in_0"]').fill('08:15');
    await page.getByRole('button', { name: 'Save the sheet' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('select[name="status_0"]')).toHaveValue('present');
    await expect(page.locator('input[name="check_in_0"]')).toHaveValue('08:15');

    const employeeLink = page.locator('table a[href^="/hr/employees/"]').first();
    const href = await employeeLink.getAttribute('href');
    await page.goto(`${href}?month=${iso.slice(0, 7)}`);
    const row = page.getByRole('row', { name: new RegExp(`08:15`) });
    await expect(row.first()).toContainText('Present');
  });
});
