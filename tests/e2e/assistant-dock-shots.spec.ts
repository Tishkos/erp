import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Pictures of the AI dock for review, beside the chat dock it must not cover —
 * desktop English and phone Arabic — and, when the host has a brain
 * (`ASSISTANT_LIVE=1`), one real question answered. Run by hand:
 *
 *   ASSISTANT_SHOTS=./var/shots npx playwright test tests/e2e/assistant-dock-shots.spec.ts --workers=1
 */
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
const SHOTS = process.env.ASSISTANT_SHOTS ?? './var/shots/assistant';

async function signIn(page: Page, user: { email: string; password: string }, locale: 'en' | 'ar' = 'en') {
  const base = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000');
  await page.context().addCookies([{ name: 'erp-locale', value: locale, domain: base.hostname, path: '/', sameSite: 'Lax' }]);
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test('desktop, English: the button, the panel, and a chat window beside it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await signIn(page, OFFICER);
  await page.screenshot({ path: `${SHOTS}/01-home-button.png` });
  // A chat window docked, to see the two side by side.
  await page.getByRole('button', { name: /Messages|Chat/i }).first().click().catch(() => {});
  const conversation = page.locator('.erp-notifications__list a').first();
  if (await conversation.count()) await conversation.click();
  else await page.keyboard.press('Escape');
  await expect(page.locator('.erp-popover-scrim')).toBeHidden({ timeout: 5_000 }).catch(() => page.keyboard.press('Escape'));
  await page.locator('[data-assistant-dock]').click();
  await expect(page.locator('[data-assistant-panel]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-panel-open-beside-chat.png` });

  if (process.env.ASSISTANT_LIVE === '1') {
    await page.locator('[data-assistant-panel] textarea').fill('How many purchase invoices are there, and what is the newest one?');
    await page.locator('[data-assistant-panel] textarea').press('Enter');
    await expect(page.locator('[data-assistant-turn="assistant"]').first()).toBeVisible({ timeout: 300_000 });
    await page.screenshot({ path: `${SHOTS}/03-answered.png` });
  }
  await context.close();
});

test('phone, Arabic: the panel takes the screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'ar' });
  const page = await context.newPage();
  await signIn(page, OFFICER, 'ar');
  await page.screenshot({ path: `${SHOTS}/04-phone-ar-button.png` });
  await page.locator('[data-assistant-dock]').click();
  await expect(page.locator('[data-assistant-panel]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/05-phone-ar-panel.png` });
  await context.close();
});
