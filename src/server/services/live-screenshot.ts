/**
 * One picture of the live application, taken when somebody asks — as the
 * person asking.
 *
 * By direction (2026-10-05): "a picture of YOUR ACTUAL document with pointers,
 * not the training copy". The pictures made ahead of time
 * (`scripts/guide/make-screens.ts`) show where a thing is and how a form is
 * laid out; they cannot show "your invoice, the one that will not post". This
 * can: it opens one address of the running application in a browser on the
 * server, draws the same boxes, numbers and arrows on it
 * (`guide/markers.ts`), and hands back the picture with what each number is
 * on — and, because the picture is the asker's own, what each field holds.
 *
 * The rules below are security rules, not preferences:
 *
 *   ONLY THE ASKER      The function is given a user id and nothing else that
 *                       names a person. It signs in AS that user: a session
 *                       row of their own is written for the browser, exactly
 *                       as the sign-in form writes one (`authentication.ts` ›
 *                       `createSession`: a random token in the cookie, its
 *                       SHA-256 in `auth_session`), so every screen answers
 *                       with that person's permissions, branches and
 *                       restrictions — a page they may not open is refused to
 *                       the browser as it would be to them.
 *   IT CANNOT OUTLIVE   The session expires three minutes after it is made,
 *   THE PICTURE         and is revoked in a `finally` whatever happened —
 *                       revoked, not deleted: the application's own role may
 *                       not delete a session (§25, migration 0014: "a revoked
 *                       session stays"), and revocation is one-way. The token
 *                       never leaves this function.
 *   IT CAN ONLY LOOK    The browser is refused every request that is not a
 *                       GET or a HEAD, every request to another origin, and
 *                       every download. A server action is a POST, so nothing
 *                       it could press would reach the server — and it presses
 *                       nothing: it opens one address, waits, draws, and takes
 *                       the picture. No click, no key, no form.
 *   ONLY THE PAGES      The address must be a page of the application itself:
 *                       not `/api`, not the export or attachment routes (a GET
 *                       there is a file, and an export is audited as one), not
 *                       the sign-in form.
 *
 * `firstRecord` (2026-10-05, for a how-to's "an opened record"): the address is
 * a list, and what is pictured is the first record that list shows the asker.
 * It is found by READING the first row's link — an `href`, nothing pressed —
 * which must pass the same address rules, and is opened with the same plain
 * GET under the same guards and the same one session. Still one address
 * pictured, one audit row, nothing changed.
 *
 * Every picture, and every refusal, is an `audit_event` (`whatsapp.screenshot`)
 * under the person it was taken as.
 *
 * The browser and the database client are imported inside the functions that
 * need them: the bridge must start on a server that has no Chromium, and the
 * address rules must be testable without a database.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { clearMarks, drawMarks, type Mark } from '../guide/markers';

export interface LiveShot {
  /** The picture, on this host. */
  readonly file: string;
  /** The address it was taken of, after any redirect the application made. */
  readonly path: string;
  /** The page's own heading. */
  readonly title: string;
  readonly marks: readonly Mark[];
  /** The `pointAt` labels that are not in the picture. */
  readonly notFound: readonly string[];
}

export type LiveShotResult = { readonly ok: true; readonly shot: LiveShot } | { readonly ok: false; readonly reason: string };

/** `session.ts` › SESSION_COOKIE. That module is Next's own (it imports `next/headers`); the name is held equal by a test. */
export const LIVE_SESSION_COOKIE = 'erp_session';
/** `i18n/config.ts` › LOCALE_COOKIE. */
const LOCALE_COOKIE = 'erp-locale';
/** How a session made here is recognised in `auth_session` and on a user's list of sessions. */
export const LIVE_SHOT_AGENT = 'noah-live-screenshot';
/** The longest such a session can live if this process dies before revoking it. */
const SESSION_MS = 3 * 60_000;
const WIDTH = 1366;
const HEIGHT = 768;
const KEEP_MS = 24 * 60 * 60_000;
const IDLE_MS = 5 * 60_000;

