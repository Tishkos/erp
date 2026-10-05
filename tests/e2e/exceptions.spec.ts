import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Exception Center (platform phase, Agent 7) — on the screens, as the seeded people.
 *
 * The manager administers the centre: the register lists what the system found
 * (the dev database's real findings — posting roles with no account, the host's
 * health), filters by severity and domain, and offers "Refresh now"; a row opens
 * its record, which wears the four doors in the standing order, shows the
 * evidence and the road, and takes an acknowledgement only with a note. The
 * acknowledged finding is still on the register, as acknowledged, after the
 * sweep runs again. The officer reads the register but cannot refresh it, and
 * sees only what her grants reach; the person with no grant is turned away.
 * The register and a record are photographed beside the Purchase Invoices list
 * they copy, desktop in English and a phone in Arabic.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const MANAGER = 'manager@example.com';
const OFFICER = 'officer@example.com';
const OUTSIDER = 'outsider@example.com';
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/exceptions';
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

/** The four doors in the title bar, in the rule's order. */
async function expectFourDoors(page: Page) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  const doors = bar.locator(':scope > button, :scope > a');
  await expect(doors).toHaveCount(4);
  const names = await doors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual(['Print / Export', 'Attachments', 'Notes', 'Audit log']);
}

test.describe.configure({ mode: 'serial' });

let exceptionNo = '';

