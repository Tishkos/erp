import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * REQ-HR-001 Stage HR-5 — recruitment and performance on the screens.
 *
 * The seed's manager holds the HR manager's hat: they make a position for
 * the run, draft a vacancy for it, open it, add an applicant, move them to an
 * offer and hire them — the employee page then says where the person came
 * from. For performance they make and open a cycle on HR Settings and start
 * a review with the seed's officer as the reviewer; the officer sets and
 * rates the goals and finishes it; the manager signs it off. The rules
 * behind each step are held by tests/integration/hr05-talent.test.ts.
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

test.describe('REQ-HR-001 Stage HR-5 · recruitment and performance', () => {
  test('a vacancy is opened, an applicant moved to an offer and hired, and the employee says where they came from', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    // A position for this run.
    await page.goto('/hr/positions');
    await page.getByRole('button', { name: 'New position' }).click();
    const seat = page.getByRole('dialog');
    await seat.locator('input[name="title_en"]').fill(`Analyst ${RUN}`);
    await seat.locator('select[name="department_code"]').selectOption({ index: 1 });
    await seat.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/positions\/POS-\d{4}\?saved=1/);
    const positionCode = recordNo(page, '/hr/positions/');

    await page.goto('/hr/recruitment');
    await expect(page.getByRole('heading', { name: 'Recruitment', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New vacancy' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="position_code"]').selectOption(positionCode);
    await dialog.locator('input[name="headcount"]').fill('1');
    await dialog.locator('textarea[name="description"]').fill(`An analyst for the run ${RUN}`);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/recruitment\/VAC-/);
    const vacancyNo = recordNo(page, '/hr/recruitment/');
    await page.goto(`/hr/recruitment/${encodeURIComponent(vacancyNo)}`);
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(`/hr/recruitment/${encodeURIComponent(vacancyNo)}`);
    await expect(page.locator('[data-status="open"]').first()).toBeVisible();

    await page.getByRole('button', { name: 'Add applicant' }).click();
    const applicant = page.getByRole('dialog');
    await applicant.locator('input[name="full_name_en"]').fill(`Applicant ${RUN}`);
    await applicant.locator('input[name="source"]').fill('Referral');
    await applicant.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/recruitment\/applicants\/APL-/);
    const applicantNo = recordNo(page, '/hr/recruitment/applicants/');
    await page.goto(`/hr/recruitment/applicants/${encodeURIComponent(applicantNo)}`);
    await page.getByRole('button', { name: 'Move on' }).click();
    const move = page.getByRole('dialog');
    await move.locator('select[name="stage"]').selectOption('offer');
    await move.getByRole('button', { name: 'Move on' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(`/hr/recruitment/applicants/${encodeURIComponent(applicantNo)}`);
    await expect(page.locator('[data-status="approved"]').first()).toBeVisible();

    await page.getByRole('button', { name: 'Hire', exact: true }).click();
    const hire = page.getByRole('dialog');
    await hire.getByRole('button', { name: 'Hire', exact: true }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(`/hr/recruitment/applicants/${encodeURIComponent(applicantNo)}`);
    await expect(page.locator('[data-status="posted"]').first()).toBeVisible();
    // The last hire filled the vacancy.
    await page.goto(`/hr/recruitment/${encodeURIComponent(vacancyNo)}`);
    await expect(page.locator('[data-status="posted"]').first()).toBeVisible();
    await page.locator('table a[href^="/hr/employees/EMP-"]').first().click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    await expect(page.getByRole('link', { name: `${applicantNo} · ${vacancyNo}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Performance reviews', level: 2 })).toBeVisible();
  });

  test('a cycle is opened on HR Settings, a review rated by its reviewer and signed off by the HR manager', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await signIn(page, MANAGER);
    // A person for this run, so nobody's own sign-in stands in the way.
    await page.goto('/hr/employees');
    await page.getByRole('button', { name: 'New employee' }).click();
    const person = page.getByRole('dialog');
    await person.locator('input[name="full_name_en"]').fill(`Reviewed Person ${RUN}`);
    await person.locator('input[name="hire_date"]').fill('2024-01-01');
    await person.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/employees\/EMP-/);
    const employeeNo = recordNo(page, '/hr/employees/');

    const cycle = `E2E-${RUN}`.toUpperCase();
    await page.goto('/administration/hr-settings');
    const cycles = page.locator('section[aria-labelledby="hrs-cycles-title"]');
    await cycles.locator('#f-cycle-code').fill(cycle);
    await cycles.locator('#f-cycle-name-en').fill(`Review ${RUN}`);
    await cycles.locator('input[name="period_from"]').fill('2026-01-01');
    await cycles.locator('input[name="period_to"]').fill('2026-06-30');
    await cycles.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto('/administration/hr-settings');
    await page.locator('section[aria-labelledby="hrs-cycles-title"] tr', { hasText: cycle }).getByRole('button', { name: 'Open' }).click();
    await page.waitForURL(/saved=1/);

    await page.goto('/hr/performance');
    await expect(page.getByRole('heading', { name: 'Performance', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New review' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="cycle_code"]').selectOption(cycle);
    const option = dialog.locator('select[name="employee_id"] option', { hasText: `${employeeNo} · ` });
    await dialog.locator('select[name="employee_id"]').selectOption((await option.getAttribute('value'))!);
    const reviewer = dialog.locator('select[name="reviewer_user_id"] option', { hasText: OFFICER });
    await dialog.locator('select[name="reviewer_user_id"]').selectOption((await reviewer.getAttribute('value'))!);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/hr\/performance\/REV-/);
    const reviewNo = recordNo(page, '/hr/performance/');

    const officer = await as(browser, OFFICER);
    await officer.page.goto(`/hr/performance/${encodeURIComponent(reviewNo)}`);
    const goals = officer.page.locator('#review-document');
    await goals.locator('input[name="title_0"]').fill(`Close the books ${RUN}`);
    await goals.locator('input[name="weight_0"]').fill('60');
    await goals.locator('select[name="rating_0"]').selectOption('4');
    await goals.locator('input[name="title_1"]').fill('Train the clerk');
    await goals.locator('input[name="weight_1"]').fill('40');
    await goals.locator('select[name="rating_1"]').selectOption('3');
    await goals.getByRole('button', { name: 'Save goals' }).click();
    await officer.page.waitForURL(/saved=1/);
    await officer.page.goto(`/hr/performance/${encodeURIComponent(reviewNo)}`);
    await officer.page.getByRole('button', { name: 'Finish the rating' }).click();
    const finish = officer.page.getByRole('dialog');
    await finish.locator('textarea[name="comment"]').fill('A steady half');
    await finish.getByRole('button', { name: 'Finish the rating' }).click();
    await officer.page.waitForURL(/saved=1/);
    await officer.page.goto(`/hr/performance/${encodeURIComponent(reviewNo)}`);
    await expect(officer.page.locator('[data-status="submitted"]').first()).toBeVisible();
    await expect(officer.page.getByText('3.60').first()).toBeVisible();
    // The reviewer does not sign their own review off.
    await expect(officer.page.getByRole('button', { name: 'Sign off' })).toHaveCount(0);
    await officer.close();

    await page.goto(`/hr/performance/${encodeURIComponent(reviewNo)}`);
    await page.getByRole('button', { name: 'Sign off' }).click();
    const sign = page.getByRole('dialog');
    await sign.locator('input[name="note"]').fill(`Agreed ${RUN}`);
    await sign.getByRole('button', { name: 'Sign off' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto(`/hr/performance/${encodeURIComponent(reviewNo)}`);
    await expect(page.locator('[data-status="posted"]').first()).toBeVisible();
    await expect(page.locator('#review-document').getByText(`Agreed ${RUN}`)).toBeVisible();
  });
});