const shotTimeout = () => Math.max(5_000, Number(process.env.NOAH_SHOT_TIMEOUT_MS) || 25_000);
const baseUrl = () => (process.env.NOAH_APP_URL?.trim() || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const shotsDir = () => process.env.NOAH_SHOTS_DIR?.trim() || join(process.cwd(), 'var', 'noah-shots');

// ---------------------------------------------------------------------------
// Which addresses may be pictured
// ---------------------------------------------------------------------------

/** Not pages: an API, the framework's own files, files to download, the way in and out. */
const NOT_A_PAGE = ['api', '_next', 'sign-in', 'sign-out', 'export', 'attachments', 'healthz', 'session'];

/**
 * An address inside the application, or the reason it is not one.
 *
 * Decided on the text alone, before anything is opened: a path that starts
 * with one `/`, on this origin and no other, that is a page.
 */
export function checkPath(raw: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const asked = String(raw ?? '').trim();
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!asked) return no('No address was given. Give the address of a screen inside the ERP, such as /sales/ar-invoices/INV-HQ-2026-000001.');
  if (asked.length > 300) return no('That address is too long to be a screen of the ERP.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(asked)) return no('Only a screen of the ERP can be pictured: give its address inside the ERP, starting with "/", not a web address.');
  if (!asked.startsWith('/')) return no('An address inside the ERP starts with "/", such as /payables/suppliers.');
  if (asked.includes('//') || asked.includes('\\')) return no('That is not an address inside the ERP ("//" and "\\" are not part of one).');
  if (/[\s\u0000-\u001f\u007f<>"`{}|^]/.test(asked)) return no('That address has characters no screen of the ERP has in its address.');

  let url: URL;
  try {
    url = new URL(asked, 'http://erp.invalid');
  } catch {
    return no('That is not an address inside the ERP.');
  }
  // Whatever the text looked like, it must still be the same origin once a browser has read it.
  if (url.origin !== 'http://erp.invalid' || url.username || url.password) return no('Only a screen of the ERP can be pictured.');
  const segments = url.pathname.split('/').filter(Boolean);
  const decoded = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return '/';
    }
  };
  if (segments.some((segment) => segment === '.' || segment === '..' || decoded(segment) === '..' || decoded(segment).includes('/') || decoded(segment).includes('\\'))) {
    return no('That is not an address inside the ERP.');
  }
  const first = (segments[0] ?? '').toLowerCase();
  if (NOT_A_PAGE.includes(first)) {
    return no(
      first === 'sign-in' || first === 'sign-out'
        ? 'The sign-in page is not pictured live: it is the same for everybody (show_screen "sign in" has it).'
        : `"/${first}…" is not a screen: it is ${first === 'export' || first === 'attachments' ? 'a file to download' : 'part of the system itself'}. Give the address of the screen the person opens.`,
    );
  }
  if (segments.some((segment) => segment.toLowerCase() === 'export')) return no('That address is a file to download, not a screen. Give the address of the screen the person opens.');
  return { ok: true, path: `${url.pathname}${url.search}` };
}

// ---------------------------------------------------------------------------
// Whether a picture can be taken here at all
// ---------------------------------------------------------------------------

/** Where Playwright keeps the browsers it installed. */
function browsersDir(): string {
  const set = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (set && set !== '0') return set;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

/**
 * Chromium is installed, and nobody switched live pictures off.
 *
 * Read from the disk, not by starting a browser: it is asked on every answer.
 * A browser that is there and still will not start is said by `liveScreenshot`.
 */
export function liveShotsReady(): { readonly ok: boolean; readonly reason?: string } {
  if ((process.env.NOAH_LIVE_SHOTS ?? '').trim().toLowerCase() === 'off') {
    return { ok: false, reason: 'Live pictures are switched off on this server (NOAH_LIVE_SHOTS=off).' };
  }
  const dir = browsersDir();
  let found = false;
  try {
    found = existsSync(dir) && readdirSync(dir).some((name) => /^chromium(_headless_shell)?-\d+/.test(name));
  } catch {
    found = false;
  }
  return found
    ? { ok: true }
    : { ok: false, reason: 'No browser is installed on this server to take a picture with (npx playwright install chromium). Use the pictures made ahead of time, or describe the screen in words.' };
}

// ---------------------------------------------------------------------------
// The session of the person asking — theirs, short, and ended here
// ---------------------------------------------------------------------------

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

interface Minted {
  readonly sessionId: string;
  readonly token: string;
}

/** A session for this user and nobody else, as the sign-in form makes one — but three minutes long, and tagged. */
async function mintSession(userId: string): Promise<Minted | { readonly refused: string }> {
  const { withScope } = await import('../db/client');
  const { appUser, authSession } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  return withScope({ userId, branchCode: '' }, async (tx) => {
    const [user] = await tx.select({ id: appUser.id, isActive: appUser.isActive }).from(appUser).where(eq(appUser.id, userId)).limit(1);
    if (!user) return { refused: 'There is no such user.' };
    if (!user.isActive) return { refused: 'This account is deactivated, so nothing can be opened as it.' };
    await tx.insert(authSession).values({
      id: sessionId,
      userId,
      token: digest(token),
      expiresAt: new Date(Date.now() + SESSION_MS),
      ipAddress: '127.0.0.1',
      userAgent: LIVE_SHOT_AGENT,
    });
    return { sessionId, token };
  });
}

/** Ends it. One-way: a revoked session is refused on the very next request, and cannot be reinstated. */
async function endSession(userId: string, sessionId: string): Promise<void> {
  const { withScope } = await import('../db/client');
  const { authSession } = await import('../db/schema');
  const { and, eq, isNull } = await import('drizzle-orm');
  await withScope({ userId, branchCode: '' }, (tx) =>
    tx
      .update(authSession)
      .set({ revokedAt: new Date(), revokedBy: userId, revokedReason: 'the picture was taken' })
      .where(and(eq(authSession.id, sessionId), isNull(authSession.revokedAt))),
  );
}

async function auditShot(userId: string, input: { path: string; outcome: 'success' | 'denied' | 'failure'; reason?: string; sessionId?: string | null; marks?: number }): Promise<void> {
  try {
    const audit = await import('./audit');
    await audit.recordSecurity(
      { userId, branchCode: '' },
      {
        actorUserId: userId,
        action: 'whatsapp.screenshot',
        objectType: 'whatsapp',
        objectId: null,
        branchCode: null,
        after: { path: input.path.slice(0, 300), ...(input.marks === undefined ? {} : { marks: input.marks }) },
        reason: input.reason ? input.reason.slice(0, 300) : null,
        outcome: input.outcome,
        sessionId: input.sessionId ?? null,
      },
    );
  } catch {
    /* the record of a picture failing to be written is not a reason to lose the answer */
  }
}

// ---------------------------------------------------------------------------
// The browser: one, shared, shut when it has been idle
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
/** One picture at a time: a second waits its turn. */
let turn: Promise<unknown> = Promise.resolve();

async function theBrowser(): Promise<Browser> {
  if (idle) clearTimeout(idle);
  idle = null;
  if (browser && browser.isConnected()) return browser;
  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  return browser;
}

function restLater(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    void closeLiveBrowser();
  }, IDLE_MS);
  // The timer alone must not keep a script that has finished from ending.
  idle.unref?.();
}

