import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * The pop-up notifications (2026-10-07) — src/components/toasts.
 *
 * Runs against the seeded development database, with events that really
 * happen:
 *
 *   1. A save shows "Saved." in the corner beside the banner the page keeps,
 *      without a second status for the suite or a screen reader to find, and
 *      it goes away by itself; a reload does not bring it back. On a phone it
 *      stands at the top, under the header, across the screen.
 *   2. A refusal pops up in its own words and stays until it is dismissed;
 *      with Pop-up notifications turned off in the account menu a save pops
 *      nothing up and a refusal still does.
 *   3. The officer sends an account for approval and writes to the manager:
 *      the manager, on another screen, gets a notification pop-up that opens
 *      the record, and a message pop-up whose Reply opens the chat window.
 *
 * A browser a program drives sees no pop-ups unless it asks (`erp-popups` =
 * `on`): the rest of the suite reads the banners by their words. These pages ask.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const ADMIN = { email: 'admin@example.com', password: PASSWORD };
const OFFICER = { email: 'officer@example.com', password: PASSWORD, name: 'Accounting Officer' };
const MANAGER = { email: 'manager@example.com', password: PASSWORD, name: 'Accounting Manager' };
const FILTERED = '/payables/invoices?view=overdue&min_amount=1000000';
const RUN = new Date().toISOString().replace(/\D/g, '').slice(8, 14);
const VIEW = `Toast ${RUN}`;

test.describe.configure({ mode: 'serial' });

/** Signs in, then reads in English whatever language this person last chose (the language is this device's cookie). */
async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
  await page.context().addCookies([{ name: 'erp-locale', value: 'en', url: new URL(page.url()).origin }]);
}

