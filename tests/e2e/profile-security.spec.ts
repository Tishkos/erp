import { expect, test, type Browser, type Page } from '@playwright/test';
import { totpAt } from '../../src/server/domain/authentication';
import { QR_QUIET_ZONE, qrCode, qrPath } from '../../src/server/domain/qr-code';

/**
 * The authenticator, from My profile to a confirmed enrolment.
 *
 *   My profile carries a Security panel whose button opens /profile/security;
 *   Begin enrolment draws a QR code of the otpauth address (the same address
 *   the "Open in the authenticator app" link carries, and the key shown under
 *   it), also at a phone's width in Arabic; the code an authenticator would
 *   show for that key confirms it; My profile then says Enrolled and offers
 *   Manage.
 *
 * An enrolment cannot be undone from a screen, so the account is made for the
 * run — as `harden.spec.ts` makes its own.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page, user: { email: string; password: string }, landing: string | RegExp = '/') {
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

test.describe('My profile · Security and the authenticator', () => {
  test('the panel on My profile, the QR code, and a confirmed enrolment', async ({ browser }) => {
    test.setTimeout(300_000);
    const email = `security.${RUN.toLowerCase()}@example.com`;

    // An account of the run's own, with no role: the screen needs none.
    const admin = await newContext(browser);
    await signIn(admin.page, ADMIN);
    await admin.page.goto('/administration/users');
    await admin.page.getByRole('button', { name: 'New user' }).click();
    await admin.page.waitForTimeout(800);
    await admin.page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await admin.page.getByRole('textbox', { name: 'Display name', exact: true }).fill(`Security ${RUN}`);
    await admin.page.getByLabel(/HQ ·/).check();
    await admin.page.getByRole('checkbox', { name: 'Also an employee' }).uncheck();
    await admin.page.getByRole('button', { name: 'Create' }).click();
    await admin.page.waitForURL(/\/administration\/users\/[a-f0-9-]+\?saved=1/, { timeout: 60_000 });
    await admin.page.waitForLoadState('networkidle');
    const temporary = (await admin.page.locator('code').first().innerText()).trim();
    await admin.context.close();

    const person = await newContext(browser);
    await signIn(person.page, { email, password: temporary }, '/password');
    const chosen = `Chosen-${RUN}-long-phrase-of-my-own`;
    await person.page.locator('input[name="currentPassword"]').fill(temporary);
    await person.page.locator('input[name="newPassword"]').fill(chosen);
    await person.page.locator('input[name="confirm"]').fill(chosen);
    await person.page.getByRole('button', { name: 'Update password' }).click();
    await person.page.waitForURL(/^http:\/\/[^/]+\/\?saved=1$/);
    const page = person.page;

    // My profile: the Security panel says where the authenticator stands and leads to its screen.
    await page.goto('/profile');
    const panel = page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Security' }) }).last();
    await expect(panel).toContainText('Not enrolled');
    await panel.getByRole('link', { name: 'Set up authenticator' }).click();
    await page.waitForURL('/profile/security');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Security');

    // No QR code before a key exists.
    await expect(page.getByRole('img', { name: 'QR code for the authenticator app' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Begin enrolment' }).click();
    await page.waitForURL(/\/profile\/security\?saved=1/);

    // The key, the address and the picture are one secret said three ways.
    const key = (await page.locator('code').first().innerText()).replace(/\s+/g, '');
    expect(key).toMatch(/^[A-Z2-7]{32}$/);
    const address = await page.getByRole('link', { name: 'Open in the authenticator app' }).getAttribute('href');
    expect(address).toMatch(/^otpauth:\/\/totp\//);
    const read = new URL(address!);
    expect(read.searchParams.get('secret')).toBe(key);
    expect(decodeURIComponent(read.pathname)).toContain(`:${email}`);
    expect(read.searchParams.get('issuer')).toBeTruthy();

    const qr = page.getByRole('img', { name: 'QR code for the authenticator app' });
    await expect(qr).toBeVisible();
    const expected = qrCode(address!);
    const span = expected.size + 2 * QR_QUIET_ZONE;
    await expect(qr).toHaveAttribute('viewBox', `0 0 ${span} ${span}`);
    await expect(qr.locator('path')).toHaveAttribute('d', qrPath(expected));
    // Black on white whatever the palette, square, and inside the page's width.
    await expect(qr.locator('rect')).toHaveAttribute('fill', '#fff');
    await expect(qr.locator('path')).toHaveAttribute('fill', '#000');
    const box = (await qr.boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    expect(box.width).toBeGreaterThanOrEqual(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // The same screen on a phone, in Arabic: the code keeps its place and nothing scrolls sideways.
    await person.context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const arabic = page.getByRole('img', { name: 'رمز QR لتطبيق المصادقة' });
    await expect(arabic).toBeVisible();
    await expect(arabic.locator('path')).toHaveAttribute('d', qrPath(expected));
    const phone = (await arabic.boundingBox())!;
    expect(phone.x).toBeGreaterThanOrEqual(0);
    expect(phone.x + phone.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('code').first()).toHaveAttribute('dir', 'ltr');
    await expect(page.getByRole('link', { name: 'افتح في تطبيق المصادقة' })).toHaveAttribute('href', address!);
    await person.context.addCookies([{ name: 'erp-locale', value: 'en', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();

    // A wrong code is refused and the same key is still offered.
    await page.locator('input[name="code"]').fill('000000');
    await page.getByRole('button', { name: 'Confirm enrolment' }).click();
    await page.waitForURL(/\/profile\/security\?error=/);
    expect((await page.locator('code').first().innerText()).replace(/\s+/g, '')).toBe(key);

    // What the app would show now.
    await page.locator('input[name="code"]').fill(totpAt(key, Math.floor(Date.now() / 30_000)));
    await page.getByRole('button', { name: 'Confirm enrolment' }).click();
    await page.waitForURL(/\/profile\/security\?saved=1&enrolled=1|\/profile\/security\?enrolled=1&saved=1/);
    await expect(page.getByRole('status').filter({ hasText: 'The authenticator is enrolled' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'QR code for the authenticator app' })).toHaveCount(0);

    // And My profile says so.
    await page.goto('/profile');
    await expect(panel).toContainText('Enrolled');
    await expect(panel).not.toContainText('Not enrolled');
    await expect(panel.getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/profile/security');

    await person.context.close();
  });
});
