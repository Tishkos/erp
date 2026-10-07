import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Saved views — the Views menu beside a screen's filters, /profile/views, and
 * pinning to Home (platform phase, Agent 8).
 *
 * Runs against the seeded development database as the administrator, with the
 * purchase invoices it needs written first (idempotently, as the owner). What
 * it proves in the browser:
 *
 *   • a filtered Payables list is saved as a named view — and the page says so
 *     only once the database has the row;
 *   • after a reload the view is there: applying it restores the filters and
 *     the register narrows to what it asked;
 *   • a default view opens on a bare arrival, and `sv=none` gets round it;
 *   • pinning puts it on Home's list (the pin is a timestamp; the count is the
 *     screen's own query) and every change leaves an audit row;
 *   • /profile/views lists it, renames it, and deletes it after a question;
 *   • Arabic at 390px, right to left: the menu fits the phone.
 */
const SHOTS = '/home/claude/shots/views';
const PASSWORD = 'Ledger-Trial-Balance-7';
const FILTERED = '/payables/invoices?view=overdue&min_amount=1000000';

const owner = () => {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (the spec writes its own fixtures).');
  return new Pool({ connectionString: url, max: 1 });
};

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('/');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const pool = owner();
  try {
    const { rows: admin } = await pool.query(`select id from app_user where email = 'admin@example.com'`);
    await pool.query(
      `insert into business_partner (code, legal_name, is_supplier) values ('SUP-SV0001','Saved Views Supplier', true)
       on conflict (code) do nothing`,
    );
    const { rows: supplier } = await pool.query(`select id from business_partner where code = 'SUP-SV0001'`);
    const invoice = (no: string, due: string, total: number) =>
      pool.query(
        `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
         values ($1,$2,$3,'HQ','2026-08-01',$4,$5,$6,true) on conflict (invoice_no) do nothing`,
        [no, `SV-${no}`, supplier[0].id, due, total, admin[0].id],
      );
    await invoice('API-HQ-2026-940001', '2026-09-01', 1800000);
    await invoice('API-HQ-2026-940002', '2026-09-05', 300000);
    await invoice('API-HQ-2026-940003', '2099-12-31', 900000);
    // Their due dates set on purpose: one never set is overdue on no day (2026-10-07).
    await pool.query(`update ap_invoice set due_date_set_at = coalesce(due_date_set_at, now()) where invoice_no like 'API-HQ-2026-9400%'`);
    // Start clean: the administrator's screen views only (the audit trail stays).
    await pool.query(`delete from saved_view where kind = 'route' and owner_user_id = $1`, [admin[0].id]);
  } finally {
    await pool.end();
  }
});

const viewsButton = (page: Page) => page.getByRole('button', { name: /^Views/ });
const menu = (page: Page) => page.getByRole('dialog', { name: 'Saved views' });
const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Saved.' });
const invoiceRows = (page: Page) => page.locator('table tbody tr').filter({ hasText: 'API-HQ-2026-94' });

