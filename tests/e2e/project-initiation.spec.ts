import { expect as baseExpect, test, type Page } from '@playwright/test';

/**
 * The Project Guide (2026-10-12) — Project Initiation in a browser.
 *
 * A direct sale is opened with the type selector, walked through its six
 * stages on the record's own forms (each gate said in the note above the
 * record, the SLD and the signed contract filed through their own paperclips,
 * the BOQ typed line by line), and its contract confirmed by a second person —
 * who lands on an Active Project that shows where it came from. Then the
 * register and the record read in Arabic at a phone's width.
 *
 * Requires `npm run db:seed` and an approved customer in use (the seed has one).
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
// The record is redrawn after each save, and a screen opened for the first time is compiled first: on a
// development server either takes a moment, so an expectation waits longer here than the default five seconds.
const expect = baseExpect.configure({ timeout: 90_000 });
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

/**
 * Presses something that posts a form and waits for the server's answer.
 *
 * Every form of the record returns to the record with `?saved=1`, so after the
 * first save the address already says so: waiting for the address alone would
 * return before the second save had been sent. The POST's own response is what
 * says this press has been answered.
 */
async function posted(page: Page, press: () => Promise<void>) {
  const answer = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith('/projects'), { timeout: 240_000 });
  await press();
  await answer;
  await page.waitForURL(/saved=1/);
}

/** Opens a stage's Edit window, lets the caller fill it, and saves. */
async function editStage(page: Page, stage: string, fill: (dialog: ReturnType<Page['getByRole']>) => Promise<void>) {
  await page.locator(`#stage-${stage}`).getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await fill(dialog);
  await posted(page, () => dialog.getByRole('button', { name: 'Save', exact: true }).click());
}

