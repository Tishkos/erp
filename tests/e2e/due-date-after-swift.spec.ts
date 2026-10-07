import { expect, test, type Browser, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { dateField } from './support/controls';

/**
 * The balance's due date, once the SWIFT is in — by direction 2026-10-07:
 * "don't show the due date until we get the SWIFT … once the payment
 * application is done, clicking the import application, a dialog comes up:
 * enter the due date, and it marks it".
 *
 * Runs against the seeded development database as the administrator, on an
 * import whose payment application is already paid (its paid paper attached)
 * and whose invoice still owes something. The spec makes that invoice's due
 * date unset again first (as the owner), so it can be run more than once.
 *
 *   • before: the import, its register row, the invoice and the Purchase
 *     Invoices register show "—" and "Set once the SWIFT is received", never
 *     the column's default; Arabic says it in Arabic, right to left;
 *   • the dialog opens by itself, says which application was paid and lists
 *     the invoice; "Later" closes it and it does not open again in this tab;
 *   • the banner's button opens it; a date before the invoice's own is
 *     refused in the dialog; a good date is saved, the dialog closes, and the
 *     import shows the date with "Set by …"; so do the invoice and the register.
 */
const PASSWORD = 'Ledger-Trial-Balance-7';

const owner = () => {
  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('DATABASE_URL_OWNER is not set (the spec prepares its own fixture).');
  return new Pool({ connectionString: url, max: 1 });
};

interface Scenario {
  readonly payableNo: string;
  readonly applicationNo: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
}
let scenario: Scenario | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const pool = owner();
  try {
    // An open import with a paid application and a posted invoice still owing.
    const { rows } = await pool.query(
      `select p.id as payable_id, p.payable_no, a.application_no, i.invoice_no, i.invoice_date::text as invoice_date
         from payable p
         join payment_application a on a.payable_id = p.id and a.status in ('confirmed', 'debited')
         join ap_invoice i on i.payable_id = p.id and i.status in ('posted', 'partially_executed') and i.total_iqd > i.settled_amount_iqd
        where p.payable_type_code = 'import' and p.cancelled_at is null and p.closed_at is null
        order by p.created_at desc, a.confirmed_on desc nulls last
        limit 1`,
    );
    if (rows.length === 0) return;
    scenario = { payableNo: rows[0].payable_no, applicationNo: rows[0].application_no, invoiceNo: rows[0].invoice_no, invoiceDate: rows[0].invoice_date };
    // Its invoices' due dates unset again, so the import asks (the dev database's own scenario, made repeatable).
    await pool.query(`update ap_invoice set due_date_set_at = null where payable_id = $1 and status in ('posted', 'partially_executed')`, [rows[0].payable_id]);
  } finally {
    await pool.end();
  }
});

async function signedIn(browser: Browser, options: { locale?: 'ar'; phone?: boolean } = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: options.phone ? { width: 390, height: 844 } : { width: 1360, height: 900 } });
  if (options.locale) await context.addCookies([{ name: 'erp-locale', value: options.locale, domain: 'localhost', path: '/' }]);
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill('admin@example.com');
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/', { timeout: 120_000 });
  return page;
}

const importPage = (s: Scenario) => `/payables/${encodeURIComponent(s.payableNo)}`;
const dialogOf = (page: Page) => page.locator('dialog[data-balance-due-dialog]');

