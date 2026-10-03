import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * REQ-HR-001 Stage HR-6 — requests, documents, the HR dashboard and reports
 * on the screens.
 *
 * The seed's manager holds the HR manager's hat (and Finance's); the officer
 * is the HR officer. The officer asks for a letter and a claim for a person
 * made for the run; the manager approves both and issues the letter, which
 * then reads as issued. The officer files the person's passport; the manager
 * renews it, and the first one reads as renewed. The dashboard and the four
 * reports open with their figures. Reimbursing a claim (C-20: from a bank
 * that holds the money) and the trip's advance are held by
 * tests/integration/hr06-requests.test.ts.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const OFFICER = 'officer@example.com';
const MANAGER = 'manager@example.com';
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

const recordNo = (page: Page, prefix: string) => decodeURIComponent(page.url().split(prefix)[1]!.split('?')[0]!);

/** The record afresh, without the last action's `saved=1` — so the next wait is for the next action. */
const openRequest = (page: Page, requestNo: string) => page.goto(`/hr/requests/${encodeURIComponent(requestNo)}`);

/** A person for the run, made by the HR manager. */
async function newPerson(page: Page, name: string): Promise<string> {
  await page.goto('/hr/employees');
  await page.getByRole('button', { name: 'New employee' }).click();
  const person = page.getByRole('dialog');
  await person.locator('input[name="full_name_en"]').fill(name);
  await person.locator('input[name="hire_date"]').fill('2024-01-01');
  await person.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/hr\/employees\/EMP-/);
  return recordNo(page, '/hr/employees/');
}

