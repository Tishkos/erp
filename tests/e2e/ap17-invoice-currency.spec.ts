import { expect, test, type Page } from '@playwright/test';

/**
 * A purchase invoice agreed in dollars, and the dinars beside it — by
 * direction, 2026-10-03.
 *
 * The company buys from Shenzhen in dollars and keeps its books in dinars, so
 * whoever enters the invoice types the supplier's own figures and has to see
 * what the ledger will carry before pressing Create. The header names the
 * currency and says the rate in force; the totals row says both figures, one
 * under the other; the advance percentage says what its share comes to in each.
 *
 * The arithmetic is held by `tests/unit/ap17-invoice-currency.test.ts` and
 * `ap16-advance-field.test.ts`, which run the browser's conversion and the
 * server's over the same figures. What is under test here is the wiring and the
 * **geometry**: that the two figures share a right edge.
 *
 * That last part is the reason this file exists. The dinar figure was first
 * drawn with `sapGridCaption` — the bordered strip that carries "▾ Lines" — and
 * its 0.55rem of padding pushed the figure in from the cell's edge, so the two
 * totals sat a few pixels out of line. It was reported twice and reasoned about
 * twice before anybody measured it. Now it is measured.
 *
 * The account: `E2E_EMAIL`, defaulting to the development seed's accounting
 * officer. A database seeded by `scripts/seed-dev.ts` has that one; a database
 * carrying a company's own people has whatever `ensure-ceo-user.ts` made.
 */
const PASSWORD = process.env.SEED_PASSWORD ?? 'Ledger-Trial-Balance-7';
const EMAIL = process.env.E2E_EMAIL ?? 'officer@example.com';

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

/** The right edge of an element, to the pixel the browser laid it out on. */
async function rightEdge(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} has no box`).not.toBeNull();
  return box!.x + box!.width;
}

test.describe('AP-17 · a dollar invoice shows its dinars', () => {
  test('the rate, the totals flush, and the advance', async ({ page }) => {
    await signIn(page);
    await page.goto('/payables/invoices/new');

    // The form itself, not an error boundary.
    const currency = page.locator('select[name="currency"]');
    await expect(currency).toBeVisible();
    await currency.selectOption('USD');

    // "1 USD = 1,307 IQD" — the rate in force, and nothing else beside it.
    const rate = page.getByText(/^1 USD = [\d,]+(\.\d+)? IQD$/);
    await expect(rate).toBeVisible();
    // The rate, which is the *second* number in "1 USD = 1,307 IQD": stripping
    // the non-digits would read the leading 1 as part of it and ask for
    // 11,307 dinars to the dollar.
    const said = /=\s*([\d,]+(?:\.\d+)?)\s*IQD/.exec(await rate.innerText());
    expect(said, 'the rate caption did not parse').not.toBeNull();
    const perDollar = Number(said![1]!.replace(/,/g, ''));
    expect(perDollar).toBeGreaterThan(100);

    // A line: 79 at 79 dollars, the figures that were on the screen when the
    // misalignment was reported.
    await page.locator('input[name="quantity_0"]').fill('79');
    await page.locator('input[name="unit_price_0"]').fill('79');

    const totals = page.locator('tfoot tr').last();
    const dollars = 79 * 79;
    await expect(totals).toContainText(dollars.toLocaleString('en-US', { minimumFractionDigits: 2 }));
    const dinars = Math.round(dollars * perDollar);
    await expect(totals).toContainText(dinars.toLocaleString('en-US'));

    /*
     * And the two share a right edge. The dollars are the cell's own text and
     * the dinars are the block under them, so the measurement is of the two
     * boxes rather than of the stylesheet: a padding or a border on either one
     * shows up here as a gap.
     */
    // `[class*=]` because the class names are hashed by the CSS module.
    const cell = 'tfoot tr:last-child td[class*="sapNum"]';
    const dollarEdge = await rightEdge(page, `${cell} > bdi:nth-of-type(1)`);
    const dinarEdge = await rightEdge(page, `${cell} > bdi:nth-of-type(2)`);
    expect(Math.abs(dollarEdge - dinarEdge)).toBeLessThanOrEqual(1);

    // Twenty per cent in front: the share in dollars and in dinars.
    const advance = page.locator('input[name="advance_percent"]');
    await advance.fill('20');
    const share = page.locator('input[name="advance_percent"] + span');
    await expect(share).toContainText(
      (dollars * 0.2).toLocaleString('en-US', { minimumFractionDigits: 2 }),
    );
    // One line, whatever the figures come to.
    const lines = await share.evaluate((node) => {
      const style = getComputedStyle(node);
      return node.getBoundingClientRect().height / parseFloat(style.lineHeight || '0');
    });
    expect(lines).toBeLessThan(1.6);

    // Never more than the whole invoice.
    await advance.fill('120');
    await expect(advance).toHaveValue('100');

    // There is no due date here — it is set once the SWIFT is confirmed — and
    // no second box asking for the terms the import application already holds.
    await expect(page.locator('input[name="due_date"]')).toHaveCount(0);
    await expect(page.locator('input[name="payment_terms_text"]')).toHaveCount(0);

    // A note, after the totals.
    const note = page.locator('input[name="note"]');
    await expect(note).toBeVisible();
    const notesTop = (await note.boundingBox())!.y;
    const totalsTop = (await totals.boundingBox())!.y;
    expect(notesTop).toBeGreaterThan(totalsTop);
  });
});
