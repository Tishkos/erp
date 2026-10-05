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
 *   IT CANNOT CHANGE    The browser is refused every request that is not a
 *   ANYTHING            GET or a HEAD, every request to another origin, and
 *                       every download. Saving, sending, approving and posting
 *                       are all POSTs: whatever happened in the page, none of
 *                       them would reach the server. That guard (`lookOnly`)
 *                       is the rule, and it is on the whole browser.
 *   IT OPENS, AND       Since 2026-10-05 ("no more training picture … always
 *   NOTHING MORE        live") the camera also shows what the ready-made
 *                       pictures used to: the form that opens, a window, the
 *                       menu. For that it may press three kinds of thing and
 *                       no other — a menu of the top bar, the Print / Export
 *                       menu, and a button that has a `<dialog>` directly
 *                       after it (which opens that window and does nothing
 *                       else). The page itself is asked whether the thing is
 *                       one of those immediately before the one press
 *                       (`MAY_PRESS`, `press`); a button that acts at once is
 *                       refused; nothing inside what opened is pressed; no
 *                       key is typed; no form is filled.
 *   ONLY THE PAGES      The address must be a page of the application itself:
 *                       not `/api`, not the export or attachment routes (a GET
 *                       there is a file, and an export is audited as one), not
 *                       the sign-in form.
 *
 * The sign-in page is the one picture taken as NOBODY (`liveSignIn`): no
 * session at all, one address, the same page everybody meets.
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
import { clearMarks, drawMarks, type Mark, type MarkOptions } from '../guide/markers';
import { DIALOG_OVERFLOW, FIND_OPENERS, PREPARE_DIALOG, RING, keyOf, type Opener } from '../guide/openers';

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
  /** A screen or a record, pictured as it opens: the windows it can open, each by the key to ask for it with. */
  readonly windows?: ReadonlyArray<{ readonly key: string; readonly name: string }>;
  /** A menu's picture: the entry that is ringed, as the menu words it. */
  readonly ringed?: string;
  /** What was opened for the picture: the button's own words (a form, a window). */
  readonly opened?: string;
}

export type LiveShotResult = { readonly ok: true; readonly shot: LiveShot } | { readonly ok: false; readonly reason: string };

/**
 * What the camera may open on the page before the picture is taken — the
 * whole list. Each is a thing a person opens to LOOK: none of them saves,
 * sends or changes anything, and nothing inside what opens is ever pressed.
 */
export type LiveOpen =
  /** A module's dropdown in the top bar, with the entry for `route` ringed in red. */
  | { readonly kind: 'menu'; readonly route: string; readonly moduleTitles: readonly string[] }
  /** The way in to a new record: its own page (its address read off a link, opened with a plain GET) or the window its button opens. */
  | { readonly kind: 'form' }
  /** A window this page opens, by its key or by words of its name; '' asks only which there are. */
  | { readonly kind: 'dialog'; readonly which: string }
  /** The menu behind the person's initials. */
  | { readonly kind: 'user-menu' }
  /** Nothing opened: the bar every screen sits under, its parts numbered. */
  | { readonly kind: 'top-bar' };

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