test.describe('Exception Center · the register, the record and the acknowledgement', () => {
  test('the manager reads the register, filters it and refreshes it', async ({ browser }) => {
    test.setTimeout(300_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto('/exceptions', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'Exceptions' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByRole('button', { name: 'Refresh now' })).toBeVisible();

    // Refresh now runs the sweep the schedule runs; the flash says what it found.
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await page.waitForURL(/saved=1/, { timeout: 180_000 });
    await expect(page.getByText(/Checked just now: \d+ found/)).toBeVisible();
    await expect(page.getByText(/Last check .*: \d+ found/)).toBeVisible();

    const rows = page.locator('table[aria-labelledby="exceptions-list-title"] tbody tr');
    expect(await rows.count()).toBeGreaterThan(0);
    await expect(rows.first().locator('a').first()).toHaveText(/^EXC-\d+$/);
    await expect(rows.first().locator('[class*="sapRegisterStatus"]').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/exceptions-list-desktop-en.png`, fullPage: true });

    // Filter by severity: every row left is of that severity.
    await page.locator('select[name="severity"]').selectOption('high');
    await page.getByRole('button', { name: 'Show' }).click();
    await page.waitForURL(/severity=high/);
    const high = page.locator('table[aria-labelledby="exceptions-list-title"] tbody tr td:nth-child(2) [class*="sapRegisterStatus"]');
    const count = await high.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) await expect(high.nth(i)).toHaveText('High');

    // And by domain, open only.
    await page.goto('/exceptions?domain=accounting&status=open', { waitUntil: 'networkidle' });
    const all = page.locator('table[aria-labelledby="exceptions-list-title"] tbody tr');
    const posting = all.filter({ hasText: 'no usable account' });
    const first = ((await posting.count()) > 0 ? posting.first() : all.first()).locator('a').first();
    exceptionNo = ((await first.textContent()) ?? '').trim();
    expect(exceptionNo).toMatch(/^EXC-\d+$/);
    await manager.close();
  });

  test('the record wears the four doors, shows the evidence and the road, and is acknowledged only with a note', async ({ browser }) => {
    test.setTimeout(240_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto(`/exceptions/${encodeURIComponent(exceptionNo)}`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: exceptionNo })).toBeVisible({ timeout: 90_000 });
    await expectFourDoors(page);
    await expect(chip(page)).toHaveText('Open');
    await expect(page.locator('#exception-document-lines-heading')).toContainText('Evidence');
    await expect(page.getByRole('heading', { name: /History/ })).toBeVisible();
    await expect(page.locator('a.action--primary').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/exception-record-open-desktop-en.png`, fullPage: true });

    // The printer door offers the copy.
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="exception"] a[data-format="pdf"]').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // A note is required: the browser asks for it, and the server would refuse an empty one.
    const note = page.getByLabel('What you know and what will be done');
    await expect(note).toHaveAttribute('required', '');
    await note.fill(`Seen on the run ${RUN}: Finance maps the account this week.`);
    await page.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(chip(page)).toHaveText('Acknowledged', { timeout: 30_000 });
    await expect(page.getByText(/Acknowledged: someone is on it/)).toBeVisible();
    await expect(page.getByText(`Seen on the run ${RUN}`).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);

    // The road shows who, when and why — in the register under the record and behind the clock.
    const road = page.locator('table[aria-labelledby="exception-road-title"]');
    await expect(road.getByRole('row', { name: /Acknowledged/ })).toContainText(`Seen on the run ${RUN}`);
    await page.getByRole('button', { name: 'Audit log' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `${SHOTS}/exception-record-acknowledged-desktop-en.png`, fullPage: true });
    await manager.close();
  });

  test('a sweep that runs again leaves the acknowledgement where it was', async ({ browser }) => {
    test.setTimeout(300_000);
    const manager = await as(browser, MANAGER);
    const page = manager.page;
    await page.goto('/exceptions?status=acknowledged', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await page.waitForURL(/saved=1/, { timeout: 180_000 });
    await page.goto('/exceptions?status=acknowledged', { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: exceptionNo })).toBeVisible();
    await page.goto(`/exceptions/${encodeURIComponent(exceptionNo)}`, { waitUntil: 'networkidle' });
    await expect(chip(page)).toHaveText('Acknowledged');
    await manager.close();
  });

  test('the officer reads the register and the record but cannot refresh it; the person with no grant is turned away', async ({ browser }) => {
    test.setTimeout(240_000);
    const officer = await as(browser, OFFICER);
    await officer.page.goto('/exceptions', { waitUntil: 'networkidle' });
    await expect(officer.page.getByRole('heading', { level: 1, name: 'Exceptions' })).toBeVisible({ timeout: 90_000 });
    await expect(officer.page.getByRole('button', { name: 'Refresh now' })).toHaveCount(0);
    // She holds the grants on the finding and on what it is about, so she reads it; she may not run the sweep.
    await officer.page.goto(`/exceptions/${encodeURIComponent(exceptionNo)}`, { waitUntil: 'networkidle' });
    await expect(officer.page.getByRole('heading', { level: 1 }).filter({ hasText: exceptionNo })).toBeVisible({ timeout: 90_000 });
    await expect(chip(officer.page)).toHaveText('Acknowledged');
    await officer.close();

    const outsider = await as(browser, OUTSIDER);
    await outsider.page.goto('/exceptions');
    await expect(outsider.page.getByRole('link', { name: exceptionNo })).toHaveCount(0);
    await expect(outsider.page.locator('select[name="severity"]')).toHaveCount(0);
    await outsider.page.goto(`/exceptions/${encodeURIComponent(exceptionNo)}`);
    await expect(outsider.page.getByRole('heading', { level: 1 }).filter({ hasText: exceptionNo })).toHaveCount(0);
    await outsider.close();
  });

  test('the register and the record read at a phone’s width, right to left, with no sideways scroll', async ({ browser }) => {
    test.setTimeout(300_000);
    const manager = await as(browser, MANAGER, { arabic: true });
    const page = manager.page;
    for (const route of ['/exceptions', '/exceptions?status=all', `/exceptions/${encodeURIComponent(exceptionNo)}`]) {
      await page.goto(route, { waitUntil: 'networkidle' });
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width, `${route} is ${width}px wide`).toBeLessThanOrEqual(390);
    }
    await page.goto('/exceptions', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1, name: 'الاستثناءات' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/exceptions-list-mobile-ar.png`, fullPage: true });
    await page.goto(`/exceptions/${encodeURIComponent(exceptionNo)}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${SHOTS}/exception-record-mobile-ar.png`, fullPage: true });
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
