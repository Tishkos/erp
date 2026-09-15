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

  test('block 5 · the Sales Invoice register opens', async ({ page }) => {
    await page.goto('/sales/ar-invoices');

    await expect(page.getByRole('heading', { name: 'Sales Invoices' }).first()).toBeVisible();
    for (const column of ['Posting Date', 'Due Date', 'Customer Code', 'Customer Name']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }
  });

  test('block 5 · the supplier column follows the item that was chosen', async ({ page }) => {
    // Block 1's link is what block 5's rule reads, so the two are proved
    // together: link a supplier to an item, then watch the invoice's supplier
    // field come alive when that item is chosen. Without the link there is
    // nothing for the field to show, which is the state the assertion below
    // starts from.
    await page.goto('/master-data/items/ITM-SEED');
    await expect(page.getByRole('heading', { level: 1, name: /Seed Cable/ })).toBeVisible();

    // Idempotent: a previous run may already have linked one, and the screen
    // then offers nothing left to link. Either way the item ends up with a
    // supplier, which is all the next step needs.
    const picker = page.getByLabel('Add a supplier');
    const choice = picker.locator('option:not([value=""])').first();
    if ((await choice.count()) > 0) {
      // By value, not by index: the picker has no placeholder row, so index 1
      // is past the end when exactly one supplier is offered.
      await picker.selectOption((await choice.getAttribute('value'))!);
      await page.getByRole('button', { name: 'Link supplier' }).click();
    }
    await expect(page.getByRole('heading', { name: /Bought from \([1-9]/ })).toBeVisible();

    await page.goto('/sales/ar-invoices/new');
    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();

    // The sponsor's line columns, Supplier among them — it is on the line and
    // not the header because the same item bought from two suppliers is two
    // pools of stock at two costs.
    for (const column of ['Quantity', 'Unit Price', 'Discount', 'Supplier']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }

    const supplier = page.locator('select[name="supplier_id_0"]');
    const item = page.locator('select[name="item_code_0"]');

    // Nothing chosen: the column is there and has nothing to offer, which is
    // the item's doing rather than a fault, so it is disabled rather than gone.
    await expect(supplier).toBeDisabled();

    // "When an item is selected, the supplier field shows the supplier(s)
    // linked to that item." Choosing one is what makes the field live.
    const firstItem = await item.locator('option:not([value=""])').first().getAttribute('value');
    await item.selectOption(firstItem!);
    await expect(supplier).toBeEnabled();

    // Blank stays on the list: it means the oldest stock of any supplier, which
    // is a real answer and not an empty one.
    await expect(supplier.locator('option').first()).toHaveText('Any supplier');
  });

  test('block 9 · the Sales Returns register opens', async ({ page }) => {
    await page.goto('/sales/sales-returns');

    await expect(page.getByRole('heading', { name: 'Sales Returns' }).first()).toBeVisible();
    // The offset is in the register because it is the difference between
    // reducing what a customer owes and handing their money back, and a list
    // that hides it hides the only thing distinguishing two returns.
    for (const column of ['Customer Code', 'Customer Name', 'Offset Account']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }
  });

  test('block 9 · the return form asks for one offset account', async ({ page }) => {
    await page.goto('/sales/sales-returns/new');
    await expect(page.getByRole('heading', { name: 'New return' })).toBeVisible();

    // The sponsor: "Offset Account (Accounts Receivable or Bank — one must be
    // selected)". Both are offered, and no third option exists.
    const offset = page.locator('select[name="offset_kind"]');
    const invoices = await page.locator('select[name="invoice"] option:not([value=""])').count();
    if (invoices === 0) {
      // Nothing posted to return against yet — the page says so rather than
      // offering a form that cannot be completed.
      await expect(page.getByText('Post a sales invoice first.')).toBeVisible();
      return;
    }
    await expect(offset).toHaveCount(1);
    await expect(offset.locator('option')).toHaveCount(2);
  });
});