test('before the date is set: no due date anywhere, said why — in English and in Arabic', async ({ browser }) => {
  test.skip(!scenario, 'No import on the development database has a paid application and an invoice still owing.');
  const s = scenario!;

  // Arabic on a phone first, so the English test below is the one that sets the date.
  const ar = await signedIn(browser, { locale: 'ar', phone: true });
  await ar.goto(importPage(s), { timeout: 120_000 });
  await expect(ar.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(dialogOf(ar)).toBeVisible({ timeout: 60_000 });
  await expect(dialogOf(ar)).toContainText('تحديد تاريخ استحقاق الرصيد');
  await dialogOf(ar).getByRole('button', { name: 'لاحقاً' }).click();
  await expect(dialogOf(ar)).toBeHidden();
  await expect(ar.locator('[data-due-date-field]')).toContainText('يُحدَّد عند استلام السويفت');
  // Nothing is wider than the phone.
  expect(await ar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await ar.context().close();

  const page = await signedIn(browser);
  await page.goto('/payables/invoices', { timeout: 120_000 });
  const row = page.getByRole('row', { name: new RegExp(s.invoiceNo) });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.locator('[data-due-date="waiting"]')).toContainText('Set once the SWIFT is received');
  await expect(row).not.toContainText('Overdue');

  await page.goto(`/payables/invoices/${encodeURIComponent(s.invoiceNo)}`, { timeout: 120_000 });
  await expect(page.locator('[data-due-date-field]')).toContainText('Set once the SWIFT is received');
  // The invoice offers the same dialog while the import waits for its date.
  await expect(page.locator('button[data-balance-due-open]')).toHaveText('Set due date');
  await page.context().close();
});

test('the import asks by itself, once per tab; a refused date is said in the dialog; a good one is marked', async ({ browser }) => {
  test.skip(!scenario, 'No import on the development database has a paid application and an invoice still owing.');
  const s = scenario!;
  const page = await signedIn(browser);

  await page.goto(importPage(s), { timeout: 120_000 });
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole('heading', { name: 'Set the due date for the balance' })).toBeVisible();
  await expect(dialog.locator('[data-balance-due-paid]')).toContainText(`${s.applicationNo} was paid on`);
  await expect(dialog.getByRole('table', { name: 'Invoices without a due date' })).toContainText(s.invoiceNo);
  await expect(page.locator('[data-due-date-field] [data-due-date="waiting"]')).toContainText('Set once the SWIFT is received');

  // Later: closed, and not asked again in this tab.
  await dialog.getByRole('button', { name: 'Later' }).click();
  await expect(dialog).toBeHidden();
  await page.reload({ timeout: 120_000 });
  await expect(page.locator('[data-balance-due-banner]')).toContainText('Set the due date for the balance');
  await page.waitForTimeout(1500);
  await expect(dialogOf(page)).toBeHidden();

  // The banner's button opens it. A date before the invoice's own date is refused, in the dialog.
  await page.locator('[data-balance-due-banner] button[data-balance-due-open]').click();
  await expect(dialogOf(page)).toBeVisible();
  await dateField(dialogOf(page), 'Due date').fill('2025-01-01');
  await dialogOf(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialogOf(page).locator('[data-balance-due-error]')).toContainText(`is before invoice ${s.invoiceNo}'s own date`, { timeout: 60_000 });
  await expect(dialogOf(page)).toBeVisible();

  // A good date: saved, closed, and marked with who set it.
  const due = `${Number(s.invoiceDate.slice(0, 4)) + 1}-03-15`;
  await dateField(dialogOf(page), 'Due date').fill(due);
  await dialogOf(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialogOf(page)).toHaveCount(0, { timeout: 60_000 });
  const field = page.locator('[data-due-date-field]');
  await expect(field.locator('[data-due-date="waiting"]')).toHaveCount(0);
  await expect(field).toContainText(`Mar 15, ${due.slice(0, 4)}`);
  await expect(field.locator('[data-due-date-mark]')).toContainText(/^Set by .+ on /);
  await expect(page.locator('[data-balance-due-banner]')).toHaveCount(0);
  // The goods' journey says it on the In Process step.
  await expect(page.locator('[data-journey-due]')).toContainText(`Mar 15, ${due.slice(0, 4)}`);

  // The invoice and the register show it now; nothing more to set.
  await page.goto(`/payables/invoices/${encodeURIComponent(s.invoiceNo)}`, { timeout: 120_000 });
  await expect(page.locator('[data-due-date-field]')).toContainText(`Mar 15, ${due.slice(0, 4)}`);
  await expect(page.locator('[data-due-date-field] [data-due-date-mark]')).toContainText('Set by');
  await expect(page.locator('button[data-balance-due-open]')).toHaveCount(0);
  await page.goto('/payables/invoices', { timeout: 120_000 });
  await expect(page.getByRole('row', { name: new RegExp(s.invoiceNo) })).toContainText(`Mar 15, ${due.slice(0, 4)}`);
  await page.context().close();
});
