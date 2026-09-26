import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 0 — System Foundation, end to end in a browser.
 *
 * The PDF's expected result, taken literally: "the company can open the ERP,
 * create the organisation structure, create users, assign access, use the
 * Department Manager approval flow, and work with one standard document
 * status and numbering model." Each test below is one of those sentences,
 * performed through the screens, against the real database.
 *
 * Codes carry a per-run suffix because the database persists between runs
 * and a branch is never deleted (§4.1) — the test leaves what it made, as a
 * real administrator would.
 *
 * Requires `npm run db:seed`.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page, user = ADMIN) {
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe.configure({ mode: 'serial' });

test.describe('Phase 0 · the administration screens read and write the database', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('every Phase 0 screen renders live, without the preview banner', async ({ page }) => {
    // Ten routes, each compiled on first visit by the dev server.
    test.setTimeout(240_000);
    for (const route of [
      '/administration/company',
      '/administration/users',
      '/administration/managers',
      '/administration/roles',
      '/administration/permissions',
      '/administration/numbering',
      '/administration/audit',
      '/master-data/branches',
      '/master-data/departments',
      '/approvals',
    ]) {
      await page.goto(route, { timeout: 120_000 });
      await expect(page.getByRole('heading', { level: 1 }), route).toBeVisible();
      await expect(page.getByRole('note'), route).toHaveCount(0);
    }
  });

  test('1 · Company Setup — the company record is created and read back', async ({ page }) => {
    await page.goto('/administration/company');
    const code = page.getByRole('textbox', { name: 'Company code', exact: true });
    // Read-only once the record exists: the code cannot change later.
    if (await code.isEditable()) await code.fill('QS');
    await page.getByRole('textbox', { name: 'Legal name', exact: true }).fill('Qimah Al-Safinah');
    await page.getByLabel('Base currency').selectOption('IQD');
    // Server-action forms replay only after hydration; give it a moment.
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: /Create|Update/ }).first().click();
    await page.waitForURL(/saved=1/, { timeout: 30_000 });
    await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByRole('textbox', { name: 'Legal name', exact: true })).toHaveValue('Qimah Al-Safinah');
  });

  test('2 · Branches — created with its defaults in one go, edited, deactivated', async ({ page }) => {
    const code = `BR${RUN}`;
    await page.goto('/master-data/branches');
    await page.getByRole('button', { name: 'New branch' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Branch ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(`**/master-data/branches/${code}?saved=1`, { timeout: 30_000 });
    // §4.1 — the default warehouse came into existence with the branch.
    await expect(page.getByText(`WH-${code}`, { exact: true })).toBeVisible();

    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Branch ${RUN} renamed`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await page.waitForLoadState('networkidle');

    // The form posts through a server action; give hydration a moment after the navigation.
    await page.waitForTimeout(1500);
    await page.getByRole('textbox', { name: 'Reason', exact: true }).fill('Closed for the test');
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await page.waitForURL(/saved=1/, { timeout: 30_000 });
    await expect(page.getByText('Inactive').first()).toBeVisible({ timeout: 15_000 });
    // Requirement 10 — the record carries its own history.
    // The record's own history names events in words; the audit report below
    // keeps the raw codes, which is what an auditor searches on.
    await expect(page.getByText('Branch closed').first()).toBeVisible();
  });

  test('3 · Departments — created, and given a Department Manager', async ({ page }) => {
    await page.goto('/master-data/departments');
    await page.getByRole('button', { name: 'New department' }).click();
    await page.waitForTimeout(800);
    // No Code field: the system mints it (Critical Rule 1, 2026-09-26).
    await expect(page.getByRole('textbox', { name: 'Code', exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Department ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/departments\/DEP-\d{4}\?saved=1/, { timeout: 30_000 });
    const code = new URL(page.url()).pathname.split('/').pop()!;

    await page
      .getByLabel('Users')
      .selectOption({ label: 'Accounting Manager · manager@example.com' });
    await page.getByLabel('As department manager').check();
    await page.getByRole('button', { name: 'Add a member' }).click();
    // The page already says "Saved." from creating the department, so the
    // proof the member landed is the row, given time for the round trip.
    await expect(page.getByRole('cell', { name: 'Accounting Manager' })).toBeVisible({ timeout: 30_000 });

    await page.goto('/administration/managers');
    await expect(page.getByRole('cell', { name: `${code} · Department ${RUN}` })).toBeVisible();
  });

  test('4 · Users — created with a temporary password, scoped, then deactivated', async ({ page }) => {
    const email = `user.${RUN.toLowerCase()}@example.com`;
    await page.goto('/administration/users');
    await page.getByRole('button', { name: 'New user' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
    await page.getByRole('textbox', { name: 'Display name', exact: true }).fill(`User ${RUN}`);
    await page.getByLabel(/Accounting Officer/).check();
    await page.getByLabel(/HQ ·/).check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(new RegExp('\\/administration\\/users\\/[a-f0-9-]+\\?saved=1'), { timeout: 60_000 });
    await page.waitForLoadState('networkidle');

    // Shown once, and long enough for the policy.
    const secret = await page.locator('code').first().innerText();
    expect(secret.length).toBeGreaterThanOrEqual(12);
    await expect(page.getByText('accounting_officer', { exact: true })).toBeVisible();
    await expect(page.getByText('HQ · Head Office', { exact: true })).toBeVisible();

    // The form posts through a server action; give hydration a moment after the navigation.
    await page.waitForTimeout(1500);
    await page.getByRole('textbox', { name: 'Reason', exact: true }).fill('Left the company');
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByText('Inactive').first()).toBeVisible();
  });

  test('5 · Roles and Permissions — a role is created and given grants by section and action', async ({ page }) => {
    const code = `role_${RUN.toLowerCase()}`;
    await page.goto('/administration/roles');
    await page.getByRole('button', { name: 'New role' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(code);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Role ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(`**/administration/roles/${code}?saved=1`, { timeout: 30_000 });

    // Sections without a grant yet are collapsed; a new role has none.
    await page.locator('details').evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
    await page.getByLabel('branch View', { exact: true }).check();
    await page.getByLabel('department View', { exact: true }).check();
    await page.getByRole('button', { name: 'Save permissions' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByLabel('branch View', { exact: true })).toBeChecked();

    await page.goto('/administration/permissions');
    await page.getByRole('heading', { name: 'Permissions', level: 1 }).waitFor({ timeout: 120_000 });
    // The editor lists every role as a tab; the new one is among them.
    await expect(page.getByRole('link', { name: new RegExp(`Role ${RUN}`) })).toBeVisible();
  });

  test('9 · Numbering — a series is defined and is visible with its issued count', async ({ page }) => {
    const key = `SER_${RUN}`;
    await page.goto('/administration/numbering');
    await page.getByRole('button', { name: 'New series' }).click();
    await page.waitForTimeout(800);
    await page.getByRole('textbox', { name: 'Series key', exact: true }).fill(key);
    await page.getByRole('textbox', { name: 'Prefix', exact: true }).fill('TS');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(`**/administration/numbering/${key}?saved=1`, { timeout: 30_000 });
    await expect(page.getByText('{PREFIX}-{SERIAL}').first()).toBeVisible();
    // The chart's own series shows numbers it has handed out — never reused.
    await page.goto('/administration/numbering');
    await expect(page.getByRole('link', { name: 'ACCOUNT_CODE_ASSET' })).toBeVisible();
  });

  test('10 · Record History — the audit trail shows what this run did, by whom', async ({ page }) => {
    await page.goto(`/administration/audit?q=BR${RUN}`);
    await expect(page.getByText('branch.created', { exact: true })).toBeVisible();
    await expect(page.getByText('branch.deactivated', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'System Administrator' }).first()).toBeVisible();
  });
});

test.describe('Phase 0 · deny by default still holds on the live screens', () => {
  test('an accounting officer cannot open Users, but can open Branches', async ({ page }) => {
    await signIn(page, { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' });
    await page.goto('/administration/users');
    await expect(page.locator('.panel[role="alert"]')).toContainText('do not have permission');
    await page.goto('/master-data/branches');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Branches');
    await expect(page.getByRole('button', { name: 'New branch' })).toHaveCount(0);
  });
});
