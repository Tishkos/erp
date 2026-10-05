import { deflateSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Internal chat (platform phase, Agent 1) — two people in two browsers.
 *
 *   1. The officer starts a chat with the manager and writes. The message is
 *      Sent; it becomes Delivered only when the manager's browser has really
 *      received it (the manager sits on the dashboard, where the header's
 *      badge is what polls); the manager's header shows the unread count.
 *   2. The manager opens the conversation from the header's drawer. The
 *      officer's message becomes Seen — by the manager reading it on screen.
 *   3. A reply that quotes, a reaction, a picture and a file, and the typing
 *      indicator.
 *   4. A person with no chat grant has no screen and no poll.
 *   5. Arabic at a phone's width (screenshots beside the model screen).
 *
 * Runs against the seeded development database; the conversation between the
 * two seeded people is found again on every run, the texts carry the time.
 */
const OFFICER = { email: 'officer@example.com', password: 'Ledger-Trial-Balance-7', name: 'Accounting Officer' };
const MANAGER = { email: 'manager@example.com', password: 'Ledger-Trial-Balance-7', name: 'Accounting Manager' };
const OUTSIDER = { email: 'outsider@example.com', password: 'Ledger-Trial-Balance-7' };
const SHOTS = process.env.CHAT_SHOTS ?? '/home/claude/shots/chat';

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, user: { email: string; password: string }) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

