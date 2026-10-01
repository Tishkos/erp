import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-AP-001 A22 — the Payables screens, driven in a browser.
 *
 * The workbench, the payable page and the stop/follow-up dialog, at desktop
 * width in English and at mobile width in real Arabic (the `erp-locale`
 * cookie, not a forced dir attribute — the labels must exist, §21). Codes
 * carry a per-run suffix because the database persists between runs and a
 * payable is never deleted (R3) — the test leaves what it made, as a real
 * accountant would.
 *
 * Requires `npm run db:seed` and the dev server.
 */

const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page) {
  // By field name, not label text — the same helper signs in under either locale.
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('A22 · the payables workbench and record', () => {
  test('opens a payable from the workbench and stops it with a reason', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);

    // ── The workbench ────────────────────────────────────────────────────
    await page.goto('/payables');
    await expect(page.getByRole('heading', { level: 1, name: 'Payables' })).toBeVisible();
    // The seed views are on the toolbar, whole.
    await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();

    // ── New payable (an advance: no PO, no department — the simplest type) ─
    await page.getByRole('button', { name: 'New payable' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Type').selectOption('advance');
    await dialog.getByLabel('Supplier', { exact: true }).selectOption({ index: 0 });
    await dialog.getByLabel('Supplier reference').fill(`E2E-${RUN}`);
    await dialog.getByLabel('Document date').fill('2026-09-20');
    await dialog.getByLabel('Currency').fill('USD');
    await dialog.getByLabel('Amount', { exact: true }).fill('5000');
    await dialog.getByLabel('Description').fill(`E2E advance ${RUN}`);
    await dialog.getByRole('button', { name: 'Create payable' }).click();

    // ── The payable page: rail, chips, story ────────────────────────────
    await page.waitForURL(/\/payables\/ADV-/);
    const payableNo = decodeURIComponent(page.url().split('/payables/')[1]!.split('?')[0]!);
    await expect(page.getByRole('heading', { level: 1, name: payableNo })).toBeVisible();
    await expect(page.getByText('1. Requested', { exact: false })).toBeVisible();
    await expect(page.getByText(`E2E-${RUN}`).first()).toBeVisible();

    // The story began.
    await page.getByRole('link', { name: 'Status log' }).click();
    // The opening event, named by its type and stamped with this run's reference.
    await expect(page.getByText(`opened — E2E-${RUN}`).first()).toBeVisible();

    // ── The stop/follow-up dialog (§21.12) ──────────────────────────────
    await page.getByRole('button', { name: 'Stop / follow-up' }).click();
    const stop = page.getByRole('dialog');
    await expect(stop).toBeVisible();
    await stop.getByLabel('Reason').selectOption({ label: 'BANK — Bank internal approval' });
    await stop.getByLabel('Owner').selectOption({ index: 0 });
    // By role: the visible labels carry the required-mark asterisk.
    await stop.getByRole('textbox', { name: 'Next action' }).fill('Call the trade desk');
    await stop.getByRole('textbox', { name: 'Expected by' }).fill('2026-10-15');
    await stop.getByRole('button', { name: 'Record the stop' }).click();

    // The red truth, everywhere: banner on the record…
    await expect(page.getByText('STOPPED: BANK', { exact: false }).first()).toBeVisible();
    // …and the chip on the workbench, sorted up top.
    await page.goto('/payables?stopped=yes');
    const row = page.getByRole('row', { name: new RegExp(payableNo) });
    await expect(row).toBeVisible();
    await expect(row.getByText('BANK', { exact: false })).toBeVisible();
  });

  test('holds the line at mobile width, in Arabic, right to left', async ({ page, context }) => {
    test.setTimeout(120_000);
    // Real Arabic — the locale cookie, so every label must actually exist.
    await context.addCookies([
      { name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' },
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    await page.goto('/payables');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'الذمم الدائنة' })).toBeVisible();

    // The page never scrolls sideways: wide tables scroll inside their wrap.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // A record page in Arabic at the same width, using the payable the
    // desktop test left behind (or any seeded one on a fresh run).
    const firstRow = page.locator('table tbody tr td a').first();
    if (await firstRow.isVisible().catch(() => false)) {
      await firstRow.click();
      await expect(page.getByText('سجل الحالة', { exact: false }).first()).toBeVisible();
      const recordOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(recordOverflow).toBeLessThanOrEqual(1);

      // The stop dialog opens and fits.
      const stopButton = page.getByRole('button', { name: 'إيقاف / متابعة' });
      if (await stopButton.isVisible().catch(() => false)) {
        await stopButton.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const box = await dialog.boundingBox();
        expect(box!.width).toBeLessThanOrEqual(390);
        await dialog.getByRole('button', { name: 'إغلاق' }).click();
      }
    }
  });
});