/** Files a document through the paperclip in a stage's own title. */
async function attachTo(page: Page, stage: string, fileName: string) {
  await page.locator(`#stage-${stage}`).getByRole('button', { name: /Attachments/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="file"]').setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: PDF });
  await posted(page, () => dialog.getByRole('button', { name: 'Attach', exact: true }).click());
}

async function nextStage(page: Page) {
  await posted(page, () => page.getByRole('button', { name: /^Next stage:/ }).click());
}


test.describe('The Project Guide · Project Initiation', () => {
  test('a direct sale goes from its first contact to an Active Project, by the guide', async ({ page, browser }) => {
    test.setTimeout(900_000);
    await signIn(page, MANAGER);

    // The register, and the guide's Main Project Initiation Selector behind New.
    await page.goto('/projects/initiation');
    await expect(page.getByRole('heading', { name: 'Project Initiation', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'New initiation' }).click();
    const fresh = page.getByRole('dialog');
    await expect(fresh.locator('select[name="kind"] option')).toHaveText(['Direct Sales Project', 'Tender Project']);
    await expect(fresh.getByText(/Pre-Sales Form, the system type/)).toBeVisible();
    await expect(fresh.getByText(/bid bonds and a compliance matrix/)).toBeVisible();
    await fresh.locator('select[name="kind"]').selectOption('direct_sales');
    await fresh.locator('input[name="title"]').fill(`Rooftop 250 kWp ${RUN}`);
    await fresh.locator('input[name="customer_name"]').fill('Al Noor Hospital');
    await fresh.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/projects\/initiation\/PIN-/);
    const no = decodeURIComponent(page.url().split('/projects/initiation/')[1]!.split(/[?#]/)[0]!);
    expect(no).toMatch(/^PIN-HQ-\d{4}-\d{6}$/);

    // The workflow strip: six stages, the first current; the note says what stage 1 still needs.
    const steps = page.locator('[data-pipeline-steps] > li');
    await expect(steps).toHaveCount(6);
    await expect(steps.first()).toHaveAttribute('data-state', 'current');
    await expect(page.locator('[data-initiation-missing]')).toContainText('1 · Sales Lead still needs:');
    await expect(page.locator('[data-initiation-missing]')).toContainText('Lead source');
    await expect(page.getByRole('button', { name: /^Next stage:/ })).toHaveCount(0);
    // A later stage's section is not there yet.
    await expect(page.locator('#stage-pre_sales')).toHaveCount(0);

    // 1 — Sales Lead.
    await editStage(page, 'lead', async (dialog) => {
      await dialog.locator('input[name="customer_phone"]').fill('+964 770 123 4567');
      await dialog.locator('select[name="lead_source_code"]').selectOption('REFERRAL');
    });
    await expect(page.locator('[data-initiation-missing]')).toHaveCount(0);
    await nextStage(page);

    // 2 — the Pre-Sales Form.
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'current');
    await editStage(page, 'pre_sales', async (dialog) => {
      await dialog.locator('input[name="site_latitude"]').fill('33.312806');
      await dialog.locator('input[name="site_longitude"]').fill('44.361488');
      await dialog.locator('input[name="site_governorate"]').fill('Baghdad');
      await dialog.locator('input[name="site_area"]').fill('Karrada');
      await dialog.locator('select[name="site_kind"]').selectOption('rooftop');
      await dialog.locator('select[name="system_type"]').selectOption('hybrid');
      await dialog.locator('input[name="contact_name"]').fill('Sara Ali');
      await dialog.locator('input[name="contact_job_title"]').fill('Facilities manager');
      await dialog.locator('input[name="contact_phone"]').fill('0770 000 0000');
      await dialog.locator('input[name="contact_email"]').fill('sara@alnoor.example');
    });
    await expect(page.locator('#stage-pre_sales')).toContainText('Hybrid');
    await expect(page.locator('#stage-pre_sales')).toContainText('33.312806, 44.361488');
    await nextStage(page);

    // 3 — Site Survey Design: the SLD and layout are part of the stage.
    await editStage(page, 'site_survey', async (dialog) => {
      await dialog.locator('input[name="survey_on"]').fill('2026-10-10');
      await dialog.locator('input[name="site_verified"]').check();
    });
    await expect(page.locator('[data-initiation-missing]')).toContainText('The SLD and layout, uploaded');
    await attachTo(page, 'site_survey', 'SLD-rev-C.pdf');
    await expect(page.locator('[data-initiation-missing]')).toHaveCount(0);
    await nextStage(page);

    // 4 — BOQ Costing, in the record's own lines.
    for (const [category, description, quantity, cost] of [
      ['material', '550 W panel', '455', '120000'],
      ['installation', 'Mounting and commissioning', '1', '9000000'],
    ] as const) {
      await page.getByRole('button', { name: 'Add BOQ line' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('select[name="category"]').selectOption(category);
      await dialog.locator('input[name="description"]').fill(description);
      await dialog.locator('input[name="quantity"]').fill(quantity);
      await dialog.locator('input[name="unit_cost_iqd"]').fill(cost);
      await posted(page, () => dialog.getByRole('button', { name: 'Save', exact: true }).click());
    }
    await expect(page.locator('#initiation-document')).toContainText('550 W panel');
    // 455 × 120,000 + 9,000,000 = 63,600,000.
    await expect(page.locator('#initiation-document')).toContainText('63,600,000');
    await nextStage(page);
    // The BOQ is approved by leaving its stage: no more lines.
    await expect(page.getByRole('button', { name: 'Add BOQ line' })).toHaveCount(0);

    // 5 — Proposal Follow-up: a sent proposal does not reach the contract; an accepted one does.
    await editStage(page, 'proposal', async (dialog) => {
      await dialog.locator('input[name="proposal_ref"]').fill('Q-2026-014');
      await dialog.locator('input[name="proposal_on"]').fill('2026-10-11');
      await dialog.locator('input[name="proposal_value_iqd"]').fill('95000000');
      await dialog.locator('select[name="proposal_status"]').selectOption('sent');
    });
    await expect(page.locator('[data-initiation-missing]')).toContainText('Proposal status: Accepted');
    await editStage(page, 'proposal', async (dialog) => {
      await dialog.locator('select[name="proposal_status"]').selectOption('accepted');
    });
    // A follow-up, kept as written.
    await page.getByRole('button', { name: 'Log activity' }).click();
    const activity = page.getByRole('dialog');
    await activity.locator('select[name="kind"]').selectOption('follow_up');
    await activity.locator('textarea[name="summary"]').fill('Customer accepted the proposal by email.');
    await posted(page, () => activity.getByRole('button', { name: 'Save', exact: true }).click());
    await expect(page.locator('#activities')).toContainText('Customer accepted the proposal by email.');
    await nextStage(page);

    // 6 — Contract Signing: terms, an approved customer, and the signed contract on file.
    await expect(steps.nth(5)).toHaveAttribute('data-state', 'current');
    await editStage(page, 'contract', async (dialog) => {
      await dialog.locator('input[name="contract_ref"]').fill(`C-${RUN}`);
      await dialog.locator('input[name="contract_signed_on"]').fill('2026-10-12');
      await dialog.locator('textarea[name="payment_terms"]').fill('30 % advance, 60 % on delivery, 10 % at handover');
      // The first approved customer in use.
      await dialog.locator('select[name="partner_id"]').selectOption({ index: 1 });
    });
    await attachTo(page, 'contract', 'signed-contract.pdf');
    await expect(page.locator('[data-initiation-missing]')).toHaveCount(0);
    // Whoever raised the record does not confirm its contract.
    await expect(page.getByRole('button', { name: 'Confirm contract and create project' })).toHaveCount(0);
    await expect(page.getByText(/Somebody other than whoever raised this record confirms it/)).toBeVisible();

    // A second person confirms: the record becomes an Active Project, and they land on it.
    const other = await browser.newContext();
    const admin = await other.newPage();
    await signIn(admin, ADMIN);
    await admin.goto(`/projects/initiation/${encodeURIComponent(no)}`);
    await admin.getByRole('button', { name: 'Confirm contract and create project' }).click();
    const convert = admin.getByRole('dialog');
    await convert.locator('input[name="baseline_starts_on"]').fill('2026-11-01');
    await convert.locator('input[name="baseline_ends_on"]').fill('2027-03-31');
    await convert.getByRole('button', { name: 'Confirm contract and create project' }).click();
    await admin.waitForURL(/\/projects\/PRJ-[^/]+\?saved=1/);
    const code = decodeURIComponent(admin.url().split('/projects/')[1]!.split('?')[0]!);
    await expect(admin.getByText('Released', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(admin.getByText('Direct Sales Project').filter({ visible: true }).first()).toBeVisible();
    // What the project carries from its initiation: the form, the files, the BOQ.
    const origin = admin.locator('[data-project-initiation]');
    await expect(origin).toContainText(no);
    await expect(origin).toContainText('Hybrid');
    await expect(origin).toContainText('SLD-rev-C.pdf');
    await expect(origin).toContainText('signed-contract.pdf');
    await expect(origin).toContainText('550 W panel');
    // The BOQ's total is the budget the project starts with.
    await expect(admin.locator('#project-document')).toContainText('63,600,000');
    await other.close();

    // The record is closed and names its project; the register says so.
    await page.goto(`/projects/initiation/${encodeURIComponent(no)}`);
    await expect(page.getByText('Converted to project', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator('#initiation-document')).toContainText(code);
    await expect(page.locator('#stage-contract').getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(page.locator('[data-pipeline-steps] > li[data-state="done"]')).toHaveCount(6);
    await page.goto(`/projects/initiation?q=${encodeURIComponent(RUN)}&status=converted`);
    await expect(page.getByRole('link', { name: no })).toBeVisible();

    // The New project form does not offer the guide's two types.
    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const values = await page.getByRole('dialog').locator('select[name="type_code"] option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(values).not.toContain('DIRECT_SALES');
    expect(values).not.toContain('TENDER');
    await page.keyboard.press('Escape');

    // Arabic, at a phone's width, right to left.
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const route of ['/projects/initiation', `/projects/initiation/${encodeURIComponent(no)}`]) {
      await page.goto(route);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} has no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    }
    await expect(page.getByText('توقيع العقد').filter({ visible: true }).first()).toBeVisible();
  });

  test('a tender opens at Tender Lead and waits for an approved Go', async ({ page }) => {
    test.setTimeout(600_000);
    await signIn(page, ADMIN);
    await page.goto('/projects/initiation');
    await page.getByRole('button', { name: 'New initiation' }).click();
    const fresh = page.getByRole('dialog');
    await fresh.locator('select[name="kind"]').selectOption('tender');
    await fresh.locator('input[name="title"]').fill(`MoE 5 MW plant ${RUN}`);
    await fresh.locator('input[name="customer_name"]').fill('Ministry of Electricity');
    await fresh.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/projects\/initiation\/PIN-/);

    // Stages 7 to 12, in the guide's numbering.
    const steps = page.locator('[data-pipeline-steps] > li');
    await expect(steps).toHaveCount(6);
    await expect(steps.first()).toContainText('7 · Tender Lead');
    await expect(steps.last()).toContainText('12 · Submission & Award');

    await editStage(page, 'tender_lead', async (dialog) => {
      await dialog.locator('input[name="tender_ref"]').fill(`MOE/2026/${RUN}`);
      await dialog.locator('input[name="submission_deadline"]').fill('2026-11-30');
      await dialog.locator('input[name="tender_documents_url"]').fill('https://tenders.example.gov/itb.pdf');
    });
    await nextStage(page);

    // 8 — the requirements and the bid bond are typed; the record waits for the decision.
    await editStage(page, 'go_no_go', async (dialog) => {
      await dialog.locator('textarea[name="qualification_requirements"]').fill('Class A contractor; two plants over 1 MW delivered.');
      await dialog.locator('input[name="bid_bond_iqd"]').fill('50000000');
    });
    await expect(page.locator('[data-initiation-missing]')).toContainText('An approved decision to participate (Go)');
    await expect(page.locator('#stage-go_no_go')).toContainText('Awaiting decision');
    await page.getByRole('button', { name: 'Approve Go' }).click();
    const go = page.getByRole('dialog');
    await go.locator('input[name="note"]').fill('Within our class; margin acceptable.');
    await posted(page, () => go.getByRole('button', { name: 'Approve Go' }).click());
    await expect(page.locator('#stage-go_no_go')).toContainText('Go');
    await expect(page.locator('[data-initiation-missing]')).toHaveCount(0);
    await nextStage(page);
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'current');

    // A tender the company walks away from is lost with its reason.
    await page.locator('input[name="reason"]').fill('Owner cancelled the tender.');
    await posted(page, () => page.getByRole('button', { name: 'Mark lost' }).click());
    await expect(page.getByText('Lost', { exact: true }).filter({ visible: true }).first()).toBeVisible();
    await expect(page.locator('#initiation-document')).toContainText('Owner cancelled the tender.');
    await expect(page.getByRole('button', { name: /^Next stage:/ })).toHaveCount(0);
  });
});
