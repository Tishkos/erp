import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { startNextcloudStub, type NextcloudStub } from '../support/nextcloud-stub';
import { keepEnglish } from './support/locale';

/**
 * Platform phase, Agent 4 — the Document Center, against a small Nextcloud.
 *
 * The sandbox has no route to files.qs-groups.com, so the cloud here is
 * tests/support/nextcloud-stub.ts on a loopback port: a real HTTP server that
 * speaks Login Flow v2, OCS, WebDAV and the preview endpoint. Everything the
 * ERP does goes through its real client; only the far end is the stub.
 *
 * The walk, in order (serial — each step is the state the next needs):
 *   1. Not configured: the screen says so; an administrator is offered the
 *      settings, anyone else is told to ask one.            (screenshots)
 *   2. The administrator configures it: address, on, a role -> group.
 *   3. The officer links their own account through the login flow; nothing
 *      is in their Cloud Files yet.                           (linked-empty)
 *   4. The administrator links; the folder lists what the cloud holds, in
 *      folders, filtered, uploaded to (confirmed by the cloud), downloaded.
 *                                                             (listing)
 *   5. Both directions: a file is linked to a record from the Document Center,
 *      and the record's paperclip shows it; a second is linked from the record.
 *   6. Everything is put back: links ended, accounts unlinked, switched off.
 *
 * Each screen is photographed at desktop width in English and at 390px in
 * Arabic into SHOTS, beside the screens it copies (Purchase Invoices,
 * Numbering).
 */
const PASSWORD = 'Ledger-Trial-Balance-7';
const ADMIN = 'admin@example.com';
const OFFICER = 'officer@example.com';
const SHOTS = process.env.DOCUMENT_CENTER_SHOTS ?? '/home/claude/shots/documents';
const RECORD = 'OPEN-DEV-2026';

let stub: NextcloudStub;

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function as(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await signIn(page, email);
  return { page, context, close: () => context.close() };
}