/** Shut the browser now — for a script that is about to end. */
export async function closeLiveBrowser(): Promise<void> {
  if (idle) clearTimeout(idle);
  idle = null;
  const open = browser;
  browser = null;
  if (open) await open.close().catch(() => {});
}

function sweep(dir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jpg')) continue;
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > KEEP_MS) unlinkSync(file);
    }
  } catch {
    /* an old picture that will not go is not worth failing a new one for */
  }
}

/**
 * It can only look: nothing but a GET or a HEAD, nowhere but this application,
 * and no address that is not one of its pages.
 *
 * Held on the whole browser context, so it covers every request any page in
 * it makes — the address it is sent to, a redirect, a script's own fetch. A
 * server action is a POST: whatever a page tried to do, it would not arrive.
 */
export async function lookOnly(context: BrowserContext, origin: string): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return route.abort('blockedbyclient');
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.abort('blockedbyclient');
    }
    if (url.origin !== origin) return route.abort('blockedbyclient');
    if (request.isNavigationRequest() && !checkPath(`${url.pathname}${url.search}`).ok) return route.abort('blockedbyclient');
    return route.continue();
  });
}

/** What the page turned out to be: its heading, and whether it is one of the application's own refusals. */
const READ_PAGE = `(function () {
  var heading = document.querySelector('main h1') || document.querySelector('h1');
  var title = heading ? String(heading.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : '';
  var state = null;
  var card = document.querySelector('[class*="stateCard"][role="alert"]');
  if (card) state = card.querySelector('[class*="stateIconAlert"]') ? 'error' : 'missing';
  else if (document.querySelector('.panel[role="alert"] > h1.page__title')) state = 'denied';
  var said = '';
  var alertBox = card || document.querySelector('.panel[role="alert"]');
  if (alertBox) said = String(alertBox.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
  return { title: title, state: state, said: said, record: !!document.querySelector('main [class*="sapDoc"]') };
})()`;

