import { expect, test, type Page } from '@playwright/test';

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

function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((n) => {
      const c = color.startsWith('color(srgb') ? n : n / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
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
  await expect(page.locator('input[name="uiPalette"]')).toHaveCount(palettes.length + 1);
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
