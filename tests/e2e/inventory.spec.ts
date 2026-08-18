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
  await page.getByLabel('Password').fill(MANAGER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

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

  test('shows the §9.5 buckets for stock on hand', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Availability' })).toBeVisible();
    await expect(page.locator('table.list th', { hasText: 'Available' })).toBeVisible();
    await expect(page.locator('table.list th', { hasText: 'On hand' })).toBeVisible();
  });

  test('refuses an issue beyond available stock, in words the user can act on', async ({
    page,
  }) => {
    const available = await page
      .locator('table.list tbody tr')
      .first()
      .locator('td')
      .nth(4)
      .innerText();

    await page.getByLabel('Item', { exact: true }).fill('ITM-SEED');
    await page.getByLabel('Warehouse', { exact: true }).fill('WH-HQ');
    await page.getByLabel('Batch', { exact: true }).fill('B-SEED');
    await page.getByLabel('Quantity', { exact: true }).fill('99999');
    await page.getByRole('button', { name: 'Issue' }).click();

    const alert = page.locator('.panel[role="alert"]');
    await expect(alert).toBeVisible();

    // The three things §25 asks for: what was refused, why, and what to do.
    await expect(alert).toContainText('Cannot issue');
    await expect(alert).toContainText('Negative inventory is prohibited without exception');
    await expect(alert).toContainText('Reduce the quantity');

    // And the figures, so the user does not have to go and look them up.
    await expect(alert).toContainText(available.replace(/[^\d.]/g, '').slice(0, 3));
  });

  test('leaves the stock untouched after the refusal', async ({ page }) => {
    const before = await page.locator('table.list tbody tr').first().locator('td').nth(3).innerText();

    await page.getByLabel('Item', { exact: true }).fill('ITM-SEED');
    await page.getByLabel('Warehouse', { exact: true }).fill('WH-HQ');
    await page.getByLabel('Batch', { exact: true }).fill('B-SEED');
    await page.getByLabel('Quantity', { exact: true }).fill('99999');
    await page.getByRole('button', { name: 'Issue' }).click();
    await expect(page.locator('.panel[role="alert"]')).toBeVisible();

    const after = await page.locator('table.list tbody tr').first().locator('td').nth(3).innerText();
    expect(after).toBe(before);
  });

  test('accepts an issue that fits, and the figures move', async ({ page }) => {
    const before = Number(
      (await page.locator('table.list tbody tr').first().locator('td').nth(3).innerText()).replace(
        /[^\d.]/g,
        '',
      ),
    );

    await page.getByLabel('Item', { exact: true }).fill('ITM-SEED');
    await page.getByLabel('Warehouse', { exact: true }).fill('WH-HQ');
    await page.getByLabel('Batch', { exact: true }).fill('B-SEED');
    await page.getByLabel('Quantity', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Issue' }).click();

    await page.waitForURL(/issued=1/);
    const after = Number(
      (await page.locator('table.list tbody tr').first().locator('td').nth(3).innerText()).replace(
        /[^\d.]/g,
        '',
      ),
    );

    expect(after).toBe(before - 1);
  });
});
