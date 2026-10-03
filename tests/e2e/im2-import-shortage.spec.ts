import { expect, test, type Page } from '@playwright/test';

/**
 * IMPROVEMENT-002 IM2-1 — a container that arrived short, on the screens.
 *
 * An import of ten, posted (the goods wait in transit), its B/L with two
 * containers of five. The first comes in whole; the second with three — the
 * form leaves Short empty and the receipt works it out (two). The import's
 * quantity board then says where every unit is; the claim takes the two still
 * in transit back to the supplier as a purchase return, which is approved and
 * posted on its own page, and the board reads nothing in transit. The same
 * page holds at mobile width in Arabic.
 *
 * The rules behind each step are tests/integration/im2-01-import.test.ts.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = 'manager@example.com';
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page, email = ADMIN.email) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function itemAccounts(page: Page, code = 'ITM-SEED') {
  await page.goto(`/master-data/items/${code}`);
  const form = page.locator('form:has(select[name="inventoryAccountId"])').first();
  await expect(form).toBeVisible({ timeout: 60_000 });
  let changed = false;
  for (const field of ['inventoryAccountId', 'cogsAccountId']) {
    const select = form.locator(`select[name="${field}"]`);
    if ((await select.inputValue()) !== '') continue;
    const first = await select.locator('option:not([value=""])').first().getAttribute('value');
    if (!first) continue;
    await select.selectOption(first);
    changed = true;
  }
  if (changed) {
    await form.locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
  }
}

test.describe('IM2-1 · a short container, worked out and claimed', () => {
  test.describe.configure({ mode: 'serial' });
  let payableNo = '';

  test('the board shows what did not arrive; the claim takes it out of transit', async ({ page, browser }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await itemAccounts(page);
    const digits = String(Date.now()).slice(-6);
    const first = `SHRU${digits}1`;
    const second = `SHRU${digits}2`;

    // The import of ten, born at its invoice and posted.
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('10');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'), { timeout: 120_000 });
    await page.getByRole('button', { name: 'Send for approval', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Approve and post', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);
    payableNo = decodeURIComponent(page.url().split('/payables/')[1]!.split('?')[0]!.split('#')[0]!);

    // Its B/L with two containers, the ten spread five and five.
    await page.getByRole('button', { name: 'New B/L' }).click();
    const create = page.getByRole('dialog');
    await create.getByRole('textbox', { name: 'B/L no.' }).fill(`BL-SHORT-${RUN}`);
    await create.getByLabel('B/L date').fill('2026-09-20');
    await create.getByRole('textbox', { name: 'Containers' }).fill(`${first}\n${second}`);
    await create.getByRole('button', { name: 'New B/L' }).click();
    await expect(page.getByText('0 of 2 received').first()).toBeVisible({ timeout: 30_000 });
    const quantities = page.getByRole('table', { name: 'Quantities by model' });
    await expect(quantities).toBeVisible();
    await expect(quantities.getByRole('row').nth(1)).toContainText('ITM-SEED');

    // The first whole; the second with three of its five — Short left empty.
    for (const [number, received] of [
      [first, null],
      [second, '3'],
    ] as const) {
      await page.goto(`/payables/containers/${encodeURIComponent(number)}`);
      await page.getByRole('button', { name: 'Receive container' }).click();
      const receive = page.getByRole('dialog');
      await receive.getByLabel('Warehouse').selectOption('WH-HQ');
      if (received) {
        await receive.getByLabel('Received 1').fill(received);
        await receive.getByRole('textbox', { name: 'What happened' }).fill('Two cartons missing, seal intact');
      }
      await receive.getByRole('button', { name: 'Receive container' }).click();
      await expect(page.getByText(/^CREC-/).first()).toBeVisible({ timeout: 60_000 });
    }

    // The board: ordered 10, received 8, short 2, still in transit 2.
    await page.goto(`/payables/${encodeURIComponent(payableNo)}`);
    const row = page.getByRole('table', { name: 'Quantities by model' }).getByRole('row').nth(1);
    await expect(row.getByRole('cell')).toHaveText(['ITM-SEED Seed Cable 2m', '10', '10', '8', '0', '2', '0', '2', '0'], { useInnerText: true });

    // The claim, from the import's page: the return opens on its own.
    await page.getByRole('button', { name: 'Claim the shortage' }).click();
    const claim = page.getByRole('dialog');
    await claim.getByRole('textbox', { name: 'What is claimed' }).fill(`Two cartons short in ${second}`);
    await claim.getByRole('button', { name: 'Claim the shortage' }).click();
    await page.waitForURL(/\/payables\/goods-returns\/[^?]+\?saved=1/, { timeout: 60_000 });
    const returnUrl = page.url().split('?')[0]!;

    // Approved and posted by the accounting manager.
    const manager = await browser.newContext();
    const other = await manager.newPage();
    await signIn(other, MANAGER);
    await other.goto(returnUrl);
    await other.getByRole('button', { name: 'Approve', exact: true }).click();
    await other.waitForURL(/saved=1/, { timeout: 60_000 });
    await other.goto(returnUrl);
    await other.getByRole('button', { name: 'Send back', exact: true }).click();
    await other.waitForURL(/saved=1/, { timeout: 60_000 });
    await manager.close();

    await page.goto(`/payables/${encodeURIComponent(payableNo)}`);
    const after = page.getByRole('table', { name: 'Quantities by model' }).getByRole('row').nth(1);
    await expect(after.getByRole('cell')).toHaveText(['ITM-SEED Seed Cable 2m', '10', '10', '8', '0', '2', '2', '0', '0'], { useInnerText: true });
    await expect(page.getByRole('button', { name: 'Claim the shortage' })).toHaveCount(0);
  });

  test('the board holds at mobile width, in Arabic, right to left', async ({ browser }) => {
    test.skip(!payableNo, 'the first test made the import');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', url: 'http://localhost:3000' }]);
    const page = await context.newPage();
    await signIn(page);
    await page.goto(`/payables/${encodeURIComponent(payableNo)}`);
    await expect(page.getByRole('table', { name: 'الكميات حسب الموديل' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await context.close();
  });
});
