import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-AP-001 A22 — the Payables screens, driven in a browser, after D12/D13.
 *
 *   D13  An import is born at the purchase invoice: the accountant enters the
 *        supplier's PDF on the ordinary New invoice form and ticks Import. The
 *        invoice page then offers "Import tracking", which opens the
 *        application (stage rail, status log, stop dialog).
 *   D12  An expense is a purchase invoice: "Add expense" on the Purchase
 *        Invoices list, a note on the invoice, Unpaid / Paid / Overdue on the
 *        register.
 *   §15  Stage 3: the instalment plan and a payment application from the
 *        import's Payments section; the maker cannot approve; the accounting
 *        manager approves and sends under a logged override; the register
 *        shows it waiting for the bank.
 *
 * At desktop width in English and at mobile width in real Arabic (the
 * `erp-locale` cookie — every label must exist). Codes carry a per-run suffix
 * because the database persists between runs and nothing is deleted (R3).
 *
 * Requires `npm run db:seed` and the dev server.
 */

const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Date.now().toString(36).toUpperCase().slice(-5);

async function signIn(page: Page, email = ADMIN.email) {
  // By field name, not label text — the same helper signs in under either locale.
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('A22 · payables in a browser', () => {
  test('D13 · an import is entered as a purchase invoice and tracked behind it', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);

    // ── The ordinary New invoice form, with the Import tick ─────────────
    await page.goto('/payables/invoices/new');
    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    // The item code is the grid's searchable field (an input over a datalist).
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('20');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.locator('input[name="payment_terms_text"]').fill(`30% deposit, 70% against B/L ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();

    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );

    // ── The invoice names its import application ─────────────────────────
    const tracking = page.getByRole('link', { name: 'Import tracking' });
    await expect(tracking).toBeVisible({ timeout: 60_000 });
    await tracking.click();

    await page.waitForURL(/\/payables\/IMP-/);
    const payableNo = decodeURIComponent(page.url().split('/payables/')[1]!.split('?')[0]!);
    await expect(page.getByRole('heading', { level: 1, name: payableNo })).toBeVisible();
    // The story began with the invoice.
    await expect(page.getByText(`30% deposit, 70% against B/L ${RUN}`).first()).toBeVisible();

    // ── The stop/follow-up dialog (§21.12) — imports only ────────────────
    await page.getByRole('button', { name: 'Stop / follow-up' }).click();
    const stop = page.getByRole('dialog');
    await expect(stop).toBeVisible();
    await stop.getByLabel('Reason').selectOption({ label: 'BANK — Bank internal approval' });
    await stop.getByLabel('Owner').selectOption({ index: 0 });
    await stop.getByRole('textbox', { name: 'Next action' }).fill('Call the trade desk');
    await stop.getByRole('textbox', { name: 'Expected by' }).fill('2026-10-15');
    await stop.getByRole('button', { name: 'Record the stop' }).click();
    await expect(page.getByText('STOPPED: BANK', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    // …and the import applications list shows it, stopped.
    await page.goto('/payables?stopped=yes');
    await expect(page.getByRole('heading', { level: 1, name: 'Import applications' })).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(payableNo) });
    await expect(row).toBeVisible();
  });

  test('D12 · Add expense, a note, and the Payment column', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);

    await page.goto('/payables/invoices');
    await expect(page.getByRole('heading', { level: 1, name: 'Purchase Invoices' })).toBeVisible();
    // The module's own tabs, as on every other screen.
    await expect(page.getByRole('link', { name: 'Supplier Statements' }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Add expense' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Type of fee').selectOption('rent');
    await dialog.getByLabel('Who we pay').selectOption({ index: 0 });
    await dialog.getByLabel('Amount (IQD)').fill('1500000');
    await dialog.getByLabel('Bill date').fill('2026-09-01');
    await dialog.getByLabel('Due date').fill('2026-09-05');
    await dialog.getByRole('textbox', { name: 'Name' }).fill(`Erbil office rent ${RUN}`);
    await dialog.getByRole('button', { name: 'Save expense' }).click();

    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );
    const invoiceNo = decodeURIComponent(page.url().split('/payables/invoices/')[1]!.split('?')[0]!);

    // A note, dated and signed, under the invoice.
    await page.getByRole('textbox', { name: 'Add note' }).fill(`Landlord travelling ${RUN}`);
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText(`Landlord travelling ${RUN}`).first()).toBeVisible({ timeout: 30_000 });

    // The register: Expenses view, the row, its Payment state.
    await page.goto('/payables/invoices?view=expenses');
    const row = page.getByRole('row', { name: new RegExp(invoiceNo) });
    await expect(row).toBeVisible();
    // Not posted yet, and due in the past: Overdue, with the note under it.
    await expect(row.getByText('Overdue', { exact: false })).toBeVisible();
    await expect(row.getByText(`Landlord travelling ${RUN}`)).toBeVisible();
  });

  test('Stage 3 · plan the terms, apply, approve (a second person), send under override', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    await signIn(page);

    // An import, born at its invoice (D13).
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('10');
    await page.getByLabel('Unit Price').first().fill('5000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.locator('input[name="payment_terms_text"]').fill(`30% deposit, 70% against B/L ${RUN}-P`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);

    // §15.2 — the plan: 30% on order, 70% against the B/L copy.
    await expect(page.getByRole('heading', { name: /Payments/ })).toBeVisible();
    await page.getByRole('button', { name: 'Plan instalments' }).click();
    const plan = page.getByRole('dialog');
    await plan.getByRole('textbox', { name: '% or amount 1' }).fill('30');
    await plan.getByRole('textbox', { name: '% or amount 2' }).fill('70');
    await plan.getByRole('combobox', { name: 'Due when 2' }).selectOption('against_bl_copy');
    await plan.getByRole('button', { name: 'Save the plan' }).click();
    await expect(page.getByRole('cell', { name: 'Deposit', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Planned').first()).toBeVisible();

    // §15.3 — the application for the deposit, by cheque from the seeded account.
    await page.getByRole('button', { name: 'New payment application' }).click();
    const create = page.getByRole('dialog');
    await create.getByLabel('Instalment').selectOption({ index: 1 });
    await create.getByLabel('Method').selectOption({ label: 'Cheque' });
    await create.getByLabel('Paid from').selectOption({ index: 0 });
    await create.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/payables\/payment-applications\/PAYAPP-/, { timeout: 60_000 });
    const applicationNo = decodeURIComponent(page.url().split('/payment-applications/')[1]!.split('?')[0]!);
    await expect(page.getByRole('heading', { level: 1, name: applicationNo })).toBeVisible();
    await expect(page.getByText('Checks before sending')).toBeVisible();
    // The maker sees no Approve: approving is a second person's act.
    await expect(page.getByRole('button', { name: 'Approve — reserve funds' })).toHaveCount(0);

    // The accounting manager approves, then sends although the funds check fails.
    const managerContext = await browser.newContext();
    const manager = await managerContext.newPage();
    await signIn(manager, 'manager@example.com');
    await manager.goto(`/payables/payment-applications/${encodeURIComponent(applicationNo)}`);
    await manager.getByRole('button', { name: 'Approve — reserve funds' }).click();
    await expect(manager.getByText('Approved — funds reserved').first()).toBeVisible({ timeout: 30_000 });

    await manager.getByRole('button', { name: 'Send to bank' }).click();
    const send = manager.getByRole('dialog');
    const override = send.getByRole('textbox', { name: 'Send anyway because…' });
    if (await override.isVisible().catch(() => false)) {
      await override.fill(`Owner deposit arrives today ${RUN}`);
    }
    await send.getByRole('button', { name: 'Send to bank' }).click();
    await expect(manager.getByText('Sent — not paid').first()).toBeVisible({ timeout: 30_000 });
    await expect(manager.getByText('The money’s path')).toBeVisible();

    // The Confirm dialog says what it will post before it posts it.
    await manager.getByRole('button', { name: 'Confirm cheque paid' }).click();
    await expect(manager.getByRole('dialog').getByText(/supplier advance/)).toBeVisible();
    await managerContext.close();

    // The register: waiting for the bank, with its days.
    await page.goto('/payables/payment-applications?view=waiting');
    await expect(page.getByRole('heading', { level: 1, name: 'Payment Applications' })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(applicationNo) })).toBeVisible();
  });

  test('holds the line at mobile width, in Arabic, right to left', async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);

    await page.goto('/payables');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1, name: 'معاملات الاستيراد' })).toBeVisible();
    await noSidewaysScroll(page);

    await page.goto('/payables/invoices');
    await noSidewaysScroll(page);
    const add = page.getByRole('button', { name: 'إضافة مصروف' });
    await expect(add).toBeVisible();
    await add.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(390);
    await dialog.getByRole('button', { name: 'إغلاق' }).click();

    // Stage 3's screens hold the same line.
    await page.goto('/payables/payment-applications');
    await expect(page.getByRole('heading', { level: 1, name: 'طلبات الدفع' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/payables/advances');
    await noSidewaysScroll(page);
    await page.goto('/master-data/banks');
    await noSidewaysScroll(page);
    const application = page.locator('table tbody tr td a').first();
    await page.goto('/payables/payment-applications');
    if (await application.isVisible().catch(() => false)) {
      await application.click();
      await expect(page.getByText('مسار المال', { exact: false }).or(page.getByText('الفحوص قبل الإرسال')).first()).toBeVisible();
      await noSidewaysScroll(page);
    }

    // An import application page in Arabic at the same width, if one exists.
    await page.goto('/payables');
    const first = page.locator('table tbody tr td a').first();
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      await expect(page.getByText('سجل الحالة', { exact: false }).first()).toBeVisible();
      await noSidewaysScroll(page);
    }
  });
});
