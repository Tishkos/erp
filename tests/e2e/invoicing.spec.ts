import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 0 · Invoicing — the round trip a person actually performs.
 *
 * An employee opens an invoice, puts items on it and sends it up; the manager
 * of that invoice's department finds it waiting and approves it. Everything
 * Phase 0 promises is visible on the way past: a number the system issued the
 * moment the document existed, a total worked out from its lines, a status
 * that only moves the way §7 allows, and a history that says who did what.
 *
 * Serial, and the tests share one invoice: the point is the journey, not each
 * screen on its own.
 *
 * Requires `npm run db:seed`.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const EMPLOYEE = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };

const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const DEPARTMENT = `IV${RUN}`;
const CUSTOMER = `Customer ${RUN}`;

/** Filled in by the second test, read by the ones after it. */
let documentNo = '';

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.describe('Phase 0 · an invoice goes up for approval and comes back approved', () => {
  test('an administrator gives the department a manager', async ({ page }) => {
    // §5.2 — the approval flow is a property of the department, so this is
    // the setup an administrator does once, not part of raising an invoice.
    await signIn(page, ADMIN);
    await page.goto('/master-data/departments');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'New department' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('textbox', { name: 'Code', exact: true }).fill(DEPARTMENT);
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(`Invoicing ${RUN}`);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(`**/master-data/departments/${DEPARTMENT}?saved=1`, { timeout: 60_000 });

    await page
      .getByLabel('Users')
      .selectOption({ label: 'Accounting Manager · manager@example.com' });
    await page.getByLabel('As department manager').check();
    await page.getByRole('button', { name: 'Add a member' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
  });

  test('the employee opens an invoice, puts items on it and submits it', async ({ page }) => {
    await signIn(page, EMPLOYEE);

    // Requirement 8 — Invoicing is reached from the navigation, under
    // Accounting, beside the Master Data it draws on.
    const nav = page.getByRole('navigation');
    await nav.getByRole('button', { name: 'Accounting' }).click();
    await expect(nav.getByText('Master Data', { exact: true })).toBeVisible();
    await expect(nav.getByText('Sample documenting', { exact: true })).toBeVisible();
    await nav.getByRole('link', { name: 'Invoicing', exact: true }).click();
    await page.waitForURL('**/accounting/invoicing');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Invoicing');

    // Requirement 9 — pressing New invoice opens the document, already
    // numbered. Nobody types a document number in this system.
    await page.goto('/accounting/invoicing');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'New invoice' }).click();
    await page.waitForURL(/\/accounting\/invoicing\/INV-/, { timeout: 60_000 });
    documentNo = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
    expect(documentNo).toMatch(/^INV-\d{4}-\d{5}$/);
    await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();

    // The header: who it is for, and which department approves it.
    await page.waitForLoadState('networkidle');
    await page.getByRole('textbox', { name: 'Customer', exact: true }).fill(CUSTOMER);
    await page.getByRole('combobox', { name: 'Currency' }).selectOption('IQD');
    await page.getByRole('combobox', { name: 'Department' }).selectOption(DEPARTMENT);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    // Two items, and a total the system works out.
    await page.waitForTimeout(1200);
    await page.getByRole('textbox', { name: 'Item', exact: true }).fill('Consultancy, March');
    await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
    await page.getByRole('spinbutton', { name: 'Unit price' }).fill('125.50');
    await page.getByRole('button', { name: 'Add item' }).click();
    await expect(page.getByRole('cell', { name: 'Consultancy, March' })).toBeVisible();

    await page.waitForTimeout(1200);
    await page.getByRole('textbox', { name: 'Item', exact: true }).fill('Printing');
    await page.getByRole('spinbutton', { name: 'Quantity' }).fill('3');
    await page.getByRole('spinbutton', { name: 'Unit price' }).fill('10');
    await page.getByRole('button', { name: 'Add item' }).click();
    await expect(page.getByRole('cell', { name: 'Printing' })).toBeVisible();

    // 2 × 125.50 + 3 × 10 = 281, and the dinar shows no subunit.
    await expect(page.locator('tfoot')).toContainText('281');

    // §21 — the evidence goes with the document.
    await page.setInputFiles('input[type="file"]', {
      name: 'purchase-order.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 the signed order'),
    });
    await page.getByRole('button', { name: 'Attach' }).click();
    await expect(page.getByRole('link', { name: 'purchase-order.pdf' })).toBeVisible();

    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Submit for approval' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByText('Pending approval', { exact: true }).first()).toBeVisible();

    // It is not the employee's to approve, whatever the URL says.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    // Nor are the items theirs to change any more.
    await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);
  });

  test('the manager finds it waiting and approves it', async ({ page }) => {
    await signIn(page, MANAGER);

    await page.goto('/approvals');
    // The inbox row is a card, and the document number on it is the way in.
    const waiting = page.getByRole('link', { name: new RegExp(documentNo) });
    await expect(waiting).toBeVisible();
    await expect(waiting).toContainText(CUSTOMER);
    await waiting.click();
    await page.waitForURL(new RegExp('/accounting/invoicing/'));

    await expect(page.getByRole('heading', { level: 1 })).toContainText(documentNo);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved');
    await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();

    // Requirement 10, on the record: who raised it, who approved it, when.
    const approvals = page.locator('section', { hasText: 'Approval history' }).last();
    await expect(approvals).toContainText('Raised');
    await expect(approvals).toContainText('Accounting Officer');
    await expect(approvals).toContainText('Approved');
    await expect(approvals).toContainText('Accounting Manager');

    // And the audit trail below it names every step in words, not codes.
    const record = page.locator('section', { hasText: 'Record history' }).last();
    await expect(record).toContainText('Sent for approval');
    await expect(record).toContainText('Approved by the department manager');
    await expect(record).toContainText('Item added');
  });

  test('the approved invoice is listed, and the trail names both people', async ({ page }) => {
    await signIn(page, ADMIN);

    await page.goto(`/accounting/invoicing?q=${encodeURIComponent(CUSTOMER)}`);
    const row = page.getByRole('row', { name: new RegExp(documentNo) });
    await expect(row).toContainText('Approved');

    await page.goto(`/administration/audit?q=invoice`);
    await expect(page.getByText('invoice.created', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('invoice.approved', { exact: true }).first()).toBeVisible();
  });
});
