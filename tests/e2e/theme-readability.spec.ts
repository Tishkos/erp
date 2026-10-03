import { expect, test, type Browser, type Page } from '@playwright/test';
import { containerNo } from '../support/container-number';
import writeXlsxFile from 'write-excel-file/node';

import { PALETTES as palettes, ACCENTS as accents } from '../../src/server/domain/appearance';

const darkPalettes = ['midnight', 'carbon', 'ocean', 'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate'];
const newCanvases: Record<string, string> = {
  obsidian_plum: '#1b1622', evergreen: '#101e19', espresso: '#211914', lunar_slate: '#222935',
  ivory_linen: '#f2ece0', glacier: '#eaf3f8', sage_white: '#edf3ec', porcelain_rose: '#f5eff1',
  dune_bronze: '#c8b99f', harbor_mist: '#a5b5be',
};

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('Ledger-Trial-Balance-7');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('/');
}

async function setAppearance(page: Page, palette: string, accent: string) {
  await page.locator('.erp-root').evaluate((root, values) => {
    (root as HTMLElement).dataset.palette = values.palette;
    (root as HTMLElement).dataset.accent = values.accent;
  }, { palette, accent });
}

/** Lifted out of `contrast` so a test can also ask "is this surface dark?". */
function luminance(color: string) {
  const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((n) => {
    const c = color.startsWith('color(srgb') ? n : n / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(a: string, b: string) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('checkbox has a white tick in light themes and a dark tick in dark themes', async ({ page }) => {
  await page.goto('/sign-in');
  const checkbox = page.locator('input[name="remember"]');
  for (const palette of palettes) {
    await setAppearance(page, palette, 'gold');
    await expect(checkbox).toBeChecked();
    const checked = await checkbox.evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      tick: getComputedStyle(el, '::before').backgroundColor,
      visibility: getComputedStyle(el, '::before').visibility,
    }));
    expect(checked.background).toBe('rgb(233, 170, 36)');
    expect(checked.tick).toBe(darkPalettes.includes(palette) ? 'rgb(23, 36, 31)' : 'rgb(255, 255, 255)');
    expect(checked.visibility).toBe('visible');
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).not.toBeChecked();
    expect(await checkbox.evaluate((el) => getComputedStyle(el, '::before').visibility)).toBe('hidden');
    await page.keyboard.press('Space');
  }
  await checkbox.evaluate((el: HTMLInputElement) => { el.indeterminate = true; });
  expect(await checkbox.evaluate((el) => getComputedStyle(el, '::before').clipPath)).toBe('inset(40% 12%)');
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await checkbox.evaluate((el) => getComputedStyle(el).appearance)).toBe('auto');
  expect(await checkbox.evaluate((el) => getComputedStyle(el, '::before').display)).toBe('none');
});

