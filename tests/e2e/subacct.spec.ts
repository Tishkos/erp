import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 1 §1 — sub-accounts.
 *
 * An account opened as a posting account can be turned into a header while it
 * has never been posted to, and then holds accounts beneath it. Two people play
 * it out here — since 0168 one person could do the whole thing, but the
 * handover is the case worth covering, because that is where an approver is
 * reading somebody else's work.
 *
 * Requires `npm run db:seed`.
 */
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/** Opens the dialog and raises one account under the named parent. */
async function raiseAccount(page: Page, under: string, name: string): Promise<string> {
  await page.goto('/master-data/chart-of-accounts');
  await expect(page.getByRole('button', { name: 'New account' })).toBeVisible();
  await page.waitForTimeout(2_500);
  await page.getByRole('button', { name: 'New account' }).click();
  await page.waitForTimeout(1_500);

  const picker = page.getByRole('combobox', { name: 'Under' });
  const option = picker.locator('option').filter({ hasText: under }).first();
  await expect(option, `"${under}" is offered as a parent`).toHaveCount(1);
  // A parent that has only just been approved may still be drawn from a
  // moment ago, when it was not yet choosable.
  await expect(option).toBeEnabled({ timeout: 20_000 });
  await picker.selectOption((await option.getAttribute('value'))!);

  await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/master-data\/chart-of-accounts\/A\d+/, { timeout: 60_000 });
  return page.url().split('/').pop()!;
}

/** Turns an account into a header, confirming by what the record then says. */
async function allowSubAccounts(page: Page, code: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto(`/master-data/chart-of-accounts/${code}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(2_500);
    if (await page.getByText('This is a header account.', { exact: false }).count()) return;
    await page.getByRole('button', { name: 'Let it hold sub-accounts' }).click();
    await page.waitForTimeout(3_000);
  }
  await expect(page.getByText('This is a header account.', { exact: false })).toBeVisible();
}

/** Presses a record action and waits for the status it should produce. */
async function press(page: Page, name: string, expected: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Already there — a previous press did its work while we were waiting.
    if (await page.getByText(expected, { exact: true }).first().isVisible().catch(() => false)) return;
    const button = page.getByRole('button', { name, exact: true }).first();
    if ((await button.count()) === 0) break;
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    try {
      await expect(page.getByText(expected, { exact: true }).first()).toBeVisible({ timeout: 25_000 });
      return;
    } catch {
      await page.reload();
      await page.waitForTimeout(2_000);
    }
  }
  await expect(page.getByText(expected, { exact: true }).first()).toBeVisible({ timeout: 25_000 });
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('an account is given sub-accounts, and one hangs beneath it', async ({ page }) => {
  const run = Date.now().toString(36).toUpperCase().slice(-5);

  // Raised as an ordinary posting account under Assets.
  await signIn(page, OFFICER);
  const parent = await raiseAccount(page, 'Assets', `Bank ${run}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(2_000);
  await press(page, 'Submit for approval', 'Pending approval');

  // Approved by somebody else, which is what makes it usable at all.
  await signIn(page, MANAGER);
  await page.goto(`/master-data/chart-of-accounts/${parent}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(2_000);
  await press(page, 'Approve', 'Approved');

  // It holds nothing yet — and now it may.
  await expect(page.getByText('Sub-accounts', { exact: true }).first()).toBeVisible();
  await allowSubAccounts(page, parent);

  // A sub-account hangs under it, inheriting its type. Raised by the officer so
  // the approval below is again one person reading another's work.
  await signIn(page, OFFICER);
  const child = await raiseAccount(page, parent, `Bank ${run} — current`);
  expect(child).not.toBe(parent);
  await expect(page.getByText(parent).first()).toBeVisible();

  // And the sub-account can hold sub-accounts of its own: the chart goes as
  // deep as a real one needs to, not one level.
  await page.waitForTimeout(2_000);
  await press(page, 'Submit for approval', 'Pending approval');

  await signIn(page, MANAGER);
  await page.goto(`/master-data/chart-of-accounts/${child}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForTimeout(2_000);
  await press(page, 'Approve', 'Approved');
  await allowSubAccounts(page, child);

  const grandchild = await raiseAccount(page, child, `Bank ${run} — current, IQD`);
  expect(grandchild).not.toBe(child);
  await expect(page.getByText(child).first()).toBeVisible();
});
