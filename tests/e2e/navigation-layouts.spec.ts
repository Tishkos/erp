import { expect, test, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * Where the modules are (2026-10-06, by direction: "move the navbar to a side
 * panel, with icons … user side view / top view", then "navbar in bottom").
 *
 * Signed in as the CEO, not the administrator, and every navigation column put
 * back in `afterAll` (database, then nothing to undo through the screen): a run
 * that stops half way must never leave a person the other specs sign in as
 * with a side panel where they expect the top bar.
 */
const EMAIL = 'ceo@example.com';
const NAVIGATION_COLUMNS = ['ui_navigation', 'ui_sidebar', 'ui_sidebar_groups', 'ui_sidebar_colour', 'ui_text_size', 'ui_header', 'ui_motion', 'ui_table_stripes'];

async function withOwner<T>(work: (pool: Pool) => Promise<T>): Promise<T | undefined> {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function resetNavigation(): Promise<void> {
  await withOwner((pool) =>
    pool.query(
      `update app_user set ${NAVIGATION_COLUMNS.map((column) => `${column} = null`).join(', ')} where email = $1`,
      [EMAIL],
    ),
  );
}

/**
 * Everyone's default (0419) reaches a person with no settings of their own —
 * which is what the CEO is here — so the spec runs on the built-in default and
 * puts back whatever default the database had (the owner's, on a development
 * database) when it ends.
 */
let companyDefaultBefore: unknown = null;
async function setCompanyDefault(value: unknown): Promise<void> {
  await withOwner((pool) => pool.query('update company set ui_defaults = $1::jsonb', [value === null ? null : JSON.stringify(value)]));
}

test.beforeAll(async () => {
  companyDefaultBefore = (await withOwner(async (pool) => (await pool.query('select ui_defaults from company limit 1')).rows[0]?.ui_defaults)) ?? null;
  await setCompanyDefault(null);
  await resetNavigation();
});
test.afterAll(async () => {
  await resetNavigation();
  await setCompanyDefault(companyDefaultBefore);
});

async function signIn(page: Page, email = EMAIL) {
  // A development server's own badge sits in the corner the panel's Collapse
  // button is in; it is not part of the ERP (live-screenshot.ts hides it too).
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      document.head.append(style);
    });
  });
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Ledger-Trial-Balance-7');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('/');
}

/**
 * Opens Appearance, presses each choice, waits for the account to have them, closes.
 * A choice whose name two settings share ("Default": Text size, Side panel colour)
 * is given with its setting, `['Text size', 'Default']`.
 */