test('preview swatches do not recolor the workspace and dark text stays readable', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto('/profile');
  // One radio per palette and no more. The `+ 1` this used to carry was for a
  // "follow the company" choice the profile screen no longer offers, so the
  // count could never be met and the whole palette sweep below never ran —
  // the assertion that was meant to guard the screen was hiding it.
  await expect(page.locator('input[name="uiPalette"]')).toHaveCount(palettes.length);
  for (const palette of palettes) {
    for (const accent of accents) {
      await setAppearance(page, palette, accent);
      const colors = await page.locator('.erp-root').evaluate((root) => {
        const style = getComputedStyle(root);
        const value = (key: string) => style.getPropertyValue(key).trim();
        const heading = root.querySelector('h1')!;
        const panel = root.querySelector('section[class*="panel"]')!;
        const label = root.querySelector('[class*="paletteName"]')!;
        const probe = document.createElement('span');
        probe.style.color = 'var(--w-text)';
        probe.style.backgroundColor = 'var(--w-bg)';
        root.append(probe);
        const normal = { text: getComputedStyle(probe).color, bg: getComputedStyle(probe).backgroundColor };
        probe.style.backgroundColor = 'var(--w-selected)';
        const selected = getComputedStyle(probe).backgroundColor;
        probe.style.color = 'var(--w-accent-ink)';
        probe.style.backgroundColor = 'var(--w-amber-b)';
        const button = { text: getComputedStyle(probe).color, bg: getComputedStyle(probe).backgroundColor };
        probe.style.backgroundColor = 'var(--w-title-b)';
        const headingBg = getComputedStyle(probe).backgroundColor;
        probe.style.color = 'var(--w-muted)';
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return {
          normal, selected, button, headingBg, muted,
          heading: getComputedStyle(heading).color,
          label: getComputedStyle(label).color,
          panel: getComputedStyle(panel).backgroundColor,
          rootCanvas: value('--w-canvas'),
          documentCanvas: getComputedStyle(document.documentElement).getPropertyValue('--w-canvas').trim(),
          scheme: style.colorScheme,
        };
      });
      expect(colors.documentCanvas, `${palette}/${accent} preview isolation`).toBe(colors.rootCanvas);
      if (newCanvases[palette]) {
        expect(colors.rootCanvas).toBe(newCanvases[palette]);
        expect(contrast(colors.muted, colors.headingBg), `${palette}/${accent} subtitle`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(colors.muted, colors.normal.bg), `${palette}/${accent} secondary text`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors.normal.text, colors.normal.bg), `${palette}/${accent} body`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.label, colors.panel), `${palette}/${accent} labels`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.normal.text, colors.selected), `${palette}/${accent} selection`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.button.text, colors.button.bg), `${palette}/${accent} button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.heading, colors.headingBg), `${palette}/${accent} heading`).toBeGreaterThanOrEqual(4.5);
      const expectedAccents: Record<string, string> = {
        gold: 'rgb(233, 170, 36)', red: 'rgb(217, 106, 80)', blue: 'rgb(111, 159, 206)',
        green: 'rgb(109, 168, 104)', purple: 'rgb(151, 123, 201)',
      };
      if (expectedAccents[accent]) expect(colors.button.bg).toBe(expectedAccents[accent]);
      if (darkPalettes.includes(palette)) {
        expect(colors.scheme).toBe('dark');
        expect(colors.heading).not.toBe('rgb(29, 49, 41)');
      }
    }
  }
});

test('saved and error notices use readable surfaces in every palette', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  for (const query of ['saved=1', 'error=Theme%20verification']) {
    await page.goto(`/profile?${query}`);
    const notice = page.locator('p[class*="flash"]').first();
    await expect(notice).toBeVisible();
    for (const palette of palettes) {
      await setAppearance(page, palette, 'gold');
      const colors = await notice.evaluate((el) => ({
        text: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
        icon: getComputedStyle(el.querySelector('svg')!).color,
      }));
      expect(contrast(colors.text, colors.background), `${palette}/${query} text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.icon, colors.background), `${palette}/${query} icon`).toBeGreaterThanOrEqual(3);
      const darkSurface = contrast(colors.background, 'rgb(255, 255, 255)') > contrast(colors.background, 'rgb(0, 0, 0)');
      expect(darkSurface, `${palette}/${query} surface`).toBe(darkPalettes.includes(palette));
    }
  }
});

test('missing/error route-state styling follows light and dark palettes', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory/theme-check-not-found');
  const card = page.locator('[class*="stateCard"]');
  await expect(card).toBeVisible();
  for (const palette of palettes) {
    await setAppearance(page, palette, 'gold');
    const colors = await card.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        heading: getComputedStyle(el.querySelector('h1')!).color,
        text: getComputedStyle(el.querySelector('p')!).color,
        radius: parseFloat(s.borderRadius),
      };
    });
    expect(colors.radius).toBeLessThan(4);
    expect(contrast(colors.heading, colors.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
  }
});

