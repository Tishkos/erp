import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Shared doors and profiles (2026-10-04) — the progress certificate, the
 * Project System's client invoice, wears printer, paperclip, notes and clock
 * from its draft; a note is added through the shared Notes door and listed;
 * the project, the customer and the journal are links to their pages. The
 * certificate is photographed beside the purchase invoice it copies, desktop
 * in English and a phone in Arabic.
 */
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7' };
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase();
const SHOTS = process.env.SHOTS_DIR ?? '/home/claude/shots/shared';

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

/** The four doors in the title bar, in the rule's order. */
async function expectFourDoors(page: Page, labels: { print: string; attachments: string; notes: string; history: string }) {
  const bar = page.locator('[class*="sapTitleActions"]').first();
  const doors = bar.locator(':scope > button, :scope > a');
  await expect(doors).toHaveCount(4);
  const names = await doors.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
  expect(names).toEqual([labels.print, labels.attachments, labels.notes, labels.history]);
}

test.describe('shared · the four doors and profile links', () => {
  test('a draft progress certificate wears the four doors, takes a note and links its parties', async ({ page, browser }) => {
    test.setTimeout(420_000);
    mkdirSync(SHOTS, { recursive: true });
    await signIn(page, MANAGER);

    // A customer project, released by somebody else, with a due billing line.
    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    const create = page.getByRole('dialog');
    await create.locator('select[name="type_code"]').selectOption('CUSTOMER');
    await create.locator('select[name="customer_id"]').selectOption({ index: 1 });
    await create.locator('input[name="name"]').fill(`Doors ${RUN}`);
    await create.locator('input[name="baseline_starts_on"]').fill('2026-09-01');
    await create.locator('input[name="baseline_ends_on"]').fill('2026-12-31');
    await create.locator('input[name="contract_value_iqd"]').fill('1000000');
    await create.locator('input[name="baseline_budget_iqd"]').fill('800000');
    await create.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/projects\/PRJ-/);
    const code = decodeURIComponent(page.url().split('/projects/')[1]!.split('?')[0]!);
    const other = await browser.newContext();
    const adminPage = await other.newPage();
    await signIn(adminPage, ADMIN);
    await adminPage.goto(`/projects/${encodeURIComponent(code)}`);
    await adminPage.getByRole('button', { name: 'Release' }).click();
    await adminPage.waitForURL(/saved=1/);
    await other.close();

    await page.goto(`/projects/billing?project=${encodeURIComponent(code)}`);
    await page.getByRole('button', { name: 'Add billing line' }).click();
    const add = page.getByRole('dialog');
    await add.locator('input[name="description"]').fill('Mobilisation');
    await add.locator('select[name="due_trigger"]').selectOption('date');
    await add.locator('input[name="due_on"]').fill('2026-09-15');
    await add.locator('select[name="basis"]').selectOption('amount');
    await add.locator('input[name="value"]').fill('250000');
    await add.locator('button[type="submit"]').first().click();
    await page.waitForURL(/saved=1/);
    const line = page.getByRole('row', { name: /Mobilisation/ });
    await line.locator('input[name="certified_on"]').fill('2026-09-20');
    await line.getByRole('button', { name: 'Raise certificate' }).click();
    await page.waitForURL(/\/projects\/billing\/PCT-/);
    const certificateNo = decodeURIComponent(page.url().split('/projects/billing/')[1]!.split('?')[0]!);
    const record = `/projects/billing/${encodeURIComponent(certificateNo)}`;

    // A draft, and already the four doors.
    await expect(page.locator('[data-status="draft"]').first()).toBeVisible();
    await expectFourDoors(page, { print: 'Print / Export', attachments: 'Attachments', notes: 'Notes', history: 'Audit log' });

    // The project, the customer: links to their profiles.
    await expect(page.locator(`a[href="/projects/${encodeURIComponent(code)}"]`)).toBeVisible();
    await expect(page.locator('a[href^="/sales/customers/"][href$="?role=customer"]')).toBeVisible();

    // The printer offers the certificate's own copies.
    await page.getByRole('button', { name: 'Print / Export' }).click();
    const copies = page.locator('[data-export-menu="project_certificate"]');
    await expect(copies.locator('a[data-format="pdf"][data-lang="en"]')).toHaveAttribute(
      'href',
      `/export/project_certificate/${encodeURIComponent(certificateNo)}?format=pdf&lang=en`,
    );
    const pdf = await page.request.get(`/export/project_certificate/${encodeURIComponent(certificateNo)}?format=pdf&lang=en`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    await page.keyboard.press('Escape');

    // A note through the shared door: back on the same record, listed, counted.
    await page.getByRole('button', { name: 'Notes', exact: true }).click();
    const notes = page.getByRole('dialog', { name: 'Notes' });
    await expect(notes.getByText('No notes yet.')).toBeVisible();
    await notes.locator('input[name="note"]').fill(`Client asked for the measurement sheet ${RUN}`);
    await notes.getByRole('button', { name: 'Add note' }).click();
    await page.waitForURL(new RegExp(`${record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?saved=1`));
    await expect(page.getByRole('button', { name: 'Notes (1)' })).toBeVisible();
    await page.getByRole('button', { name: 'Notes (1)' }).click();
    await expect(page.getByRole('dialog', { name: 'Notes' }).getByRole('cell', { name: `Client asked for the measurement sheet ${RUN}` })).toBeVisible();
    await page.keyboard.press('Escape');

    // And on the clock, the note is an event of the certificate.
    await page.getByRole('button', { name: 'Audit log' }).click();
    await expect(page.getByRole('dialog', { name: 'Audit log' }).getByText(/note added/i).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // The screenshots: the certificate beside the purchase invoice it copies.
    await page.goto(record);
    await page.screenshot({ path: `${SHOTS}/certificate-desktop-en.png`, fullPage: true });
    const invoices = await page.request.get('/payables/invoices');
    const invoiceNo = /href="\/payables\/invoices\/([^"?]+)"/.exec(await invoices.text())?.[1];
    if (invoiceNo) {
      await page.goto(`/payables/invoices/${invoiceNo}`);
      await page.screenshot({ path: `${SHOTS}/purchase-invoice-desktop-en.png`, fullPage: true });
    }

    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(record);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width, 'no horizontal scroll at 390px').toBeLessThanOrEqual(390);
    await expect(page.locator('[class*="sapTitleActions"]').first().locator(':scope > button, :scope > a')).toHaveCount(4);
    await page.screenshot({ path: `${SHOTS}/certificate-mobile-ar.png`, fullPage: true });
    if (invoiceNo) {
      await page.goto(`/payables/invoices/${invoiceNo}`);
      await page.screenshot({ path: `${SHOTS}/purchase-invoice-mobile-ar.png`, fullPage: true });
    }
  });
});
