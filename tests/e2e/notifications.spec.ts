import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Notification centre (platform phase, Agent 6) — the bell and /notifications.
 *
 * Runs against the seeded development database, with events that really happen
 * (nothing is written into the notification table by the spec):
 *
 *   1. The officer raises an account and submits it for approval; the officer
 *      writes to the manager in the chat. The manager's bell counts both, lists
 *      them with a category filter and the time on hover; the approval opens
 *      the real record, and opening it reads it.
 *   2. Mark all as read persists across a reload; one can be marked unread again
 *      on the full screen, and that persists too.
 *   3. Nobody else sees them: the outsider's bell is empty and the manager's
 *      notification leads nowhere for them ("no longer available", never a dead
 *      link); the super user reads only their own.
 *   4. Arabic, right to left, at a phone's width, beside the model screen; and
 *      the desktop screens in English.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const OFFICER = { email: 'officer@example.com', password: PASSWORD, name: 'Accounting Officer' };
const MANAGER = { email: 'manager@example.com', password: PASSWORD, name: 'Accounting Manager' };
const ADMIN = { email: 'admin@example.com', password: PASSWORD };
const OUTSIDER = { email: 'outsider@example.com', password: PASSWORD };
const SHOTS = process.env.NOTIFICATION_SHOTS ?? '/home/claude/shots/notifications';

test.describe.configure({ mode: 'serial' });

const RUN = new Date().toISOString().replace(/\D/g, '').slice(8, 14);

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function person(browser: Browser, user: { email: string; password: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

/** Presses a button until the page shows what it should (a click before hydration is dropped). */
async function press(page: Page, name: string, expected: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.getByText(expected, { exact: true }).first().isVisible().catch(() => false)) return;
    const button = page.getByRole('button', { name, exact: true }).first();
    if ((await button.count()) === 0) break;
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    try {
      await expect(page.getByText(expected, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 25_000 });
      return;
    } catch {
      await page.reload();
      await page.waitForTimeout(2_000);
    }
  }
  throw new Error(`"${name}" did not lead to "${expected}"`);
}

