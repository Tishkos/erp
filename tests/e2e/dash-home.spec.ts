import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { keepEnglish } from './support/locale';

/**
 * Home and My Approvals — platform phase, Agent 2.
 *
 * Runs against the seeded development database (`npm run db:seed`). It writes
 * one fixture of its own, as the owner and idempotently: a person who holds
 * stock grants and nothing else (a warehouse role does not exist in the seed).
 * What it proves in a browser:
 *
 *   • the CEO, a warehouse person, an accounting officer and a person with no
 *     role are shown different pages — different figures, different shortcuts,
 *     and a plain sentence for each kind of data their role does not hold;
 *   • an account raised by the officer waits on the manager in My Approvals,
 *     opens the real account from its row, and is approved from the row through
 *     the chart of accounts' own service — it then leaves the list;
 *   • both screens read at a phone's width, in Arabic, right to left, with no
 *     sideways scroll — screenshots beside the screens they copy.
 */
const SHOTS = '/home/claude/shots/dashboard';
const PASSWORD = 'Ledger-Trial-Balance-7';
const CEO = 'ceo@example.com';
const MANAGER = 'manager@example.com';
const OFFICER = 'officer@example.com';
const OUTSIDER = 'outsider@example.com';
const WAREHOUSE = 'warehouse.home@example.com';
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page, email: string) {
  // Signing in as somebody else means being somebody else.
  await page.context().clearCookies();
  await keepEnglish(page.context());
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function arabic(page: Page) {
  await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
}

/** Script errors and console errors a page raises (a hydration mismatch among them); the font fetch is the sandbox's, not the page's. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/fonts\.g|Failed to load resource|favicon/i.test(message.text())) errors.push(message.text());
  });
  return errors;
}

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (the spec writes its own fixture).');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(`insert into role (code, name) values ('dash_e2e_warehouse', 'Warehouse (Home spec)') on conflict (code) do nothing`);
    for (const [object, verb] of [
      ['inventory_movement', 'view'],
      ['inventory_movement', 'execute'],
      ['stock_movement', 'view'],
      ['warehouse', 'view'],
      ['item', 'view'],
      ['stock_count', 'view'],
      ['task', 'view'],
      ['notification', 'view'],
      ['chat', 'view'],
    ] as const) {
      await pool.query(
        `insert into role_grant (role_code, object, verb) values ('dash_e2e_warehouse', $1, $2::permission_verb) on conflict do nothing`,
        [object, verb],
      );
    }
    const { rows: existing } = await pool.query(`select id from app_user where lower(email) = $1`, [WAREHOUSE]);
    let id = existing[0]?.id as string | undefined;
    if (!id) {
      const made = await pool.query(
        `insert into app_user (email, display_name, is_active) values ($1, 'Warehouse Home', true) returning id`,
        [WAREHOUSE],
      );
      id = made.rows[0].id as string;
    }
    await pool.query(`insert into user_role (user_id, role_code) values ($1, 'dash_e2e_warehouse') on conflict do nothing`, [id]);
    await pool.query(
      `insert into user_branch_scope (user_id, branch_code, is_default) values ($1, 'HQ', true)
       on conflict (user_id, branch_code) do update set is_default = true`,
      [id],
    );
    // The same salted hash as the seeded people: one password for every development account.
    await pool.query(
      `insert into auth_account (id, user_id, account_id, provider_id, password)
       select gen_random_uuid()::text, $1::uuid, $3::text, 'credential', a.password
         from auth_account a join app_user u on u.id = a.user_id
        where lower(u.email) = $2 and a.provider_id = 'credential'
          and not exists (select 1 from auth_account b where b.user_id = $1::uuid and b.provider_id = 'credential')`,
      [id, OFFICER, id],
    );
  } finally {
    await pool.end();
  }
});

test.describe('Home is composed from who is asking', () => {
  test('the CEO is shown the management view, with a shortcut to what waits on them', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const errors = watchErrors(page);
    await signIn(page, CEO);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard', { timeout: 60_000 });
    // Management-only figures: the overdue amounts, and the audit trail further down.
    await expect(page.getByText('Overdue from customers').first()).toBeVisible();
    await expect(page.getByText('Overdue to suppliers').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'My approvals', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Recent activity').first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/home-ceo-desktop-en.png`, fullPage: true });
    expect(errors, 'errors raised by the page').toEqual([]);
  });

  test('a warehouse person is shown stock and nothing financial, and is told so', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, WAREHOUSE);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard', { timeout: 60_000 });
    await expect(page.getByText('Stock value').first()).toBeVisible();
    await expect(page.getByText('Stock movements today').first()).toBeVisible();
    for (const hidden of ['Cash and bank', 'Owed to us', 'Owed by us', 'Overdue from customers', 'Result this year', 'Recent activity']) {
      await expect(page.getByText(hidden, { exact: true })).toHaveCount(0);
    }
    await expect(page.getByText('No finance data is available for your role.')).toBeVisible();
    await expect(page.getByText('No logistics data is available for your role.')).toBeVisible();
    await expect(page.getByText('No inventory data is available for your role.')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/home-warehouse-desktop-en.png`, fullPage: true });
  });

  test('an accounting officer sees the money but not management\'s figures, and nothing waits on them', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, OFFICER);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard', { timeout: 60_000 });
    await expect(page.getByText('Cash and bank').first()).toBeVisible();
    await expect(page.getByText('Overdue from customers', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Recent activity', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Waiting for my approval', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/home-officer-desktop-en.png`, fullPage: true });
  });

  test('a person with no role is shown no figures, only what their role does not hold', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, OUTSIDER);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard', { timeout: 60_000 });
    await expect(page.getByText('Not available for your role')).toBeVisible();
    for (const family of ['finance', 'receivables', 'payables', 'sales', 'purchasing', 'inventory', 'logistics', 'HR', 'project']) {
      await expect(page.getByText(`No ${family} data is available for your role.`)).toBeVisible();
    }
    for (const hidden of ['Cash and bank', 'Stock value', 'My open tasks', 'Imports in progress']) {
      await expect(page.getByText(hidden, { exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: `${SHOTS}/home-outsider-desktop-en.png`, fullPage: true });
  });
});

test.describe('My Approvals lists what the viewer can act on and decides through the owning service', () => {
  test('an account the officer raised waits on the manager, who approves it from the list', async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    // The officer raises an account and sends it for approval, exactly as the Chart of Accounts screen does.
    await signIn(page, OFFICER);
    await page.goto('/master-data/chart-of-accounts');
    await expect(page.getByRole('button', { name: 'New account' })).toBeVisible();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: 'New account' }).click();
    await page.waitForTimeout(1200);
    const parent = page.getByRole('combobox', { name: 'Under' });
    const option = await parent.locator('option:not([disabled])').filter({ hasText: 'Assets' }).first().getAttribute('value');
    await parent.selectOption(option!);
    const name = `Home approval ${RUN}`;
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, { timeout: 60_000 });
    const code = page.url().split('/').pop()!;
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(2000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await page.getByText('Pending approval', { exact: true }).first().isVisible().catch(() => false)) break;
      await page.getByRole('button', { name: 'Submit for approval', exact: true }).first().click();
      await page.getByText('Pending approval', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 25_000 }).catch(() => page.reload());
    }
    await expect(page.getByText('Pending approval', { exact: true }).filter({ visible: true }).first()).toBeVisible();

    // The person who raised it is never asked to decide it.
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Approvals');
    await expect(page.getByRole('link', { name: new RegExp(`^${code}`) })).toHaveCount(0);

    // The manager is.
    await signIn(page, MANAGER);
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('My Approvals');
    // The first register only: once decided, the account is also listed under "My decisions".
    const waiting = page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Action required' }) });
    const row = waiting.getByRole('row').filter({ hasText: name });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByRole('link', { name: new RegExp(code) })).toHaveAttribute('href', `/master-data/chart-of-accounts/${code}`);
    await expect(row).toContainText('Chart account');
    await page.screenshot({ path: `${SHOTS}/approvals-manager-desktop-en.png`, fullPage: true });

    // Approve from the row: the service's own maker-checker, then the row is gone.
    await page.waitForTimeout(1500);
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved', { timeout: 30_000 });
    await expect(waiting.getByRole('row').filter({ hasText: name })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(1); // under "My decisions"

    // And the account itself says so — the list did not just say "Saved".
    await page.goto(`/master-data/chart-of-accounts/${code}`);
    await expect(page.getByText('Approved', { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  });

  test('an error carried in the address is shown as the error banner, never as "Saved"', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, MANAGER);
    // A decision on a document that does not exist: refused by the owning service, shown as the error, never as "Saved".
    const response = await page.goto('/approvals?error=Nothing%20was%20decided');
    expect(response?.status()).toBeLessThan(400);
    await expect(page.getByText('Nothing was decided')).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
  });
});

test.describe('Arabic, right to left, at a phone\'s width', () => {
  test('Home and My Approvals fit 390px with no sideways scroll, beside the screens they copy', async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    await signIn(page, CEO);
    await arabic(page); // after signing in: signing in clears the cookies
    const wide: string[] = [];
    for (const [route, shot] of [
      ['/', 'home-ceo-mobile-ar'],
      ['/approvals', 'approvals-ceo-mobile-ar'],
      ['/tasks', 'tasks-ceo-mobile-ar'],
      ['/payables/invoices', 'invoices-ceo-mobile-ar'],
    ] as const) {
      const response = await page.goto(route, { waitUntil: 'networkidle' });
      expect(response?.status(), `${route} responds`).toBeLessThan(400);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 45_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 390) wide.push(`${route}: ${width}px`);
      await page.screenshot({ path: `${SHOTS}/${shot}.png`, fullPage: true });
    }
    expect(wide, 'screens wider than the phone').toEqual([]);
    expect(errors, 'errors raised by the pages').toEqual([]);
    // No raw message key reached the page.
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(await page.locator('body').innerText()).not.toMatch(/\bhome\.[a-z_]+\.[a-z_]+|\badmin\.approvals\./);
  });

  test('the warehouse person\'s Home reads at 390px in Arabic', async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, WAREHOUSE);
    await arabic(page);
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 45_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/home-warehouse-mobile-ar.png`, fullPage: true });
  });
});
