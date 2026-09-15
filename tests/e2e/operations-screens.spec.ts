import { expect, test, type Page } from '@playwright/test';

/**
 * The Operations Build screens open.
 *
 * A lesson rather than a formality. The Warehouses Report was written, unit
 * tested, typechecked and deployed, and answered "That page does not exist"
 * because its route was never added to the phase gate. Every check I made was
 * a `curl`, and the middleware redirects an unauthenticated request to the
 * sign-in page *before* the gate runs — so the route answered 307 whether it
 * worked or not, and the first person to see the truth was the sponsor.
 *
 * So: signed in, one navigation per screen, asserting the thing a person would
 * look at. Nothing here tests business logic — the integration suites do that.
 * This tests that a human being can reach it.
 *
 * Requires `npm run db:seed`.
 */

const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(MANAGER.email);
  await page.getByLabel('Password', { exact: true }).fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe('the Operations Build screens open', () => {
  // Serial: they share one seeded database, and a warehouse created by one
  // test is visible to the next.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('block 7 · the Warehouses Report shows the sponsor’s six columns', async ({ page }) => {
    await page.goto('/inventory/fifo-valuation');

    await expect(page.getByRole('heading', { name: 'Warehouses Report' })).toBeVisible();
    for (const column of [
      'Item Name',
      'Item Code',
      'Warehouse Name',
      'Warehouse Code',
      'Quantity',
      'Total Price',
    ]) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }
  });

  test('block 7 · a warehouse can be set up', async ({ page }) => {
    await page.goto('/master-data/warehouses');
    await expect(page.getByRole('heading', { name: 'Warehouses' })).toBeVisible();

    await page.getByRole('button', { name: 'New warehouse' }).click();
    const code = `WH-E2E-${Date.now().toString().slice(-6)}`;
    // Scoped to the dialog: the list behind it renames warehouses in place, so
    // the page carries one name field per row as well as this one.
    const dialog = page.locator('dialog[open], [role="dialog"]').first();
    await dialog.getByLabel('Warehouse Code').fill(code);
    await dialog.getByLabel(/Warehouse Name/).fill('End To End Depot');
    await dialog.getByRole('button', { name: 'Create' }).click();

    // The row is on the list, which is the whole of what block 7 asks for. The
    // name is read from the rename field's value, because that is where the
    // list puts it — it is edited in place rather than on a record page.
    await expect(page.getByText(code)).toBeVisible();
    await expect(page.getByLabel(`Rename ${code}`)).toHaveValue('End To End Depot');
  });

  test('block 4 · the Purchase Invoice register opens', async ({ page }) => {
    await page.goto('/purchasing/ap-invoices');

    await expect(page.getByRole('heading', { name: 'Purchase Invoices' }).first()).toBeVisible();
    for (const column of ['Posting Date', 'Due Date', 'Supplier Code', 'Supplier Name']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }
  });

  test('block 4 · the invoice form offers suppliers, items and warehouses', async ({ page }) => {
    // A Purchase Invoice needs a supplier to be raised against, and the
    // development database has none. Making one here rather than seeding it
    // keeps the test honest about the whole path: block 3's screen is what a
    // person would use, so it is what this uses.
    await page.goto('/master-data/suppliers');
    await page.getByRole('button', { name: 'New supplier' }).click();
    const supplier = page.locator('dialog[open], [role="dialog"]').first();
    await supplier.getByLabel('Legal name').fill('End To End Supplies');
    await supplier.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('End To End Supplies').first()).toBeVisible();

    await page.goto('/purchasing/ap-invoices/new');

    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();

    // The sponsor's line columns. Item Name is not among them because the item
    // picker carries `CODE · Name` in one control — "automatically shown when
    // the Item Code is selected", without a second field to keep in step.
    for (const column of ['Quantity', 'Unit Price', 'Discount']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }

    // Every picker has something in it. An empty one means the screen is built
    // and unusable, which is the failure this whole file exists to catch.
    await expect(page.locator('select[name="supplier_id"] option')).not.toHaveCount(0);
    await expect(page.locator('select[name="item_code_0"] option')).not.toHaveCount(1);
    await expect(page.locator('select[name="warehouse_code_0"] option')).not.toHaveCount(0);
  });
});
