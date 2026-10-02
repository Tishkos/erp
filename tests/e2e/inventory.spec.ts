import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 04.4 test gate — *"An issue exceeding available stock is rejected via
 * the UI."*
 *
 * A separate item from the API and import ones on purpose. Those prove the rule
 * holds; this proves the refusal **reaches a person as a sentence they can act
 * on**. §25: *"Validation messages identify the field, reason and corrective
 * action; no generic 'something went wrong' for business errors."* A screen is
 * where that is judged, and a 500 page would satisfy the rule and fail the
 * requirement.
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

/** The row of the seeded item in the seeded warehouse, and one of its bucket cells by column header. */
const SEED_ROW = (page: Page) => page.locator('table[aria-labelledby="availability-title"] tbody tr', { hasText: 'ITM-SEED' }).filter({ hasText: 'WH-HQ' }).first();
const AVAILABLE_CELL = 5; // item, name, warehouse, branch, on hand, available

async function issue(page: Page, quantity: string) {
  await page.getByRole('button', { name: 'Issue stock' }).click();
  const dialog = page.getByRole('dialog', { name: 'Issue stock' });
  await dialog.getByLabel('Item Code', { exact: true }).selectOption('ITM-SEED');
  await dialog.getByLabel('Warehouse Code', { exact: true }).selectOption('WH-HQ');
  await dialog.getByLabel('Batch', { exact: true }).fill('B-SEED');
  await dialog.getByRole('textbox', { name: 'Quantity' }).fill(quantity);
  await dialog.getByRole('button', { name: 'Issue', exact: true }).click();
}

const numberIn = async (page: Page, cell: number) => Number((await SEED_ROW(page).locator('td').nth(cell).innerText()).replace(/[^\d.]/g, ''));

test.describe('04.4 gate · the UI path', () => {
  // Serial, because these tests read and move the same seeded stock. Run in
  // parallel they interfere with each other, which would make a real refusal
  // look like a flake — and a flaky control test is worse than none, because it
  // gets muted.
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/inventory/availability');
  });

  test('shows the §9.5 buckets for stock on hand, as a register with the Inventory tabs (REQ-FIX-001 FX4)', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Availability', level: 1 })).toBeVisible();
    const table = page.locator('table[aria-labelledby="availability-title"]');
    await expect(table.locator('th', { hasText: 'Available' })).toBeVisible();
    await expect(table.locator('th', { hasText: 'On hand' })).toBeVisible();
    // The section's own tabs — the screen is one of Inventory's, not a page apart.
    const tabs = page.getByRole('navigation', { name: 'Availability' });
    await expect(tabs.getByRole('link', { name: 'Stock Movement' })).toBeVisible();
  });

  test('refuses an issue beyond available stock, in words the user can act on', async ({ page }) => {
    const available = await SEED_ROW(page).locator('td').nth(AVAILABLE_CELL).innerText();
    await issue(page, '99999');

    const alert = page.getByRole('alert').filter({ hasText: 'Cannot issue' });
    await expect(alert).toBeVisible();
    // The three things §25 asks for: what was refused, why, and what to do.
    await expect(alert).toContainText('Cannot issue');
    await expect(alert).toContainText('Negative inventory is prohibited without exception');
    await expect(alert).toContainText('Reduce the quantity');
    // And the figures, so the user does not have to go and look them up.
    await expect(alert).toContainText(available.replace(/[^\d.]/g, '').slice(0, 3));
  });

  test('leaves the stock untouched after the refusal', async ({ page }) => {
    const before = await numberIn(page, AVAILABLE_CELL - 1);
    await issue(page, '99999');
    await expect(page.getByRole('alert').filter({ hasText: 'Cannot issue' })).toBeVisible();
    expect(await numberIn(page, AVAILABLE_CELL - 1)).toBe(before);
  });

  test('accepts an issue that fits, and the figures move', async ({ page }) => {
    const before = await numberIn(page, AVAILABLE_CELL - 1);
    await issue(page, '1');
    await expect(page.getByRole('status').filter({ hasText: /saved/i })).toBeVisible();
    expect(await numberIn(page, AVAILABLE_CELL - 1)).toBe(before - 1);
  });
});