/** The New request dialog, filled for a person. */
async function ask(page: Page, kind: string, employeeNo: string, subject: string) {
  await page.goto('/hr/requests');
  await expect(page.getByRole('heading', { name: 'Employee Requests', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'New request' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('select[name="request_kind"]').selectOption(kind);
  const option = dialog.locator('select[name="employee_id"] option', { hasText: employeeNo });
  await dialog.locator('select[name="employee_id"]').selectOption((await option.getAttribute('value'))!);
  await dialog.locator('input[name="subject"]').fill(subject);
  return dialog;
}

test.describe('REQ-HR-001 Stage HR-6 · requests, documents, dashboard and reports', () => {
  test('a letter is asked by HR, approved and issued by the HR manager, and reads as issued', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    const employeeNo = await newPerson(page, `Letter Person ${RUN}`);

    const officer = await as(browser, OFFICER);
    const dialog = await ask(officer.page, 'letter', employeeNo, `Employment letter ${RUN}`);
    await dialog.locator('select[name="letter_type"]').selectOption('employment');
    await dialog.locator('input[name="addressed_to"]').fill('The Embassy');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await officer.page.waitForURL(/\/hr\/requests\/LTR-[^?]+\?saved=1/);
    const requestNo = recordNo(officer.page, '/hr/requests/');
    await expect(officer.page.locator('[data-status="draft"]').first()).toBeVisible();
    await openRequest(officer.page, requestNo);
    await officer.page.getByRole('button', { name: 'Send for approval' }).click();
    await officer.page.waitForURL(/saved=1/);
    await expect(officer.page.locator('[data-status="submitted"]').first()).toBeVisible();
    await officer.close();

    // The HR manager decides it and issues it with its text.
    await page.goto(`/hr/requests/${encodeURIComponent(requestNo)}`);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('[data-status="approved"]').first()).toBeVisible();
    await openRequest(page, requestNo);
    await page.getByRole('button', { name: 'Issue the letter' }).click();
    const issue = page.getByRole('dialog');
    await expect(issue.locator('textarea[name="issued_text"]')).toHaveValue(/This is to certify that Letter Person/);
    await issue.locator('textarea[name="issued_text"]').fill(`The Embassy,\n\nThis is to certify that Letter Person ${RUN} works with us.`);
    await issue.getByRole('button', { name: 'Issue the letter' }).click();
    await page.waitForURL(/saved=1/);
    await openRequest(page, requestNo);
    await expect(page.locator('[data-status="posted"]').first()).toBeVisible();
    await expect(page.getByText(`This is to certify that Letter Person ${RUN} works with us.`)).toBeVisible();
  });

  test('a claim with its lines and receipt is sent, approved, and listed on the person', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    const employeeNo = await newPerson(page, `Claim Person ${RUN}`);

    const officer = await as(browser, OFFICER);
    const dialog = await ask(officer.page, 'expense_claim', employeeNo, `Customs trip ${RUN}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await officer.page.waitForURL(/\/hr\/requests\/ECLM-[^?]+\?saved=1/);
    const requestNo = recordNo(officer.page, '/hr/requests/');
    await openRequest(officer.page, requestNo);
    // One line; the category comes from the expense categories.
    await officer.page.getByLabel('Spent on 1').fill('2026-09-20');
    const category = officer.page.getByLabel('Expense category 1');
    await category.selectOption({ index: 1 });
    await officer.page.getByLabel('What for 1').fill('Taxi to the customs office');
    await officer.page.getByLabel('Amount 1').fill('25000');
    await officer.page.getByRole('button', { name: 'Save', exact: true }).click();
    await officer.page.waitForURL(/saved=1/);
    await expect(officer.page.getByText('25,000').first()).toBeVisible();
    // Its receipt, then sent.
    await openRequest(officer.page, requestNo);
    await officer.page.locator('input[name="file"]').setInputFiles({ name: `receipt-${RUN}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% receipt\n%%EOF\n') });
    await officer.page.getByRole('button', { name: 'Attach' }).click();
    await officer.page.waitForURL(/saved=1/);
    await openRequest(officer.page, requestNo);
    await officer.page.getByRole('button', { name: 'Send for approval' }).click();
    await officer.page.waitForURL(/saved=1/);
    await expect(officer.page.locator('[data-status="submitted"]').first()).toBeVisible();
    await officer.close();

    await page.goto(`/hr/requests/${encodeURIComponent(requestNo)}`);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('[data-status="approved"]').first()).toBeVisible();
    // Finance reimburses it from here; the person's page lists it.
    await expect(page.getByRole('button', { name: 'Reimburse' })).toBeVisible();
    await page.goto(`/hr/employees/${encodeURIComponent(employeeNo)}`);
    await expect(page.getByRole('link', { name: requestNo })).toBeVisible();
  });

  test('a passport is filed, renewed, and the first one reads as renewed', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    const employeeNo = await newPerson(page, `Paper Person ${RUN}`);

    const officer = await as(browser, OFFICER);
    await officer.page.goto('/hr/documents');
    await expect(officer.page.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible();
    await officer.page.getByRole('button', { name: 'New document' }).click();
    const dialog = officer.page.getByRole('dialog');
    const option = dialog.locator('select[name="employee_id"] option', { hasText: employeeNo });
    await dialog.locator('select[name="employee_id"]').selectOption((await option.getAttribute('value'))!);
    await dialog.locator('select[name="doc_type"]').selectOption('passport');
    await dialog.locator('input[name="reference_no"]').fill(`A${RUN}`.toUpperCase());
    await dialog.locator('input[name="issued_on"]').fill('2020-01-01');
    await dialog.locator('input[name="expires_on"]').fill('2030-01-01');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await officer.page.waitForURL(/\/hr\/documents\/EDOC-[^?]+\?saved=1/);
    const first = recordNo(officer.page, '/hr/documents/');
    await expect(officer.page.locator('[data-status="approved"]').first()).toBeVisible();
    await officer.close();

    await page.goto(`/hr/documents/${encodeURIComponent(first)}`);
    await page.getByRole('button', { name: 'Renew' }).click();
    const renew = page.getByRole('dialog');
    await renew.locator('#f-renew-reference').fill(`B${RUN}`.toUpperCase());
    await renew.locator('#f-renew-issued').fill('2026-01-01');
    await renew.locator('#f-renew-expires').fill('2036-01-01');
    await renew.getByRole('button', { name: 'Renew' }).click();
    await page.waitForURL(/\/hr\/documents\/EDOC-[^?]+\?saved=1/);
    const second = recordNo(page, '/hr/documents/');
    expect(second).not.toBe(first);
    await page.goto(`/hr/documents/${encodeURIComponent(first)}`);
    await expect(page.locator('[data-status="closed"]').first()).toBeVisible();
    await page.goto(`/hr/employees/${encodeURIComponent(employeeNo)}`);
    await expect(page.getByRole('link', { name: second })).toBeVisible();
  });

  test('the HR dashboard and the four reports open with their figures', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, MANAGER);
    await page.goto('/hr/dashboard');
    await expect(page.getByRole('heading', { name: 'HR Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Headcount').first()).toBeVisible();
    for (const report of ['headcount', 'leave', 'payroll', 'advances']) {
      await page.goto(`/hr/reports?report=${report}`);
      await expect(page.locator('main table').first()).toBeVisible();
    }
  });
});
