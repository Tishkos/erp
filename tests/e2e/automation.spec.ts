import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Workflow Automation (platform phase, Agent 10) — on the screens, as the seeded people.
 *
 * The administrator makes a rule from the "Task overdue" template (it is born OFF), reads it in
 * words on its own record page — four doors in the standing order — and switches it on. The
 * manager raises a task for the officer through the Task Center. The morning's sweep, run for
 * a business day three days after the task was due (so the spec does not depend on the calendar
 * day), records one event; the runner answers it as the rule's owner and the officer is told.
 * The run is on the register and on its own page: the conditions as they stood, the step it
 * took, the notice it made. Running the sweep a second time records nothing, and the kill
 * switch stops everything until it is put back. The manager and the outsider hold no grant on
 * automation and are turned away from the screen, the rule and the run. The screen and a
 * record are photographed beside the Numbering screen they copy, desktop in English and a
 * phone (390px) in Arabic.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const ADMIN = 'admin@example.com';
const MANAGER = 'manager@example.com';
const OFFICER = 'officer@example.com';
const OUTSIDER = 'outsider@example.com';
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/automation';
mkdirSync(SHOTS, { recursive: true });

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function as(browser: Browser, email: string, options: { arabic?: boolean } = {}) {
  const context = await browser.newContext(options.arabic ? { viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } });
  if (options.arabic) await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
  const page = await context.newPage();
  await signIn(page, email);
  return { page, close: () => context.close() };
}

const chip = (page: Page) => page.locator('[class*="sapStatus"]').first();

/** The four doors in the title bar, in the standing order. */
async function expectFourDoors(page: Page) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  const doors = bar.locator(':scope > button, :scope > a');
  await expect(doors).toHaveCount(4);
  const names = await doors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual(['Print / Export', 'Attachments', 'Notes', 'Audit log']);
}

const iso = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};
/** A task cannot be given a deadline in the past, so it is due in a week and the sweep is run for a day three days later. */
const DUE = iso(Date.now() + 7 * 86_400_000);
const SWEEP_DAY = iso(Date.now() + 10 * 86_400_000);

/** The runner, the way cron runs it, from the worktree (it reads the same `.env` as the server). */
function sweep(day?: string): string {
  return execFileSync('npx', ['tsx', 'scripts/ops/automation-run.ts', ...(day ? ['--produce', day] : [])], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 180_000,
  });
}

test.describe.configure({ mode: 'serial' });

const RULE_NAME = `Late task notice ${RUN}`;
const TASK_TITLE = `Match the Erbil statement ${RUN}`;
let ruleNo = '';
let taskNo = '';
let runHref = '';

