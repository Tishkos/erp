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
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
/**
 * The development super user, for the master data a manager may not maintain.
 *
 * Payment Terms is one of those screens: §4.3 puts it with the masters an
 * administrator keeps, and the manager who raises invoices is refused it. So
 * the term is created the way it is created in life — by an administrator, in
 * a session of their own — and the invoice is still raised as the manager.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page, who: { email: string; password: string } = MANAGER) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
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

    // Wait for the redirect back to the list before looking for the row. The
    // assertion starting its own clock against a page still being produced is
    // the flake this suite has already been bitten by twice.
    await page.waitForURL(/\/master-data\/warehouses(\?|$)/, { timeout: 60_000 });

    // The row is on the list, and its code opens the warehouse's own record —
    // where it is named, edited, and carries its history, like every other
    // master record.
    await expect(page.getByRole('link', { name: code })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('link', { name: code }).click();
    await page.waitForURL(new RegExp(`/master-data/warehouses/${code}`), { timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(code) })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByLabel('Warehouse Name')).toHaveValue('End To End Depot');

    // Laid out as a branch is: identity and facts on the left, editing and
    // history on the right.
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
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

    // The sponsor's line columns, in the sponsor's own words.
    for (const column of ['Item Code', 'Item Name', 'Quantity', 'Unit Price', 'Discount']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }

    // Every picker has something in it. An empty one means the screen is built
    // and unusable, which is the failure this whole file exists to catch.
    //
    // The supplier is the sponsor's "searchable" field — an input over a
    // datalist rather than a select, so it is the list that is counted.
    await expect(page.locator('datalist option')).not.toHaveCount(0);
    await expect(page.locator('select[name="item_code_0"] option')).not.toHaveCount(1);
    await expect(page.locator('select[name="warehouse_code_0"] option')).not.toHaveCount(0);
  });

  test('block 4 · the invoice is raised, and falls due when the terms say', async ({
    browser,
    page,
  }) => {
    /*
     * The screen's own path, pressed all the way through.
     *
     * The test above stops at "the form rendered", and that is how a form
     * nobody could submit came to ship: block 4's header does not collect the
     * supplier's own invoice number, and the service asked every blank one for
     * the reason behind a duplicate exception (§15). Every invoice raised here
     * came back refused.
     *
     * It proves §16 on the same pass. The due date is not typed — it is the
     * supplier's payment terms counted from the posting date, filled in by the
     * form before anything is saved.
     */
    const stamp = Date.now().toString().slice(-6);
    const termsCode = `E2ET${stamp}`;
    const supplierCode = `E2ESUP${stamp}`;

    const administration = await browser.newContext();
    const administrator = await administration.newPage();
    try {
      await signIn(administrator, ADMIN);
      await administrator.goto('/master-data/payment-terms');
      await administrator.getByRole('button', { name: 'New payment term' }).click();
      const term = administrator.locator('dialog[open], [role="dialog"]').first();
      await term.getByLabel('Code', { exact: true }).fill(termsCode);
      await term.getByLabel(/^Name/).fill('Thirty days');
      await term.getByLabel('Days to pay').fill('30');
      await term.getByRole('button', { name: 'Create' }).click();
      // A new term opens its own record, where its worked example is.
      await administrator.waitForURL(new RegExp(`/master-data/payment-terms/${termsCode}`), {
        timeout: 60_000,
      });
    } finally {
      await administration.close();
    }

    await page.goto('/master-data/suppliers');
    await page.getByRole('button', { name: 'New supplier' }).click();
    const supplier = page.locator('dialog[open], [role="dialog"]').first();
    await supplier.getByLabel('Code', { exact: true }).fill(supplierCode);
    await supplier.getByLabel(/^Legal name/).fill(`Terms Test ${stamp}`);
    await supplier.getByLabel(/^Payment terms/).selectOption(termsCode);
    await supplier.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(new RegExp(`/master-data/business-partners/${supplierCode}`), {
      timeout: 60_000,
    });

    await page.goto('/purchasing/ap-invoices/new');
    await expect(page.getByRole('heading', { name: 'New invoice' })).toBeVisible();

    // Today, as the form opens it — and thirty days after it, which is what
    // the due date should say once the supplier is named, and nothing else.
    const posting = await page.getByLabel('Posting Date').inputValue();
    const thirtyDaysOn = new Date(`${posting}T00:00:00Z`);
    thirtyDaysOn.setUTCDate(thirtyDaysOn.getUTCDate() + 30);

    await page.getByLabel('Supplier Code').fill(supplierCode);
    await expect(page.getByLabel('Due Date')).toHaveValue(thirtyDaysOn.toISOString().slice(0, 10));

    await page.locator('select[name="item_code_0"]').selectOption('ITM-SEED');
    await page.getByLabel('Quantity').first().fill('2');
    await page.getByLabel('Unit Price').first().fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');

    await page.getByRole('button', { name: 'Create' }).click();

    // On the invoice's own record, not back on the form under a refusal.
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/purchasing/ap-invoices/') &&
        !url.pathname.endsWith('/new') &&
        url.search === '',
      { timeout: 120_000 },
    );
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  });

  test('draft quantity remains reliable while a row saves', async ({ browser, page }) => {
    test.setTimeout(180_000);
    const stamp = Date.now().toString(36).toUpperCase();
    const supplierCode = `E2E-SUP-${stamp}`;
    const itemCode = `E2E-ITM-${stamp}`;
    const administration = await browser.newContext();
    const administrator = await administration.newPage();

    try {
      await signIn(administrator, ADMIN);
      await administrator.goto('/master-data/suppliers');
      await administrator.getByRole('button', { name: 'New supplier' }).click();
      const supplier = administrator.locator('dialog[open], [role="dialog"]').first();
      await supplier.getByLabel('Code', { exact: true }).fill(supplierCode);
      await supplier.getByLabel(/^Legal name/).fill(`Draft Save ${stamp}`);
      await supplier.getByRole('button', { name: 'Create' }).click();
      await administrator.waitForURL(
        new RegExp(`/master-data/business-partners/${supplierCode}`),
        { timeout: 60_000 },
      );

      await administrator.goto('/master-data/items');
      await administrator.getByRole('button', { name: 'New item' }).click();
      const item = administrator.locator('dialog[open], [role="dialog"]').first();
      await item.getByLabel('Code', { exact: true }).fill(itemCode);
      await item.getByLabel(/^Name/).fill(`Draft Save Item ${stamp}`);
      const uom = item.getByLabel('Base unit', { exact: true });
      await uom.selectOption(
        (await uom.locator('option:not([value=""])').first().getAttribute('value'))!,
      );
      await item.getByRole('button', { name: 'Create' }).click();
      await administrator.waitForURL(new RegExp(`/master-data/items/${itemCode}`), {
        timeout: 60_000,
      });
    } finally {
      await administration.close();
    }

    await page.goto('/purchasing/ap-invoices/new');
    await page.getByLabel('Supplier Code').fill(supplierCode);
    await page.locator('select[name="item_code_0"]').selectOption('ITM-SEED');
    await page.locator('input[name="quantity_0"]').fill('2');
    await page.locator('input[name="unit_price_0"]').fill('100');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/purchasing\/ap-invoices\/[^/]+$/, { timeout: 60_000 });

    const grid = page.locator('table[aria-labelledby="ap-invoice-document-lines-heading"]');
    const rows = grid.locator('tbody tr:not([aria-hidden="true"])');
    const row = rows.first();
    const quantity = row.getByLabel('Quantity', { exact: true });
    const remove = row.getByRole('button', { name: 'Remove line' });
    await expect(
      row.getByText(/Available stock|Stock availability is unavailable/, { exact: false }),
    ).toBeVisible({ timeout: 60_000 });
    const isLineSave = (request: { method(): string }) => request.method() === 'POST';
    const isLineSaveResponse = (response: import('@playwright/test').Response) =>
      isLineSave(response.request());

    let releaseResponse!: () => void;
    const responseHeld = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestSeen!: () => void;
    const requestArrived = new Promise<void>((resolve) => {
      requestSeen = resolve;
    });
    let responseFinished!: () => void;
    const responseComplete = new Promise<void>((resolve) => {
      responseFinished = resolve;
    });
    let holding = true;
    const holdRoute = async (route: import('@playwright/test').Route) => {
      const request = route.request();
      if (holding && isLineSave(request)) {
        holding = false;
        requestSeen();
        const response = await route.fetch();
        await responseHeld;
        await route.fulfill({ response });
        responseFinished();
      } else {
        await route.continue();
      }
    };
    await page.route('**/*', holdRoute);
    try {
      await quantity.fill('3');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await requestArrived;
      await expect(quantity).toBeDisabled();
      await expect(remove).toBeDisabled();
      await expect(rows.nth(1).getByLabel('Item Code', { exact: true })).toBeEnabled();
    } finally {
      releaseResponse();
      await responseComplete;
      await page.unroute('**/*', holdRoute);
    }
    await expect(quantity).toBeEnabled({ timeout: 60_000 });

    const savedSeven = page.waitForResponse(isLineSaveResponse, { timeout: 60_000 });
    await quantity.fill('7');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await savedSeven;
    await expect(quantity).toBeEnabled({ timeout: 60_000 });
    await page.reload();
    await expect(
      page
        .locator('table[aria-labelledby="ap-invoice-document-lines-heading"]')
        .locator('tbody tr:not([aria-hidden="true"])')
        .first()
        .getByLabel('Quantity', { exact: true }),
    ).toHaveValue('7');
    await expect(
      page
        .locator('table[aria-labelledby="ap-invoice-document-lines-heading"]')
        .locator('tbody tr:not([aria-hidden="true"])'),
    ).toHaveCount(2);

    let abortSeen!: () => void;
    const aborted = new Promise<void>((resolve) => {
      abortSeen = resolve;
    });
    const abortRoute = async (route: import('@playwright/test').Route) => {
      if (isLineSave(route.request())) {
        abortSeen();
        await route.abort();
      } else {
        await route.continue();
      }
    };
    await page.route('**/*', abortRoute);
    try {
      await quantity.fill('5');
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await aborted;
      await expect(quantity).toBeEnabled({ timeout: 60_000 });
      await expect(row.getByRole('alert')).toContainText('could not be saved');
      await expect(quantity).toHaveValue('5');
      await expect(remove).toBeEnabled();
    } finally {
      await page.unroute('**/*', abortRoute);
    }

    const retried = page.waitForResponse(isLineSaveResponse, { timeout: 60_000 });
    await quantity.focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await retried;
    await page.reload();
    await expect(
      page
        .locator('table[aria-labelledby="ap-invoice-document-lines-heading"]')
        .locator('tbody tr:not([aria-hidden="true"])')
        .first()
        .getByLabel('Quantity', { exact: true }),
    ).toHaveValue('5');

    await page.goto('/purchasing/ap-invoices/new');
    const newQuantity = page.locator('input[name="quantity_0"]');
    const newItem = page.locator('select[name="item_code_0"]');
    await newItem.selectOption('ITM-SEED');
    await expect(newQuantity).toHaveValue('1');
    await newQuantity.fill('2');
    await newItem.selectOption(itemCode);
    await expect(newQuantity).toHaveValue('2');
  });

  test('invoice prices follow user-maintained defaults', async ({ browser, page }) => {
    test.setTimeout(180_000);
    const stamp = Date.now().toString(36).toUpperCase();
    const supplierACode = `E2E-PA-${stamp}`;
    const supplierBCode = `E2E-PB-${stamp}`;
    const customerCode = `E2E-C-${stamp}`;
    const itemCode = `E2E-P-${stamp}`;
    const administration = await browser.newContext();
    const administrator = await administration.newPage();

    const saveCurrentPage = async (submit: () => Promise<void>) => {
      await Promise.all([
        administrator.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().includes('/master-data/items/'),
          { timeout: 60_000 },
        ),
        submit(),
      ]);
      await administrator.waitForLoadState('networkidle');
    };

    try {
      await signIn(administrator, ADMIN);
      const makePartner = async (
        list: 'suppliers' | 'customers',
        buttonName: string,
        code: string,
        name: string,
      ) => {
        await administrator.goto(`/master-data/${list}`);
        await administrator.getByRole('button', { name: buttonName }).click();
        const dialog = administrator.locator('dialog[open], [role="dialog"]').first();
        await dialog.getByLabel('Code', { exact: true }).fill(code);
        await dialog.getByLabel(/^Legal name/).fill(name);
        await dialog.getByRole('button', { name: 'Create' }).click();
        await administrator.waitForURL(new RegExp(`/master-data/business-partners/${code}`), {
          timeout: 60_000,
        });
      };
      await makePartner('suppliers', 'New supplier', supplierACode, `Price Supplier A ${stamp}`);
      await makePartner('suppliers', 'New supplier', supplierBCode, `Price Supplier B ${stamp}`);
      await makePartner('customers', 'New customer', customerCode, `Price Customer ${stamp}`);

      await administrator.goto('/master-data/items');
      await administrator.getByRole('button', { name: 'New item' }).click();
      const item = administrator.locator('dialog[open], [role="dialog"]').first();
      await item.getByLabel('Code', { exact: true }).fill(itemCode);
      await item.getByLabel(/^Name/).fill(`Priced Item ${stamp}`);
      const uom = item.getByLabel('Base unit', { exact: true });
      await uom.selectOption(
        (await uom.locator('option:not([value=""])').first().getAttribute('value'))!,
      );
      await item.getByRole('button', { name: 'Create' }).click();
      await administrator.waitForURL(new RegExp(`/master-data/items/${itemCode}`), {
        timeout: 60_000,
      });

      for (const [code, name, price] of [
        [supplierACode, `Price Supplier A ${stamp}`, '80'],
        [supplierBCode, `Price Supplier B ${stamp}`, '90'],
      ] as const) {
        await administrator
          .getByLabel('Add a supplier', { exact: true })
          .selectOption({ label: `${code} · ${name}` });
        await saveCurrentPage(() =>
          administrator
            .getByRole('button', { name: 'Link supplier', exact: true })
            .click(),
        );
        const supplierRow = administrator
          .getByRole('row')
          .filter({ hasText: code })
          .first();
        await supplierRow.locator('input[name="price"]').fill(price);
        await saveCurrentPage(() =>
          supplierRow.getByRole('button', { name: 'Save', exact: true }).click(),
        );
      }

      const sellingForm = administrator
        .locator('form')
        .filter({ has: administrator.locator('input[name="price"]') })
        .filter({ hasNot: administrator.locator('input[name="supplierId"]') });
      const sellingPrice = sellingForm.locator('input[name="price"]');
      const sellingButton = sellingForm.getByRole('button', {
        name: 'Save',
        exact: true,
      });
      await expect(sellingButton).toBeEnabled();
      await sellingPrice.fill('150');
      await expect(sellingPrice).toHaveValue('150');
      await expect
        .poll(async () =>
          sellingForm.evaluate(
            (form) => new FormData(form as HTMLFormElement).get('price'),
          ),
        )
        .toBe('150');
      await saveCurrentPage(() => sellingPrice.press('Enter'));
      await expect(administrator.getByLabel(/^Selling price \(IQD\)/)).toHaveValue(
        '150',
      );
    } finally {
      await administration.close();
    }

    await page.goto('/purchasing/ap-invoices/new');
    await page.getByLabel('Supplier Code').fill(supplierACode);
    await page.locator('select[name="item_code_0"]').selectOption(itemCode);
    await expect(page.locator('input[name="quantity_0"]')).toHaveValue('1');
    await expect(page.locator('input[name="unit_price_0"]')).toHaveValue('80.0000');

    await page.getByLabel('Supplier Code').fill(supplierBCode);
    await expect(page.locator('input[name="unit_price_0"]')).toHaveValue('90.0000');
    await page.locator('input[name="unit_price_0"]').fill('95');
    await page.getByLabel('Supplier Code').fill(supplierACode);
    await expect(page.locator('input[name="unit_price_0"]')).toHaveValue('95');

    const warehouse = page.locator('select[name="warehouse_code_0"]');
    await warehouse.selectOption(
      (await warehouse.locator('option:not([value=""])').first().getAttribute('value'))!,
    );
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/purchasing\/ap-invoices\/(?!new\b)[^/]+$/, {
      timeout: 60_000,
    });
    const draftUrl = page.url();

    const secondAdministration = await browser.newContext();
    const priceEditor = await secondAdministration.newPage();
    try {
      await signIn(priceEditor, ADMIN);
      await priceEditor.goto(`/master-data/items/${itemCode}`);
      const supplierRow = priceEditor
        .getByRole('row')
        .filter({ hasText: supplierACode })
        .first();
      await supplierRow.locator('input[name="price"]').fill('85');
      await Promise.all([
        priceEditor.waitForURL(/saved=1/, { timeout: 60_000 }),
        supplierRow.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
    } finally {
      await secondAdministration.close();
    }

    await page.goto(draftUrl);
    await expect(
      page
        .locator('table[aria-labelledby="ap-invoice-document-lines-heading"]')
        .locator('tbody tr:not([aria-hidden="true"])')
        .first()
        .getByLabel('Unit Price', { exact: true }),
    ).toHaveValue('95');

    await page.goto('/sales/ar-invoices/new');
    await page.getByLabel('Customer Code').fill(customerCode);
    await page.getByLabel('Item Code', { exact: true }).first().fill(itemCode);
    await expect(page.locator('input[name="quantity_0"]')).toHaveValue('1');
    await expect(page.locator('input[name="unit_price_0"]')).toHaveValue('150.0000');
    await expect(page.locator('input[name="quantity_0"]')).toBeEnabled();
    await expect(page.locator('input[name="unit_price_0"]')).toBeEnabled();
  });

  test('§3.3 · an account is mapped to a document line, on the row', async ({
    browser,
    page,
  }) => {
    /*
     * The screen that did not exist while every document needed it. The
     * Purchase Invoice refuses to post without an account for what the company
     * owes, and said so by naming this page — so the page is proved the way the
     * invoice was: by pressing the control and reading back what it saved.
     *
     * As the administrator: §4.3 puts the mapping with the configuration an
     * administrator keeps, and the Accounting Manager who may configure it is
     * not who the seed signs in as here.
     */
    test.setTimeout(180_000);
    const administration = await browser.newContext();
    const administrator = await administration.newPage();
    const stamp = Date.now().toString(36).toUpperCase();

    const supplierAccount = async (name: string) => {
      await administrator.goto('/master-data/chart-of-accounts');
      await administrator.getByRole('button', { name: 'New account' }).click();
      const dialog = administrator.locator('dialog[open], [role="dialog"]').first();
      const under = dialog.getByLabel('Under', { exact: true });
      const parent = under
        .locator('option:not([disabled])')
        .filter({ hasText: 'Liabilities' })
        .first();
      const parentId = await parent.getAttribute('value');
      await under.selectOption(parentId!);
      await dialog.getByLabel(/^Name/).fill(name);
      await dialog.getByRole('button', { name: 'Create' }).click();
      await administrator.waitForURL(/\/master-data\/chart-of-accounts\/[A-Z]\d+/, {
        timeout: 60_000,
      });

      const path = new URL(administrator.url()).pathname;
      const accountId = await administrator.locator('input[name="id"]').first().inputValue();
      const controlForm = administrator
        .locator('form')
        .filter({ has: administrator.locator('select[name="controlAccount"]') });
      await controlForm
        .getByLabel('Control account', { exact: true })
        .selectOption('supplier');
      await controlForm.getByRole('button', { name: 'Save', exact: true }).click();
      await administrator.waitForURL(/saved=1/, { timeout: 60_000 });
      await administrator
        .getByRole('button', { name: 'Submit for approval', exact: true })
        .click();
      await expect(
        administrator.getByText('Pending approval', { exact: true }).first(),
      ).toBeVisible({ timeout: 30_000 });

      await page.goto(path);
      await expect(page.getByLabel('Control account', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      return { accountId, path };
    };

    try {
      await signIn(administrator, ADMIN);
      const first = await supplierAccount(`E2E Supplier Payable ${stamp} A`);

      const officers = await browser.newContext();
      const officer = await officers.newPage();
      try {
        await signIn(officer, OFFICER);
        await officer.goto(first.path);
        await expect(officer.getByLabel('Control account', { exact: true })).toHaveCount(0);
      } finally {
        await officers.close();
      }

      const second = await supplierAccount(`E2E Supplier Payable ${stamp} B`);
      await administrator.goto('/finance/posting-mappings');
      await expect(
        administrator.getByRole('heading', { name: 'Posting Mappings' }).first(),
      ).toBeVisible();

      // The line every purchase invoice credits, and the account it will go to.
      for (const accountId of [first.accountId, second.accountId]) {
        await administrator.goto('/finance/posting-mappings');
        const row = administrator
          .getByRole('row')
          .filter({ hasText: 'What the company owes the supplier' })
          .first();
        await row.getByRole('combobox').selectOption(accountId);
        await Promise.all([
          administrator.waitForURL(/posting-mappings\?saved=1/, { timeout: 60_000 }),
          row.getByRole('button', { name: 'Save' }).click(),
        ]);
        // Saved, and read back from the database rather than from the form.
        await administrator.reload();
        await expect(
          administrator
            .getByRole('row')
            .filter({ hasText: 'What the company owes the supplier' })
            .first()
            .getByRole('combobox'),
        ).toHaveValue(accountId);
      }
    } finally {
      await administration.close();
    }
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
    for (const column of ['Item Code', 'Item Name', 'Quantity', 'Unit Price', 'Discount', 'Supplier']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }

    const supplier = page.locator('select[name="supplier_id_0"]');
    // Block 5: "Item Code (searchable); Item Name (searchable)" — typed into
    // over a list, not chosen from a drop-down.
    const item = page.locator('input[name="item_code_0"]');

    // Nothing chosen: the column is there and has nothing to offer, which is
    // the item's doing rather than a fault, so it is disabled rather than gone.
    await expect(supplier).toBeDisabled();

    // "When an item is selected, the supplier field shows the supplier(s)
    // linked to that item." Choosing one is what makes the field live.
    // The item the supplier was just linked to, by name — not "the first one
    // on the list". The list grows with every run of this suite, and the item
    // that happens to sort first has no supplier behind it, so the assertion
    // below would be about the wrong item.
    const itemList = await item.getAttribute('list');
    await expect(
      page.locator(`datalist[id="${itemList}"] option[value="ITM-SEED"]`),
    ).toHaveCount(1);
    await item.fill('ITM-SEED');
    await expect(supplier).toBeEnabled();

    // "Selecting the Item Code brings the Item Name."
    await expect(page.locator('input[aria-label="Item Name"]').first()).not.toHaveValue('');

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
    const choices = page.locator('select[name="invoice"] option:not([value=""])');
    if ((await choices.count()) === 0) {
      // Nothing posted to return against yet — the page says so rather than
      // offering a form that cannot be completed.
      await expect(page.getByText('Post a sales invoice first.')).toBeVisible();
      return;
    }

    // The form belongs to an invoice, so one is chosen before there is a form.
    await page
      .locator('select[name="invoice"]')
      .selectOption((await choices.first().getAttribute('value'))!);
    await page.getByRole('button', { name: 'Choose the invoice being returned against.' }).click();
    await page.waitForURL(/invoice=/, { timeout: 60_000 });

    await expect(offset).toHaveCount(1);
    await expect(offset.locator('option')).toHaveCount(2);
  });

  test('block 10 · the Purchase Returns register opens', async ({ page }) => {
    await page.goto('/purchasing/goods-returns');

    await expect(page.getByRole('heading', { name: 'Purchase Returns' }).first()).toBeVisible();
    for (const column of ['Supplier Code', 'Supplier Name', 'Offset Account']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }
  });

  test('block 10 · the return form asks for one offset account', async ({ page }) => {
    await page.goto('/purchasing/goods-returns/new');
    await expect(page.getByRole('heading', { name: 'New return' })).toBeVisible();

    const choices = page.locator('select[name="invoice"] option:not([value=""])');
    if ((await choices.count()) === 0) {
      await expect(page.getByText('Post a purchase invoice first.')).toBeVisible();
      return;
    }

    // The form belongs to an invoice, so one has to be chosen before there is
    // a form to look at. Asserting without choosing passed only while the
    // database held no posted invoice — which is to say, it asserted nothing.
    await page
      .locator('select[name="invoice"]')
      .selectOption((await choices.first().getAttribute('value'))!);
    await page.getByRole('button', { name: 'Choose the invoice being returned against.' }).click();
    await page.waitForURL(/invoice=/, { timeout: 60_000 });

    // "Accounts Payable or Bank — one must be selected", and the sign is the
    // mirror of block 9's: the debt shrinks, or the money comes back.
    const offset = page.locator('select[name="offset_kind"]');
    await expect(offset).toHaveCount(1);
    await expect(offset.locator('option')).toHaveCount(2);
    await expect(offset.locator('option').first()).toHaveText('Accounts Payable');
  });

  test('block 6 · Payments and Receipts open, with the bank columns', async ({ page }) => {
    await page.goto('/purchasing/supplier-payments');
    await expect(page.getByRole('heading', { name: 'Payments' }).first()).toBeVisible();
    for (const column of ['Supplier Code', 'Supplier Name', 'Bank/Cash Code', 'Bank/Cash Name']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }

    await page.goto('/sales/customer-receipts');
    await expect(page.getByRole('heading', { name: 'Receipts' }).first()).toBeVisible();
    for (const column of ['Customer Code', 'Customer Name', 'Bank/Cash Code', 'Bank/Cash Name']) {
      await expect(page.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
    }
  });

  test('block 6 · a payment can be recorded against a bank account', async ({ page }) => {
    await page.goto('/purchasing/supplier-payments/new');
    await expect(page.getByRole('heading', { name: 'New payment' })).toBeVisible();

    // Both pickers have something in them, or the screen is built and unusable.
    // Supplier and bank are both code-and-name pairs now — inputs over
    // datalists rather than selects, so it is the lists that are counted.
    await expect(page.locator('datalist option')).not.toHaveCount(0);
    const bank = page.getByLabel('Bank/Cash Name');
    const bankOptions = page.locator(
      `datalist#${(await bank.getAttribute('list'))!} option`,
    );
    if ((await bankOptions.count()) === 0) {
      await expect(page.getByText('Set up a bank or cash account first.')).toBeVisible();
      return;
    }

    // A paired picker submits the id only when what is typed matches an option
    // exactly, so the test picks one the way a person would: read the first
    // entry out of the list and type it.
    const supplierList = page.locator(
      `datalist#${(await page.getByLabel('Supplier Name').getAttribute('list'))!} option`,
    );
    await page.getByLabel('Supplier Name').fill((await supplierList.first().getAttribute('value'))!);
    await bank.fill((await bankOptions.first().getAttribute('value'))!);
    await page.getByLabel('Amount').fill('1000');
    await page.getByRole('button', { name: 'Create' }).click();

    // Wait for the navigation rather than for the text. The record page may be
    // compiling for the first time, and an assertion that starts its own clock
    // fails on a cold build while passing on every warm one — which is a flaky
    // test, and a flaky test gets muted.
    await page.waitForURL(/\/purchasing\/supplier-payments\/PAY-/, { timeout: 60_000 });

    // The payment exists and says what is still unallocated, which is the whole
    // of it until somebody puts it against an invoice.
    await expect(page.getByText('Unallocated')).toBeVisible({ timeout: 30_000 });

    // Every record carries its history, as the master-data screens do. A
    // document you cannot ask "who did this, and when" of is a document you
    // cannot defend a year later.
    await expect(page.getByRole('link', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

    // The Journal Entry's window: the document's type and number in the title
    // bar, its fields in boxes, a disclosed lines grid, and the verbs in the
    // foot beside the totals. Asserting the chrome, because "same as journals"
    // is the thing that was asked for and the thing that drifts.
    const window = page.locator('#payment-document');
    await expect(window).toBeVisible();
    await expect(window.getByText('Supplier Payments', { exact: false }).first()).toBeVisible();
    await expect(window.getByText('Supplier Invoice', { exact: true })).toBeVisible();
  });

  test('block 8 · Invoice Status Tracking shows the four stages', async ({ page }) => {
    await page.goto('/inventory/in-transit');

    await expect(page.getByRole('heading', { name: 'Invoice Status Tracking' })).toBeVisible();

    // The sponsor's four, in his order, in one picker rather than five links.
    // Nothing is created here — a shipment appears when a Purchase Invoice
    // posts, which is what "automatically copied to this section" means.
    const stages = page.locator('select[name="status"]');
    await expect(stages).toBeVisible();
    for (const stage of ['In Process', 'On Board', 'On Port', 'In Bounded']) {
      await expect(stages.locator('option', { hasText: stage })).toHaveCount(1);
    }
  });
});
