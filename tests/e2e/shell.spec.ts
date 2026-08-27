import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 01.12 test gate, in a browser.
 *
 * The rules that can be judged without rendering are unit-tested in
 * tests/unit/ui-frameworks.test.ts. These are the ones that cannot: that the
 * shell actually refuses an unauthenticated visitor, that the navigation shows
 * what the signed-in user may reach, and that an export leaves with exactly the
 * rows the screen had.
 *
 * Requires `npm run db:seed`.
 */

// The two seeded users differ only in role, which is the point: the officer may
// read the chart and submit changes; only the manager may approve or export it.
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

async function signIn(page: Page, user = OFFICER) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe('§25 · deny by default', () => {
  test('an unauthenticated visitor is sent to sign in, not to a screen', async ({ page }) => {
    await page.goto('/master-data/chart-of-accounts');
    // Navigation hiding is not access control — the page itself refuses.
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('the sign-in failure does not say which part was wrong', async ({ page }) => {
    // Distinguishing "no such account" from "wrong password" turns the form
    // into a way of discovering who has an account.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@example.com');
    await page.getByLabel('Password', { exact: true }).fill('Ledger-Trial-Balance-7');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Scoped to the form: Next renders its own route announcer with role=alert.
    await expect(page.locator('form[role="alert"], form [role="alert"]')).toContainText(
      'not accepted',
    );
  });

  test('signing out from the user menu ends the session for good', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Open user menu' }).click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in/);

    // §25 — revocation is immediate: the cookie is gone *and* the session is
    // revoked server-side, so going back to a screen asks for credentials.
    await page.goto('/master-data/chart-of-accounts');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe('01.2 gate · denial on the direct URL, not a hidden menu item', () => {
  const OUTSIDER = { email: 'outsider@example.com', password: 'Ledger-Trial-Balance-7' };

  test('refuses the page itself to a signed-in user with no grants', async ({ page }) => {
    await signIn(page, OUTSIDER);

    // Nothing is in their menu — but that is not the control being tested.
    await expect(page.getByRole('navigation').getByRole('link')).toHaveCount(0);

    // The control is that typing the URL is refused too.
    await page.goto('/master-data/chart-of-accounts');
    await expect(page.locator('.panel[role="alert"]')).toContainText('do not have permission');
    await expect(page.locator('table.list')).toHaveCount(0);
  });

  test('tells them what to ask for, rather than only refusing', async ({ page }) => {
    // §25 — reason and corrective action, not a stack trace or a blank 500.
    await signIn(page, OUTSIDER);
    await page.goto('/master-data/chart-of-accounts');
    await expect(page.locator('.panel[role="alert"]')).toContainText('Ask an administrator');
  });

  test('refuses the API for the same user and object', async ({ page, request }) => {
    await signIn(page, OUTSIDER);
    const cookies = await page.context().cookies();
    const response = await request.get('/master-data/chart-of-accounts/export', {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    expect(response.ok()).toBe(false);
  });
});

test.describe('Appendix A · the shell', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('shows the approved menu tree, and marks what is not built yet', async ({ page }) => {
    const nav = page.getByRole('navigation');
    // Master Data sits under Accounting, alongside the sample document that
    // exercises it — Settings is administration only.
    await nav.getByRole('button', { name: 'Accounting' }).click();
    await expect(nav.getByText('Master Data', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Chart of Accounts' })).toBeVisible();

    // Appendix A's tree is mandatory at functional level, so a page whose
    // module has not arrived is shown and marked, never silently dropped.
    //
    // It used to be shown as inert text. Every screen in the tree now has an
    // address — the one its module declared, or one the screen catalogue
    // derives — so the item opens, and what marks it as not-yet-live is the
    // phase badge here plus the preview banner on the screen itself. An item
    // that renders but refuses to open was the worse of the two honesty
    // signals: it left 176 of 218 functions with no way to see them at all.
    const pending = nav.getByRole('link', { name: 'Price Lists', exact: true });
    await expect(pending).toBeVisible();
    await expect(pending).toHaveAttribute('href', '/master-data/price-lists');
  });

  test('opens a screen the tree offers but no module has wired yet', async ({ page }) => {
    // The other half of the promise above: the link resolves, and the screen it
    // reaches says plainly that its figures are samples.
    await page.goto('/master-data/price-lists');
    await expect(page.getByRole('heading', { name: 'Price Lists', level: 1 })).toBeVisible();
    // No sample figures anywhere: an unbuilt screen says which phase delivers it.
    await expect(page.getByText('This screen is not available yet.', { exact: true })).toBeVisible();
  });

  test('declares the language and direction the whole layout flips on', async ({ page }) => {
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', /.+/);
    await expect(html).toHaveAttribute('dir', /^(ltr|rtl)$/);
  });

  test('switches the navbar theme and keeps the choice after reload', async ({ page }) => {
    const html = page.locator('html');
    const theme = page.getByRole('button', { name: 'Theme: Light / Dark' });

    await expect(theme).toHaveAttribute('aria-pressed', 'false');
    await theme.click();
    await expect(theme).toHaveAttribute('aria-pressed', 'true');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('shows the branch the session is working in', async ({ page }) => {
    // Posting to the wrong branch is expensive to unwind (§4.1), so which one
    // is in force is on screen rather than in a menu.
    await expect(page.getByRole('banner')).toContainText('HQ');
  });
});

test.describe('Appendix A rule 1 · lists', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/master-data/chart-of-accounts');
  });

  test('lists the chart, in code order', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Chart of Accounts' })).toBeVisible();
    const codes = await page.locator('table.list tbody tr td:first-child').allInnerTexts();
    expect(codes.length).toBeGreaterThan(0);
    expect([...codes]).toEqual([...codes].sort());
  });

  test('searches, and says plainly when nothing matches', async ({ page }) => {
    await page.getByRole('searchbox', { name: 'Search' }).fill('Liabilit');
    await page.locator('main form[role="search"] button').click();
    await expect(page.locator('table.list tbody tr')).toHaveCount(1);

    await page.getByRole('searchbox', { name: 'Search' }).fill('zzzz-no-such-account');
    await page.locator('main form[role="search"] button').click();
    // §25 — not a generic failure; it says what to do next.
    await expect(page.getByText('No records match these filters.')).toBeVisible();
    await expect(page.getByText('Clear a filter')).toBeVisible();
  });

  test('refuses the export to someone without the export permission', async ({ page, request }) => {
    // The officer may read the chart on screen and may not take a copy of it.
    // §5.3 lists `export` as its own verb precisely so the two can differ, and
    // the route enforces it rather than relying on the button being hidden.
    const cookies = await page.context().cookies();
    const response = await request.get('/master-data/chart-of-accounts/export', {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    expect(response.ok()).toBe(false);
  });
});

test.describe('01.12 gate · export returns exactly the on-screen rows', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, MANAGER);
    await page.goto('/master-data/chart-of-accounts');
  });

  test('gives the manager the same rows the screen showed', async ({ page, request }) => {
    // Same query string to both paths; the export may only widen the page
    // window, never a filter, a column or a scope.
    await page.getByRole('searchbox', { name: 'Search' }).fill('Liabilit');
    await page.locator('main form[role="search"] button').click();
    await page.waitForURL(/q=Liabilit/);
    const onScreen = await page.locator('table.list tbody tr').count();

    const cookies = await page.context().cookies();
    const response = await request.get('/master-data/chart-of-accounts/export?q=Liabilit', {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });

    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/csv');

    const lines = (await response.text()).trim().split('\r\n');
    expect(lines.length - 1).toBe(onScreen); // minus the header row
  });

  test('exports every row when the screen is unfiltered', async ({ page, request }) => {
    const onScreen = await page.locator('table.list tbody tr').count();

    const cookies = await page.context().cookies();
    const response = await request.get('/master-data/chart-of-accounts/export', {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });

    const lines = (await response.text()).trim().split('\r\n');
    expect(lines.length - 1).toBe(onScreen);
    // The header row names the columns the reader was allowed to see.
    expect(lines[0]).toContain('code');
    expect(lines[0]).toContain('account_type');
  });

  test('is not cached by anything in front of the server', async ({ page, request }) => {
    const cookies = await page.context().cookies();
    const response = await request.get('/master-data/chart-of-accounts/export', {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});