test('Print / Export uses the active palette and readable download links', async ({ page }) => {
  await signIn(page);
  await page.goto('/inventory/fifo-valuation');
  const menu = page.locator('[data-export-menu="warehouses_report"]');
  await menu.locator('summary').click();
  for (const palette of palettes) {
    await setAppearance(page, palette, 'blue');
    const pdf = menu.locator('a[data-format="pdf"][data-lang="en"]');
    await expect(pdf).toBeVisible();
    const style = await pdf.evaluate((el) => {
      const s = getComputedStyle(el);
      return { text: s.color, bg: s.backgroundColor, radius: s.borderRadius };
    });
    expect(contrast(style.text, style.bg)).toBeGreaterThanOrEqual(4.5);
    expect(parseFloat(style.radius)).toBeLessThan(4);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const direction of ['ltr', 'rtl']) {
    await page.evaluate((dir) => { document.documentElement.dir = dir; }, direction);
    const box = await menu.locator('[role="group"]').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
});

/**
 * One row on each register the chip test reads, raised through the screens a
 * person uses — so the test never depends on what an earlier spec or run left
 * behind (a fresh database has no import, payment application, declaration,
 * B/L, container, loan or migration run). The journal register has the seed's
 * opening entry, and the chart its approved accounts.
 */
async function raiseOneOfEach(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const run = Date.now().toString(36).toUpperCase().slice(-5);
  const digits = String(Date.now()).slice(-6);
  try {
    await signIn(page);

    // An import, born at its purchase invoice (the Import box starts ticked).
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('input[name="item_code_0"]').fill('ITM-SEED');
    await page.locator('input[name="quantity_0"]').fill('1');
    await page.locator('input[name="unit_price_0"]').fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);
    const importUrl = page.url().split('?')[0]!;

    // A payment application for part of it.
    await page.getByRole('button', { name: 'New payment application' }).click();
    const pay = page.getByRole('dialog');
    await pay.getByRole('textbox', { name: 'Amount' }).fill('500');
    await pay.getByLabel('Method').selectOption({ label: 'Cheque' });
    await pay.getByLabel('Paid from').selectOption({ index: 0 });
    await pay.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/payables\/payment-applications\/PAYAPP-/, { timeout: 60_000 });

    // A declaration registered on it.
    await page.goto(importUrl);
    await page.getByRole('button', { name: 'Register PD' }).click();
    const pd = page.getByRole('dialog');
    await pd.getByRole('textbox', { name: 'PD no.' }).fill(`6${run}`);
    await pd.getByLabel('Registered').fill('2026-09-02');
    await pd.getByLabel('Expires').fill('2027-03-01');
    await pd.getByRole('button', { name: 'Register PD' }).click();
    await expect(page.getByRole('link', { name: `6${run}` })).toBeVisible({ timeout: 30_000 });

    // A B/L with one container.
    await page.goto(importUrl);
    await page.getByRole('button', { name: 'New B/L' }).click();
    const bl = page.getByRole('dialog');
    await bl.getByRole('textbox', { name: 'B/L no.' }).fill(`BL-THEME-${run}`);
    await bl.getByLabel('B/L date').fill('2026-09-20');
    await bl.getByLabel('ETA').fill('2026-10-20');
    await bl.getByLabel('Container no. 1').fill(containerNo('TEMU', `${digits}5`));
    await bl.getByRole('button', { name: 'New B/L' }).click();
    await expect(page.getByRole('link', { name: `BL-THEME-${run}` })).toBeVisible({ timeout: 30_000 });

    // A loan, entered.
    await page.goto('/treasury/loans');
    await page.getByRole('button', { name: 'New loan' }).click();
    const loan = page.getByRole('dialog');
    await loan.getByLabel('Proceeds land in').selectOption({ index: 0 });
    await loan.getByRole('textbox', { name: 'Principal' }).fill('100000');
    await loan.getByRole('button', { name: 'Create loan' }).click();
    await page.waitForURL(/\/payables\/loans\/LOAN-/, { timeout: 60_000 });

    // A migration dry run: the run register's row.
    // The sheet's shape, as payables.spec.ts Stage 8 writes it: 46266 is
    // 2026-09-01 as a spreadsheet serial.
    const rows = (data: unknown[][]) => data.map((row) => row.map((value) => (value === null ? null : { value })));
    const buffer = (await writeXlsxFile([
      {
        sheet: 'dashboard',
        data: rows([
          ['PO no./ INV.', 'INV. Date', 'Supplier', 'INV. Amount', 'INV. Qty', 'Pmt Terms', 'Products', 'PD. No.', 'Registration Date', 'Expire Date', 'PD. Status', 'Paid Amount (SWIFT)', 'Pmt Remaining', 'Applied Amount', 'BL No.', 'Inbounded Qty', 'Clear?'],
          [`THEME-${run}`, 46266, 'Al-Rafidain Trading Co.', 1000, 10, 'CFR', 'panel', null, null, null, null, 0, 1000, 0, null, null, null],
        ]),
      },
      {
        sheet: 'PMT',
        data: rows([['PO/INV. no.', 'Supplier', 'INV. Date', 'Bank', 'Application AMT.', 'Application date', 'Swift date', 'Payment Status']]),
      },
      {
        sheet: 'PD',
        data: rows([['PO no./ INV.', 'INV. Date', 'Supplier', 'PD No.', 'Registration Date', 'Expire Date', 'Status', 'Bank Code', 'SWIFT', 'Notes']]),
      },
    ] as never).toBuffer()) as Buffer;
    await page.goto('/administration/payables-migration');
    await page.locator('input[name="file"]').setInputFiles({
      name: `THEME-${run}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#migration-latest-title')).toContainText('Dry run', { timeout: 60_000 });
  } finally {
    await context.close();
  }
}

test('status chips follow the palette into the dark, on every screen that draws one', async ({ browser, page }) => {
  test.setTimeout(300_000);
  await raiseOneOfEach(browser);
  await signIn(page);

  // A status is drawn in three different rules — the document window's
  // `.sapStatus`, the register's `.sapRegisterStatus`, and the global
  // `.status` on a SAP page. They were three copies of the same twelve hexes,
  // so fixing the dark palette in one fixed exactly one, and twice it was not
  // noticed (2026-09-29: "approved posted draft status in dark mode they
  // shouldn't be white"). One screen per rule, so a fourth copy cannot hide.
  const screens = [
    '/payables/invoices',
    '/finance/journals',
    '/master-data/chart-of-accounts',
    // REQ-AP-001's registers draw the same chips (Stages 3–8).
    '/payables/payment-applications',
    '/payables/pd?view=all',
    '/payables/shipments',
    '/payables/containers?view=all',
    '/treasury/loans?view=all',
    // …and Stage 8's run register.
    '/administration/payables-migration',
  ];

  for (const route of screens) {
    await page.goto(route);
    await setAppearance(page, 'midnight', 'gold');

    const chips = await page.locator('[class*="tatus"]').evaluateAll((els) =>
      els
        .filter((el) => {
          const text = el.textContent?.trim() ?? '';
          return text.length > 0 && text.length <= 24;
        })
        .map((el) => {
          const style = getComputedStyle(el);
          return { text: el.textContent!.trim(), background: style.backgroundColor, color: style.color };
        }),
    );

    expect(chips.length, `${route} draws at least one status`).toBeGreaterThan(0);

    for (const chip of chips) {
      // On a dark ground the chip's own surface must be dark. A pale pastel
      // here is the light-mode treatment showing through, which is what the
      // sponsor saw as "white".
      const background = luminance(chip.background);
      expect(background, `${route} · ${chip.text} background is dark`).toBeLessThan(0.35);
      // And it still has to be readable, which a dark chip with dark ink is not.
      expect(
        contrast(chip.color, chip.background),
        `${route} · ${chip.text} is readable`,
      ).toBeGreaterThan(4.5);
    }
  }
});