/**
 * The first record a list shows, found the way a person finds it: the first
 * link, in a row of a table on the page, that leads to a page UNDER the list's
 * own address (`/payables/suppliers` → `/payables/suppliers/SUP-00001`).
 *
 * It reads an `href` and returns it — looking, not pressing. A link to "new",
 * to an export, or to anywhere that is not under the list is passed over, so a
 * row that names its import or its supplier does not send the picture there.
 * Plain ES5, handed to the page as text (see `guide/markers.ts` for why).
 */
const firstRecordCall = (listPath: string): string => `(function (route) {
  var under = String(route).replace(/\\/+$/, '') + '/';
  var links = document.querySelectorAll('main table tbody tr a[href]');
  for (var i = 0; i < links.length; i += 1) {
    var url;
    try {
      url = new URL(links[i].getAttribute('href'), location.href);
    } catch (e) {
      continue;
    }
    if (url.origin !== location.origin) continue;
    if (url.pathname.indexOf(under) !== 0) continue;
    var rest = url.pathname.slice(under.length).replace(/\\/+$/, '');
    if (!rest || /(^|\\/)(new|export|edit)$/i.test(rest)) continue;
    return url.pathname + url.search;
  }
  return null;
})(${JSON.stringify(listPath)})`;

/** The page a person sees: its heading there, the top bar measured, the fonts in. */
async function settle(page: Page, budget: number): Promise<void> {
  await page.locator('h1').first().waitFor({ timeout: budget });
  await page
    .locator('.erp-nav[data-fit]')
    .first()
    .waitFor({ state: 'attached', timeout: Math.min(8_000, budget) })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(6_000, budget) }).catch(() => {});
  await page.evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(function () { return true; }) : true').catch(() => {});
  // A development server's own badge is not part of the ERP.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {});
  await page.waitForTimeout(250);
}

interface Seen {
  readonly title: string;
  readonly state: 'error' | 'missing' | 'denied' | null;
  readonly said: string;
  readonly record: boolean;
}

