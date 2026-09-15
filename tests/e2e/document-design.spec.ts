import { expect, test, type Page } from '@playwright/test';

/**
 * A Purchase Invoice is built like a Journal Entry.
 *
 * Asserted by comparing the two pages rather than by reading the code, because
 * "same as journals" was claimed twice from the source and was wrong twice. The
 * structure a person sees is the thing being asked for, so the structure a
 * person sees is what this reads.
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

    await page.goto('/purchasing/ap-invoices');

    // Wait for the register to have rendered before deciding it is empty. A
    // `count()` against a page still compiling answers zero, and the test then
    // skips itself — which reads as "passed" and proves nothing.
    await expect(page.getByRole('heading', { name: 'Purchase Invoices' }).first()).toBeVisible({
      timeout: 60_000,
    });

    // Not `/new`: that is the form, and it carries no document window. The
    // register's own rows are the only links to a record.
    const firstInvoice = page
      .locator('a[href^="/purchasing/ap-invoices/"]:not([href$="/new"])')
      .first();
    if ((await firstInvoice.count()) === 0) {
      test.skip(true, 'No purchase invoice to compare — raise one first.');
      return;
    }
    await firstInvoice.click();
    await page.waitForURL(/\/purchasing\/ap-invoices\/.+/);
    await expect(page.locator('#ap-invoice-document')).toBeVisible({ timeout: 60_000 });
    const invoice = await shapeOf(page, '#ap-invoice-document');

    // Every structural part the journal has, the invoice has — except the ones
    // that are about a journal's content rather than a document's shape. An
    // account cell holds "code · name" and an invoice has no accounts on it;
    // requiring that would be requiring the invoice to be a journal.
    const contentOnly = ['sapAccountCell'];
    const missing = journal
      .filter((part) => !contentOnly.includes(part))
      .filter((part) => !invoice.includes(part));

    expect(missing).toEqual([]);
  });
});