async function person(
  browser: Browser,
  user: { email: string; password: string },
  popups = true,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // Ask for the pop-ups once; a choice made on the page (the switch) is kept after that.
  if (popups) {
    await context.addInitScript(() => {
      try {
        if (window.localStorage.getItem('erp-popups') === null) window.localStorage.setItem('erp-popups', 'on');
      } catch {
        // No storage: no pop-ups, and the test says so.
      }
    });
  }
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

const region = (page: Page) => page.locator('[data-toast-region]');
const popUp = (page: Page, kind: string) => region(page).locator(`[data-toast="${kind}"]`);
const viewsButton = (page: Page) => page.getByRole('button', { name: /^Views/ });
const menu = (page: Page) => page.getByRole('dialog', { name: 'Saved views' });

/** Saves the current screen as a view under this name, from the Views menu. */
async function saveView(page: Page, name: string) {
  await expect(async () => {
    if (!(await menu(page).isVisible())) await viewsButton(page).click();
    await expect(menu(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await menu(page).getByLabel('View name').fill(name);
  await menu(page).getByRole('button', { name: 'Save view' }).click();
}

/** The Views window can stay open when its form comes back to the same screen; a pop-up waits behind a modal window. */
async function closeMenu(page: Page) {
  if (await menu(page).isVisible().catch(() => false)) await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden({ timeout: 5_000 });
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

/** The window coming back to the front: the bell and the chat ask the server at once. */
const nudge = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test.describe('Pop-up notifications', () => {
  // The views this spec saves go, whatever happened — and any an interrupted run left behind.
  test.afterAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await person(browser, ADMIN, false);
    const page = admin.page;
    await page.goto('/profile/views');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    const ours = () => page.locator('table tbody tr').filter({ has: page.getByRole('textbox', { name: /^Rename: Toast \d{6}( b| p)?$/ }) });
    for (let left = await ours().count(); left > 0; left -= 1) {
      await ours().first().getByRole('button', { name: 'Delete' }).click();
      await page.getByRole('dialog', { name: 'Delete this view?' }).getByRole('button', { name: 'Delete' }).click();
      await expect(ours()).toHaveCount(left - 1, { timeout: 60_000 });
    }
    await admin.context.close();
  });

  test('a save pops up "Saved." beside the banner, and goes away by itself', async ({ browser }) => {
    test.setTimeout(180_000);
    const admin = await person(browser, ADMIN);
    const page = admin.page;
    await page.goto(FILTERED);
    await expect(viewsButton(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);

    await saveView(page, VIEW);
    // The banner is exactly as it was: one "Saved." status on the page, the pop-up is not a second one.
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(1, { timeout: 60_000 });
    await closeMenu(page);
    const saved = popUp(page, 'success');
    await expect(saved).toBeVisible({ timeout: 10_000 });
    await expect(saved).toContainText('Saved.');
    await expect(region(page).getByRole('status')).toHaveCount(0);
    await expect(region(page).getByRole('alert')).toHaveCount(0);
    await expect(region(page)).toHaveAttribute('role', 'region');

    // The bottom end corner of a desktop screen.
    const box = (await saved.boundingBox())!;
    expect(box.y + box.height).toBeGreaterThan(900 - 160);
    expect(box.x + box.width).toBeGreaterThan(1360 - 40);
    await expect(saved.locator('.erp-toast__time')).toHaveCount(1);

    // Five seconds, then it is gone (the pointer is not resting on it).
    await page.mouse.move(10, 10);
    await expect(saved).toHaveCount(0, { timeout: 12_000 });

    // A reload is not a second save.
    await page.reload();
    await expect(viewsButton(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await expect(popUp(page, 'success')).toHaveCount(0);
    await admin.context.close();
  });

  test('on a phone it pops up at the top, under the header, across the screen', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      try {
        if (window.localStorage.getItem('erp-popups') === null) window.localStorage.setItem('erp-popups', 'on');
      } catch {
        // No storage: no pop-ups.
      }
    });
    const page = await context.newPage();
    await signIn(page, ADMIN);
    await page.goto(FILTERED);
    await expect(viewsButton(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await saveView(page, `${VIEW} p`);
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(1, { timeout: 60_000 });
    await closeMenu(page);
    const saved = popUp(page, 'success');
    await expect(saved).toBeVisible({ timeout: 10_000 });
    const card = (await saved.boundingBox())!;
    const header = (await page.locator('.erp-header').boundingBox())!;
    expect(card.y).toBeGreaterThanOrEqual(Math.max(0, header.y + header.height) - 1);
    expect(card.y).toBeLessThan(header.y + header.height + 40);
    expect(card.width).toBeGreaterThan(390 - 40);
    await context.close();
  });

  test('a refusal pops up in its own words and stays until dismissed; switched off, only refusals pop up', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await person(browser, ADMIN);
    const page = admin.page;
    await page.goto(FILTERED);
    await expect(viewsButton(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);

    // The same name again is refused.
    await saveView(page, VIEW);
    await expect(page.getByRole('alert').filter({ hasText: 'That could not be saved.' })).toBeVisible({ timeout: 60_000 });
    await closeMenu(page);
    const refused = popUp(page, 'error');
    await expect(refused).toBeVisible({ timeout: 10_000 });
    await expect(refused).toContainText('That could not be saved.');
    await expect(refused).toContainText(`You already have a view named “${VIEW}”`);
    await refused.getByRole('button', { name: 'Dismiss' }).click();
    await expect(refused).toHaveCount(0);

    // Pop-up notifications: Off, in the account menu.
    const avatar = page.getByRole('button', { name: 'Open user menu' });
    await expect(async () => {
      if (!(await page.locator('[data-popups-switch]').isVisible())) await avatar.click();
      await expect(page.locator('[data-popups-switch]')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const toggle = page.locator('[data-popups-switch]');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toContainText('Pop-up notifications');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');

    // A save now pops nothing up; its banner says Saved as always.
    await page.goto(FILTERED);
    await expect(viewsButton(page)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await saveView(page, `${VIEW} b`);
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toHaveCount(1, { timeout: 60_000 });
    await page.waitForTimeout(2_500);
    await expect(popUp(page, 'success')).toHaveCount(0);

    // A refusal still does.
    await saveView(page, `${VIEW} b`);
    await expect(page.getByRole('alert').filter({ hasText: 'That could not be saved.' })).toBeVisible({ timeout: 60_000 });
    await expect(popUp(page, 'error')).toBeVisible({ timeout: 10_000 });
    await admin.context.close();
  });

  test('a new notification and a new message pop up for the manager on another screen', async ({ browser }) => {
    test.setTimeout(420_000);

    // The manager is on Home, the bell and the chat have looked once.
    const manager = await person(browser, MANAGER);
    const m = manager.page;
    await m.goto('/');
    await expect(m.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    await m.waitForTimeout(3_000);
    await nudge(m);
    await m.waitForTimeout(3_000);
    // What was waiting when the page opened never pops up.
    await expect(popUp(m, 'notification')).toHaveCount(0);

    // The officer raises an account and sends it for approval.
    const officer = await person(browser, OFFICER, false);
    const page = officer.page;
    await page.goto('/master-data/chart-of-accounts');
    await expect(page.getByRole('button', { name: 'New account' })).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await page.getByRole('button', { name: 'New account' }).click();
    await page.waitForTimeout(1_200);
    const parent = page.getByRole('combobox', { name: 'Under' });
    const option = await parent.locator('option:not([disabled])').filter({ hasText: 'Assets' }).first().getAttribute('value');
    await parent.selectOption(option!);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Pop-up ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, { timeout: 60_000 });
    const account = page.url().split('/').pop()!;
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Submit for approval', exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(2_000);
    await press(page, 'Submit for approval', 'Pending approval');
    // A program that did not ask sees no pop-ups.
    await expect(region(page)).toHaveCount(0);

    // The manager's bell hears it: a pop-up with its title, in the accent, read out (an alert inside).
    const notice = popUp(m, 'notification').filter({ hasText: `Approval needed: ${account}` });
    await expect(async () => {
      await nudge(m);
      await expect(notice).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
    await expect(notice.getByRole('alert')).toHaveCount(1);
    const open = notice.getByRole('link', { name: 'Open' });
    await expect(open).toHaveAttribute('href', /^\/notifications\/open\/\d+$/);

    // The officer writes to the manager.
    await page.goto('/chat');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Chat', { timeout: 60_000 });
    await page.getByRole('button', { name: 'New chat' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Find a colleague').fill(MANAGER.name);
    await dialog.locator('li', { hasText: MANAGER.name }).getByRole('button', { name: 'Chat' }).click();
    await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible({ timeout: 20_000 });
    const words = `Have a look at ${account} ${RUN}`;
    await page.getByRole('textbox', { name: 'Message' }).fill(words);
    await page.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(page.locator('li', { hasText: words })).toBeVisible();
    await officer.context.close();

    // The manager, not on the chat screen: the sender's face and the line.
    const message = popUp(m, 'message').filter({ hasText: words });
    await expect(async () => {
      await nudge(m);
      await expect(message).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000 });
    await expect(message).toContainText(OFFICER.name);
    await expect(message.locator('[data-avatar]')).toHaveCount(1);
    await expect(message.getByRole('link', { name: 'Reply' })).toHaveAttribute('href', /^\/chat\?c=/);

    // Reply opens the conversation as a chat window at the foot of the screen; reading it takes the pop-up away.
    await message.getByRole('link', { name: 'Reply' }).click();
    const chatWindow = m.locator('[data-chat-window]').filter({ hasText: words });
    await expect(chatWindow).toBeVisible({ timeout: 30_000 });
    await expect(message).toHaveCount(0);
    await m.waitForTimeout(6_000);

    // The notification's pop-up, if still there, opens the real record; else the bell does.
    await m.goto('/notifications');
    await expect(m.getByRole('heading', { level: 1 })).toHaveText('Notifications', { timeout: 60_000 });
    const row = m.locator('tr[data-notification-id]').filter({ hasText: `Approval needed: ${account}` }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole('link').first().click();
    await m.waitForURL(new RegExp(`/master-data/chart-of-accounts/${account}$`), { timeout: 60_000 });
    await m.locator('[data-chat-window] button[aria-label="Close"]').first().click().catch(() => undefined);
    await manager.context.close();
  });
});