async function take(input: {
  readonly userId: string;
  readonly path: string;
  readonly locale: 'en' | 'ar';
  readonly pointAt?: readonly string[];
  readonly fullPage?: boolean;
  readonly firstRecord?: boolean;
}): Promise<LiveShotResult> {
  const base = baseUrl();
  const origin = new URL(base).origin;
  // A record found on a list is two pages opened, not one.
  const timeout = shotTimeout() * (input.firstRecord ? 2 : 1);
  const started = Date.now();
  const left = () => Math.max(1_000, timeout - (Date.now() - started));

  const minted = await mintSession(input.userId);
  if ('refused' in minted) {
    await auditShot(input.userId, { path: input.path, outcome: 'denied', reason: minted.refused });
    return { ok: false, reason: minted.refused };
  }

  let context: BrowserContext | null = null;
  let outcome: 'success' | 'denied' | 'failure' = 'failure';
  let why = '';
  let count: number | undefined;
  /** What was pictured, once it is not the address that was asked for: the record a list led to. */
  let pictured = '';
  const refuse = (kind: 'denied' | 'failure', reason: string): LiveShotResult => {
    outcome = kind;
    why = reason;
    return { ok: false, reason };
  };

  try {
    let open: Browser;
    try {
      open = await theBrowser();
    } catch (error) {
      return refuse('failure', `The browser on this server would not start (${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 160) : String(error)}). Describe the screen in words, or use the pictures made ahead of time.`);
    }
    context = await open.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: input.locale === 'ar' ? 'ar-IQ' : 'en-GB',
    });
    await context.addCookies([
      { name: LIVE_SESSION_COOKIE, value: minted.token, url: base, httpOnly: true, sameSite: 'Lax' },
      { name: LOCALE_COOKIE, value: input.locale, url: base, sameSite: 'Lax' },
    ]);
    await lookOnly(context, origin);

    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    // Where the application tried to send the browser: a redirect the guard stopped is still known by its address.
    let sentTo = '';
    page.on('request', (request) => {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      try {
        sentTo = new URL(request.url()).pathname;
      } catch {
        /* not an address */
      }
    });
    /** Opens one address and reads what it turned out to be — or says why it is not a screen to picture. */
    const visit = async (path: string): Promise<{ readonly landed: URL; readonly seen: Seen | null } | LiveShotResult> => {
      let status = 0;
      try {
        const response = await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: left() });
        status = response?.status() ?? 0;
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        if (/Timeout|timed out/i.test(said)) return refuse('failure', `The page did not open within ${Math.round(timeout / 1000)} seconds. Try once more; if it happens again the system is slow or that screen is failing (system_status).`);
        if (/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|Download is starting/i.test(said)) {
          if (sentTo.startsWith('/sign-in')) {
            return refuse('failure', 'The application did not accept the sign-in for this picture and sent the browser back to the sign-in page, so nothing was pictured. That is a fault on the server, not theirs: report it.');
          }
          return refuse('denied', 'That address does not lead to a screen: it sent the browser somewhere that is not a page of the ERP.');
        }
        return refuse('failure', `The page could not be opened (${(said.split('\n')[0] ?? '').slice(0, 140)}).`);
      }

      const landed = new URL(page.url());
      const asked = path.split('?')[0] ?? path;
      if (landed.pathname.startsWith('/sign-in')) return refuse('failure', 'The application did not accept the sign-in for this picture, so nothing was pictured. That is a fault on the server, not theirs: report it.');
      if (landed.pathname.startsWith('/password') && !asked.startsWith('/password')) {
        return refuse('denied', 'This person is still on a temporary password: until they change it (the Change password screen opens by itself when they sign in) the system opens no other screen for them, so there is nothing to picture.');
      }
      if (landed.pathname.startsWith('/profile/security') && !asked.startsWith('/profile/security')) {
        return refuse('denied', 'This person has not set up their authenticator app, and the time allowed for it has passed: until they do (their initials → Profile settings → Security) the system opens no other screen for them, so there is nothing to picture.');
      }
      if (status === 404) return refuse('denied', `There is no such page or record at ${asked} — or none that this person may see. Check the address (screens) or the document number (document_story).`);
      if (status >= 500) return refuse('failure', `The application failed to draw ${asked} (it answered ${status}). That is a defect: system_status shows the error it logged; report it.`);

      try {
        await settle(page, left());
      } catch {
        return refuse('failure', `The page at ${asked} did not finish opening within ${Math.round(timeout / 1000)} seconds.`);
      }
      const seen = (await page.evaluate(READ_PAGE).catch(() => null)) as Seen | null;
      if (seen?.state === 'missing') return refuse('denied', `There is no such page or record at ${asked} — or none that this person may see. Check the address (screens) or the document number (document_story).`);
      if (seen?.state === 'denied') return refuse('denied', `This person's role may not open ${asked}: the system showed them its refusal instead of the screen (${seen.said}).`);
      if (seen?.state === 'error') return refuse('failure', `The application failed to draw ${asked} and showed its error page (${seen.said}). That is a defect: system_status shows the error it logged; report it.`);
      return { landed, seen };
    };

    let opened = await visit(input.path);
    if ('ok' in opened) return opened;

    if (input.firstRecord) {
      // The list is open as the asker sees it: the first record it shows them is read off it, and opened the same way.
      const found = (await page.evaluate(firstRecordCall(opened.landed.pathname)).catch(() => null)) as string | null;
      const checked = typeof found === 'string' && found ? checkPath(found) : null;
      if (!checked || !checked.ok) return refuse('denied', 'There is no record on that screen yet to open.');
      pictured = checked.path;
      opened = await visit(checked.path);
      if ('ok' in opened) return opened;
    }
    const { landed, seen } = opened;
    const where = `${landed.pathname}${landed.search}`;

    const lastSegment = (landed.pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase();
    const record = Boolean(input.firstRecord) || Boolean(seen?.record) || /\d/.test(lastSegment);
    const drawnMarks = await drawMarks(page, {
      scope: record ? 'record' : 'screen',
      withValues: true,
      ...(input.pointAt && input.pointAt.length > 0 ? { pointAt: input.pointAt.slice(0, 6).map((one) => String(one).slice(0, 80)) } : {}),
      ...(input.fullPage ? { fullPage: true } : {}),
    });
    await page.waitForTimeout(120);

    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    sweep(dir);
    const file = join(dir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 65, fullPage: Boolean(input.fullPage), timeout: left() });
    await clearMarks(page);

    outcome = 'success';
    count = drawnMarks.marks.length;
    return { ok: true, shot: { file, path: where, title: seen?.title ?? '', marks: drawnMarks.marks, notFound: drawnMarks.notFound } };
  } catch (error) {
    const said = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    return refuse('failure', `The picture could not be taken (${said.slice(0, 160)}).`);
  } finally {
    if (context) await context.close().catch(() => {});
    // Whatever happened above, the session ends here.
    await endSession(input.userId, minted.sessionId).catch(() => {});
    await auditShot(input.userId, { path: pictured || input.path, outcome, ...(why ? { reason: why } : {}), sessionId: minted.sessionId, ...(count === undefined ? {} : { marks: count }) });
    restLater();
  }
}