async function person(browser: Browser, user: { email: string; password: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await signIn(page, user);
  return { context, page };
}

/** A picture with something in it, made here so the test needs no fixture file. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      row[1 + x * 3] = Math.round((x / width) * 255);
      row[2 + x * 3] = Math.round((y / height) * 255);
      row[3 + x * 3] = 160;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const stamp = new Date().toISOString().replace(/\D/g, '').slice(8, 14);
let conversationUrl = '';

test.describe('Chat · two people', () => {
  test('a message is Sent, then Delivered when the other browser has it, then Seen when it is read', async ({ browser }) => {
    test.setTimeout(240_000);
    const officer = await person(browser, OFFICER);
    const manager = await person(browser, MANAGER);

    // The manager is elsewhere in the application: only the header is asking.
    await manager.page.goto('/');
    await expect(manager.page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 60_000 });

    // The officer starts the conversation.
    await officer.page.goto('/chat');
    await expect(officer.page.getByRole('heading', { level: 1 })).toHaveText('Chat', { timeout: 60_000 });
    await officer.page.getByRole('button', { name: 'New chat' }).click();
    const dialog = officer.page.getByRole('dialog');
    await dialog.getByLabel('Find a colleague').fill(MANAGER.name);
    await dialog.locator('li', { hasText: MANAGER.name }).getByRole('button', { name: 'Chat' }).click();
    await expect(officer.page.getByRole('textbox', { name: 'Message' })).toBeVisible({ timeout: 20_000 });
    conversationUrl = await officer.page.evaluate(() => window.location.search);
    expect(conversationUrl).toMatch(/^\?c=[0-9a-f-]{36}$/);

    // Writes.
    const hello = `Good morning, the statement is ready ${stamp}`;
    await officer.page.getByRole('textbox', { name: 'Message' }).fill(hello);
    await officer.page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const mine = officer.page.locator('li', { hasText: hello });
    await expect(mine).toBeVisible();
    // Never shown as delivered or seen at once: it is Sent (or still Sending) until the other side says otherwise.
    await expect(mine.locator('[data-status="seen"]')).toHaveCount(0);

    // The manager's header gets the unread count by itself, and with it the message is Delivered.
    await expect(manager.page.locator('[data-chat-badge]')).toBeVisible({ timeout: 60_000 });
    await expect(mine.locator('[data-status="delivered"]')).toBeVisible({ timeout: 60_000 });
    await expect(mine.locator('[data-status="seen"]')).toHaveCount(0);

    // The manager opens the drawer, then the conversation. Reading it is what makes it Seen.
    await manager.page.getByRole('button', { name: /^Messages/ }).click();
    await manager.page.locator('#erp-messages-panel').getByRole('link', { name: new RegExp(OFFICER.name) }).first().click();
    await manager.page.waitForURL(/\/chat\?c=/);
    await expect(manager.page.locator('li', { hasText: hello })).toBeVisible({ timeout: 30_000 });
    await expect(mine.locator('[data-status="seen"]')).toBeVisible({ timeout: 30_000 });
    await expect(manager.page.locator('[data-chat-badge]')).toHaveCount(0, { timeout: 30_000 });

    // The typing indicator crosses.
    await manager.page.getByRole('textbox', { name: 'Message' }).pressSequentially('Thank', { delay: 40 });
    await expect(officer.page.getByText(`${MANAGER.name} is typing`)).toBeVisible({ timeout: 20_000 });

    // A reply that keeps what it answers.
    const answer = `Thanks, I will post it today ${stamp}`;
    await manager.page.locator('li', { hasText: hello }).getByRole('button', { name: 'Reply' }).click();
    await manager.page.getByRole('textbox', { name: 'Message' }).fill(answer);
    await manager.page.getByRole('textbox', { name: 'Message' }).press('Enter');
    const reply = officer.page.locator('li', { hasText: answer });
    await expect(reply).toBeVisible({ timeout: 30_000 });
    await expect(reply.getByText(hello.slice(0, 30))).toBeVisible();

    // A reaction, seen by the person it was left for.
    await reply.getByRole('button', { name: 'React' }).click();
    await reply.getByRole('button', { name: 'Thanks' }).click();
    await expect(manager.page.locator('li', { hasText: answer }).getByRole('button', { name: /Thanks:/ })).toBeVisible({ timeout: 30_000 });

    // A picture and a file, through the attachment store.
    await manager.page.locator('input[type="file"]').setInputFiles([
      { name: 'statement.png', mimeType: 'image/png', buffer: png(160, 90) },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`Statement notes ${stamp}`) },
    ]);
    await manager.page.getByRole('textbox', { name: 'Message' }).fill(`Statement attached ${stamp}`);
    await manager.page.getByRole('button', { name: 'Send' }).click();
    const withFiles = officer.page.locator('li', { hasText: `Statement attached ${stamp}` });
    await expect(withFiles).toBeVisible({ timeout: 30_000 });
    const image = withFiles.locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 20_000 }).toBe(160);
    await expect(withFiles.getByRole('link', { name: 'notes.txt' })).toBeVisible();

    // The download route is the member's alone.
    const href = await withFiles.getByRole('link', { name: 'notes.txt' }).getAttribute('href');
    const own = await officer.page.request.get(href!);
    expect(own.status()).toBe(200);
    expect(await own.text()).toContain('Statement notes');

    // The outsider has no chat grant: the screen refuses, the poll refuses, the file is not there.
    const outsider = await person(browser, OUTSIDER);
    await outsider.page.goto(`/chat${conversationUrl}`);
    await expect(outsider.page.getByText('You do not have permission to open this screen.')).toBeVisible({ timeout: 60_000 });
    const poll = await outsider.page.request.post('/chat/api/sync', {
      data: { open: null, visible: true, active: true, revs: {}, ack: {}, seen: null },
    });
    expect(poll.status()).toBe(403);
    expect((await outsider.page.request.get(href!)).status()).toBe(404);

    await outsider.context.close();
    await manager.context.close();
    await officer.context.close();
  });

  test('Arabic, right to left, at a phone width, beside the model screen', async ({ browser }) => {
    test.setTimeout(240_000);
    mkdirSync(SHOTS, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    const page = await context.newPage();
    await signIn(page, OFFICER);

    await page.goto('/chat');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('المحادثات', { timeout: 60_000 });
    await expect(page.getByRole('link', { name: new RegExp(MANAGER.name) }).first()).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/chat-list-mobile-ar.png`, fullPage: true });

    await page.goto(`/chat${conversationUrl}`);
    await expect(page.getByRole('textbox', { name: 'الرسالة' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('list', { name: 'الرسائل' }).getByText(`Statement attached ${stamp}`)).toBeVisible();
    // Hydrated: the back-to-list control is there once the client has taken the page over.
    await expect(page.getByRole('button', { name: 'العودة إلى المحادثات' })).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/chat-thread-mobile-ar.png`, fullPage: true });

    await page.goto('/payables/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: `${SHOTS}/model-invoices-mobile-ar.png`, fullPage: true });
    await context.close();

    // Desktop, English: the chat beside the register it copies.
    const desktop = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const wide = await desktop.newPage();
    await signIn(wide, OFFICER);
    await wide.goto(`/chat${conversationUrl}`);
    await expect(wide.getByRole('textbox', { name: 'Message' })).toBeVisible({ timeout: 60_000 });
    await wide.waitForTimeout(1200);
    await wide.screenshot({ path: `${SHOTS}/chat-desktop-en.png` });
    await wide.getByRole('button', { name: 'Details' }).click();
    await wide.getByRole('dialog').getByText(MANAGER.name).waitFor();
    await wide.screenshot({ path: `${SHOTS}/chat-details-desktop-en.png` });
    await wide.keyboard.press('Escape');
    await wide.getByRole('button', { name: 'New group' }).click();
    await wide.getByRole('dialog').getByLabel('Find a colleague').waitFor();
    await wide.waitForTimeout(800);
    await wide.screenshot({ path: `${SHOTS}/chat-new-group-desktop-en.png` });
    await wide.keyboard.press('Escape');
    await wide.getByRole('button', { name: /^Messages/ }).click();
    await wide.waitForTimeout(500);
    await wide.screenshot({ path: `${SHOTS}/chat-header-drawer-desktop-en.png`, clip: { x: 760, y: 0, width: 600, height: 420 } });
    await wide.goto('/payables/invoices');
    await expect(wide.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    await wide.screenshot({ path: `${SHOTS}/model-invoices-desktop-en.png` });
    await desktop.close();
  });
});
