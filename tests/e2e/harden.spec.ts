import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * REQ-HARDEN-001 Stage 1, in a browser.
 *
 *   HD1  A role granted while the person is signed in shows in their menu on
 *        the next click, with no reload (two browser contexts: the CEO grants,
 *        the person navigates).
 *   HD2  A temporary password opens only the password screen; every other
 *        address lands there; replacing it frees the session.
 *   HD3  Five wrong passwords lock the form with its own message.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const CEO = { email: 'ceo@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page, user: { email: string; password: string }, landing = '/') {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(landing);
}

async function newContext(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe('REQ-HARDEN-001 Stage 1 · access and accounts', () => {
  test('HD2 then HD1 · a temporary password, then a role granted mid-session', async ({ browser }) => {
    test.setTimeout(300_000);
    const email = `harden.${RUN.toLowerCase()}@example.com`;

    // The administrator creates the account; the temporary password is shown once.
    const admin = await newContext(browser);
    await signIn(admin.page, ADMIN);
    await admin.page.goto('/administration/users');
    await admin.page.getByRole('button', { name: 'New user' }).click();
    await admin.page.waitForTimeout(800);
    await admin.page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await admin.page.getByRole('textbox', { name: 'Display name', exact: true }).fill(`Harden ${RUN}`);
    // No role yet: the CEO grants one later, while the person is signed in (HD1).
    await admin.page.getByLabel(/HQ ·/).check();
    // Since FIX-5 a new user is also an employee unless unticked, and an
    // employee needs a department. This account is about access alone.
    await admin.page.getByRole('checkbox', { name: 'Also an employee' }).uncheck();
    await admin.page.getByRole('button', { name: 'Create' }).click();
    await admin.page.waitForURL(/\/administration\/users\/[a-f0-9-]+\?saved=1/, { timeout: 60_000 });
    await admin.page.waitForLoadState('networkidle');
    const temporary = (await admin.page.locator('code').first().innerText()).trim();
    const userUrl = admin.page.url().split('?')[0]!;

    // HD2 — the person signs in and is held at the password screen.
    const person = await newContext(browser);
    await signIn(person.page, { email, password: temporary }, '/password');
    await expect(person.page.getByRole('heading', { level: 1, name: 'Change password' })).toBeVisible({ timeout: 60_000 });
    await person.page.goto('/profile');
    await person.page.waitForURL('/password');
    await person.page.goto('/master-data/branches');
    await person.page.waitForURL('/password');

    const chosen = `Chosen-${RUN}-long-phrase-of-my-own`;
    await person.page.locator('input[name="currentPassword"]').fill(temporary);
    await person.page.locator('input[name="newPassword"]').fill(chosen);
    await person.page.locator('input[name="confirm"]').fill(chosen);
    await person.page.getByRole('button', { name: 'Update password' }).click();
    await person.page.waitForURL(/^http:\/\/[^/]+\/\?saved=1$/);
    await person.page.goto('/profile');
    await expect(person.page.getByRole('heading', { level: 1 })).toContainText('My profile');
    // No role yet: no Payables module in the navigation.
    await expect(person.page.getByRole('button', { name: 'Payables', exact: true })).toHaveCount(0);

    // HD1 — the CEO grants a role while the person is signed in…
    const ceo = await newContext(browser);
    await signIn(ceo.page, CEO);
    await ceo.page.goto(userUrl);
    await ceo.page.waitForLoadState('networkidle');
    await ceo.page.locator('select[name="roleCode"]').selectOption({ value: 'accounting_officer' });
    await ceo.page.locator('form:has(select[name="roleCode"]) button[type="submit"]').click();
    await expect(ceo.page.getByRole('status')).toContainText('Saved');

    // …and the person's next click, a client-side navigation, redraws the menu.
    await person.page.locator('a.erp-brand').first().click();
    await person.page.waitForURL(/^http:\/\/[^/]+\/$/);
    await expect(person.page.getByRole('button', { name: 'Payables', exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(person.page.url()).not.toContain('/sign-in');

    await Promise.all([admin.context.close(), person.context.close(), ceo.context.close()]);
  });

  test('HD3 · five wrong passwords lock the form', async ({ page }) => {
    const email = `locked.${RUN.toLowerCase()}@example.com`;
    for (let i = 0; i < 5; i += 1) {
      await page.goto('/sign-in');
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill('not the password');
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(/\/sign-in\?error=1/);
    }
    await page.goto('/sign-in');
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill('not the password');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/sign-in\?error=locked/);
    await expect(page.getByRole('alert').filter({ hasText: 'Too many failed attempts' })).toBeVisible();
  });
});
