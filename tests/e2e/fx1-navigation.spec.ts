import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-FIX-001 FX2 — the dropdowns the sponsor asked for (2026-10-02).
 *
 * Payables opens on three headings (FIX-1 made it four; the owner folded
 * Payments into Purchasing & Invoices on 2026-10-03, 009c1fb), with nothing
 * of logistics or banking left in it; Logistics holds the customs declarations,
 * the ASYCUDA list and the shipping; Treasury & Banking, under Accounting,
 * holds the bank loans and the deposits beside the accounts. Then a cash
 * deposit is raised on the new screen and its record opens.
 *
 * Requires `npm run db:seed`.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe('FX2 · the module dropdowns', () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test('Payables is three headings, and holds only payables work', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Payables' }).click();
    // The Purchasing & Payables finalisation (2026-10-04): purchasing and
    // invoices, how the supplier is paid and what they hold, the balances.
    for (const heading of ['Purchasing & Invoices', 'Supplier Payments & Credits', 'Supplier Balances']) {
      await expect(nav.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    // The settings and the sheet migration are Administration's now.
    await expect(nav.getByRole('heading', { name: 'Setup', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Purchase Invoices', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Payment Applications', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Supplier Reconciliation', exact: true })).toBeVisible();
    // The supplier master is Master Data — Financial's since 2026-10-06 (by
    // direction), at the address every supplier link already uses (D-FX-1).
    await expect(nav.getByRole('link', { name: 'Suppliers', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Supplier Statements', exact: true })).toBeVisible();
    for (const gone of ['Customs Pre-Declarations', 'Bills of Lading', 'Containers', 'Bank Loans']) {
      await expect(nav.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
    }
  });

  test('Logistics is four headings: customs, shipping, in transit, landed costs (REQ-LOG-001)', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Logistics' }).click();
    for (const heading of ['Customs — ASYCUDA', 'Shipping', 'In Transit', 'Landed Costs']) {
      await expect(nav.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: 'Customs Pre-Declarations', exact: true })).toHaveAttribute('href', '/payables/pd');
    await expect(nav.getByRole('link', { name: 'Customs Declarations', exact: true })).toHaveAttribute('href', '/logistics/customs-declarations');
    await expect(nav.getByRole('link', { name: 'Update from ASYCUDA', exact: true })).toHaveAttribute('href', '/payables/pd/asycuda');
    await expect(nav.getByRole('link', { name: 'Bills of Lading', exact: true })).toHaveAttribute('href', '/payables/shipments');
    await expect(nav.getByRole('link', { name: 'Containers', exact: true })).toHaveAttribute('href', '/payables/containers');
    await expect(nav.getByRole('link', { name: 'In-Transit Inventory', exact: true })).toHaveAttribute('href', '/logistics/in-transit');
    for (const item of ['Customs Duties & Taxes', 'Customs Documents', 'Shipments', 'Ports & Routes', 'Freight & Shipping Costs', 'Shipment Documents', 'Shipment Tracking', 'Landed Costs', 'Cost Allocation']) {
      await expect(nav.getByRole('link', { name: item, exact: true })).toBeVisible();
    }
    // Invoice Status Tracking was absorbed; the client jobs are not in the dropdown.
    await expect(nav.getByRole('link', { name: 'Invoice Status Tracking', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Logistics Jobs', exact: true })).toHaveCount(0);
  });

  test('Customers and Suppliers are Master Data’s, at their old addresses (2026-10-06)', async ({ page }) => {
    // By direction, 2026-10-06: "yes move the customer and supplier to master data".
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Accounting' }).click();
    await expect(nav.getByRole('heading', { name: 'Master Data — Financial', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Customers', exact: true })).toHaveAttribute('href', '/sales/customers');
    await expect(nav.getByRole('link', { name: 'Suppliers', exact: true })).toHaveAttribute('href', '/payables/suppliers');

    await nav.getByRole('button', { name: 'Receivables' }).click();
    await expect(nav.getByRole('heading', { name: 'Sales & Invoices', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Customers', exact: true })).toHaveCount(0);
    await nav.getByRole('button', { name: 'Payables' }).click();
    await expect(nav.getByRole('heading', { name: 'Supplier Balances', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Suppliers', exact: true })).toHaveCount(0);

    // Each page's tabs are its new heading's screens: the partners lead Master Data — Financial.
    await page.goto('/payables/suppliers');
    const supplierTabs = page.getByRole('navigation', { name: 'Suppliers' });
    await expect(supplierTabs.getByRole('link', { name: 'Customers', exact: true })).toBeVisible();
    await expect(supplierTabs.getByRole('link', { name: 'Supplier Statements' })).toHaveCount(0);
    await page.goto('/sales/customers');
    const customerTabs = page.getByRole('navigation', { name: 'Customers' });
    await expect(customerTabs.getByRole('link', { name: 'Suppliers', exact: true })).toBeVisible();
    await expect(customerTabs.getByRole('link', { name: 'Sales Invoices' })).toHaveCount(0);
  });

  test('Treasury & Banking holds the loans and the deposits beside the accounts', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Accounting' }).click();
    await expect(nav.getByRole('heading', { name: 'Treasury & Banking', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Bank Loans', exact: true })).toHaveAttribute('href', '/treasury/loans');
    // Renamed Manual Deposits on 2026-10-04 (cdc9c86); the route stays.
    await expect(nav.getByRole('link', { name: 'Manual Deposits', exact: true })).toHaveAttribute('href', '/treasury/deposits');
  });

  test('the loans and the declarations show their new neighbours as tabs', async ({ page }) => {
    await page.goto('/treasury/loans');
    const tabs = page.getByRole('navigation', { name: 'Bank Loans' });
    await expect(tabs.getByRole('link', { name: 'Manual Deposits' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Purchase Invoices' })).toHaveCount(0);
    await page.goto('/payables/pd');
    const pdTabs = page.getByRole('navigation', { name: 'Customs Pre-Declarations' });
    await expect(pdTabs.getByRole('link', { name: 'Update from ASYCUDA' })).toBeVisible();
  });
});

test('FX3 · a deposit from another source is raised on the Manual Deposits screen and opens as its record', async ({ page }) => {
  await signIn(page);
  await page.goto('/treasury/deposits');
  await expect(page.getByRole('heading', { name: 'Manual Deposits', level: 1 })).toBeVisible();
  // The two buttons are "Cash deposit" and "Bank deposit" (2026-10-04).
  await page.getByRole('button', { name: 'Bank deposit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bank deposit', exact: true });
  await dialog.getByLabel('Into bank account').selectOption({ index: 0 });
  const credit = dialog.getByLabel('Credit account');
  // An income account — the seeded chart's revenue accounts start with R.
  const income = await credit.locator('option').filter({ hasText: /^R/ }).first().getAttribute('value');
  await credit.selectOption(income!);
  await dialog.getByLabel('Paid in by').fill('E2E depositor');
  await dialog.getByLabel('Amount').fill('25');
  await dialog.getByLabel('Bank reference').fill('E2E-SLIP');
  await dialog.getByRole('button', { name: 'Create deposit' }).click();

  // The record: the document type, the status chip, and the register lists it.
  // (First: the printer door's window is headed the same way, 2026-10-04.)
  await expect(page.getByText('Bank deposit — other source').first()).toBeVisible({ timeout: 30_000 });
  const number = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
  expect(number).toMatch(/^ORC-/);
  await page.goto(`/treasury/deposits?q=${encodeURIComponent(number)}`);
  await expect(page.getByRole('link', { name: number })).toBeVisible();
});
