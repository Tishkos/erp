import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 01.12 test gate — right-to-left.
 *
 * *"Flipping the layout to RTL produces a usable screen with no code change."*
 *
 * §25: *"the localisation architecture shall allow Arabic labels and
 * right-to-left layout later without redesign."*
 *
 * The flip here is one attribute on <html>, set from the outside. Nothing else
 * changes — no stylesheet is swapped, no component takes a direction prop. If a
 * rule anywhere used `margin-left` instead of `margin-inline-start`, these
 * assertions would fail, which is the point: the cost of RTL is paid once, now,
 * rather than as a rewrite in Phase 20.
 *
 * §1.1 keeps English as the launch language. This proves the mechanism, not a
 * shipped Arabic locale.
 */

const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(OFFICER.email);
  await page.getByLabel('Password', { exact: true }).fill(OFFICER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/** The chart's rows — its register table is labelled by the window title. */
const CHART_ROWS = 'table[aria-labelledby="chart-title"] tbody tr';

/** Flips direction the way a locale would, without touching the application. */
async function flipToRtl(page: Page) {
  await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
}

test.describe('§25 · the layout mirrors without a code change', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/master-data/chart-of-accounts');
    // The chart is drawn by a client component; measuring before it has put a
    // row on screen measures nothing. It is the standard register table now,
    // named by its window title, as shell.spec.ts reads it.
    await expect(page.locator(CHART_ROWS).first()).toBeVisible();
  });

  test('mirrors the brand and user utilities in the application header', async ({ page }) => {
    const brand = page.locator('.erp-brand');
    const utilities = page.locator('.erp-header__utilities');

    const brandBefore = await brand.boundingBox();
    const utilitiesBefore = await utilities.boundingBox();
    expect(brandBefore!.x).toBeLessThan(utilitiesBefore!.x);

    await flipToRtl(page);

    const brandAfter = await brand.boundingBox();
    const utilitiesAfter = await utilities.boundingBox();
    expect(brandAfter!.x).toBeGreaterThan(utilitiesAfter!.x);
  });

  test('aligns table cells logically, so they follow the direction', async ({ page }) => {
    // The first cell is the tree column: its content is a full-width flex row
    // (toggle, icon, code), so it fills the cell in either direction and cannot
    // show the shift. The name cell is a plain text run, which can.
    const cell = page.locator(CHART_ROWS).first().locator('td').nth(1);

    // The computed value is the logical keyword itself. A cell written as
    // `text-align: left` would report "left" here and would stay left-aligned
    // in an Arabic layout — which is the defect this asserts against.
    expect(await cell.evaluate((el) => getComputedStyle(el).textAlign)).toBe('start');

    // And it actually moves: under rtl the text sits at the far end of the cell.
    const before = await cell.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().left - el.getBoundingClientRect().left;
    });

    await flipToRtl(page);

    const after = await cell.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().left - el.getBoundingClientRect().left;
    });

    expect(after).toBeGreaterThan(before);
  });

  test('does not make the page scroll sideways', async ({ page }) => {
    await flipToRtl(page);

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );

    // A mirrored layout that overflows is the usual sign of a physical margin
    // surviving the flip.
    expect(overflows).toBe(false);
  });

  test('keeps every top-level module on screen', async ({ page }) => {
    await flipToRtl(page);

    const viewport = page.viewportSize()!.width;
    const modules = page.getByRole('navigation').locator('.erp-nav__trigger');
    const count = await modules.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const box = await modules.nth(i).boundingBox();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport + 1);
    }
  });

  test('keeps the record page usable, including the draft band', async ({ page }) => {
    await page.locator(`${CHART_ROWS} td:first-child a`).first().click();
    await page.waitForURL(/chart-of-accounts\/[^/]+$/);

    await flipToRtl(page);

    // The band is the Appendix A rule 4 marking; it must still be legible and
    // on screen after the flip.
    const band = page.locator('.draft-band');
    if (await band.count()) {
      const box = await band.boundingBox();
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.x).toBeGreaterThanOrEqual(-1);
    }

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});