/** The header's bell and the count it carries (0 when the bell shows no count). */
const bell = (page: Page) => page.locator('.erp-header__utilities button[aria-controls="erp-notifications-panel"]');
const panel = (page: Page) => page.locator('#erp-notifications-panel');
async function badge(page: Page): Promise<number> {
  const value = await page.locator('[data-bell-badge]').first().getAttribute('data-bell-badge', { timeout: 2_000 }).catch(() => null);
  return value === null ? 0 : Number(value);
}
async function openBell(page: Page) {
  await expect(bell(page)).toBeVisible({ timeout: 60_000 });
  // A click before the shell has hydrated is dropped: click until the panel is there.
  await expect(async () => {
    if (!(await panel(page).isVisible())) await bell(page).click();
    await expect(panel(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

let account = '';
let approvalTitle: RegExp;
const managerIds: string[] = [];

test.describe('Notification centre', () => {
  test('an approval and a chat message reach the manager’s bell; the approval opens the real record', async ({ browser }) => {
    test.setTimeout(300_000);

    // The officer raises an account and sends it for approval.
    const officer = await person(browser, OFFICER);
    const page = officer.page;
    await page.goto('/master-data/chart-of-accounts');
    await expect(page.getByRole('button', { name: 'New account' })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'New account' }).click();
    await page.waitForTimeout(1200);
    const parent = page.getByRole('combobox', { name: 'Under' });
    const option = await parent.locator('option:not([disabled])').filter({ hasText: 'Assets' }).first().getAttribute('value');
    await parent.selectOption(option!);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Notice ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, { timeout: 60_000 });
    account = page.url().split('/').pop()!;
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(2000);
    await press(page, 'Submit for approval', 'Pending approval');
    approvalTitle = new RegExp(`Approval needed: ${account}`);

    // ...and writes to the manager.
    await page.goto('/chat');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chat', { timeout: 60_000 });
    await page.getByRole('button', { name: 'New chat' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Find a colleague').fill(MANAGER.name);
    await dialog.locator('li', { hasText: MANAGER.name }).getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('textbox', { name: 'Message' }).fill(`The new account is waiting for you ${RUN}`);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.locator('li', { hasText: `The new account is waiting for you ${RUN}` })).toBeVisible();
    await officer.context.close();

    // The manager's bell counts what is waiting, on any screen.
    const manager = await person(browser, MANAGER);
    const m = manager.page;
    await m.goto('/');
    await expect(m.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => badge(m), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    const before = await badge(m);
    await expect(bell(m)).toHaveAttribute('aria-label', `Notifications: ${before} unread`);

    // The list: both, newest first; the time reads relative and carries the absolute time on hover.
    await openBell(m);
    const rows = panel(m).locator('li[data-notification-id]');
    const approval = rows.filter({ hasText: approvalTitle });
    await expect(approval).toHaveCount(1, { timeout: 30_000 });
    await expect(rows.filter({ hasText: OFFICER.name }).first()).toBeVisible();
    const hover = await approval.locator('time').getAttribute('title');
    expect(hover).toMatch(/\d{4}/);
    await expect(approval.locator('time')).toHaveText(/^(now|just now|\d+ (min|hour|day)|.*ago)/i);
    await m.screenshot({ path: `${SHOTS}/bell-popover-desktop-en.png` });

    // The category filter narrows the list; "All categories" brings the rest back.
    const filter = panel(m).getByRole('combobox', { name: 'Category' });
    await filter.selectOption('approvals');
    await expect(rows.filter({ hasText: OFFICER.name })).toHaveCount(0, { timeout: 15_000 });
    await expect(approval).toHaveCount(1);
    await filter.selectOption('chat');
    await expect(approval).toHaveCount(0, { timeout: 15_000 });
    await expect(rows.filter({ hasText: OFFICER.name }).first()).toBeVisible();
    await filter.selectOption('');
    await expect(approval).toHaveCount(1, { timeout: 15_000 });

    // Click: the real record opens (resolved on the server, in this person's scope), and reading it reads it.
    await approval.getByRole('link').click();
    await m.waitForURL(new RegExp(`/master-data/chart-of-accounts/${account}$`), { timeout: 60_000 });
    await expect(m.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => badge(m), { timeout: 45_000 }).toBe(before - 1);

    // Their ids, for the isolation test below.
    await m.goto('/notifications');
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Notifications', { timeout: 60_000 });
    const ids = await m.locator('tr[data-notification-id]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-notification-id') ?? ''));
    managerIds.push(...ids.filter((id) => id !== ''));
    expect(managerIds.length).toBeGreaterThanOrEqual(2);
    await manager.context.close();
  });

  test('mark all as read is kept across a reload; one can be marked unread again on the full screen', async ({ browser }) => {
    test.setTimeout(180_000);
    const manager = await person(browser, MANAGER);
    const m = manager.page;
    await m.goto('/');
    await expect(m.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => badge(m), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);

    await openBell(m);
    const markAll = panel(m).getByRole('button', { name: 'Mark all as read' });
    await expect(markAll).toBeEnabled({ timeout: 30_000 });
    await markAll.click();
    await expect.poll(() => badge(m), { timeout: 30_000 }).toBe(0);
    await expect(bell(m)).toHaveAttribute('aria-label', 'Notifications');

    // Kept in the database, not the browser: a reload (and a fresh page) still shows none.
    await m.reload();
    await expect(m.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    await expect(bell(m)).toBeVisible();
    expect(await badge(m)).toBe(0);

    // The full screen: nothing unread; everything listed, read.
    await m.goto('/notifications?state=unread');
    await expect(m.getByText('You are all caught up. No unread notifications.')).toBeVisible({ timeout: 60_000 });
    await m.goto('/notifications');
    const approvalRow = m.locator('tr[data-notification-id]', { hasText: approvalTitle });
    await expect(approvalRow).toHaveCount(1, { timeout: 30_000 });
    await expect(approvalRow).toHaveAttribute('data-read', 'true');
    await expect(approvalRow.locator('[data-status]')).toHaveText('Read');

    // Marked unread again: the row, the bell and a reload all agree.
    await approvalRow.getByRole('button', { name: 'Mark as unread' }).click();
    await expect(m.locator('tr[data-notification-id]', { hasText: approvalTitle })).toHaveAttribute('data-read', 'false', { timeout: 30_000 });
    await m.reload();
    await expect(m.locator('tr[data-notification-id]', { hasText: approvalTitle })).toHaveAttribute('data-read', 'false', { timeout: 30_000 });
    await expect.poll(() => badge(m), { timeout: 30_000 }).toBe(1);
    await manager.context.close();
  });

  test('nobody else sees them: the outsider’s bell is empty, the manager’s notification leads nowhere for others, the super user reads only their own', async ({ browser }) => {
    test.setTimeout(240_000);
    expect(managerIds.length).toBeGreaterThanOrEqual(2);

    const outsider = await person(browser, OUTSIDER);
    const o = outsider.page;
    await o.goto('/notifications');
    await expect(o.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    for (const id of managerIds) await expect(o.locator(`[data-notification-id="${id}"]`)).toHaveCount(0);
    await expect(o.getByText(account)).toHaveCount(0);
    expect(await badge(o)).toBe(0);
    // The poll answers for them alone (or refuses): never anyone else's rows.
    const poll = await o.request.post('/notifications/api/feed', {
      data: { list: true, scope: 'all', category: null },
      headers: { origin: new URL(o.url()).origin },
    });
    if (poll.status() === 200) {
      const body = (await poll.json()) as { unread: number; items: Array<{ id: string }> | null };
      expect(body.unread).toBe(0);
      for (const item of body.items ?? []) expect(managerIds).not.toContain(item.id);
    } else {
      expect(poll.status()).toBe(403);
    }
    // Opening the manager's notification by its address: refused, and nothing of it is shown.
    await o.goto(`/notifications/open/${managerIds[0]}`);
    await o.waitForLoadState('domcontentloaded');
    expect(o.url()).not.toContain('chart-of-accounts');
    expect(o.url()).not.toContain('/chat?c=');
    await expect(o.getByText(account)).toHaveCount(0);
    await outsider.context.close();

    // The super user sees the whole ledger, but their notifications are their own.
    const admin = await person(browser, ADMIN);
    const a = admin.page;
    await a.goto('/notifications');
    await expect(a.getByRole('heading', { level: 1 }).first()).toHaveText('Notifications', { timeout: 60_000 });
    for (const id of managerIds) await expect(a.locator(`[data-notification-id="${id}"]`)).toHaveCount(0);
    await a.goto(`/notifications/open/${managerIds[0]}`);
    await a.waitForURL(/\/notifications\?gone=1/, { timeout: 30_000 });
    await expect(a.getByText('That notification leads to something you can no longer open.')).toBeVisible();
    await admin.context.close();
  });

  test('Arabic, right to left, at a phone width, beside the model screen; and the desktop screens in English', async ({ browser }) => {
    test.setTimeout(300_000);
    mkdirSync(SHOTS, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    const page = await context.newPage();
    await signIn(page, MANAGER);

    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    // The phone has no header bell: the drawer's Notifications row opens the same panel.
    await expect(async () => {
      if (!(await page.locator('#erp-mobile-drawer .erp-mobile-action').first().isVisible())) {
        await page.locator('.erp-mobile-trigger').click();
      }
      await expect(page.locator('#erp-mobile-drawer .erp-mobile-action').first()).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await page.locator('#erp-mobile-drawer .erp-mobile-action').first().click();
    await expect(panel(page)).toBeVisible({ timeout: 30_000 });
    await expect(panel(page).locator('li[data-notification-id]').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/bell-popover-mobile-ar.png` });

    await page.goto('/notifications');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('الإشعارات', { timeout: 60_000 });
    await expect(page.locator('tr[data-notification-id]').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/notifications-mobile-ar.png`, fullPage: true });

    await page.goto('/payables/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/model-invoices-mobile-ar.png`, fullPage: true });
    await context.close();

    // Desktop, English: the screen beside the register it copies.
    const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const wide = await desktop.newPage();
    await signIn(wide, MANAGER);
    await wide.goto('/notifications');
    await expect(wide.getByRole('heading', { level: 1 })).toHaveText('Notifications', { timeout: 60_000 });
    await expect(wide.locator('tr[data-notification-id]').first()).toBeVisible({ timeout: 30_000 });
    await wide.waitForTimeout(800);
    await wide.screenshot({ path: `${SHOTS}/notifications-desktop-en.png` });
    await wide.goto('/payables/invoices');
    await expect(wide.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await wide.waitForTimeout(800);
    await wide.screenshot({ path: `${SHOTS}/model-invoices-desktop-en.png` });
    await desktop.close();
  });
});