/** Desktop in English, then a phone in Arabic with no horizontal scroll. Leaves the page as it found it. */
async function photograph(page: Page, route: string, name: string, ready: (page: Page) => Promise<void>) {
  await page.goto(route);
  await ready(page);
  await page.screenshot({ path: `${SHOTS}/${name}-desktop-en.png`, fullPage: true });
  await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(route);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('main, [class*="sapDoc"], [class*="emptyState"]').first()).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width, `${name}: no horizontal scroll at 390px`).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${SHOTS}/${name}-mobile-ar.png`, fullPage: true });
  await keepEnglish(page.context());
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(route);
}

/** Starts the login flow as whoever is on the page, and approves it at the stub the way the person would in Cloud Files. */
async function linkAccount(page: Page, uid: string) {
  await page.goto('/documents');
  await expect(page.getByText('Link your Cloud Files account')).toBeVisible();
  await page.getByRole('button', { name: 'Link my account' }).click();
  await expect(page.getByText('Waiting for your approval in Cloud Files')).toBeVisible();
  const loginUrl = await page.getByRole('link', { name: 'Open Cloud Files' }).getAttribute('href');
  expect(loginUrl).toContain('/login/v2/flow/');
  stub.grant(loginUrl!, uid);
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText(/Connected as /)).toBeVisible();
}

/** A run that stopped half way leaves an account linked or a request open: start from "not linked". */
async function clearAccount(page: Page) {
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  await page.goto('/documents');
  for (let step = 0; step < 4; step += 1) {
    if (await button('Link my account').count()) return;
    if (await button('Cancel').count()) await button('Cancel').click();
    else if (await button('Unlink').count()) await button('Unlink').click();
    else if (await button('Link my account again').count()) await button('Link my account again').click();
    await page.goto('/documents');
  }
  await expect(button('Link my account')).toBeVisible();
}

async function setEnabled(page: Page, on: boolean) {
  await page.goto('/administration/cloud-files');
  const box = page.getByRole('checkbox', { name: 'Cloud Files is switched on' });
  if ((await box.isChecked()) === on) return;
  await box.setChecked(on);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/saved=1/);
}

test.describe('Document Center · QS Cloud Files', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    stub = await startNextcloudStub();
    stub.addUser('admin', { displayName: 'Dev Administrator', groups: ['Management'] });
    stub.addUser('officer', { displayName: 'Dev Officer', groups: ['Accounting'] });
    stub.putFile('admin', 'Contracts/Supplier agreement.pdf', '%PDF-1.4\nSupplier agreement\n', 'application/pdf');
    stub.putFile('admin', 'Contracts/Price list.xlsx', 'not really a workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    stub.putFile('admin', 'Customs/Release note.txt', 'Released', 'text/plain');
    stub.putFile('admin', 'Port photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), 'image/png');
    stub.putFile('admin', 'Notes.txt', 'Loading plan for Thursday', 'text/plain');
  });

  test.afterAll(async () => {
    await stub?.close();
  });

  test('not configured: said plainly, the way on only for whoever may configure it', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await as(browser, ADMIN);
    await setEnabled(admin.page, false);

    await photograph(admin.page, '/documents', 'documents-not-configured', async (page) => {
      await expect(page.getByText('This integration is not configured')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Open Cloud Files settings' })).toBeVisible();
    });
    await admin.close();

    const officer = await as(browser, OFFICER);
    await officer.page.goto('/documents');
    await expect(officer.page.getByText('This integration is not configured')).toBeVisible();
    await expect(officer.page.getByText('Ask an administrator to connect it.')).toBeVisible();
    await expect(officer.page.getByRole('link', { name: 'Open Cloud Files settings' })).toHaveCount(0);
    // Nothing is fetched or invented while it is off.
    const file = await officer.page.request.get('/documents/file?path=/Notes.txt', { maxRedirects: 0 });
    expect([303, 404]).toContain(file.status());
    expect(stub.requests.filter((r) => r.path.includes('/remote.php/dav/files/'))).toHaveLength(0);
    await officer.close();
  });

  test('the administrator switches it on, tests the address and maps a role to a group', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await page.goto('/administration/cloud-files');
    await page.getByLabel('Address of Cloud Files').fill(stub.url);
    await page.getByRole('checkbox', { name: 'Cloud Files is switched on' }).check();
    await page.getByRole('button', { name: 'Test the address' }).click();
    await expect(page.getByText(/Cloud Files answered \(version/)).toBeVisible();

    await page.goto('/administration/cloud-files');
    await page.getByLabel('Address of Cloud Files').fill(stub.url);
    await page.getByRole('checkbox', { name: 'Cloud Files is switched on' }).check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForURL(/saved=1/);

    await page.getByRole('button', { name: 'Map a role' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('ERP role').selectOption('accounting_officer');
    await dialog.getByLabel('Cloud Files group').fill('Accounting');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('cell', { name: 'Accounting', exact: true })).toBeVisible();

    await photograph(page, '/administration/cloud-files', 'cloud-files-settings', async (p) => {
      await expect(p.getByRole('heading', { name: 'ERP roles and Cloud Files groups' })).toBeVisible();
    });
    // The model it copies.
    await photograph(page, '/administration/numbering', 'model-numbering', async (p) => {
      await expect(p.locator('main').first()).toBeVisible();
    });
    await admin.close();
  });

  test('the officer links their own account; nothing is in their Cloud Files yet', async ({ browser }) => {
    test.setTimeout(240_000);
    const officer = await as(browser, OFFICER);
    const page = officer.page;
    await clearAccount(page);
    await photograph(page, '/documents', 'documents-not-linked', async (p) => {
      await expect(p.getByText('Link your Cloud Files account')).toBeVisible();
    });

    await linkAccount(page, 'officer');
    // The app password was made for this person and is stored, never shown.
    expect(stub.appPasswordsOf('officer')).toHaveLength(1);
    const html = await page.content();
    expect(html).not.toContain(stub.appPasswordsOf('officer')[0]!);

    await photograph(page, '/documents', 'documents-linked-empty', async (p) => {
      await expect(p.getByText('Connected as Dev Officer')).toBeVisible();
      await expect(p.getByText('Nothing is in your Cloud Files here yet.')).toBeVisible();
    });
    await photograph(page, '/payables/invoices', 'model-purchase-invoices', async (p) => {
      await expect(p.locator('main').first()).toBeVisible();
    });
    await officer.close();
  });

  test('the administrator browses real folders, uploads with the cloud confirming, downloads', async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;
    await clearAccount(page);
    await linkAccount(page, 'admin');

    await photograph(page, '/documents', 'documents-listing', async (p) => {
      await expect(p.getByRole('link', { name: 'Contracts' })).toBeVisible();
      await expect(p.getByRole('link', { name: 'Notes.txt' })).toBeVisible();
      await expect(p.getByRole('link', { name: 'Port photo.png' })).toBeVisible();
    });

    // Into a folder: the breadcrumb shows where we are and the rows are the cloud's.
    await page.getByRole('link', { name: 'Contracts' }).first().click();
    await expect(page.getByRole('heading', { name: 'Contracts' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Supplier agreement.pdf' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Price list.xlsx' })).toBeVisible();

    // Filter by kind, then search.
    await page.getByLabel('Show').selectOption('pdf');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('link', { name: 'Supplier agreement.pdf' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Price list.xlsx' })).toHaveCount(0);
    await page.goto('/documents?path=%2FContracts&q=price');
    await expect(page.getByRole('link', { name: 'Price list.xlsx' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Supplier agreement.pdf' })).toHaveCount(0);

    // Upload: "uploaded" is shown only once the cloud holds the bytes.
    await page.goto('/documents?path=%2FContracts');
    await page.getByRole('button', { name: 'Upload files' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'Bill of lading copy.txt', mimeType: 'text/plain', buffer: Buffer.from('Container MSKU 0000000 loaded') });
    await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(dialog.getByText(/Uploaded to Cloud Files/)).toBeVisible();
    expect(stub.readFile('admin', 'Contracts/Bill of lading copy.txt')?.toString()).toBe('Container MSKU 0000000 loaded');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await page.reload();
    await expect(page.getByRole('link', { name: 'Bill of lading copy.txt' })).toBeVisible();

    // Download goes through the ERP, as this person; the cloud's password never reaches the browser.
    const download = await page.request.get('/documents/file?path=%2FContracts%2FSupplier%20agreement.pdf');
    expect(download.status()).toBe(200);
    expect(download.headers()['content-disposition']).toContain('attachment');
    expect(download.headers()['x-content-type-options']).toBe('nosniff');
    expect(await download.text()).toContain('Supplier agreement');
    expect(JSON.stringify(download.headers())).not.toContain(stub.appPasswordsOf('admin')[0]!);
    // A path outside the person's cloud is not a file.
    const outside = await page.request.get('/documents/file?path=%2F..%2Fofficer%2FSecret.txt');
    expect([400, 404]).toContain(outside.status());
    await admin.close();
  });

  test('both directions: a file linked to a record, and the record shows it', async ({ browser }) => {
    test.setTimeout(300_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;

    // Document -> record: from the file's row, to a journal entry by its number.
    await page.goto('/documents?path=%2FContracts');
    const row = page.getByRole('row', { name: /Supplier agreement\.pdf/ });
    await row.getByRole('link', { name: 'Link to record' }).click();
    await expect(page.getByRole('heading', { name: /Link Supplier agreement\.pdf to a record/ })).toBeVisible();
    await page.getByLabel('Kind of record').selectOption('journal_entry');
    await page.getByLabel('Record number').fill('NO-SUCH-ENTRY');
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(page.getByText(/cannot|not found|no such/i).first()).toBeVisible();
    await page.goto('/documents?path=%2FContracts&linkFile=%2FContracts%2FSupplier%20agreement.pdf');
    await page.getByLabel('Kind of record').selectOption('journal_entry');
    await page.getByLabel('Record number').fill(RECORD);
    await page.getByRole('button', { name: 'Link', exact: true }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole('row', { name: /Supplier agreement\.pdf/ }).getByRole('link', { name: RECORD })).toBeVisible();

    // Record -> documents: the record's paperclip lists it, with the people and time.
    await page.goto(`/finance/journals/${RECORD}`);
    await page.getByRole('button', { name: /Attachments/ }).first().click();
    const clip = page.getByRole('dialog');
    await expect(clip.getByRole('heading', { name: 'QS Cloud Files' })).toBeVisible();
    await expect(clip.getByRole('link', { name: 'Supplier agreement.pdf' })).toBeVisible();
    await expect(clip.getByText(/linked by System Administrator/)).toBeVisible();
    // The paperclip open, desktop in English and a phone in Arabic.
    await page.screenshot({ path: `${SHOTS}/record-paperclip-desktop-en.png` });
    await page.context().addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/finance/journals/${RECORD}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.getByRole('button', { name: /المرفقات/ }).first().click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'QS Cloud Files' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), 'no horizontal scroll at 390px').toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/record-paperclip-mobile-ar.png` });
    await keepEnglish(page.context());
    await page.setViewportSize({ width: 1280, height: 800 });

    // From the record: "Link a file from Cloud Files" brings the Document Center in link mode.
    await page.goto(`/finance/journals/${RECORD}`);
    await page.getByRole('button', { name: /Attachments/ }).first().click();
    await page.getByRole('dialog').getByRole('link', { name: 'Link a file from Cloud Files' }).click();
    await expect(page.getByText(/Choose a file to link to Journal entry/)).toBeVisible();
    await page.getByRole('link', { name: 'Customs' }).first().click();
    await page.getByRole('row', { name: /Release note\.txt/ }).getByRole('button', { name: 'Link to this record' }).click();
    await page.waitForURL(new RegExp(`/finance/journals/${RECORD}`));
    await page.getByRole('button', { name: /Attachments/ }).first().click();
    await expect(page.getByRole('dialog').getByRole('link', { name: 'Release note.txt' })).toBeVisible();

    // The record's folder: made under the record root, shared with the mapped group, linked.
    await page.getByRole('dialog').getByRole('button', { name: "Create the record's folder" }).click();
    await expect.poll(() => stub.exists('admin', `Qimah/Journal Entries/${RECORD}`), { message: 'the record folder is made in the cloud' }).toBe(true);
    expect(stub.shares().some((share) => share.group === 'Accounting')).toBe(true);

    // The officer's cloud does not show them the administrator's private file: the record says so and gives no name.
    const officer = await as(browser, OFFICER);
    await officer.page.goto(`/finance/journals/${RECORD}`);
    await officer.page.getByRole('button', { name: /Attachments/ }).first().click();
    const officerClip = officer.page.getByRole('dialog');
    await expect(officerClip.getByText('Not available to you in Cloud Files').first()).toBeVisible();
    await expect(officerClip.getByText('Supplier agreement.pdf')).toHaveCount(0);
    const through = await officer.page.request.get('/documents/file?path=%2FContracts%2FSupplier%20agreement.pdf', { maxRedirects: 0 });
    expect([403, 404]).toContain(through.status());
    await officer.close();
    await admin.close();
  });

  test('put back: links ended, accounts unlinked, switched off', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await as(browser, ADMIN);
    const page = admin.page;

    await page.goto(`/finance/journals/${RECORD}`);
    await page.getByRole('button', { name: /Attachments/ }).first().click();
    for (;;) {
      const unlink = page.getByRole('dialog').getByRole('button', { name: 'Unlink' }).first();
      if ((await unlink.count()) === 0) break;
      await page.getByRole('dialog').getByLabel(/Reason for unlinking/).first().fill('Spec clean-up');
      await unlink.click();
      await page.waitForURL(/saved=1/);
      await page.goto(`/finance/journals/${RECORD}`);
      await page.getByRole('button', { name: /Attachments/ }).first().click();
    }

    await page.goto('/documents');
    await page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await page.waitForURL(/saved=1/);
    expect(stub.appPasswordsOf('admin')).toHaveLength(0);
    await admin.close();

    const officer = await as(browser, OFFICER);
    await officer.page.goto('/documents');
    await officer.page.getByRole('button', { name: 'Unlink', exact: true }).click();
    await officer.page.waitForURL(/saved=1/);
    expect(stub.appPasswordsOf('officer')).toHaveLength(0);
    await officer.close();

    const again = await as(browser, ADMIN);
    await setEnabled(again.page, false);
    await again.page.goto('/documents');
    await expect(again.page.getByText('This integration is not configured')).toBeVisible();
    await again.close();
  });
});
