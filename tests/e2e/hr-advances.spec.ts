import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * REQ-HR-001 Stage HR-4 — advances, loans and equipment on the screens.
 *
 * The seed's officer holds the HR officer's hat and asks; the manager holds
 * the HR manager's and endorses — and, holding the accounting manager's too,
 * may not also approve what they endorsed, so the administrator approves;
 * the manager pays. Recovery through payroll is held by
 * tests/integration/hr04-advances.test.ts.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const OFFICER = 'officer@example.com';
const MANAGER = 'manager@example.com';
const ADMIN = 'admin@example.com';
const RUN = Math.random().toString(36).slice(2, 7);

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function as(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return { page, close: () => context.close() };
}

test.describe('REQ-HR-001 Stage HR-4 · advances, loans and equipment', () => {
  test('an advance is asked for, endorsed, approved by somebody else, and paid out', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, OFFICER);
    // A person for this run, so nobody's own sign-in stands in the way of the approvals.
    await page.goto('/hr/employees');
    await page.getByRole('button', { name: 'New employee' }).click();
    const hire = page.getByRole('dialog');
    await hire.locator('input[name="full_name_en"]').fill(`Advance Person ${RUN}`);
    await hire.locator('input[name="hire_date"]').fill('2024-01-01');
    await hire.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    const employeeNo = decodeURIComponent(page.url().split('/hr/employees/')[1]!.split('?')[0]!);

    await page.goto('/hr/advances');
    await expect(page.getByRole('heading', { name: 'Advances & Loans', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New advance or loan' }).click();
    const dialog = page.getByRole('dialog');
    const option = dialog.locator('select[name="employee_id"] option', { hasText: `${employeeNo} · ` });
    await dialog.locator('select[name="employee_id"]').selectOption((await option.getAttribute('value'))!);
    await dialog.locator('input[name="amount"]').fill('100000');
    await dialog.locator('input[name="reason"]').fill(`Rent deposit ${RUN}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/advances\/EADV-/);
    const advanceNo = decodeURIComponent(page.url().split('/hr/advances/')[1]!.split('?')[0]!);
    await page.goto(`/hr/advances/${encodeURIComponent(advanceNo)}`);
    await page.getByRole('button', { name: 'Send for endorsement' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('[data-status="submitted"]').first()).toBeVisible();

    const hrManager = await as(browser, MANAGER);
    await hrManager.page.goto(`/hr/advances/${encodeURIComponent(advanceNo)}`);
    await hrManager.page.getByRole('button', { name: 'Endorse' }).click();
    const endorse = hrManager.page.getByRole('dialog');
    await endorse.locator('input[name="note"]').fill(`Agreed ${RUN}`);
    await endorse.getByRole('button', { name: 'Endorse' }).click();
    await hrManager.page.waitForURL(/saved=1/);
    await hrManager.page.goto(`/hr/advances/${encodeURIComponent(advanceNo)}`);
    // The endorser does not also approve.
    await expect(hrManager.page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(hrManager.page.getByText(/somebody else takes the next step/)).toBeVisible();

    const admin = await as(browser, ADMIN);
    await admin.page.goto(`/hr/advances/${encodeURIComponent(advanceNo)}`);
    await admin.page.getByRole('button', { name: 'Approve' }).click();
    await admin.page.waitForURL(/saved=1/);
    await admin.close();

    await hrManager.page.goto(`/hr/advances/${encodeURIComponent(advanceNo)}`);
    await hrManager.page.getByRole('button', { name: 'Pay out' }).click();
    const pay = hrManager.page.getByRole('dialog');
    await pay.getByRole('button', { name: 'Pay out' }).click();
    await hrManager.page.waitForURL(/saved=1/);
    await expect(hrManager.page.locator('[data-status="posted"]').first()).toBeVisible();
    await expect(hrManager.page.getByRole('link', { name: /JE-/ }).first()).toBeVisible();
    await hrManager.close();
  });

  test('equipment is handed out on the employee page and taken back with its condition', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, MANAGER);
    await page.goto('/hr/employees');
    await page.locator('table a[href^="/hr/employees/EMP-"]').first().click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    const record = page.url().split('?')[0]!;
    const section = page.locator('section[aria-labelledby="employee-equipment-title"]');
    await section.locator('input[name="description"]').fill(`Laptop ${RUN}`);
    await section.locator('input[name="serial_no"]').fill(`SN-${RUN}`);
    await section.locator('input[name="condition"]').last().fill('New');
    await section.getByRole('button', { name: 'Hand out' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(record);
    const row = page.locator('section[aria-labelledby="employee-equipment-title"] tr', { hasText: `Laptop ${RUN}` });
    await expect(row).toContainText(`SN-${RUN}`);
    await row.locator('input[name="condition"]').fill('Scratched lid');
    await row.getByRole('button', { name: 'Returned' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(record);
    await expect(page.locator('section[aria-labelledby="employee-equipment-title"] tr', { hasText: `Laptop ${RUN}` })).toContainText('Scratched lid');
    await expect(page.getByRole('heading', { name: 'Advances & loans', level: 2 })).toBeVisible();
  });
});