/**
 * The `screenshot` tool's work: one address of the live ERP, pictured as the
 * asker, with the pointers drawn on it.
 *
 * Refusals come back as values with a sentence that can be repeated to the
 * person — a picture that could not be taken is an answer too.
 */
export async function liveScreenshot(input: {
  /** The asker — the only person it can ever be taken as. */
  readonly userId: string;
  /** An address inside the ERP, e.g. /sales/ar-invoices/INV-HQ-2026-000001. */
  readonly path: string;
  readonly locale: 'en' | 'ar';
  readonly pointAt?: readonly string[];
  /** Default false: the first screenful. */
  readonly fullPage?: boolean;
  /** The path is a list: open the first record it shows, and picture that. */
  readonly firstRecord?: boolean;
}): Promise<LiveShotResult> {
  const ready = liveShotsReady();
  if (!ready.ok) return { ok: false, reason: ready.reason ?? 'Live pictures cannot be taken on this server.' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.userId)) return { ok: false, reason: 'There is nobody to take the picture as.' };
  const checked = checkPath(input.path);
  if (!checked.ok) {
    await auditShot(input.userId, { path: String(input.path ?? ''), outcome: 'denied', reason: checked.reason });
    return { ok: false, reason: checked.reason };
  }
  const work = turn.then(
    () => take({ ...input, path: checked.path }),
    () => take({ ...input, path: checked.path }),
  );
  turn = work.catch(() => {});
  return work;
}