async function auditShot(
  userId: string,
  input: { path: string; outcome: 'success' | 'denied' | 'failure'; reason?: string; sessionId?: string | null; marks?: number; opened?: string },
): Promise<void> {
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
        after: { path: input.path.slice(0, 300), ...(input.marks === undefined ? {} : { marks: input.marks }), ...(input.opened ? { opened: input.opened } : {}) },
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

// ---------------------------------------------------------------------------
// What may be opened for a picture — and the one place anything is pressed
// ---------------------------------------------------------------------------

/**
 * THE ONLY THINGS THAT MAY BE PRESSED, asked of the page itself about the one
 * element tagged for pressing, immediately before the press:
 *
 *   1. a menu of the top bar — a module's dropdown, the account menu;
 *   2. the Print / Export menu of a list — a `<details>`, opened by its `<summary>`;
 *   3. a button with a `<dialog>` DIRECTLY AFTER it, that belongs to no form
 *      (or says `type="button"`): it opens that window and does nothing else.
 *
 * A button with no dialog after it acts at once, and is refused here whatever
 * asked for it. This is the rule the ready-made pictures were taken by, over
 * every screen of the menu, without saving anything (`guide/openers.ts`).
 */
export const MAY_PRESS = String.raw`(function () {
  var all = document.querySelectorAll('[data-noah-press]');
  if (all.length !== 1) return 'none';
  var el = all[0];
  var raw = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
  var cls = ' ' + String(raw || '') + ' ';
  if (el.disabled) return 'refused';
  if (el.tagName === 'BUTTON' && el.closest('.erp-header') && (cls.indexOf(' erp-nav__trigger ') >= 0 || cls.indexOf(' erp-user-trigger ') >= 0)) return 'ok';
  if (el.tagName === 'SUMMARY' && el.parentElement && el.parentElement.tagName === 'DETAILS' && el.parentElement.hasAttribute('data-export-menu')) return 'ok';
  if (
    el.tagName === 'BUTTON' &&
    !el.closest('dialog') &&
    el.nextElementSibling &&
    el.nextElementSibling.tagName === 'DIALOG' &&
    (!el.form || el.getAttribute('type') === 'button')
  ) {
    return 'ok';
  }
  return 'refused';
})()`;

/**
 * Finds what is to be opened and tags it (`data-noah-press`) — finding is
 * reading; the press is `press`'s, after `MAY_PRESS` has agreed.
 *
 *   user        the account menu's button
 *   module      the top bar's button for one module, by its title (either language)
 *   opener      a window's opener, by the place `FIND_OPENERS` gave it
 *   form        the way in to a new record: a link to its own page (returned, not
 *               tagged — it is opened with a GET), else the button whose dialog
 *               is the form (tagged), else the button that starts one at once
 *               (named, never tagged)
 *   point-new   the same thing, only marked for the arrow (`data-guide-point`)
 */
export const TAG_TARGET = String.raw`(function (kind, arg) {
  var old = document.querySelectorAll('[data-noah-press]');
  for (var o = 0; o < old.length; o += 1) old[o].removeAttribute('data-noah-press');
  function classOf(el) {
    var raw = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    return String(raw || '');
  }
  function shown(el) {
    if (!el || !el.getClientRects().length) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) return false;
    var style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  function words(el) {
    return String(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  var el = null;
  if (kind === 'user') {
    el = document.querySelector('.erp-header .erp-user-trigger');
  } else if (kind === 'module') {
    var triggers = document.querySelectorAll('.erp-header button.erp-nav__trigger');
    for (var i = 0; i < triggers.length && !el; i += 1) {
      var title = String(triggers[i].getAttribute('title') || triggers[i].textContent || '').replace(/\s+/g, ' ').trim();
      for (var t = 0; t < arg.length; t += 1) if (title === arg[t]) el = triggers[i];
    }
  } else if (kind === 'opener') {
    el = document.querySelector('[data-guide-dialog="' + String(Number(arg)) + '"]');
  } else {
    var link = null;
    var links = document.querySelectorAll('main a[href]');
    for (var l = 0; l < links.length && !link; l += 1) {
      if (/\/new(\?|$)/.test(links[l].getAttribute('href') || '') && shown(links[l]) && !links[l].closest('dialog')) link = links[l];
    }
    var button = null;
    var buttons = document.querySelectorAll('main button');
    for (var b = 0; b < buttons.length && !button; b += 1) {
      var one = buttons[b];
      var next = one.nextElementSibling;
      if (!next || next.tagName !== 'DIALOG' || one.disabled || one.closest('dialog') || !shown(one)) continue;
      /* A door of the title bar opens a window too, and is not a new record; neither is a row's own button. */
      if (/sapIconButton/.test(classOf(one)) || one.closest('tbody')) continue;
      button = one;
    }
    var plus = null;
    var primaries = document.querySelectorAll('main header [class*="headerActions"] a[class*="primary"], main header [class*="headerActions"] button[class*="primary"]');
    for (var p = 0; p < primaries.length && !plus; p += 1) if (primaries[p].querySelector('svg') && shown(primaries[p])) plus = primaries[p];
    if (kind === 'point-new') {
      var starter = link || button || plus;
      var was = document.querySelectorAll('[data-guide-point]');
      for (var w = 0; w < was.length; w += 1) was[w].removeAttribute('data-guide-point');
      if (starter) starter.setAttribute('data-guide-point', '');
      return { found: !!starter, label: starter ? words(starter) : '' };
    }
    if (link) return { found: true, way: 'link', href: link.getAttribute('href'), label: words(link) };
    if (button) {
      button.setAttribute('data-noah-press', '');
      return { found: true, way: 'button', label: words(button) };
    }
    return { found: false, way: plus ? 'acts' : 'none', label: plus ? words(plus) : '' };
  }
  if (!el || !shown(el)) return { found: false, label: '' };
  el.setAttribute('data-noah-press', '');
  return { found: true, label: words(el) };
})`;

/** The open dropdown of the top bar: the entry for one address ringed in red, and where the dropdown ends. */
const RING_ENTRY = String.raw`(function (route, ring) {
  var all = document.querySelectorAll('.erp-module-popover');
  var popover = null;
  for (var i = 0; i < all.length && !popover; i += 1) if (all[i].getClientRects().length) popover = all[i];
  if (!popover) return { found: false, label: '', bottom: 0 };
  var links = popover.querySelectorAll('a[href]');
  var link = null;
  for (var l = 0; l < links.length && !link; l += 1) if (links[l].getAttribute('href') === route) link = links[l];
  if (!link) return { found: false, label: '', bottom: 0 };
  link.setAttribute('style', (link.getAttribute('style') || '') + ';' + ring);
  link.scrollIntoView({ block: 'nearest' });
  var rect = popover.getBoundingClientRect();
  return { found: true, label: String(link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), bottom: rect.top + rect.height };
})`;

/** Where one thing on the page ends, for a picture that stops just under it. */
const BOTTOM_OF = String.raw`(function (selector) {
  var el = document.querySelector(selector);
  if (!el || !el.getClientRects().length) return 0;
  var rect = el.getBoundingClientRect();
  return rect.top + rect.height;
})`;

const call = (snippet: string, ...args: readonly unknown[]): string => `${snippet}(${args.map((one) => JSON.stringify(one ?? null)).join(', ')})`;

interface Tagged {
  readonly found: boolean;
  readonly label: string;
  readonly way?: 'link' | 'button' | 'acts' | 'none';
  readonly href?: string | null;
}

/**
 * The press. The one line in this service that presses anything, and it
 * presses only what the page itself has just agreed is a menu of the top bar,
 * an export menu, or a button that opens a window. Returns '' when it was
 * pressed, else the sentence that says why not.
 *
 * It is not the guard — `lookOnly` is: whatever is pressed, no request that
 * is not a GET or a HEAD leaves this browser, so nothing can be saved. This
 * is the second lock on the same door, and the page must still be the same
 * page afterwards.
 */
async function press(page: Page, budget: number): Promise<string> {
  const verdict = (await page.evaluate(MAY_PRESS).catch(() => 'none')) as string;
  if (verdict !== 'ok') {
    return 'Nothing was pressed: what would open it is not one of the things this camera may press (a menu of the top bar, or a button that only opens a window).';
  }
  const before = page.url();
  try {
    await page.locator('[data-noah-press]').first().click({ timeout: Math.min(8_000, budget) });
  } catch (error) {
    return `It could not be opened (${(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)).slice(0, 120)}).`;
  }
  await page.waitForTimeout(150);
  if (page.url() !== before) return 'Pressing it left the page, which a button that only opens a window never does, so nothing was pictured.';
  return '';
}

/** A long window scrolls inside itself: the browser is made taller for the picture, so every numbered field is in it. */
async function fitWindow(page: Page): Promise<void> {
  const over = Number(await page.evaluate(DIALOG_OVERFLOW).catch(() => 0)) || 0;
  if (over > 4) await page.setViewportSize({ width: WIDTH, height: Math.min(2400, HEIGHT + Math.ceil(over) + 40) }).catch(() => {});
  await page.waitForTimeout(180);
}

/** Words as a person may write them, for matching a window's name: lower case, punctuation as spaces. */
const fold = (text: string) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim();

/** The windows a page opens, each with the key to ask for it by. */
async function windowsOf(page: Page): Promise<Array<Opener & { readonly key: string }>> {
  const found = ((await page.evaluate(FIND_OPENERS).catch(() => [])) as Opener[]).slice(0, 12);
  const used = new Set<string>();
  return found.map((one) => {
    let key = keyOf(one);
    for (let again = 2; used.has(key); again += 1) key = `${keyOf(one)}_${again}`;
    used.add(key);
    return { ...one, key };
  });
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
  readonly open?: LiveOpen;
  readonly pointNew?: boolean;
  readonly as?: 'form';
}): Promise<LiveShotResult> {
  const base = baseUrl();
  const origin = new URL(base).origin;
  // A record found on a list, and a thing opened on the page, are each a step more than one page opened.
  const timeout = shotTimeout() * (1 + (input.firstRecord ? 1 : 0) + (input.open ? 1 : 0));
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
  /** What was opened for the picture, for the audit row. */
  let what = '';
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
    let { landed, seen } = opened;
    let where = `${landed.pathname}${landed.search}`;

    const lastSegment = (landed.pathname.split('/').filter(Boolean).pop() ?? '').toLowerCase();
    const record = Boolean(input.firstRecord) || Boolean(seen?.record) || /\d/.test(lastSegment);

    /** What the numbers are drawn over, and how much of the page the picture takes. */
    let scope: MarkOptions['scope'] = input.as === 'form' ? 'form' : record ? 'record' : 'screen';
    let root: string | undefined = input.as === 'form' ? 'main' : undefined;
    let gridAsOne: boolean | undefined = input.as === 'form' ? false : undefined;
    let whole = Boolean(input.fullPage);
    let numbered = true;
    /** A picture that stops just under what was opened: how far down that is. */
    let stopAt = 0;
    let ringed = '';
    let openedBy = '';
    let windows: Array<{ readonly key: string; readonly name: string }> = [];

    const toOpen = input.open;
    if (!toOpen) {
      // The windows this page can open are named with its picture, so one can be asked for by name.
      if (scope === 'screen' || scope === 'record') windows = (await windowsOf(page)).map((one) => ({ key: one.key, name: one.name }));
      // A screen's picture is about the way to a new one: that button gets the thick box and the arrow.
      if (input.pointNew && scope === 'screen') await page.evaluate(call(TAG_TARGET, 'point-new', null)).catch(() => null);
    } else if (toOpen.kind === 'top-bar') {
      scope = 'top-bar';
    } else if (toOpen.kind === 'user-menu') {
      const target = (await page.evaluate(call(TAG_TARGET, 'user', null)).catch(() => null)) as Tagged | null;
      if (!target?.found) return refuse('failure', 'The account menu could not be found on the page.');
      const refused = await press(page, left());
      if (refused) return refuse('failure', refused);
      const shownPanel = await page.locator('#erp-user-panel').first().waitFor({ state: 'visible', timeout: Math.min(8_000, left()) }).then(() => true, () => false);
      if (!shownPanel) return refuse('failure', 'The account menu did not open.');
      scope = 'user-menu';
      stopAt = Number(await page.evaluate(call(BOTTOM_OF, '#erp-user-panel')).catch(() => 0)) || 0;
    } else if (toOpen.kind === 'menu') {
      const target = (await page.evaluate(call(TAG_TARGET, 'module', toOpen.moduleTitles.slice(0, 6))).catch(() => null)) as Tagged | null;
      if (!target?.found) return refuse('denied', 'That module is not in this person\'s top bar, so there is no menu of it to picture.');
      const refused = await press(page, left());
      if (refused) return refuse('failure', refused);
      const shownMenu = await page.locator('.erp-module-popover').first().waitFor({ state: 'visible', timeout: Math.min(8_000, left()) }).then(() => true, () => false);
      if (!shownMenu) return refuse('failure', 'The module\'s menu did not open.');
      await page.waitForTimeout(150);
      const entry = (await page.evaluate(call(RING_ENTRY, toOpen.route, RING.replace(/\s+/g, ' ').trim())).catch(() => null)) as { found: boolean; label: string; bottom: number } | null;
      if (!entry?.found) return refuse('denied', 'That screen is not in this person\'s menu: their role does not open it, or it is reached from another screen.');
      await page.waitForTimeout(120);
      ringed = entry.label;
      openedBy = target.label;
      stopAt = entry.bottom;
      numbered = false;
    } else if (toOpen.kind === 'form') {
      const way = (await page.evaluate(call(TAG_TARGET, 'form', null)).catch(() => null)) as Tagged | null;
      if (way?.way === 'link' && way.href) {
        const checked = checkPath(new URL(way.href, `${origin}${where}`).pathname + new URL(way.href, `${origin}${where}`).search);
        if (!checked.ok) return refuse('denied', 'The way to a new one on that screen does not lead to a page of the ERP.');
        pictured = checked.path;
        const next = await visit(checked.path);
        if ('ok' in next) return next;
        ({ landed, seen } = next);
        where = `${landed.pathname}${landed.search}`;
        scope = 'form';
        root = 'main';
        whole = true;
        openedBy = way.label;
      } else if (way?.way === 'button') {
        const refused = await press(page, left());
        if (refused) return refuse('failure', refused);
        const shownForm = await page.locator('dialog[open]').first().waitFor({ state: 'visible', timeout: Math.min(8_000, left()) }).then(() => true, () => false);
        if (!shownForm) return refuse('failure', `"${way.label}" was pressed and no window opened.`);
        await page.waitForTimeout(250);
        await page.evaluate(PREPARE_DIALOG).catch(() => 0);
        await fitWindow(page);
        scope = 'form';
        openedBy = way.label;
      } else if (way?.way === 'acts') {
        return refuse(
          'denied',
          `There is no form to picture before starting one here: "${way.label}" does its work at once — it raises the draft and opens it. Take the screen's picture, where the arrow is at that button, and say that pressing it opens the new draft to fill in.`,
        );
      } else {
        return refuse('denied', 'This screen has no button for a new one — nothing is created here, or this person\'s role may not create it.');
      }
    } else if (toOpen.kind === 'dialog') {
      const all = await windowsOf(page);
      const list = all.map((one) => `"${one.key}" — ${one.name}`).join('; ');
      const wanted = fold(toOpen.which);
      const match = !wanted
        ? null
        : (all.find((one) => fold(one.key) === wanted || fold(one.name) === wanted) ?? all.find((one) => fold(one.name).includes(wanted) || fold(one.key).includes(wanted) || wanted.includes(fold(one.name))) ?? null);
      if (!match) {
        return refuse(
          'denied',
          all.length === 0
            ? `That page opens no window${record ? '' : ' — an opened record of it may: ask for the window on the record'}.`
            : `${wanted ? `No window on that page is called "${toOpen.which}". ` : ''}The windows it opens: ${list}. Ask for one of them by its name.`,
        );
      }
      const target = (await page.evaluate(call(TAG_TARGET, 'opener', match.order)).catch(() => null)) as Tagged | null;
      if (!target?.found) return refuse('failure', `The button for "${match.name}" could not be found again on the page.`);
      const refused = await press(page, left());
      if (refused) return refuse('failure', refused);
      root = match.menu ? 'details[open][data-export-menu]' : 'dialog[open]';
      const shownWindow = await page.locator(root).first().waitFor({ state: 'visible', timeout: Math.min(8_000, left()) }).then(() => true, () => false);
      if (!shownWindow) return refuse('failure', `"${match.name}" was pressed and no window opened.`);
      await page.waitForTimeout(250);
      if (!match.menu) {
        await page.evaluate(PREPARE_DIALOG).catch(() => 0);
        await fitWindow(page);
      }
      scope = 'dialog';
      openedBy = match.name;
    }

    const drawnMarks = numbered
      ? await drawMarks(page, {
          scope,
          ...(root ? { root } : {}),
          ...(gridAsOne === undefined ? {} : { gridAsOne }),
          withValues: true,
          ...(input.pointAt && input.pointAt.length > 0 ? { pointAt: input.pointAt.slice(0, 6).map((one) => String(one).slice(0, 80)) } : {}),
          ...(whole ? { fullPage: true } : {}),
        })
      : { marks: [] as Mark[], notFound: [] as string[] };
    if (toOpen?.kind === 'form' && drawnMarks.marks.length === 0) {
      return refuse('denied', 'What opens there has nothing to fill in for this person — it says why a new one cannot be started yet. Say what it says, in words.');
    }
    await page.waitForTimeout(120);

    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    sweep(dir);
    const file = join(dir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.jpg`);
    const tall = page.viewportSize()?.height ?? HEIGHT;
    await page.screenshot({
      path: file,
      type: 'jpeg',
      quality: 65,
      fullPage: whole,
      ...(stopAt > 0 && !whole ? { clip: { x: 0, y: 0, width: WIDTH, height: Math.max(120, Math.min(tall, Math.ceil(stopAt + 14))) } } : {}),
      timeout: left(),
    });
    await clearMarks(page);

    outcome = 'success';
    count = drawnMarks.marks.length;
    what = toOpen?.kind ?? '';
    return {
      ok: true,
      shot: {
        file,
        path: where,
        title: seen?.title ?? '',
        marks: drawnMarks.marks,
        notFound: drawnMarks.notFound,
        ...(windows.length > 0 ? { windows } : {}),
        ...(ringed ? { ringed } : {}),
        ...(openedBy ? { opened: openedBy } : {}),
      },
    };
  } catch (error) {
    const said = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    return refuse('failure', `The picture could not be taken (${said.slice(0, 160)}).`);
  } finally {
    if (context) await context.close().catch(() => {});
    // Whatever happened above, the session ends here.
    await endSession(input.userId, minted.sessionId).catch(() => {});
    await auditShot(input.userId, {
      path: pictured || input.path,
      outcome,
      ...(why ? { reason: why } : {}),
      sessionId: minted.sessionId,
      ...(count === undefined ? {} : { marks: count }),
      ...(what || input.open ? { opened: what || input.open!.kind } : {}),
    });
    restLater();
  }
}

/**
 * The sign-in page, as somebody who is not signed in meets it.
 *
 * The one picture taken as NOBODY: no session is made, no cookie but the
 * language is sent, and the browser may open that one address and no other.
 * It is the same page for everybody, so there is nothing of anybody's on it;
 * `userId` is only who asked, for the audit row.
 */
async function takeSignIn(input: { readonly userId: string; readonly locale: 'en' | 'ar' }): Promise<LiveShotResult> {
  const base = baseUrl();
  const origin = new URL(base).origin;
  const timeout = shotTimeout();
  let context: BrowserContext | null = null;
  let outcome: 'success' | 'denied' | 'failure' = 'failure';
  let why = '';
  let count: number | undefined;
  try {
    const open = await theBrowser();
    context = await open.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
      locale: input.locale === 'ar' ? 'ar-IQ' : 'en-GB',
    });
    await context.addCookies([{ name: LOCALE_COOKIE, value: input.locale, url: base, sameSite: 'Lax' }]);
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
      if (request.isNavigationRequest() && url.pathname !== '/sign-in') return route.abort('blockedbyclient');
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(`${base}/sign-in`, { waitUntil: 'domcontentloaded', timeout });
    await page.locator('main input').first().waitFor({ timeout });
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
    await page.evaluate('document.fonts && document.fonts.ready ? document.fonts.ready.then(function () { return true; }) : true').catch(() => {});
    await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {});
    await page.waitForTimeout(250);
    const title = String((await page.evaluate(`(function () { var h = document.querySelector('h1'); return h ? String(h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) : ''; })()`).catch(() => '')) ?? '');
    // Nobody's values: the form is empty, and what a browser might offer to fill is not read.
    const drawn = await drawMarks(page, { scope: 'form', root: 'main', gridAsOne: false });
    await page.waitForTimeout(120);
    const dir = shotsDir();
    mkdirSync(dir, { recursive: true });
    sweep(dir);
    const file = join(dir, `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 65, timeout });
    await clearMarks(page);
    outcome = 'success';
    count = drawn.marks.length;
    return { ok: true, shot: { file, path: '/sign-in', title, marks: drawn.marks, notFound: [] } };
  } catch (error) {
    why = `The sign-in page could not be pictured (${(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)).slice(0, 160)}).`;
    return { ok: false, reason: why };
  } finally {
    if (context) await context.close().catch(() => {});
    await auditShot(input.userId, { path: '/sign-in', outcome, ...(why ? { reason: why } : {}), ...(count === undefined ? {} : { marks: count }), opened: 'sign-in, as nobody' });
    restLater();
  }
}

/** The sign-in page as it is now — the same for everybody, pictured as nobody. `userId` is who asked. */
export async function liveSignIn(input: { readonly userId: string; readonly locale: 'en' | 'ar' }): Promise<LiveShotResult> {
  const ready = liveShotsReady();
  if (!ready.ok) return { ok: false, reason: ready.reason ?? 'Live pictures cannot be taken on this server.' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.userId)) return { ok: false, reason: 'There is nobody to take the picture for.' };
  const locale = input.locale === 'ar' ? 'ar' : 'en';
  const work = turn.then(
    () => takeSignIn({ userId: input.userId, locale }),
    () => takeSignIn({ userId: input.userId, locale }),
  );
  turn = work.catch(() => {});
  return work;
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
  /** Open one thing on that page first: its menu entry, its form, one of its windows (see `LiveOpen`). */
  readonly open?: LiveOpen;
  /** A screen's picture: the thick box and the arrow go to the way in to a new record. */
  readonly pointNew?: boolean;
  /** The page is itself a form (changing a password): number its fields as one. */
  readonly as?: 'form';
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
