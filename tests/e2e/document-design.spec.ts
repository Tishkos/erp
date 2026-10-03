import { expect, test, type Page } from '@playwright/test';

/**
 * A Purchase Invoice is built like a Journal Entry.
 *
 * Asserted by comparing the two pages rather than by reading the code, because
 * "same as journals" was claimed twice from the source and was wrong twice. The
 * structure a person sees is the thing being asked for, so the structure a
 * person sees is what this reads.
 *
 * Four claims, four tests: it wears the same window, its grid grows as it is
 * typed the way the journal's does, it names everybody it passed through, and
 * a draft is corrected on the document itself rather than raised again.
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

/**
 * A purchase invoice to read: the register's first, or — on a database no
 * earlier spec has raised one on — a draft raised here through the form, so
 * the comparison never depends on what another run left behind.
 */
async function anInvoice(page: Page): Promise<void> {
  await page.goto('/payables/invoices');
  await expect(page.getByRole('heading', { name: 'Purchase Invoices' }).first()).toBeVisible({
    timeout: 60_000,
  });
  // Not `/new`: that is the form, and it carries no document window. The
  // register's own rows are the only links to a record.
  const firstInvoice = page.locator('a[href^="/payables/invoices/"]:not([href$="/new"])').first();
  if ((await firstInvoice.count()) > 0) {
    await firstInvoice.click();
  } else {
    await page.goto('/payables/invoices/new');
    await page.getByLabel('Supplier Code').fill('SUP-00001');
    await page.locator('[name="item_code_0"]').fill('ITM-SEED');
    await page.locator('input[name="quantity_0"]').fill('1');
    await page.locator('input[name="unit_price_0"]').fill('1000');
    await page.locator('select[name="warehouse_code_0"]').selectOption('WH-HQ');
    // A local purchase: the Import box starts ticked (2026-10-03).
    await page.locator('input[name="is_import"]').uncheck();
    await page.getByRole('button', { name: 'Create' }).click();
  }
  await page.waitForURL(
    (url) => url.pathname.startsWith('/payables/invoices/') && !url.pathname.endsWith('/new'),
    { timeout: 120_000 },
  );
  await expect(page.locator('#ap-invoice-document')).toBeVisible({ timeout: 60_000 });
}

/**
 * The document's shape: the chrome classes in the order they nest.
 *
 * Module CSS hashes the names, so the raw strings cannot be compared between
 * pages — but the *suffix* after the last underscore is stable, and that is
 * what carries the meaning: sapDoc, sapWindow, sapTitle, sapFields, sapFoot.
 */
async function shapeOf(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluate((root) => {
    const names = new Set<string>();
    const walk = (node: Element) => {
      for (const raw of node.classList) {
        const short = raw.includes('__') ? (raw.split('__').pop() ?? raw) : raw;
        if (short.startsWith('sap')) names.add(short);
      }
      for (const child of node.children) walk(child);
    };
    walk(root);
    return [...names].sort();
  });
}

