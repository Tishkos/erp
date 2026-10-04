import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Task Center (platform phase, Agent 3) — on the screens, as the seeded people.
 *
 * The manager runs Finance (`user_department_scope.is_manager`) and holds the
 * right to assign; the officer is a Finance member who works what is given;
 * the CEO administers; the outsider holds nothing. The manager raises a task
 * and the dropdown offers only the people the manager may give work to — the
 * officer, the manager and the CEO (all members of Finance in the seed), not the
 * person with no grant; the officer, who holds no right to assign, has no New
 * task button at all. The
 * officer accepts it, starts it, is blocked, resumes, hands it in; at each
 * step the page shows only the verbs that person may take. The manager
 * replies in Chat (a draft, nothing sent), completes it, and the record reads
 * as completed. The person with no grant is turned away. The list and the
 * record are photographed beside the Purchase Invoices list they copy,
 * desktop in English and a phone in Arabic.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const MANAGER = 'manager@example.com';
const OFFICER = 'officer@example.com';
const CEO = 'ceo@example.com';
const OUTSIDER = 'outsider@example.com';
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/tasks';

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

const open = (page: Page, taskNo: string) => page.goto(`/tasks/${encodeURIComponent(taskNo)}`);
const chip = (page: Page) => page.locator('[class*="sapStatus"]').first();
const verb = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

/** A verb pressed on the record: the page comes back with the next status. */
async function press(page: Page, name: string, next: string) {
  await verb(page, name).click();
  await expect(chip(page)).toHaveText(next, { timeout: 30_000 });
}

/** The four doors in the title bar, in the rule's order. */
async function expectFourDoors(page: Page) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  const doors = bar.locator(':scope > button, :scope > a');
  await expect(doors).toHaveCount(4);
  const names = await doors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual(['Print / Export', 'Attachments', 'Notes', 'Audit log']);
}

