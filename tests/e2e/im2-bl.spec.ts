import { expect, test, type Page } from '@playwright/test';
import { containerNo } from '../support/container-number';

/**
 * IMPROVEMENT-002 — the B/L, written properly, on the screens.
 *
 * An import of ten, posted. Its New B/L takes the containers as a table: a
 * wrong check digit is pointed out as it is typed (and refused by the
 * server); two containers, each its own size/type and seal, carrying six and
 * four. The B/L page carries the paperclip, the clock and the printer in its
 * title bar; its boxes are corrected (the ETA moves its containers); one
 * container is cancelled with its reason and the register lists it among the
 * cancelled. The same page holds at mobile width in Arabic.
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

test.describe('IM2 · the B/L table, its doors, correction and cancel', () => {
  test.describe.configure({ mode: 'serial' });
  const blNo = `BL-ROWS-${RUN}`;
  const digits = String(Date.now()).slice(-5);
  const first = containerNo('ROWU', `${digits}1`);
  const second = containerNo('ROWU', `${digits}2`);

  test('containers are rows with their own size, seal and quantity; the B/L page has its three doors', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('10');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'), { timeout: 120_000 });
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);

    await page.getByRole('button', { name: 'New B/L' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'B/L no.' }).fill(blNo);
    await dialog.getByLabel('B/L date').fill('2026-09-20');
    await dialog.getByLabel('ETA').fill('2026-10-20');
    // A wrong last digit is pointed out as it is typed.
    const wrong = `${first.slice(0, 10)}${(Number(first[10]) + 1) % 10}`;
    await dialog.getByLabel('Container no. 1').fill(wrong);
    await expect(dialog.getByText(`Check digit should be ${first[10]}`)).toBeVisible();
    await dialog.getByLabel('Container no. 1').fill(first);
    await expect(dialog.getByText(/Check digit should be/)).toHaveCount(0);
    await dialog.getByLabel('Size / type 1').selectOption('40HC');
    await dialog.getByLabel('Seal no. 1').fill(`SL-${RUN}-1`);
    await dialog.getByLabel('ITM-SEED 1').fill('6');
    await dialog.getByLabel('Container no. 2').fill(second);
    await dialog.getByLabel('Size / type 2').selectOption('20GP');
    await dialog.getByLabel('ITM-SEED 2').fill('4');
    await dialog.getByRole('button', { name: 'New B/L' }).click();
    await expect(page.getByRole('link', { name: blNo })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('link', { name: blNo }).click();
    await page.waitForURL(/\/payables\/shipments\//);
    const lines = page.locator('#bl-document table').first();
    await expect(lines.getByRole('row', { name: new RegExp(first) })).toContainText('40HC');
    await expect(lines.getByRole('row', { name: new RegExp(first) })).toContainText(`SL-${RUN}-1`);
    await expect(lines.getByRole('row', { name: new RegExp(second) })).toContainText('20GP');
    // The three doors: paperwork, history, copies.
    await expect(page.getByRole('button', { name: 'Attachments' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Audit log' })).toBeVisible();
    await page.getByRole('button', { name: 'Print / Export' }).click();
    await expect(page.locator('[data-export-menu="bill_of_lading"] a[data-format="pdf"]').first()).toBeVisible();
  });

  test('the B/L’s boxes are corrected and a container cancelled with its reason', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    await page.goto(`/payables/shipments/${encodeURIComponent(blNo)}`);
    await page.getByRole('button', { name: 'Edit B/L' }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('ETA').fill('2026-10-27');
    await edit.getByRole('textbox', { name: 'Vessel' }).fill('MSC Aurora');
    await edit.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.locator('#bl-document')).toContainText('MSC Aurora');

    await page.goto(`/payables/containers/${encodeURIComponent(second)}`);
    await page.getByRole('textbox', { name: 'Why the container is cancelled' }).fill('Not loaded on this vessel');
    await page.getByRole('button', { name: 'Cancel container' }).click();
    await page.waitForURL(/saved=1/);
    await page.goto('/payables/containers?view=cancelled');
    await expect(page.getByRole('link', { name: second })).toBeVisible();
  });

  test('the B/L page holds at mobile width, in Arabic', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', url: 'http://localhost:3000' }]);
    const page = await context.newPage();
    await signIn(page);
    await page.goto(`/payables/shipments/${encodeURIComponent(blNo)}`);
    await expect(page.locator('#bl-document')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});