test.describe('Automation · a rule from a template, an event, a run, and who may see it', () => {
  test('the administrator makes a rule from a template, reads it in words, and switches it on', async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto('/administration/automation', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Automation' })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('Automation is on')).toBeVisible();

    // The templates: the closed set a rule can be made from, each to be created on its own.
    const row = page.locator('tr', { has: page.getByRole('button', { name: 'Create a rule' }) }).filter({ hasText: 'Task overdue' });
    await expect(row).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/automation-list-desktop-en.png`, fullPage: true });
    await row.getByRole('button', { name: 'Create a rule' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="name"]').fill(RULE_NAME);
    await dialog.locator('input[name="p_daysLate"]').fill('1');
    await dialog.locator('input[name="p_notifyAssignee"]').check();
    await dialog.getByRole('button', { name: 'Create rule' }).click();
    await page.waitForURL(/\/administration\/automation\/[^/?]+\?saved=1/, { timeout: 60_000 });
    ruleNo = decodeURIComponent(page.url().split('/administration/automation/')[1]!.split('?')[0]!);
    expect(ruleNo).toMatch(/^AUT-\d+$/);

    // Born off; the page says in words what it listens for, checks and does; the four doors.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ruleNo);
    await expect(chip(page)).toHaveText('Off');
    await expectFourDoors(page);
    await expect(page.getByText(/Days late is at least 1/)).toBeVisible();
    await expect(page.getByText(/Tell the person the task is with|Tell the person it is with/).first()).toBeVisible();
    await expect(page.getByText('Never run').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/automation-rule-off-desktop-en.png`, fullPage: true });

    // The printer door offers the copy.
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="automation_rule"] a[data-format="pdf"]').first()).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Switch on', exact: true }).click();
    await expect(chip(page)).toHaveText('On', { timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Switch off', exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/automation-rule-on-desktop-en.png`, fullPage: true });
    await admin.close();
  });

  test('the manager raises a task for the officer, due in a week', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'New task' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="title"]').fill(TASK_TITLE);
    const officerOption = dialog.locator('select[name="assignee_id"] option', { hasText: 'Accounting Officer' });
    await dialog.locator('select[name="assignee_id"]').selectOption((await officerOption.getAttribute('value'))!);
    await dialog.locator('select[name="priority"]').selectOption('high');
    await dialog.locator('input[name="due_date"]').fill(DUE);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/tasks\/TASK-[^?]+\?saved=1/, { timeout: 60_000 });
    taskNo = decodeURIComponent(page.url().split('/tasks/')[1]!.split('?')[0]!);
    await expect(chip(page)).toHaveText('Assigned');
    await manager.close();
  });

  test('the sweep for a day three days after the deadline records the event once; the runner answers it as the owner', async () => {
    test.setTimeout(420_000);
    const first = sweep(SWEEP_DAY);
    expect(first, first).toMatch(/task\.overdue: [1-9]\d* found, [1-9]\d* recorded/);
    expect(first, first).toMatch(/\d+ events: [1-9]\d* done/);
    // The same day again: nothing is recorded twice and nothing is done twice.
    const again = sweep(SWEEP_DAY);
    expect(again, again).toMatch(/task\.overdue: [1-9]\d* found, 0 recorded/);
    expect(again, again).toMatch(/0 events: 0 done, 0 skipped, 0 failed/);
  });

  test('the run is on the register and has its own page: the conditions as they stood, the step it took', async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto(`/administration/automation?run_rule=${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
    const mine = page.locator('tr', { hasText: taskNo });
    await expect(mine).toHaveCount(1, { timeout: 60_000 });
    await expect(mine.locator('[data-status="posted"]')).toHaveText('Done');
    await page.screenshot({ path: `${SHOTS}/automation-runs-desktop-en.png`, fullPage: true });
    runHref = (await mine.locator('a').first().getAttribute('href'))!;
    expect(runHref).toMatch(/^\/administration\/automation\/runs\/\d+$/);

    await page.goto(runHref, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ruleNo, { timeout: 60_000 });
    await expect(chip(page)).toHaveText('Done');
    await expectFourDoors(page);
    await expect(page.getByText(/Days late is at least 1/)).toBeVisible();
    await expect(page.getByText(/Accounting Officer/).first()).toBeVisible();
    await expect(page.getByText(taskNo).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/automation-run-desktop-en.png`, fullPage: true });
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="automation_run"] a[data-format="pdf"]').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // The rule's own page now says it ran, and shows the run beneath it.
    await page.goto(`/administration/automation/${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
    await expect(page.locator('tr', { hasText: taskNo })).toHaveCount(1);
    await expect(page.getByText('Never run')).toHaveCount(0);
    await admin.close();
  });

  test('the officer is told, and the notice opens the task', async ({ browser }) => {
    test.setTimeout(240_000);
    const officer = await as(browser, OFFICER);
    const page = officer.page;
    await page.goto('/notifications', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Notifications', { timeout: 60_000 });
    await expect(page.getByText(`Task ${taskNo} is overdue: ${RULE_NAME}`).first()).toBeVisible({ timeout: 60_000 });
    // The line says which task it is, how late, and what the rule's note adds; the notice opens the task.
    const line = page.locator('tr', { hasText: `Task ${taskNo} is overdue` });
    await expect(line).toContainText(TASK_TITLE);
    await expect(line).toContainText('3 days past its due date');
    await line.getByRole('link', { name: new RegExp(`Task ${taskNo} is overdue`) }).click();
    await page.waitForURL(new RegExp(`/tasks/${taskNo}`), { timeout: 60_000 });
    await expect(page.getByText(TASK_TITLE).first()).toBeVisible();
    await officer.close();
  });

  test('the kill switch stops every rule until it is put back; the task is not announced twice', async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto('/administration/automation', { waitUntil: 'networkidle' });
    try {
      const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Switch automation off' }) });
      await form.locator('textarea, input[name="reason"]').first().fill(`Held while the books are checked ${RUN}`);
      await form.getByRole('button', { name: 'Switch automation off' }).click();
      await expect(page.getByText('Automation is switched off')).toBeVisible({ timeout: 30_000 });
      const held = sweep(SWEEP_DAY);
      // Switched off, nothing listens: the sweep records no event and the runner has nothing to run.
      expect(held, held).toMatch(/task\.overdue: no enabled rule is listening/);
      expect(held, held).toMatch(/0 events: 0 done, 0 skipped, 0 failed/);
      // A rule's own page stays readable while it is off, and says the same as before.
      await page.goto(`/administration/automation/${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
      await expect(chip(page)).toHaveText('On');
      await page.goto('/administration/automation', { waitUntil: 'networkidle' });
    } finally {
      await page.goto('/administration/automation', { waitUntil: 'networkidle' });
      const back = page.locator('form').filter({ has: page.getByRole('button', { name: 'Switch automation on' }) });
      if ((await back.count()) > 0) {
        await back.locator('textarea, input[name="reason"]').first().fill(`Put back ${RUN}`);
        await back.getByRole('button', { name: 'Switch automation on' }).click();
        await expect(page.getByText('Automation is on')).toBeVisible({ timeout: 30_000 });
      }
    }
    // Back on, the same day again records nothing new and the task was not announced twice.
    const after = sweep(SWEEP_DAY);
    expect(after, after).toMatch(/task\.overdue: [1-9]\d* found, 0 recorded/);
    await page.goto(`/administration/automation/${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
    await expect(page.locator('tr', { hasText: taskNo })).toHaveCount(1);
    await admin.close();
  });

  test('changing a rule is a new version: the form shows what was typed, and the old version stays on the page', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto(`/administration/automation/${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Edit parameters' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('input[name="p_daysLate"]')).toHaveValue('1');
    await expect(dialog.locator('input[name="p_notifyAssignee"]')).toBeChecked();
    await dialog.locator('input[name="p_daysLate"]').fill('2');
    await dialog.locator('input[name="note"]').fill(`Two days is enough ${RUN}`);
    await dialog.getByRole('button', { name: 'Save as a new version' }).click();
    await page.waitForURL(/saved=1/, { timeout: 60_000 });
    await expect(page.getByText(/Days late is at least 2/)).toBeVisible();
    const versions = page.locator('table[aria-labelledby="automation-versions-title"] tbody tr');
    await expect(versions).toHaveCount(2);
    await expect(versions.first()).toContainText('Current');
    await expect(versions.first()).toContainText(`Two days is enough ${RUN}`);
    await expect(chip(page)).toHaveText('On');
    await admin.close();
  });

  test('the administrator switches the rule off again, with a reason; it keeps its history', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto(`/administration/automation/${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
    await page.getByLabel('Why it is switched off').fill(`Test finished ${RUN}`);
    await page.getByRole('button', { name: 'Switch off', exact: true }).click();
    await expect(chip(page)).toHaveText('Off', { timeout: 30_000 });
    await expect(page.locator('tr', { hasText: taskNo })).toHaveCount(1);
    await page.getByRole('button', { name: 'Audit log' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await admin.close();
  });

  test('the manager and the outsider hold no grant on automation: the screen, the rule and the run turn them away', async ({ browser }) => {
    test.setTimeout(240_000);
    for (const who of [MANAGER, OUTSIDER]) {
      const person = await as(browser, who);
      for (const route of ['/administration/automation', `/administration/automation/${encodeURIComponent(ruleNo)}`, runHref]) {
        await person.page.goto(route);
        await expect(person.page.getByText('Not available to you').first(), `${who} ${route}`).toBeVisible({ timeout: 60_000 });
        await expect(person.page.getByText(RULE_NAME)).toHaveCount(0);
        await expect(person.page.getByText(taskNo)).toHaveCount(0);
      }
      await person.close();
    }
  });

  test('the screen and the records hold at a phone’s width, right to left, beside the Numbering screen they copy', async ({ browser }) => {
    test.setTimeout(420_000);
    const admin = await as(browser, ADMIN, { arabic: true });
    const page = admin.page;
    for (const route of ['/administration/automation', `/administration/automation/${encodeURIComponent(ruleNo)}`, runHref]) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} is ${width}px wide`).toBeLessThanOrEqual(390);
    }
    await page.goto('/administration/automation', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'الأتمتة' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/automation-list-mobile-ar.png`, fullPage: true });
    await page.goto(`/administration/automation/${encodeURIComponent(ruleNo)}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/automation-rule-mobile-ar.png`, fullPage: true });
    await page.goto(runHref, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/automation-run-mobile-ar.png`, fullPage: true });
    // The models they copy: the settings screen and the record screen.
    await page.goto('/administration/numbering', { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/model-numbering-mobile-ar.png`, fullPage: true });
    await admin.close();

    const desktop = await as(browser, ADMIN);
    await desktop.page.goto('/administration/numbering', { waitUntil: 'networkidle' });
    await desktop.page.screenshot({ path: `${SHOTS}/model-numbering-desktop-en.png`, fullPage: true });
    await desktop.close();
  });
});