const inAWeek = () => {
  const d = new Date(Date.now() + 7 * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

test.describe.configure({ mode: 'serial' });

let taskNo = '';
const title = `Reconcile the Erbil statement ${RUN}`;

test.describe('Task Center · the road, the scope and the doors', () => {
  test('the manager raises a task for somebody in scope and only in scope', async ({ browser }) => {
    test.setTimeout(240_000);
    mkdirSync(SHOTS, { recursive: true });
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Tasks', level: 1 })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'New task' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="title"]').fill(title);

    // The dropdown lists the people the manager may assign to in Finance, and no one else.
    const options = await dialog.locator('select[name="assignee_id"] option').allTextContents();
    expect(options.some((o) => o.includes('Accounting Officer'))).toBe(true);
    expect(options.some((o) => o.includes('Accounting Manager'))).toBe(true);
    // The seed puts everyone in Finance, so the CEO is a member of the manager's section; the person who holds
    // no grant on tasks cannot do the work and is not offered. Who is out of scope in other ways is
    // tests/integration/task-center.test.ts (another section, another branch, no manager link).
    expect(options.some((o) => o.includes('CEO'))).toBe(true);
    expect(options.some((o) => o.includes('No Permissions')), 'a person with no grant on tasks').toBe(false);
    await expect(dialog.locator('select[name="department_code"] option')).toHaveText(['Finance']);

    const officerOption = dialog.locator('select[name="assignee_id"] option', { hasText: 'Accounting Officer' });
    await dialog.locator('select[name="assignee_id"]').selectOption((await officerOption.getAttribute('value'))!);
    await dialog.locator('select[name="priority"]').selectOption('high');
    await dialog.locator('input[name="due_date"]').fill(inAWeek());
    await dialog.locator('textarea[name="description"]').fill('Match every line of the March statement and list the differences.');
    await page.screenshot({ path: `${SHOTS}/task-new-desktop-en.png` });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/tasks\/TASK-[^?]+\?saved=1/, { timeout: 60_000 });
    taskNo = decodeURIComponent(page.url().split('/tasks/')[1]!.split('?')[0]!);

    // The record: assigned, the four doors, and only what the assigner may do.
    await expect(chip(page)).toHaveText('Assigned');
    await expectFourDoors(page);
    await expect(page.getByText(title).first()).toBeVisible();
    await expect(verb(page, 'Reassign')).toBeVisible();
    await expect(verb(page, 'Cancel task')).toBeVisible();
    for (const notHers of ['Accept', 'Decline', 'Start', 'Hand in', 'Complete']) await expect(verb(page, notHers), notHers).toHaveCount(0);

    // A watcher who may open it.
    await page.getByLabel('Add a watcher').selectOption({ label: 'CEO' });
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('table').filter({ hasText: 'Watcher' }).getByText('CEO')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/task-record-assigned-desktop-en.png`, fullPage: true });
    await manager.close();
  });

  test('the officer sees it in My tasks and takes it along the road, one valid verb at a time', async ({ browser }) => {
    test.setTimeout(240_000);
    const officer = await as(browser, OFFICER);
    const page = officer.page;
    await page.goto('/tasks');
    await expect(page.getByRole('link', { name: taskNo })).toBeVisible({ timeout: 60_000 });
    // Working tasks is the officer's; giving them out is not.
    await expect(page.getByRole('button', { name: 'New task' })).toHaveCount(0);
    await page.getByRole('link', { name: taskNo }).click();
    await page.waitForURL(new RegExp(`/tasks/${taskNo}`));
    await expect(chip(page)).toHaveText('Assigned');
    await expect(verb(page, 'Accept')).toBeVisible();
    await expect(verb(page, 'Decline')).toBeVisible();
    for (const notHis of ['Complete', 'Reassign', 'Cancel task', 'Start', 'Hand in', 'Return for rework']) await expect(verb(page, notHis), notHis).toHaveCount(0);

    await press(page, 'Accept', 'Accepted');
    await expect(verb(page, 'Decline')).toHaveCount(0);
    await press(page, 'Start', 'In progress');

    // A block must say why.
    await page.getByRole('textbox', { name: 'What is in the way' }).fill('Waiting for the bank letter');
    await verb(page, 'Block').click();
    await expect(chip(page)).toHaveText('Blocked', { timeout: 30_000 });
    await expect(page.getByText('Waiting for the bank letter').filter({ visible: true }).first()).toBeVisible();
    await press(page, 'Resume', 'In progress');
    await press(page, 'Hand in', 'Handed in');
    for (const done of ['Accept', 'Start', 'Hand in', 'Resume', 'Block', 'Complete']) await expect(verb(page, done), done).toHaveCount(0);
    await officer.close();
  });

  test('the manager replies in Chat with a draft, then completes the task', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await open(page, taskNo);
    await expect(chip(page)).toHaveText('Handed in');
    await expect(verb(page, 'Complete')).toBeVisible();
    await expect(verb(page, 'Return for rework')).toBeVisible();

    await verb(page, 'Reply in Chat').click();
    await page.waitForURL(/\/chat\?c=[^&]+&draft=/, { timeout: 60_000 });
    expect(decodeURIComponent(page.url())).toContain(`About ${taskNo} — ${title}: `);
    // The draft waits in the box; nothing has been sent.
    await expect(page.locator('textarea').first()).toHaveValue(new RegExp(`About ${taskNo}`), { timeout: 30_000 });

    await open(page, taskNo);
    await press(page, 'Complete', 'Completed');
    for (const done of ['Complete', 'Return for rework', 'Reassign', 'Cancel task', 'Accept', 'Start']) await expect(verb(page, done), done).toHaveCount(0);
    await page.getByRole('button', { name: 'Audit log' }).click();
    const history = page.getByRole('dialog', { name: 'Audit log' });
    for (const step of ['Task raised', 'Task assigned', 'Task accepted', 'Task started', 'Task blocked', 'Task resumed', 'Task handed in', 'Task completed']) {
      await expect(history.getByText(step).first(), step).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${SHOTS}/task-record-completed-desktop-en.png`, fullPage: true });
    await manager.close();
  });

  test('a task about another record takes a file with it, links the record, and refuses one the person cannot open', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'New task' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[name="title"]').fill(`Follow up on ${taskNo} ${RUN}`);
    // Left as a draft: no assignee chosen.
    await dialog.locator('select[name="related_type"]').selectOption('task');
    await dialog.locator('input[name="related_no"]').fill('TASK-999999');
    await dialog.locator('input[name="files"]').setInputFiles({ name: 'workings.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 workings') });
    await dialog.getByRole('button', { name: 'Create' }).click();
    // A record that does not exist (or that the person may not open) is refused, and the dialog comes back with the sentence.
    await expect(page.getByText(/There is no task 'TASK-999999' that you may open/)).toBeVisible({ timeout: 60_000 });

    // The page comes back with the dialog open (and the sentence); open it ourselves if it has not.
    if (!(await page.getByRole('dialog').isVisible())) await page.getByRole('button', { name: 'New task' }).click();
    const again = page.getByRole('dialog');
    await again.locator('input[name="title"]').fill(`Follow up on ${taskNo} ${RUN}`);
    await again.locator('select[name="related_type"]').selectOption('task');
    await again.locator('input[name="related_no"]').fill(taskNo);
    await again.locator('input[name="files"]').setInputFiles({ name: 'workings.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 workings') });
    await again.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/tasks\/TASK-[^?]+\?saved=1/, { timeout: 60_000 });
    // A draft: its raiser can assign it from the page, and nobody else sees it.
    await expect(chip(page)).toHaveText('Draft');
    await expect(verb(page, 'Assign')).toBeVisible();
    await expect(page.locator(`a[href="/tasks/${encodeURIComponent(taskNo)}"]`).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attachments (1)' })).toBeVisible();
    await expectFourDoors(page);
    await manager.close();
  });

  test('the Team view is offered to the people who lead, with the load by person', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto('/tasks');
    await expect(page.locator('select[name="view"] option')).toHaveText(['My tasks', 'Assigned by me', 'Team']);
    await page.goto('/tasks?view=assigned');
    await expect(page.getByRole('link', { name: taskNo })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/tasks-assigned-desktop-en.png`, fullPage: true });
    await page.goto('/tasks?view=team');
    await expect(page.getByRole('heading', { name: 'Team workload' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Accounting Officer' }).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/tasks-team-desktop-en.png`, fullPage: true });
    await manager.close();

    // The officer leads no one: the Team view is not offered, and asking for it shows My tasks.
    const officer = await as(browser, OFFICER);
    await officer.page.goto('/tasks?view=team');
    await expect(officer.page.locator('select[name="view"] option')).toHaveText(['My tasks', 'Assigned by me']);
    await officer.page.screenshot({ path: `${SHOTS}/tasks-mine-desktop-en.png`, fullPage: true });
    await officer.close();

    // The CEO administers the module, so leads everyone, and may open the task.
    const ceo = await as(browser, CEO);
    await open(ceo.page, taskNo);
    await expect(chip(ceo.page)).toHaveText('Completed');
    await ceo.close();
  });

  test('a person with no grant on tasks is turned away', async ({ browser }) => {
    test.setTimeout(240_000);
    const outsider = await as(browser, OUTSIDER);
    await outsider.page.goto('/tasks');
    await expect(outsider.page.getByRole('link', { name: taskNo })).toHaveCount(0);
    await expect(outsider.page.locator('select[name="view"]')).toHaveCount(0);
    await open(outsider.page, taskNo);
    await expect(outsider.page.getByRole('heading', { level: 1 }).filter({ hasText: taskNo })).toHaveCount(0);
    await expect(outsider.page.getByText(title)).toHaveCount(0);
    await outsider.close();
  });

  test('the list and the record read at a phone’s width, right to left, with no sideways scroll', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER, { arabic: true });
    const page = manager.page;
    for (const route of ['/tasks', '/tasks?view=assigned', '/tasks?view=team', `/tasks/${encodeURIComponent(taskNo)}`]) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 45_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} is ${width}px wide`).toBeLessThanOrEqual(390);
    }
    await page.goto('/tasks?view=assigned', { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/tasks-list-mobile-ar.png`, fullPage: true });
    await page.goto(`/tasks/${encodeURIComponent(taskNo)}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/task-record-mobile-ar.png`, fullPage: true });
    // The model it copies.
    await page.goto('/payables/invoices', { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/model-invoices-mobile-ar.png`, fullPage: true });
    await manager.close();

    const desktop = await as(browser, MANAGER);
    await desktop.page.goto('/payables/invoices', { waitUntil: 'networkidle' });
    await desktop.page.screenshot({ path: `${SHOTS}/model-invoices-desktop-en.png`, fullPage: true });
    await desktop.close();
  });
});
