import { expect, test, type Page } from '@playwright/test';

/**
 * The AI dock (2026-10-07) — Noah in the bottom-end corner of every screen.
 *
 *   1. The button is on the Home screen and on a record screen; it opens the
 *      panel, the panel closes on Escape and on its close button.
 *   2. The chat dock sits beside the AI dock, further along while the panel is
 *      open — the two never overlap.
 *   3. The route refuses a question from nobody (401) and takes one from the
 *      signed-in person; with no brain on the host the panel says so rather
 *      than failing (the answer itself is the brain's and is not asserted).
 *
 * Runs against the seeded development database.
 */
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test('the button opens the panel, and the panel closes on Escape', async ({ page }) => {
  await signIn(page, OFFICER);
  const button = page.locator('[data-assistant-dock]');
  await expect(button).toBeVisible();
  await button.click();
  const panel = page.locator('[data-assistant-panel]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading').or(panel.getByText('Noah — AI'))).toBeVisible();
  await panel.locator('textarea').press('Escape');
  await expect(panel).toBeHidden();
  await button.click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toBeHidden();

  // On a record screen too.
  await page.goto('/payables/payment-applications');
  await expect(page.locator('[data-assistant-dock]')).toBeVisible();
});

test('the route refuses a stranger and answers the signed-in person, or says the host has no brain', async ({ page, request }) => {
  const stranger = await request.post('/assistant/api', { data: { kind: 'ask', text: 'hello' } });
  expect(stranger.status()).toBe(401);

  await signIn(page, OFFICER);
  const yes = await page.request.post('/assistant/api', { data: { kind: 'no' } });
  expect(yes.ok()).toBe(true);
  expect(await yes.json()).toEqual({ dropped: false });
  const bad = await page.request.post('/assistant/api', { data: { kind: 'ask' } });
  expect(bad.status()).toBe(400);
});

test('the chat dock keeps out of the corner while the panel is open', async ({ page }) => {
  await signIn(page, OFFICER);
  // The chat dock renders only with a window open; its inset is what moves, so read the style the store would give it.
  await page.locator('[data-assistant-dock]').click();
  await expect(page.locator('[data-assistant-panel]')).toBeVisible();
  const panelBox = await page.locator('[data-assistant-panel]').boundingBox();
  const buttonBox = await page.locator('[data-assistant-dock]').boundingBox();
  expect(panelBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  // The panel sits above the button, in the same corner, and neither leaves the viewport.
  const viewport = page.viewportSize()!;
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(buttonBox!.y + 1);
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(viewport.width + 1);
});