test('saves a filtered Payables list, reopens it after a reload, sets it as the default and pins it', async ({ page }) => {
  await signIn(page);
  await page.goto(FILTERED);

  // The filters narrow the register to the one large overdue invoice.
  await expect(invoiceRows(page)).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByText('API-HQ-2026-940001')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/invoices-list-desktop-en.png`, fullPage: true });

  // Save the current view. Nothing is confirmed until the page comes back from the database.
  await viewsButton(page).click();
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByText('This view will keep: View: Overdue')).toBeVisible();
  await expect(menu(page).getByText('You have not saved a view of this screen yet.')).toBeVisible();
  await menu(page).getByLabel('View name').fill('Large overdue bills');
  await page.screenshot({ path: `${SHOTS}/invoices-views-menu-empty-desktop-en.png` });
  await menu(page).getByRole('button', { name: 'Save view' }).click();
  await expect(saved(page)).toBeVisible();
  await expect(page).toHaveURL(/view=overdue/);
  await expect(viewsButton(page)).toHaveText('Views (1)');

  // The row is the database's: owner-only, a screen view, the filters and nothing else.
  const pool = owner();
  try {
    const { rows } = await pool.query(
      `select v.kind, v.list_key, v.is_shared, v.query from saved_view v join app_user u on u.id = v.owner_user_id
        where u.email = 'admin@example.com' and v.name = 'Large overdue bills'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'route', list_key: 'payables.invoices', is_shared: false });
    expect(rows[0].query).toEqual({ v: 1, params: { view: 'overdue', min_amount: '1000000' } });
  } finally {
    await pool.end();
  }

  // After a reload on a bare address the view is in the menu; applying it restores the filters.
  await page.goto('/payables/invoices');
  await expect(invoiceRows(page)).toHaveCount(3);
  await viewsButton(page).click();
  await expect(menu(page).getByRole('textbox', { name: 'Rename: Large overdue bills' })).toBeVisible();
  await menu(page).getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(/\/payables\/invoices\?view=overdue&min_amount=1000000/);
  await expect(invoiceRows(page)).toHaveCount(1);
  await viewsButton(page).click();
  await expect(menu(page).getByText('Showing now')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/invoices-views-menu-desktop-en.png` });

  // Make it the default: a bare arrival now lands on it, and `sv=none` gets round it.
  await menu(page).getByRole('button', { name: 'Make default' }).click();
  await expect(saved(page)).toBeVisible();
  await page.goto('/payables/invoices');
  await expect(page).toHaveURL(/view=overdue&min_amount=1000000/);
  await expect(invoiceRows(page)).toHaveCount(1);
  await page.goto('/payables/invoices?sv=none');
  await expect(page).toHaveURL(/sv=none/);
  await expect(invoiceRows(page)).toHaveCount(3);

  // Pin it to Home.
  await page.goto('/payables/invoices?view=overdue&min_amount=1000000');
  await viewsButton(page).click();
  await menu(page).getByRole('button', { name: 'Pin to Home' }).click();
  await expect(saved(page)).toBeVisible();
  await viewsButton(page).click();
  await expect(menu(page).getByRole('button', { name: 'Unpin' })).toBeVisible();
  await expect(menu(page).getByText('On Home')).toBeVisible();

  // Every change is on the audit trail, in order, by the person who made it.
  const check = owner();
  try {
    const { rows } = await check.query(
      `select e.action from audit_event e join saved_view v on v.id::text = e.object_id
        where e.object_type = 'saved_view' and v.name = 'Large overdue bills' order by e.id`,
    );
    expect(rows.map((row) => row.action)).toEqual(['saved_view.created', 'saved_view.default_set', 'saved_view.pinned']);
    const { rows: pinned } = await check.query(
      `select pinned_at is not null as pinned, is_default from saved_view where name = 'Large overdue bills'`,
    );
    expect(pinned[0]).toMatchObject({ pinned: true, is_default: true });
  } finally {
    await check.end();
  }
});

test('/profile/views lists it, renames it, and deletes it only after a question', async ({ page }) => {
  await signIn(page);
  await page.goto('/profile');
  await expect(page.getByRole('link', { name: '1 view' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('link', { name: '1 view' }).click();
  await expect(page).toHaveURL(/\/profile\/views/);

  const row = page.locator('table tbody tr').filter({ hasText: 'Large overdue bills' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Default');
  await expect(row).toContainText('On Home');
  await expect(row).toContainText('Minimum amount (IQD): 1000000');
  await page.screenshot({ path: `${SHOTS}/profile-views-desktop-en.png`, fullPage: true });

  await row.getByLabel(/^Rename:/).fill('Big late bills');
  await row.getByRole('button', { name: 'Rename' }).click();
  await expect(saved(page)).toBeVisible();
  await expect(page.locator('table tbody tr').filter({ hasText: 'Big late bills' })).toHaveCount(1);

  // A name that is already used is refused in words, and nothing changes.
  const pool = owner();
  try {
    const { rows: admin } = await pool.query(`select id from app_user where email = 'admin@example.com'`);
    await pool.query(
      `insert into saved_view (list_key, name, owner_user_id, kind, query) values ('payables.invoices','Spare',$1,'route','{"v":1,"params":{"q":"x"}}')
       on conflict do nothing`,
      [admin[0].id],
    );
  } finally {
    await pool.end();
  }
  await page.goto('/profile/views');
  const spare = page.locator('table tbody tr').filter({ hasText: 'Spare' });
  await spare.getByLabel(/^Rename:/).fill('Big late bills');
  await spare.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'That could not be saved.' })).toContainText(
    'You already have a view named “Big late bills”',
  );

  // Delete asks first, then removes — and only then says it did.
  await page.goto('/profile/views');
  const target = page.locator('table tbody tr').filter({ hasText: 'Spare' });
  await target.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this view?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('table tbody tr').filter({ hasText: 'Spare' })).toHaveCount(1);
  await target.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this view?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(saved(page)).toBeVisible();
  await expect(page.locator('table tbody tr').filter({ hasText: 'Spare' })).toHaveCount(0);
});

test('every registered screen offers the menu, and a screen without the grant offers nothing', async ({ page }) => {
  test.setTimeout(480_000);
  await signIn(page);
  const { VIEWABLE_ROUTES } = await import('../../src/server/domain/saved-view-routes');
  for (const route of VIEWABLE_ROUTES) {
    await page.goto(route.route);
    await expect(viewsButton(page), route.key).toBeVisible({ timeout: 90_000 });
    // The window opens and names the screen's views; it is drawn from this screen's own registry entry.
    await viewsButton(page).click();
    await expect(menu(page), route.key).toBeVisible();
    await menu(page).getByRole('button', { name: 'Close' }).click();
    await expect(menu(page), route.key).toBeHidden();
  }
  await page.screenshot({ path: `${SHOTS}/stock-ledger-views-desktop-en.png` });
});

test.describe('Arabic, 390px', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the views menu reads right to left and fits the phone', async ({ page, context }) => {
    await signIn(page);
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.goto('/payables/invoices?view=overdue&min_amount=1000000');
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');

    const button = page.getByRole('button', { name: /^العروض/ });
    await expect(button).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/invoices-list-mobile-ar.png`, fullPage: true });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'العروض المحفوظة' });
    await expect(dialog).toBeVisible();
    // The view saved in English is listed; the words around it are Arabic.
    await expect(dialog.getByRole('textbox', { name: /Big late bills/ })).toBeVisible();
    await expect(dialog.getByText('حفظ المرشّحات الظاهرة على الشاشة')).toBeVisible();
    await expect(dialog.getByText('معروض الآن')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/views-menu-mobile-ar.png` });

    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // Save one in Arabic: the notice and the row come back in Arabic.
    await dialog.getByLabel('اسم العرض').fill('فواتير متأخرة كبيرة');
    await dialog.getByRole('button', { name: 'حفظ العرض' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'تم الحفظ' })).toBeVisible();
    await page.goto('/profile/views');
    await expect(page.locator('table tbody tr').filter({ hasText: 'فواتير متأخرة كبيرة' })).toHaveCount(1);
    await page.screenshot({ path: `${SHOTS}/profile-views-mobile-ar.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});

test.afterAll(async () => {
  // Leave the administrator's own screens as they were: no default view redirecting the next spec.
  const pool = owner();
  try {
    await pool.query(
      `delete from saved_view where kind = 'route' and owner_user_id = (select id from app_user where email = 'admin@example.com')`,
    );
  } finally {
    await pool.end();
  }
});
