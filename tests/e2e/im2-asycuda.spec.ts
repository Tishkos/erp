import { expect, test, type Page } from '@playwright/test';

/**
 * IMPROVEMENT-002 — the ASYCUDA reading as a document, on the screens.
 *
 * The officer reads the export as a file from "Read the ASYCUDA list"; the
 * reading opens on its own page with its number, its lines as ASYCUDA gave
 * them, and the file kept behind the paperclip; the clock and the printer sit
 * beside it. The register lists the reading with the file counted. Both hold
 * at mobile width in Arabic.
 *
 * The rules behind each step are tests/integration/im2-03-asycuda.test.ts.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('IM2 · the ASYCUDA reading, its file and its doors', () => {
  test.describe.configure({ mode: 'serial' });
  let runNo = '';
  const fileName = `asycuda-${RUN}.csv`;

  test('a file read becomes a numbered reading with the file kept on it', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await page.goto('/payables/pd/asycuda');
    await expect(page.getByRole('heading', { level: 1, name: 'Update from ASYCUDA list' })).toBeVisible();
    await page.getByRole('button', { name: 'Read the ASYCUDA list' }).click();
    const read = page.getByRole('dialog');
    await read.getByLabel('The ASYCUDA report').setInputFiles({
      name: fileName,
      mimeType: 'text/csv',
      buffer: Buffer.from(`PD No,Status,Date\n8${RUN},Validated,08/09/2026\n`),
    });
    await read.getByRole('button', { name: 'Show the difference' }).click();
    await page.waitForURL(/\/payables\/pd\/asycuda\/ASY-\d{4}-\d+/);
    runNo = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
    await expect(page.getByRole('heading', { level: 1, name: `ASYCUDA reading ${runNo}` })).toBeVisible();

    const lines = page.locator('#asycuda-document table').first();
    await expect(lines.getByRole('row', { name: new RegExp(`8${RUN}`) })).toContainText('No such PD');
    await expect(lines.getByText('Not read', { exact: true })).toBeVisible();

    // The three doors: the export it was read from, the history, the copy.
    await page.getByRole('button', { name: 'Attachments' }).click();
    await expect(page.getByRole('dialog').getByText(fileName)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByRole('button', { name: 'Audit log' })).toBeVisible();
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="asycuda_reading"] a[data-format="pdf"]').first()).toBeVisible();

    await page.goto(`/payables/pd/asycuda?q=${encodeURIComponent(runNo)}`);
    const row = page.getByRole('row', { name: new RegExp(runNo) });
    await expect(row).toContainText(fileName);
    await expect(row).toContainText('1 file kept');
    await expect(row).toContainText('Not applied');
  });

  test('the register and the reading hold at mobile width, in Arabic', async ({ browser }) => {
    test.skip(!runNo, 'the first test made the reading');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', url: 'http://localhost:3000' }]);
    const page = await context.newPage();
    await signIn(page);
    for (const path of ['/payables/pd/asycuda', `/payables/pd/asycuda/${encodeURIComponent(runNo)}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    await context.close();
  });
});
