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
    for (const heading of ['Purchasing & Invoices', 'Suppliers & Balances', 'Setup']) {
      await expect(nav.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    // The payment screens sit with the invoices they pay — no heading of their own.
    await expect(nav.getByRole('heading', { name: 'Payments', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Purchase Invoices', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Payment Applications', exact: true })).toBeVisible();
    for (const gone of ['Customs Pre-Declarations', 'Bills of Lading', 'Containers', 'Bank Loans']) {
      await expect(nav.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
    }
  });

  test('Logistics holds customs and shipping', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Logistics' }).click();
    await expect(nav.getByRole('heading', { name: 'Customs (ASYCUDA)', exact: true })).toBeVisible();
    await expect(nav.getByRole('heading', { name: 'Shipping', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Customs Pre-Declarations', exact: true })).toHaveAttribute('href', '/payables/pd');
    await expect(nav.getByRole('link', { name: 'Update from ASYCUDA', exact: true })).toHaveAttribute('href', '/payables/pd/asycuda');
    await expect(nav.getByRole('link', { name: 'Bills of Lading', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Containers', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Invoice Status Tracking', exact: true })).toBeVisible();
  });

  test('Treasury & Banking holds the loans and the deposits beside the accounts', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('button', { name: 'Accounting' }).click();
    await expect(nav.getByRole('heading', { name: 'Treasury & Banking', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Bank Loans', exact: true })).toHaveAttribute('href', '/payables/loans');
    await expect(nav.getByRole('link', { name: 'Bank Deposits', exact: true })).toHaveAttribute('href', '/treasury/deposits');
  });

  test('the loans and the declarations show their new neighbours as tabs', async ({ page }) => {
    await page.goto('/payables/loans');
    const tabs = page.getByRole('navigation', { name: 'Bank Loans' });
    await expect(tabs.getByRole('link', { name: 'Bank Deposits' })).toBeVisible();
    await expect(tabs.getByRole('link', { name: 'Purchase Invoices' })).toHaveCount(0);
    await page.goto('/payables/pd');
    const pdTabs = page.getByRole('navigation', { name: 'Customs Pre-Declarations' });
    await expect(pdTabs.getByRole('link', { name: 'Update from ASYCUDA' })).toBeVisible();
  });
});

test('FX3 · a deposit from another source is raised on the Bank Deposits screen and opens as its record', async ({ page }) => {
  await signIn(page);
  await page.goto('/treasury/deposits');
  await expect(page.getByRole('heading', { name: 'Bank Deposits', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Other deposit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Other deposit' });
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
  await expect(page.getByText('Bank deposit — other source')).toBeVisible({ timeout: 30_000 });
  const number = (await page.getByRole('heading', { level: 1 }).textContent())!.trim();
  expect(number).toMatch(/^ORC-/);
  await page.goto(`/treasury/deposits?q=${encodeURIComponent(number)}`);
  await expect(page.getByRole('link', { name: number })).toBeVisible();
});