test.describe('an invoice is built like a journal entry', () => {
  test.describe.configure({ mode: 'serial' });

  test('wears the same document chrome', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);

    // The reference: a posted Journal Entry, whichever one the seed left.
    await page.goto('/finance/journals');
    const firstEntry = page.getByRole('link', { name: /JE-/ }).first();
    await expect(firstEntry).toBeVisible();
    await firstEntry.click();
    await page.waitForURL(/\/finance\/journals\/JE-/);
    const journal = await shapeOf(page, '#journal-document');

    // The journal's own window must carry the parts this comparison is about,
    // or the assertion below would pass by both pages being empty.
    for (const part of ['sapDoc', 'sapWindow', 'sapTitle', 'sapFields', 'sapFoot']) {
      expect(journal).toContain(part);
    }

    await anInvoice(page);
    const invoice = await shapeOf(page, '#ap-invoice-document');

    // Every structural part the journal has, the invoice has — except the ones
    // that are about a journal's content rather than a document's shape. An
    // account cell holds "code · name" and an invoice has no accounts on it;
    // a full-width field exists only where there is a description to put in
    // one, and block 4's header has none (2026-09-16: "no extra details");
    // a link to another record is there only when the entry names one (the
    // document that posted it, the entry it reverses), which depends on which
    // journal the register happens to list first.
    // Requiring any of them would be requiring the invoice to be a journal.
    const contentOnly = ['sapAccountCell', 'sapWide', 'sapLink'];
    const missing = journal
      .filter((part) => !contentOnly.includes(part))
      .filter((part) => !invoice.includes(part));

    expect(missing).toEqual([]);
  });

  test('the line grid opens a new line as each one is filled', async ({ page }) => {
    await signIn(page);
    await page.goto('/payables/invoices/new');
    // The item code is the grid's searchable field — an input over a
    // datalist, as on the sales invoice — not a select.
    await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });

    // One line to start with. There is no "Add line" button to look for —
    // the second row is meant to exist only because the first was filled.
    await expect(page.getByRole('button', { name: /add line/i })).toHaveCount(0);
    await expect(page.locator('[name="item_code_1"]')).toHaveCount(0);

    const itemList = await page.locator('input[name="item_code_0"]').getAttribute('list');
    const item = await page.locator(`datalist[id="${itemList}"] option`).first().getAttribute('value');
    await page.fill('input[name="item_code_0"]', item!);

    await expect(page.locator('input[name="item_code_1"]')).toBeVisible();

    // The line's total follows the typing rather than waiting for the server:
    // three at a thousand, less nothing, is three thousand on screen.
    await page.fill('input[name="quantity_0"]', '3');
    await page.fill('input[name="unit_price_0"]', '1000');
    await expect(page.getByText('IQD 3,000').first()).toBeVisible();

    // How many rows there are travels with the form, because the grid grew
    // after the server drew it and the action has to read what was typed.
    await expect(page.locator('input[name="line_count"]')).toHaveValue('2');

    // And a row is dropped from the row itself.
    await page.getByRole('button', { name: 'Remove line' }).first().click();
    await expect(page.locator('input[name="item_code_0"]')).toHaveValue('');
  });

  test('the document names everybody it passed through', async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await anInvoice(page);

    // Three questions with three different answers, as the Journal Entry asks
    // them. An empty box is an answer too: that step has not happened.
    const document = page.locator('#ap-invoice-document');
    for (const label of ['Raised by', 'Submitted by', 'Posted by']) {
      await expect(document.getByText(label, { exact: true })).toBeVisible();
    }

    // Block 4's header, and nothing else beside it (2026-09-16: "no extra
    // details"). What the document also carries is read from the audit log.
    for (const label of ['Invoice Number', 'Supplier Code', 'Supplier Name']) {
      await expect(document.getByText(label, { exact: true })).toBeVisible();
    }
    for (const gone of ['Match status', 'Branch', 'Description', "Supplier's Invoice Number"]) {
      await expect(document.getByText(gone, { exact: true })).toHaveCount(0);
    }
  });

  test('a draft is corrected on the document itself', async ({ page }) => {
    // Raising a document, saving two lines through it and taking one off again
    // is four server round trips; the default half-minute is not enough.
    test.setTimeout(120_000);
    await signIn(page);

    // Raised here rather than found on the register, so the test owns the
    // draft it is about to edit and does not depend on what an earlier run
    // left behind.
    await page.goto('/sales/ar-invoices/new');
    await expect(page.locator('input[name="item_code_0"]')).toBeVisible({ timeout: 60_000 });

    // Block 5's header is a code and a name that fill each other: typing the
    // code is enough, and the name follows.
    const customer = await page.locator('datalist option').first().getAttribute('value');
    await page.getByLabel('Customer Code').fill(customer!);
    await expect(page.getByLabel('Customer Name')).not.toHaveValue('');

    // The item's own list, not the first datalist on the page — the customer
    // pair has two of its own above it.
    const itemList = await page.locator('input[name="item_code_0"]').getAttribute('list');
    const item = await page
      .locator(`datalist[id="${itemList}"] option`)
      .first()
      .getAttribute('value');
    await page.fill('input[name="item_code_0"]', item!);
    await page.fill('input[name="quantity_0"]', '1');
    await page.fill('input[name="unit_price_0"]', '5000');
    await page.getByRole('button', { name: 'Create' }).click();

    await page.waitForURL(/\/sales\/ar-invoices\/INV-/);
    const document = page.locator('#ar-invoice-document');
    await expect(document).toBeVisible({ timeout: 60_000 });

    // The count in the grid's caption is the server's answer — the number of
    // lines the invoice actually carries. The totals under the grid are summed
    // on screen as it is typed, so waiting on those would pass before anything
    // had been saved, which is how this test first fooled itself.
    const carried = page.locator('#ar-invoice-document-lines-heading');
    await expect(carried).toContainText('1');

    // The one line it was raised with, and a blank one under it. The lines are
    // typed into on the record — not read back as text, as they were.
    const rows = document.locator('tbody tr:not([aria-hidden="true"])');
    await expect(rows).toHaveCount(2);

    // Fill the blank row: another opens under it, as on the form.
    // `.nth(1)` and not `.last()` — the last row moves the moment one opens.
    const second = rows.nth(1);
    await second.locator('input[aria-label="Item Code"]').fill(item!);
    await second.locator('input[aria-label="Quantity"]').fill('2');
    await second.locator('input[aria-label="Unit Price (IQD)"]').fill('3000');
    await expect(rows).toHaveCount(3);

    // Leaving the row saves it. There is no button to press.
    await document.getByText('Lines', { exact: true }).click();
    await expect(carried).toContainText('2', { timeout: 60_000 });

    // And ✕ takes it off again.
    await rows.nth(1).locator('button[aria-label="Remove line"]').click();
    await expect(carried).toContainText('1', { timeout: 60_000 });

    // The last line is refused, on the row it concerns, because an invoice
    // bills for something. The sentence is the service's own.
    await rows.nth(0).locator('button[aria-label="Remove line"]').click();
    await expect(document.getByRole('alert')).toContainText('billing for nothing', {
      timeout: 60_000,
    });
    await expect(carried).toContainText('1');
  });
});