async function choose(page: Page, ...choices: (string | readonly [string, string])[]) {
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Appearance' });
  for (const choice of choices) {
    const [group, name] = typeof choice === 'string' ? [null, choice] : choice;
    const scope = group ? drawer.getByRole('group', { name: group, exact: true }) : drawer;
    await scope.getByRole('button', { name, exact: true }).click();
    await expect(scope.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(drawer.getByRole('status')).toHaveText('Appearance saved to your account.', { timeout: 60_000 });
  await drawer.getByRole('button', { name: 'Close' }).click();
}

test.use({ viewport: { width: 1440, height: 900 } });
// Each test walks many screens and saves the account several times; a development server compiles each on first use.
test.describe.configure({ timeout: 300_000 });

/**
 * The side panel's colours as drawn, each turned to sRGB through a canvas (so
 * oklab and color-mix values compare like any other) and measured against the
 * panel: its text, its icons, a group heading, the Collapse row, and the module
 * you are in against its own step. The top bar's background comes back too.
 */
async function sidePanelContrast(page: Page) {
  return page.evaluate(async () => {
    // The names fade their colour over 120 ms; read them once it has settled.
    await new Promise((resolve) => setTimeout(resolve, 170));
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgb = (color: string, under: readonly number[] = [255, 255, 255]): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[];
      const t = a! / 255;
      return [r! * t + under[0]! * (1 - t), g! * t + under[1]! * (1 - t), b! * t + under[2]! * (1 - t)];
    };
    const lum = (c: readonly number[]) => {
      const [r, g, b] = c.map((n) => {
        const v = n / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
    };
    const ratio = (a: readonly number[], b: readonly number[]) => {
      const [x, y] = [lum(a), lum(b)];
      return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
    };
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const panel = rgb(style('.erp-sidebar').backgroundColor);
    const idle = '.erp-sidebar__trigger:not([data-active="true"])';
    const current = rgb(style('.erp-sidebar__trigger[data-active="true"]').backgroundColor, panel);
    return {
      panel: panel.map(Math.round).join(','),
      header: style('.erp-header').backgroundColor,
      text: ratio(rgb(style(idle).color, panel), panel),
      icon: ratio(rgb(style(`${idle} .erp-sidebar__icon`).color, panel), panel),
      heading: ratio(rgb(style('.erp-sidebar__group-label').color, panel), panel),
      collapse: ratio(rgb(style('.erp-sidebar__collapse').color, panel), panel),
      currentText: ratio(rgb(style('.erp-sidebar__trigger[data-active="true"]').color, current), current),
      currentIcon: ratio(rgb(style('.erp-sidebar__trigger[data-active="true"] .erp-sidebar__icon').color, current), current),
      currentStep: ratio(current, panel),
    };
  });
}

test('the side panel takes the highlight or the accent, readable in a light and a dark palette, and follows a change of palette at once', async ({ page }) => {
  await signIn(page);
  const root = page.locator('.erp-root');
  await page.goto('/payables/invoices');
  await choose(page, 'Side panel');
  await expect(root).toHaveAttribute('data-side-colour', 'default');
  const headerBefore = (await sidePanelContrast(page)).header;

  for (const colour of ['Highlight', 'Accent'] as const) {
    await choose(page, ['Side panel colour', colour]);
    await expect(root).toHaveAttribute('data-side-colour', colour.toLowerCase());
    const seen = new Set<string>();
    // A light and a dark palette, every accent — switched on the page, never reloaded.
    for (const palette of ['sand', 'midnight']) {
      for (const accent of ['gold', 'red', 'blue', 'green', 'purple']) {
        await root.evaluate((el, values) => {
          (el as HTMLElement).dataset.palette = values.palette;
          (el as HTMLElement).dataset.accent = values.accent;
        }, { palette, accent });
        const measured = await sidePanelContrast(page);
        const where = `${colour} on ${palette}/${accent}`;
        expect(measured.text, `${where}: text`).toBeGreaterThanOrEqual(4.5);
        expect(measured.heading, `${where}: group heading`).toBeGreaterThanOrEqual(4.5);
        expect(measured.collapse, `${where}: Collapse`).toBeGreaterThanOrEqual(4.5);
        expect(measured.icon, `${where}: icons`).toBeGreaterThanOrEqual(3);
        expect(measured.currentText, `${where}: the module you are in`).toBeGreaterThanOrEqual(4.5);
        expect(measured.currentIcon, `${where}: its icon`).toBeGreaterThanOrEqual(3);
        expect(measured.currentStep, `${where}: the module you are in stands out`).toBeGreaterThan(1.1);
        seen.add(measured.panel);
      }
    }
    // Restyled by the change itself: the highlight follows the palette and the accent (ten pairs, ten
    // panels); the accent's deeper step is the accent's own, the same on a light and a dark palette (five).
    expect(seen.size, `${colour} follows the palette and the accent`).toBe(colour === 'Highlight' ? 10 : 5);
    await root.evaluate((el) => {
      (el as HTMLElement).dataset.palette = 'sand';
      (el as HTMLElement).dataset.accent = 'gold';
    });
  }

  // Kept across a reload (the account's own palette again); the top bar is never touched.
  await page.reload();
  await expect(root).toHaveAttribute('data-side-colour', 'accent');
  expect((await sidePanelContrast(page)).header).toBe(headerBefore);
  await choose(page, ['Side panel colour', 'Default'], 'Top bar');
  await expect(root).toHaveAttribute('data-side-colour', 'default');
  await expect(page.locator('.erp-sidebar')).toHaveCount(0);
});

test('the modules move to a side panel, a rail of icons and a bottom bar, and back', async ({ page }) => {
  await signIn(page);
  const root = page.locator('.erp-root');
  await expect(root).toHaveAttribute('data-navigation', 'top');
  await expect(page.locator('.erp-header .erp-nav')).toBeVisible();

  // The top bar: the page's own section tabs are there.
  await page.goto('/payables/invoices');
  await expect(page.getByRole('navigation', { name: 'Purchase Invoices', exact: true })).toBeVisible();

  // The side panel: the one "Primary navigation", the modules as links, Odoo's way.
  await choose(page, 'Side panel');
  await expect(root).toHaveAttribute('data-navigation', 'side');
  await expect(page.locator('.erp-header .erp-nav')).toHaveCount(0);
  const panel = page.locator('.erp-sidebar');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(1);
  await expect(panel.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Payables', exact: true })).toHaveAttribute('aria-current', 'true');

  // Grouped by default: related modules under a heading — Receivables, Payables and Transfers under Invoicing.
  await expect(root).toHaveAttribute('data-side-groups', 'grouped');
  const invoicing = panel.getByRole('list', { name: 'Invoicing' });
  await expect(invoicing.getByRole('link', { name: 'Payables', exact: true })).toBeVisible();
  await expect(invoicing.getByRole('link', { name: 'Receivables', exact: true })).toBeVisible();
  await expect(panel.locator('.erp-sidebar__group-label', { hasText: 'Invoicing' })).toBeVisible();

  // Plain list: no headings, the same modules; kept across a reload.
  await choose(page, 'Plain list');
  await expect(root).toHaveAttribute('data-side-groups', 'plain');
  await expect(panel.locator('.erp-sidebar__group-label')).toHaveCount(0);
  await page.reload();
  await expect(root).toHaveAttribute('data-side-groups', 'plain');
  await expect(panel.locator('.erp-sidebar__group-label')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Payables', exact: true })).toBeVisible();
  await choose(page, 'Grouped');
  await expect(panel.locator('.erp-sidebar__group-label', { hasText: 'Invoicing' })).toBeVisible();

  // A chosen option wears the side panel's own highlight.
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  const highlight = await page.evaluate(() => {
    const paint = (el: Element | null) => (el ? getComputedStyle(el).backgroundColor : null);
    return {
      panel: paint(document.querySelector('.erp-sidebar__trigger[data-active="true"]')),
      option: paint(document.querySelector('#erp-appearance-drawer .erp-preference__option[data-selected="true"]')),
      card: paint(document.querySelector('#erp-appearance-drawer .erp-appearance-card[aria-checked="true"]')),
    };
  });
  expect(highlight.option).toBe(highlight.panel);
  expect(highlight.card).toBe(highlight.panel);
  await page.getByRole('dialog', { name: 'Appearance' }).getByRole('button', { name: 'Close' }).click();

  // The open module's headings are the bar's menus; the page's tabs give way to them.
  const payablesMenu = page.getByRole('navigation', { name: 'Payables menu' });
  await expect(payablesMenu).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Purchase Invoices', exact: true })).toBeHidden();
  const purchasing = payablesMenu.getByRole('button', { name: 'Purchasing & Invoices' });
  await expect(purchasing).toHaveAttribute('aria-current', 'true');
  await purchasing.click();
  await expect(payablesMenu.getByRole('link', { name: 'Purchase Invoices', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(payablesMenu.getByRole('link', { name: 'Purchase Invoices', exact: true })).toHaveCount(0);
  await expect(purchasing).toBeFocused();

  // A module of the panel opens its first screen, and the bar becomes its menu.
  await panel.getByRole('link', { name: 'Accounting', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/payables'), { timeout: 120_000 });
  const accountingMenu = page.getByRole('navigation', { name: 'Accounting menu' });
  await expect(accountingMenu).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole('link', { name: 'Accounting', exact: true })).toHaveAttribute('aria-current', 'true');
  await accountingMenu.getByRole('button', { name: 'Treasury & Banking' }).click();
  await accountingMenu.getByRole('link', { name: 'Bank Loans', exact: true }).click();
  await page.waitForURL(/\/treasury\/loans$/, { timeout: 120_000 });
  await expect(accountingMenu.getByRole('button', { name: 'Treasury & Banking' })).toHaveAttribute('aria-current', 'true');

  // The Active branch and the language are in the account menu, not the bar.
  await expect(page.locator('.erp-header__utilities .erp-branch, .erp-header__utilities .erp-locale-toggle')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open user menu' }).click();
  const account = page.locator('#erp-user-panel');
  await expect(account.getByRole('group', { name: /^Active branch/ }).locator('[data-active-branch]')).toHaveText('HQ');
  await expect(account.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  await expect(account.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'العربية' })).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');

  // The rail: a module's name on hover; pressing it opens the module.
  await panel.getByRole('button', { name: 'Collapse side panel' }).click();
  await expect(root).toHaveAttribute('data-side-panel', 'icons');
  const payables = panel.getByRole('link', { name: 'Payables', exact: true });
  await payables.hover();
  await expect(page.locator('.erp-tip')).toHaveText('Payables');
  await payables.click();
  await page.waitForURL(/\/payables\//, { timeout: 120_000 });
  await expect(page.getByRole('navigation', { name: 'Payables menu' })).toBeVisible({ timeout: 60_000 });

  // It is the account's: a reload keeps it.
  await page.reload();
  await expect(root).toHaveAttribute('data-navigation', 'side');
  await expect(root).toHaveAttribute('data-side-panel', 'icons');
  await panel.getByRole('button', { name: 'Expand side panel' }).click();
  await expect(root).toHaveAttribute('data-side-panel', 'full');

  // The bottom bar: every module, a menu upwards, the current one marked; the bar keeps the module's menu.
  await choose(page, 'Bottom bar');
  const dock = page.locator('.erp-dock');
  await expect(dock).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Payables', exact: true })).toHaveAttribute('aria-current', 'page');
  await dock.getByRole('button', { name: 'Payables', exact: true }).click();
  await expect(page.locator('#erp-dock-menu-payables').getByRole('link', { name: 'Supplier Statements', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: 'Payables menu' })).toBeVisible();

  // The reading switches no style touches.
  await choose(page, 'Larger', 'Plain', 'Scrolls away', 'Reduced');
  await expect(root).toHaveAttribute('data-text-size', 'larger');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('16px');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.erp-header')!).position)).toBe('relative');
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.erp-root')!).getPropertyValue('--ui-row-stripe').trim())).toBe('transparent');

  // A style leaves them alone.
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radio', { name: /Enterprise/ }).click();
  await expect(root).toHaveAttribute('data-appearance', 'enterprise');
  await expect(root).toHaveAttribute('data-navigation', 'bottom');
  await expect(root).toHaveAttribute('data-text-size', 'larger');
  await page.getByRole('radio', { name: /Current \/ Default/ }).click();
  await expect(page.getByRole('dialog', { name: 'Appearance' }).getByRole('status')).toHaveText('Appearance saved to your account.', { timeout: 60_000 });
  await page.getByRole('dialog', { name: 'Appearance' }).getByRole('button', { name: 'Close' }).click();

  // Back to the top bar, exactly as it was.
  await choose(page, 'Top bar', ['Text size', 'Default'], 'Striped', 'Stays in view', 'On');
  await expect(root).toHaveAttribute('data-navigation', 'top');
  await expect(page.locator('.erp-header .erp-nav[data-fit]')).toBeVisible();
  await expect(page.locator('.erp-sidebar, .erp-dock, .erp-sections')).toHaveCount(0);
  await page.goto('/payables/invoices');
  await expect(page.getByRole('navigation', { name: 'Purchase Invoices', exact: true })).toBeVisible();
});

test("everyone's default reaches a person with no appearance of their own, is not written into their row, and a choice makes it theirs", async ({ page }) => {
  await resetNavigation();
  const everyone = {
    palette: 'pearl', accent: 'blue', appearance: 'enterprise', density: 'airy', cornerStyle: 'rounded',
    contentWidth: 'wide', borderStyle: 'strong', shadow: 'subtle', componentSize: 'small', navigation: 'side',
    sidebar: 'full', sidebarGroups: 'grouped', sidebarColour: 'highlight', textSize: 'smaller', header: 'sticky',
    motion: 'full', tableStripes: 'on',
  };
  await setCompanyDefault(everyone);
  const own = async () =>
    (await withOwner(async (pool) =>
      (await pool.query(`select ${NAVIGATION_COLUMNS.join(', ')} from app_user where email = $1`, [EMAIL])).rows[0],
    )) as Record<string, string | null>;
  try {
    await signIn(page);
    const root = page.locator('.erp-root');
    await expect(root).toHaveAttribute('data-navigation', 'side');
    await expect(root).toHaveAttribute('data-palette', 'pearl');
    await expect(root).toHaveAttribute('data-accent', 'blue');
    await expect(root).toHaveAttribute('data-appearance', 'enterprise');
    await expect(root).toHaveAttribute('data-text-size', 'smaller');
    await expect(root).toHaveAttribute('data-side-colour', 'highlight');
    await expect(page.locator('.erp-sidebar')).toBeVisible();
    // Following the default writes nothing of it into the person's row.
    await page.reload();
    await expect(root).toHaveAttribute('data-navigation', 'side');
    expect(Object.values(await own()).every((value) => value === null)).toBe(true);

    // One choice of their own: from then on the appearance is theirs, whatever the default does.
    await choose(page, 'Bottom bar');
    await setCompanyDefault(null);
    await page.reload();
    await expect(root).toHaveAttribute('data-navigation', 'bottom');
    await expect(root).toHaveAttribute('data-appearance', 'enterprise');
    await expect(root).toHaveAttribute('data-text-size', 'smaller');
  } finally {
    await setCompanyDefault(null);
    await resetNavigation();
  }
});

test("whoever configures the company makes their appearance everyone's default, after a confirm, and resets it", async ({ page }) => {
  await setCompanyDefault(null);
  try {
    await signIn(page, 'admin@example.com');
    await page.getByRole('button', { name: 'Open user menu' }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Appearance' });
    const section = drawer.getByRole('region', { name: "Everyone's default" });
    await section.getByRole('button', { name: "Make my appearance everyone's default" }).click();
    await expect(section.locator('[data-company-default-confirm="confirm_make"]')).toBeVisible();
    await section.getByRole('button', { name: "Yes, make it everyone's default" }).click();
    await expect(section.locator('[data-company-default-state="made"]')).toHaveText("Your appearance is now everyone's default.", { timeout: 60_000 });
    const stored = await withOwner(async (pool) => (await pool.query('select ui_defaults from company limit 1')).rows[0]?.ui_defaults);
    const navigation = await page.locator('.erp-root').getAttribute('data-navigation');
    expect(stored).toMatchObject({ navigation, palette: await page.locator('.erp-root').getAttribute('data-palette') });

    await section.getByRole('button', { name: "Reset everyone's default to the built-in" }).click();
    await section.getByRole('button', { name: 'Yes, reset it' }).click();
    await expect(section.locator('[data-company-default-state="reset"]')).toBeVisible({ timeout: 60_000 });
    expect(await withOwner(async (pool) => (await pool.query('select ui_defaults from company limit 1')).rows[0]?.ui_defaults)).toBeNull();
  } finally {
    await setCompanyDefault(null);
  }
});