import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Moving between modules with the side panel never takes the application down
 * (2026-10-12, by report: "sometimes from settings to accounting we get
 * issues" — the whole screen replaced by "This screen could not be shown").
 *
 * With the modules in the side panel (or the bottom bar) the top bar carries
 * the open module's headings, and what does not fit goes behind "More". That
 * bar is part of the layout, so it is one instance from module to module — and
 * it used the "behind More" measurement of the module just left for the first
 * drawing of the next. From Settings (some twenty screens, most behind "More")
 * to Accounting (six headings) the measurement named entries that did not
 * exist; the bar threw, and with it the shell. It happened on every such move,
 * for everybody on the side panel — which the company's default made everyone.
 *
 * So: the side panel, a width at which Settings tucks screens behind "More",
 * and a walk through the modules that goes from many entries to few again and
 * again. After every step the shell is standing and no state card is drawn.
 *
 * Signed in as the administrator (the one account that sees both Settings and
 * every module); the navigation choice is put back to the top bar when the
 * test ends, and again in the database afterwards, so a run that stops half
 * way does not leave the other specs a side panel.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

async function resetNavigation(): Promise<void> {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) return;
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(`update app_user set ui_navigation = null where email = $1`, [ADMIN.email]);
  } finally {
    await pool.end();
  }
}
test.afterAll(resetNavigation);

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

/** Opens Appearance, presses one navigation choice, waits for the account to have it, closes. */
async function chooseNavigation(page: Page, name: 'Top bar' | 'Side panel' | 'Bottom bar') {
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Appearance' });
  await drawer.getByRole('button', { name, exact: true }).click();
  await expect(drawer.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(drawer.getByRole('status')).toHaveText('Appearance saved to your account.', { timeout: 60_000 });
  await drawer.getByRole('button', { name: 'Close' }).click();
}

test.use({ viewport: { width: 1366, height: 850 } });

test('the side panel: from a module of many screens to one of few, the shell stands', async ({ page }) => {
  test.setTimeout(1_200_000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(`page error: ${String(error).slice(0, 200)}`));
  await signIn(page);
  await chooseNavigation(page, 'Side panel');

  try {
    await expect(page.locator('.erp-root')).toHaveAttribute('data-navigation', 'side');
    const panel = page.locator('#erp-sidebar');
    const modules = await panel.locator('a.erp-sidebar__trigger').evaluateAll((links) => links.map((link) => link.getAttribute('data-module') ?? ''));
    expect(modules).toContain('settings');
    expect(modules).toContain('accounting');

    /** Goes to a module by its own link in the side panel — a client-side navigation, as a person makes it. */
    const go = async (module: string) => {
      const link = panel.locator(`a.erp-sidebar__trigger[data-module="${module}"]`);
      const href = await link.getAttribute('href');
      await link.click();
      await page.waitForURL((url) => url.pathname === href, { timeout: 240_000 });
      // The bar has measured this module's own entries.
      await expect(page.locator('nav.erp-sections')).toHaveAttribute('data-measured', '', { timeout: 120_000 });
      await expect(page.locator('.erp-header'), `the shell stands after going to ${module}`).toBeVisible();
      await expect(page.locator('.stateCard'), `no error card after going to ${module}`).toHaveCount(0);
      return page.locator('nav.erp-sections [data-measure-entry]').count();
    };

    // The precondition the defect needs: Settings holds more entries than the bar can show.
    const inSettings = await go('settings');
    const more = page.locator('nav.erp-sections .erp-sections__item--more');
    await expect(more, 'Settings tucks screens behind "More" at this width').toHaveCount(1);
    const tucked = Number(await more.locator('.erp-sections__count').textContent());
    const inAccounting = await go('accounting');
    // What used to break: an entry behind "More" in Settings whose place does not exist in Accounting.
    expect(inSettings - 1, 'Settings has an entry beyond the last one of Accounting').toBeGreaterThanOrEqual(inAccounting);
    expect(tucked).toBeGreaterThan(0);

    // Many to few, again and again, through every module the panel lists.
    for (const module of modules.filter((key) => key !== 'settings' && key !== 'accounting')) {
      await go('settings');
      await go(module);
    }
    await go('settings');
    await go('accounting');
    // "More" still opens, and lists this module's own headings.
    const moreNow = page.locator('nav.erp-sections .erp-sections__item--more button');
    if (await moreNow.count()) {
      await moreNow.click();
      await expect(page.locator('#erp-sections-more')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(failures, failures.join('\n')).toEqual([]);
  } finally {
    await page.goto('/');
    await chooseNavigation(page, 'Top bar').catch(() => undefined);
  }
});
