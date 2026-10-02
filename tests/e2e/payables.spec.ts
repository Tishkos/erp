import { expect, test, type Page } from '@playwright/test';
import writeXlsxFile from 'write-excel-file/node';

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
 *   §16  Stage 4: a PD registered on the import, validated on its record,
 *        and the ASYCUDA list read into a difference before it is applied.
 *   §15  Stage 3: the instalment plan and a payment application from the
 *        import's Payments section; the maker cannot approve; the accounting
 *        manager approves and sends under a logged override; the register
 *        shows it waiting for the bank.
 *   §17  Stage 5: a B/L entered from the import page with its containers
 *        pasted in; one container moved to the port and received into a
 *        warehouse (out of transit); the B/L counts "1 of 2 received".
 *   §15.7 Stage 6: a loan entered by the officer, approved by a second
 *        person, disbursed and its first instalment repaid.
 *   §20.2 Stage 7: a charge from a posted journal, the PD written off, the
 *        landed cost locked from the import page.
 *   §24.3 Stage 8: a small workbook in the sheet's shape dry-run (the report
 *        names what is skipped and the holding list), applied, and its
 *        holding-list PD linked to the migrated import.
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

/**
 * The accounts an item carries itself (where its stock is held, what it cost
 * when sold) — a posted import needs them. Set once, as the invoice-to-
 * statement spec does.
 */
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
    await page.waitForLoadState('networkidle');
  }
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
    // The module's own tabs, as on every other screen — its heading's
    // (REQ-FIX-001 FIX-1: Purchasing & Invoices).
    await expect(page.getByRole('link', { name: 'Purchase Orders' }).first()).toBeVisible();

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

  test('Stage 4 · register a PD on the import, validate it, read the ASYCUDA list', async ({ page }) => {
    test.setTimeout(240_000);
    await signIn(page);
    const pdNo = `9${RUN}`;

    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('5');
    await page.getByLabel('Unit Price').first().fill('2000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);

    // §16.1 — the PD, as the ASYCUDA screen shows it.
    await page.getByRole('button', { name: 'Register PD' }).click();
    const register = page.getByRole('dialog');
    await register.getByRole('textbox', { name: 'PD no.' }).fill(pdNo);
    await register.getByLabel('Registered').fill('2026-09-02');
    await register.getByLabel('Expires').fill('2027-03-01');
    await register.getByLabel('Bank').selectOption({ label: 'Arab Bank · ARABIQBAXXX' });
    await register.getByRole('button', { name: 'Register PD' }).click();
    const pdLink = page.getByRole('link', { name: pdNo });
    await expect(pdLink).toBeVisible({ timeout: 30_000 });

    // Validated — one history row, the status in the header.
    await pdLink.click();
    await expect(page.getByRole('heading', { level: 1, name: `PD ${pdNo}` })).toBeVisible();
    await page.getByRole('button', { name: 'Change status' }).click();
    const change = page.getByRole('dialog');
    await change.getByLabel('New status').selectOption('validated');
    await change.getByRole('button', { name: 'Change status' }).click();
    await expect(page.getByText('Validated ·').first()).toBeVisible({ timeout: 30_000 });

    // §21.8 — the ASYCUDA list: the difference first, then applied.
    await page.goto('/payables/pd/asycuda');
    await page.getByRole('textbox', { name: 'List' }).fill(`${pdNo}\tTotally Written Off\n12345 Lost`);
    await page.getByRole('button', { name: 'Show the difference' }).click();
    await expect(page.getByText('Will be updated')).toBeVisible();
    await expect(page.getByText('Not read')).toBeVisible();
    await page.getByRole('button', { name: 'Apply 1 changes' }).click();
    await page.waitForURL(/\/payables\/pd\?applied=1/);
    await expect(page.getByText('1 PD statuses updated from the ASYCUDA list.')).toBeVisible();
    await page.goto(`/payables/pd?view=final&q=${pdNo}`);
    await expect(page.getByRole('row', { name: new RegExp(pdNo) })).toContainText('Totally written off');
  });

  test('Stage 5 · a B/L with two containers, one moved to port and received', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    // Container numbers are unique while in transit; this run's are its own.
    const digits = String(Date.now()).slice(-6);
    const first = `EEXU${digits}1`;
    const second = `EEXU${digits}2`;
    const blNo = `BL-E2E-${RUN}`;
    await itemAccounts(page);

    // The import, born at its invoice and posted: the goods wait in transit.
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('4');
    await page.getByLabel('Unit Price').first().fill('1500');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );
    await page.getByRole('button', { name: 'Send for approval', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Approve and post', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);

    // §17.1 — the B/L from the import page, its containers pasted in.
    await expect(page.getByRole('heading', { name: /Shipment/ })).toBeVisible();
    await page.getByRole('button', { name: 'New B/L' }).click();
    const create = page.getByRole('dialog');
    await create.getByRole('textbox', { name: 'B/L no.' }).fill(blNo);
    await create.getByLabel('B/L date').fill('2026-09-20');
    await create.getByLabel('ETA').fill('2026-10-20');
    await create.getByRole('textbox', { name: 'Containers' }).fill(`${first}\n${second}`);
    await create.getByRole('button', { name: 'New B/L' }).click();
    await expect(page.getByRole('link', { name: blNo })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('0 of 2 received').first()).toBeVisible();

    // §17.3 — one container reaches the port.
    await page.getByRole('link', { name: first }).click();
    await expect(page.getByRole('heading', { level: 1, name: first })).toBeVisible();
    await page.getByRole('button', { name: 'Change stage' }).click();
    const stage = page.getByRole('dialog');
    await stage.getByLabel('Stage').selectOption('at_port');
    await stage.getByRole('button', { name: 'Change stage' }).click();
    await expect(page.getByText('At port ·').first()).toBeVisible({ timeout: 30_000 });

    // §18 — received whole into WH-HQ: out of transit, at the invoice's cost.
    await page.getByRole('button', { name: 'Receive container' }).click();
    const receive = page.getByRole('dialog');
    await receive.getByLabel('Warehouse').selectOption('WH-HQ');
    await receive.getByRole('button', { name: 'Receive container' }).click();
    await expect(page.getByText(/^Received ·/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/^CREC-/).first()).toBeVisible();

    // The B/L counts it; the register finds it among the received.
    await page.goto(`/payables/shipments/${encodeURIComponent(blNo)}`);
    await expect(page.getByRole('heading', { level: 1, name: `B/L ${blNo}` })).toBeVisible();
    await expect(page.getByText('1 of 2 received').first()).toBeVisible();
    await page.goto(`/payables/containers?view=received&q=${first}`);
    await expect(page.getByRole('row', { name: new RegExp(first) })).toBeVisible();
    await page.goto(`/payables/containers?view=in_transit&q=${second}`);
    await expect(page.getByRole('row', { name: new RegExp(second) })).toBeVisible();
  });

  test('Stage 6 · a loan entered, approved by a second person, disbursed and repaid', async ({ page, browser }) => {
    test.setTimeout(240_000);
    const purpose = `Import finance ${RUN}`;

    // The officer enters the bank's offer (§15.7).
    await signIn(page, 'officer@example.com');
    await page.goto('/payables/loans');
    await expect(page.getByRole('heading', { level: 1, name: 'Bank Loans' })).toBeVisible();
    await page.getByRole('button', { name: 'New loan' }).click();
    const create = page.getByRole('dialog');
    await create.getByLabel('Bank', { exact: true }).selectOption({ label: 'Rafidain Bank' });
    await create.getByLabel('Proceeds land in').selectOption({ index: 0 });
    await create.getByRole('textbox', { name: 'Principal' }).fill('1000000');
    await create.getByRole('textbox', { name: 'Commission %' }).fill('2');
    await create.getByLabel('Commission taken').selectOption('deducted_at_disbursement');
    await create.getByRole('textbox', { name: 'Instalments' }).fill('4');
    await create.getByLabel('Repaid').selectOption('quarterly');
    await create.getByLabel('First instalment due').fill('2026-12-31');
    await create.getByRole('textbox', { name: 'Purpose' }).fill(purpose);
    await create.getByRole('button', { name: 'Create loan' }).click();
    await page.waitForURL(/\/payables\/loans\/LOAN-/, { timeout: 60_000 });
    const loanNo = decodeURIComponent(page.url().split('/payables/loans/')[1]!.split('?')[0]!);
    await expect(page.getByRole('heading', { level: 1, name: loanNo })).toBeVisible();
    await expect(page.getByText('980,000', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: '250,000 IQD' }).first()).toBeVisible();
    // The person who entered it does not approve it.
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

    // A second person approves, records the money arriving, pays the first quarter.
    const second = await browser.newContext();
    const admin = await second.newPage();
    await signIn(admin);
    await admin.goto(`/payables/loans/${encodeURIComponent(loanNo)}`);
    await admin.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(admin.getByText('Approved', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    await admin.getByRole('button', { name: 'Record disbursement' }).click();
    const disburse = admin.getByRole('dialog');
    await disburse.getByRole('textbox', { name: 'Bank reference' }).fill(`RAF-CR-${RUN}`);
    await disburse.getByRole('button', { name: 'Record disbursement' }).click();
    await expect(admin.getByText('Disbursed', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    await admin.getByRole('button', { name: 'Pay instalment' }).click();
    const pay = admin.getByRole('dialog');
    await pay.getByRole('textbox', { name: 'Bank reference' }).fill(`RAF-DR-${RUN}`);
    await pay.getByRole('button', { name: 'Pay instalment' }).click();
    await expect(admin.getByText(`RAF-DR-${RUN}`).first()).toBeVisible({ timeout: 30_000 });
    await second.close();

    // The register: 750,000 still owed on it.
    await page.goto(`/payables/loans?q=${loanNo}`);
    const row = page.getByRole('row', { name: new RegExp(loanNo) });
    await expect(row).toContainText('750,000');
    await expect(row).toContainText('Disbursed');
  });

  test('Stage 7 · a charge from a journal, the PD written off, the landed cost locked', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    await itemAccounts(page);
    const container = `EEXU${String(Date.now()).slice(-6)}7`;
    const pdNo = `7${RUN}`;

    // An import, posted, its one container received.
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('2');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.locator('input[name="is_import"]').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
      { timeout: 120_000 },
    );
    const invoiceNo = decodeURIComponent(page.url().split('/payables/invoices/')[1]!.split('?')[0]!);
    await page.getByRole('button', { name: 'Send for approval', exact: true }).click();
    await page.getByRole('button', { name: 'Approve and post', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Approve and post', exact: true })).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole('link', { name: 'Import tracking' }).click();
    await page.waitForURL(/\/payables\/IMP-/);
    const importUrl = page.url().split('?')[0]!;

    await page.getByRole('button', { name: 'New B/L' }).click();
    const bl = page.getByRole('dialog');
    await bl.getByRole('textbox', { name: 'B/L no.' }).fill(`BL-LC-${RUN}`);
    await bl.getByLabel('B/L date').fill('2026-09-20');
    await bl.getByRole('textbox', { name: 'Containers' }).fill(container);
    await bl.getByRole('button', { name: 'New B/L' }).click();
    await page.getByRole('link', { name: container }).click();
    await page.getByRole('button', { name: 'Receive container' }).click();
    await page.getByRole('dialog').getByLabel('Warehouse').selectOption('WH-HQ');
    await page.getByRole('dialog').getByRole('button', { name: 'Receive container' }).click();
    await expect(page.getByText(/^Received ·/).first()).toBeVisible({ timeout: 60_000 });

    // The PD, validated, then totally written off.
    await page.goto(importUrl);
    await page.getByRole('button', { name: 'Register PD' }).click();
    const register = page.getByRole('dialog');
    await register.getByRole('textbox', { name: 'PD no.' }).fill(pdNo);
    await register.getByLabel('Registered').fill('2026-09-02');
    await register.getByLabel('Expires').fill('2027-03-01');
    await register.getByRole('button', { name: 'Register PD' }).click();
    await page.getByRole('link', { name: pdNo }).click();
    for (const status of ['validated', 'totally_written_off']) {
      await page.getByRole('button', { name: 'Change status' }).click();
      const change = page.getByRole('dialog');
      await change.getByLabel('New status').selectOption(status);
      await change.getByRole('button', { name: 'Change status' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 });
    }

    // A posted journal to charge from — the invoice's own, for the test.
    await page.goto(`/finance/journals?q=${encodeURIComponent(invoiceNo)}`);
    const entryNo = (await page.locator('table tbody tr td a').first().innerText()).trim();

    // §20.2 — the charge, the preview, the lock.
    await page.goto(importUrl);
    await expect(page.getByRole('heading', { name: /Landed cost/ })).toBeVisible();
    await page.getByRole('button', { name: 'Add charge' }).click();
    const add = page.getByRole('dialog');
    await add.getByLabel('Type of cost').selectOption('freight');
    await add.getByRole('textbox', { name: 'Journal no.' }).fill(entryNo);
    await add.getByRole('textbox', { name: 'Amount (IQD)' }).fill('500');
    await add.getByRole('button', { name: 'Add charge' }).click();
    await expect(page.getByText('Not locked', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('table', { name: 'Allocation preview' })).toBeVisible();

    await page.getByRole('button', { name: 'Lock landed cost' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Lock landed cost' }).click();
    await expect(page.getByText('Locked · 1', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('table', { name: 'Locks' })).toContainText('500');
  });

  test('Stage 8 · the sheet dry-run, applied, and its holding-list PD linked', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const reference = `E2E-${RUN}`;
    const held = `82${RUN}`;
    const serial = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;
    const rows = (data: unknown[][]) => data.map((row) => row.map((value) => (value === null ? null : { value })));
    const buffer = (await writeXlsxFile([
      {
        sheet: 'dashboard',
        data: rows([
          ['PO no./ INV.', 'INV. Date', 'Supplier', 'INV. Amount', 'INV. Qty', 'Pmt Terms', 'Products', 'PD. No.', 'Registration Date', 'Expire Date', 'PD. Status', 'Paid Amount (SWIFT)', 'Pmt Remaining', 'Applied Amount', 'BL No.', 'Inbounded Qty', 'Clear?'],
          [reference, serial('2026-09-01'), 'Al-Rafidain Trading Co.', 1000, 10, 'CFR', 'panel', null, null, null, null, 0, 1000, 0, null, null, null],
        ]),
      },
      {
        sheet: 'PMT',
        data: rows([
          ['PO/INV. no.', 'Supplier', 'INV. Date', 'Bank', 'Application AMT.', 'Application date', 'Swift date', 'Payment Status'],
          [`${reference}-X`, 'NOBODY', null, 'MANSOUR', 500, serial('2026-09-05'), null, 'NOT PAID'],
        ]),
      },
      {
        sheet: 'PD',
        data: rows([
          ['PO no./ INV.', 'INV. Date', 'Supplier', 'PD No.', 'Registration Date', 'Expire Date', 'Status', 'Bank Code', 'SWIFT', 'Notes'],
          [null, null, null, held, serial('2026-09-02'), serial('2027-03-01'), 'Validated', null, null, null],
        ]),
      },
    ] as never).toBuffer()) as Buffer;
    const file = { name: `QS_DASHBOARD-${RUN}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer };

    // Dry run first: the report, and nothing applied.
    await page.goto('/administration/payables-migration');
    await expect(page.getByRole('heading', { level: 1, name: 'Sheet Migration' })).toBeVisible();
    await page.locator('input[name="file"]').setInputFiles(file);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Payment applications not imported' })).toContainText(
      'No dashboard row has this PO / invoice number.',
      { timeout: 60_000 },
    );
    await expect(page.getByRole('table', { name: 'PDs with no import' })).toContainText(held);

    // Apply the same file.
    await page.locator('input[name="file"]').setInputFiles(file);
    await page.getByLabel('Run', { exact: true }).selectOption('apply');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.locator('#migration-latest-title')).toContainText('Apply ·', { timeout: 60_000 });

    // The customs officer's holding list: the PD, linked to the migrated import.
    await page.goto('/payables/pd?view=holding');
    await page.getByRole('link', { name: held }).click();
    await page.getByRole('button', { name: 'Link to an import' }).click();
    const link = page.getByRole('dialog');
    const option = link.locator('select[name="payable_id"] option', { hasText: reference });
    await link.locator('select[name="payable_id"]').selectOption((await option.getAttribute('value'))!);
    await link.getByRole('button', { name: 'Link to an import' }).click();
    await expect(page.getByRole('link', { name: new RegExp(reference) }).first()).toBeVisible({ timeout: 30_000 });

    // Invoice Status Tracking points imports to their containers — its note,
    // and since REQ-FIX-001 FIX-1 its Shipping tabs, both name the register.
    await page.goto('/inventory/in-transit');
    const containers = page.getByRole('link', { name: /Containers$/ });
    await expect(containers.first()).toBeVisible();
    for (const link of await containers.all()) await expect(link).toHaveAttribute('href', '/payables/containers');
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
    await page.goto('/payables/pd');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/payables/pd/asycuda');
    await noSidewaysScroll(page);
    // Stage 5's registers too.
    await page.goto('/payables/shipments');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/payables/containers?view=all');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await noSidewaysScroll(page);
    // …and Stage 6's.
    await page.goto('/payables/loans?view=all');
    await expect(page.getByRole('heading', { level: 1, name: 'القروض المصرفية' })).toBeVisible();
    await noSidewaysScroll(page);
    // …and Stage 8's.
    await page.goto('/administration/payables-migration');
    await expect(page.getByRole('heading', { level: 1, name: 'ترحيل الجدول' })).toBeVisible();
    await noSidewaysScroll(page);
    await page.goto('/payables/pd?view=holding');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
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
