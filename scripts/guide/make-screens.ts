/**
 * The pictures Noah sends: every built screen, in both languages, three ways.
 *
 *   npx tsx scripts/guide/make-screens.ts [--only <part of a route>] [--force]
 *
 * By direction (2026-10-04): "if he can take screenshots it would be so good —
 * send it to the group chat and point out what to do". He cannot open a
 * browser from a chat, and a picture of the live books in a group is nobody's
 * wish; so the pictures are taken here, once, from a development copy with
 * sample data, and he sends the one that answers the question:
 *
 *   menu    the module's dropdown open, the screen's entry ringed — where to click
 *   screen  the screen itself, its "New …" button ringed where it has one
 *   form    what opens when that button is pressed — the fields to fill, each
 *           with a red number beside its name, and the button that saves last
 *   record  one record of a list, opened: its status, the doors in its title
 *           bar, its actions and its tables
 *   dialog  what opens from a screen or a record without saving anything — the
 *           printer, the paperclip, the notes, the history, and each button
 *           that opens a dialog (a reason to reverse, a bank account to add) —
 *           its fields and buttons numbered like a form's
 *
 * The same day: "step 1 look at this screenshot where I point out, do that,
 * write that in that input" — and then "not just login: all screens,
 * everything". So what a picture shows is numbered in it — a form's fields; a
 * screen's buttons, tabs, search, filters, tables, paging and sections; a
 * record's status, doors and actions — and the numbers are written down beside
 * it (`marks` in `index.json`: the number, the thing's name as the screen
 * shows it, and what kind of thing it is). He can only say "write it in 3" if
 * he knows what 3 is. A numbered field also carries what the screen itself
 * says about it — the choices of a dropdown (`options`) and the hint written
 * under it (`hint`) — so the explanation is the form's own, not a guess.
 *
 * The pointing itself — a box round each numbered thing, and a thick box with
 * an arrow for the one the step is about ("points with square, arrows",
 * 2026-10-05) — is `src/server/guide/markers.ts`, the same code that marks a
 * picture taken of the live system, so the two never look like two systems.
 * What this script adds is where to look: a screen's "New …" button is the
 * thing pointed at (`pointed` on its mark; `ringed` on the picture).
 *
 * And four pictures that are not screens of the menu, for the questions asked
 * first: signing in (`/sign-in`, form), the top bar (`top-bar`, screen), the
 * menu behind the avatar (`user-menu`, menu) and changing the password
 * (`/password`, form). `--only sign-in`, `--only top-bar`, … take one.
 *
 * Written to `var/guide-shots/<locale>/…` with an `index.json`; `var/` is not
 * in git. Copy the folder to the server's `var/guide-shots` and Noah's
 * `show_screen` tool finds them (`services/system-guide.ts`).
 * `GUIDE_SHOTS_OUT` writes somewhere else — for a trial that must not disturb
 * a run in progress.
 *
 * Runs against the local development server (http://localhost:3000, the
 * seeded administrator). It reads screens and presses "New …" to open a form,
 * and the buttons that only open a dialog; it never presses a form's own
 * button, nor a button that acts at once, so it saves nothing.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { MENU } from '../../src/server/domain/menu';
import { MODULES } from '../../src/server/domain/modules';
import { isDelivered, routeFor } from '../../src/server/domain/screens';
import { clearMarks, drawMarks, type Mark } from '../../src/server/guide/markers';
import { refuseOnLive } from '../lib/live-guard';

const BASE = process.env.GUIDE_BASE_URL ?? 'http://localhost:3000';
const OUT = process.env.GUIDE_SHOTS_OUT?.trim() || join(process.cwd(), 'var', 'guide-shots');
const ONLY = process.argv.includes('--only') ? (process.argv[process.argv.indexOf('--only') + 1] ?? '') : '';
const FORCE = process.argv.includes('--force');
const WIDTH = 1366;
const HEIGHT = 768;
type Catalogue = { shell: { module: Record<string, string> } };
const labels = (locale: string) => (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Catalogue).shell.module;

/** A route as a file name: /payables/invoices → payables_invoices. */
export const slugOf = (route: string) => route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_') || 'home';

interface Shot {
  readonly route: string;
  readonly locale: 'en' | 'ar';
  readonly view: 'menu' | 'screen' | 'form' | 'record' | 'dialog';
  readonly file: string;
  /** A dialog: whether it opens from the list screen or from an opened record. */
  readonly on?: 'screen' | 'record';
  /** A dialog: what its opener is called, in this picture's language. */
  readonly name?: string;
  /** A dialog: the same word for the same opener in both languages (`attachments`, `notes`, `reverse` …). */
  readonly key?: string;
  /** A dialog: its opener's place among the page's openers — how the Arabic picture finds the English one's key. */
  readonly order?: number;
  /** On a screen's picture: its "New …" button is the thing pointed at (the thick box and the arrow). */
  readonly ringed?: boolean;
  /** The numbers drawn on the picture, in order (`src/server/guide/markers.ts`). */
  readonly marks?: ReadonlyArray<Mark>;
}

/** The menu's picture: the entry to click, ringed. (Everything else is pointed at by the shared markers.) */
const RING = `
  outline: 3px solid #e11d48 !important;
  outline-offset: 3px !important;
  box-shadow: 0 0 0 8px rgba(225, 29, 72, 0.25) !important;
  border-radius: 4px !important;
`;

/*
 * The snippets below run in the page, and are handed over as text on purpose: a
 * function given to `page.evaluate` is compiled by tsx first, which wraps every
 * inner function in a helper (`__name`) the page has never heard of.
 */

/**
 * What on this page opens a dialog without saving anything: a button whose
 * next sibling is a `<dialog>` — the doors of a record's title bar are that,
 * and so is every "New …", "Reverse", "Add …" that asks before it acts — and
 * the Print / Export menu of a list. A button with no dialog after it acts at
 * once, and is never one of these. In a table only the first row's are taken:
 * every row opens the same dialog.
 *
 * Each is tagged (`data-guide-dialog`) with its place among them, which is the
 * same in both languages — the page is the same page.
 */
const FIND_OPENERS = String.raw`(function () {
  var main = document.querySelector('main') || document.body;
  var out = [];
  var order = 0;
  var firstRows = [];
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
  function tidy(text) {
    return String(text || '').replace(/\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  var old = document.querySelectorAll('[data-guide-dialog]');
  for (var o = 0; o < old.length; o += 1) old[o].removeAttribute('data-guide-dialog');
  var all = main.querySelectorAll('button, details[data-export-menu] > summary');
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    var menu = el.tagName === 'SUMMARY';
    if (!menu) {
      var next = el.nextElementSibling;
      if (!next || next.tagName !== 'DIALOG' || el.disabled) continue;
    }
    if (el.closest('dialog') || el.hasAttribute('data-guide-form-opener') || !shown(el)) continue;
    var row = el.closest('tbody tr');
    if (row) {
      var table = row.closest('table');
      var known = null;
      for (var k = 0; k < firstRows.length; k += 1) if (firstRows[k].table === table) known = firstRows[k];
      if (!known) firstRows.push({ table: table, row: row });
      else if (known.row !== row) continue;
    }
    order += 1;
    var sign = '';
    if (menu) sign = 'export-menu';
    else if (/sapIconButton/.test(classOf(el))) {
      var svg = el.querySelector('svg');
      sign = svg ? classOf(svg) : '';
    }
    el.setAttribute('data-guide-dialog', String(order));
    out.push({ order: order, name: tidy(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent), sign: sign, menu: menu });
  }
  return out;
})()`;

/** How far the open dialog's own scrolling area runs past what is shown. */
const DIALOG_OVERFLOW = `(function () {
  var dialog = document.querySelector('dialog[open]');
  if (!dialog) return 0;
  var worst = 0;
  var all = [dialog].concat(Array.prototype.slice.call(dialog.querySelectorAll('*')));
  for (var i = 0; i < all.length; i += 1) {
    var over = all[i].scrollHeight - all[i].clientHeight;
    if (over <= worst || all[i].clientHeight < 40) continue;
    var flow = getComputedStyle(all[i]).overflowY;
    if (flow === 'auto' || flow === 'scroll') worst = over;
  }
  return worst;
})()`;

interface Opener {
  readonly order: number;
  readonly name: string;
  readonly sign: string;
  readonly menu: boolean;
}

/** The doors of a record are the same four everywhere, whatever language names them. */
const DOORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/printer/, 'print_export'],
  [/paperclip/, 'attachments'],
  [/message|note/, 'notes'],
  [/history|clock/, 'audit_log'],
];

/** An opener's key from what does not change with the language, else from its English name. */
function keyOf(opener: Opener): string {
  if (opener.menu) return 'print_export';
  for (const [icon, key] of DOORS) if (opener.sign && icon.test(opener.sign)) return key;
  const slug = opener.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || `d${opener.order}`;
}

/** No page gets more dialog pictures than this. */
const MAX_DIALOGS = 8;

/**
 * Two things about a dialog that the shared markers do not allow for yet, put
 * right in the page for the length of one picture and put back afterwards:
 *
 *   * Two dialogs of the same form on one page ("New line" in the header, and
 *     "Edit" on every row) share their fields' ids, and a `<label for>` answers
 *     for the FIRST field with its id — so the second dialog's fields have no
 *     label of their own. Each such field and its label are given an id of
 *     their own (and the hint that is named by id with them).
 *   * A dialog opened from a table's row is itself inside that row's cell. The
 *     markers take a field inside a cell for a cell of a grid, and a button
 *     inside a table for a row's button, and number neither. The dialog is
 *     lifted out of the table — closed, moved to the page's own container (so
 *     it is styled as it was), opened again — and goes home afterwards.
 */
const PREPARE_DIALOG = String.raw`(function () {
  var dialog = document.querySelector('dialog[open]');
  if (!dialog) return 0;
  var changed = 0;
  var serial = 0;
  var fields = dialog.querySelectorAll('input:not([type="hidden"]), select, textarea');
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    var own = field.labels && field.labels[0] && dialog.contains(field.labels[0]);
    if (own || field.closest('label') || !field.parentNode) continue;
    var wrap = field.parentNode;
    var label = wrap.querySelector(':scope > label');
    if (!label || wrap.querySelectorAll('input:not([type="hidden"]), select, textarea').length !== 1) continue;
    serial += 1;
    var id = 'guide-field-' + serial;
    field.setAttribute('data-guide-was-id', field.id || '');
    label.setAttribute('data-guide-was-for', label.getAttribute('for') || '');
    field.id = id;
    label.setAttribute('for', id);
    var hint = wrap.querySelector('[class*="hint"][id]');
    if (hint && field.getAttribute('aria-describedby')) {
      hint.setAttribute('data-guide-was-id', hint.id);
      field.setAttribute('data-guide-was-described', field.getAttribute('aria-describedby'));
      hint.id = id + '-hint';
      field.setAttribute('aria-describedby', id + '-hint');
    }
    changed += 1;
  }
  if (dialog.parentNode && dialog.parentNode.closest && dialog.parentNode.closest('table')) {
    var host = dialog.closest('[class*="sapPage"]') || document.querySelector('main') || document.body;
    var home = document.createComment('guide-dialog-home');
    dialog.parentNode.insertBefore(home, dialog);
    window.__guideDialogHome = home;
    dialog.close();
    host.appendChild(dialog);
    dialog.showModal();
    dialog.setAttribute('data-guide-lifted', '');
    changed += 1;
  }
  return changed;
})()`;

const RESTORE_DIALOG = String.raw`(function () {
  var lifted = document.querySelector('dialog[data-guide-lifted]');
  var home = window.__guideDialogHome;
  if (lifted) {
    lifted.removeAttribute('data-guide-lifted');
    if (lifted.open) lifted.close();
    if (home && home.parentNode) {
      home.parentNode.insertBefore(lifted, home);
      home.parentNode.removeChild(home);
    }
  }
  window.__guideDialogHome = null;
  var all = document.querySelectorAll('[data-guide-was-id], [data-guide-was-for], [data-guide-was-described]');
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    if (el.hasAttribute('data-guide-was-id')) {
      var id = el.getAttribute('data-guide-was-id');
      if (id) el.id = id;
      else el.removeAttribute('id');
      el.removeAttribute('data-guide-was-id');
    }
    if (el.hasAttribute('data-guide-was-for')) {
      var was = el.getAttribute('data-guide-was-for');
      if (was) el.setAttribute('for', was);
      else el.removeAttribute('for');
      el.removeAttribute('data-guide-was-for');
    }
    if (el.hasAttribute('data-guide-was-described')) {
      el.setAttribute('aria-describedby', el.getAttribute('data-guide-was-described'));
      el.removeAttribute('data-guide-was-described');
    }
  }
})()`;

const prepareDialog = (page: Page) => page.evaluate(PREPARE_DIALOG).catch(() => 0);
const restoreDialog = (page: Page) => page.evaluate(RESTORE_DIALOG).catch(() => {});

/** What the picture is to point at: tagged before the marks are drawn, untagged after. */
const POINT = 'data-guide-point';

/**
 * Wait until the page is the page a person sees.
 *
 * The server's HTML arrives with the heading already in it, and a picture
 * taken then shows the top bar before it has measured itself — the modules as
 * icons, the company's name missing. `erp-shell.tsx` › `fitNav` marks the bar
 * once it has run (`data-fit`), which is also the proof that the page is alive.
 * A page outside the shell (signing in, the password) has no bar to wait for.
 */
async function settle(page: Page, shell = true): Promise<void> {
  await page.locator('h1').first().waitFor({ timeout: 120_000 });
  if (shell) await page.locator('.erp-nav[data-fit]').first().waitFor({ state: 'attached', timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => {});
  // The development server's own badge is not part of the ERP.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {});
  await page.waitForTimeout(350);
}

/** Sign in as the seeded administrator; `onForm` runs on the page before anything is typed. */
async function signIn(page: Page, onForm?: () => Promise<void>): Promise<void> {
  const seed = readFileSync('scripts/seed-dev.ts', 'utf8');
  const password = /const PASSWORD = '([^']+)'/.exec(seed)?.[1] ?? '';
  await page.goto(`${BASE}/sign-in`, { timeout: 180_000 });
  // By name, not by label: the labels are in whichever language the cookie chose.
  await page.locator('input[name="email"]').waitFor({ timeout: 120_000 });
  if (onForm) await onForm();
  await page.locator('input[name="email"]').fill('admin@example.com');
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 180_000 });
}

async function main(): Promise<void> {
  // The pictures show sample data on purpose: they are never taken from the company's books.
  refuseOnLive('take the guide pictures');
  // `--only dashboard` is the home page: its route is "/", which every route contains.
  const wants = (route: string) => !ONLY || (ONLY === 'dashboard' && route === '/') || (ONLY !== '/' && route !== '/' && route.includes(ONLY));
  const screens = MODULES.flatMap((module) =>
    module.sectionKeys.flatMap((sectionKey) => {
      const section = MENU.find((candidate) => candidate.key === sectionKey);
      return (section?.items ?? [])
        .map((item) => ({ moduleKey: module.key, route: routeFor(item, sectionKey) }))
        .filter((screen) => isDelivered(screen.route) && wants(screen.route));
    }),
  );
  console.log(`${screens.length} screen(s) to picture, in two languages`);

  mkdirSync(OUT, { recursive: true });
  const index: Shot[] = existsSync(join(OUT, 'index.json')) ? (JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) as Shot[]) : [];
  /** One picture's place in the index; a page has several dialogs, told apart by where they open and their key. */
  const idOf = (shot: Pick<Shot, 'locale' | 'view' | 'route' | 'on' | 'key'>) =>
    `${shot.locale}:${shot.view}:${shot.route}${shot.view === 'dialog' ? `:${shot.on ?? ''}:${shot.key ?? ''}` : ''}`;
  const have = new Set(index.map(idOf));
  const keep = (shot: Shot) => {
    const key = idOf(shot);
    const at = index.findIndex((one) => idOf(one) === key);
    if (at >= 0) index[at] = shot;
    else index.push(shot);
    have.add(key);
    writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  };
  /** The dialogs a revisited page no longer has: out of the index, and off the disk. */
  const dropDialogs = (locale: string, route: string, on: 'screen' | 'record', kept: ReadonlySet<string>) => {
    let changed = false;
    for (let at = index.length - 1; at >= 0; at -= 1) {
      const one = index[at]!;
      if (one.view !== 'dialog' || one.locale !== locale || one.route !== route || one.on !== on || kept.has(one.key ?? '')) continue;
      index.splice(at, 1);
      have.delete(idOf(one));
      rmSync(join(OUT, one.file), { force: true });
      changed = true;
    }
    if (changed) writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  };
  /** A view the screen turns out not to have: out of the index, and its old picture off the disk. */
  const drop = (locale: string, view: Shot['view'], route: string) => {
    const key = `${locale}:${view}:${route}`;
    const at = index.findIndex((one) => `${one.locale}:${one.view}:${one.route}` === key);
    if (at < 0) return;
    const [gone] = index.splice(at, 1);
    have.delete(key);
    if (gone) rmSync(join(OUT, gone.file), { force: true });
    writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 1)}\n`);
  };
  const done = (locale: string, view: string, route: string) => !FORCE && have.has(`${locale}:${view}:${route}`);
  const withMarks = (marks: readonly Mark[]) => (marks.length > 0 ? { marks } : {});

  const browser = await chromium.launch();
  for (const locale of ['en', 'ar'] as const) {
    mkdirSync(join(OUT, locale), { recursive: true });
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'erp-locale', value: locale, url: BASE }]);
    const page = await context.newPage();
    const shoot = (file: string, options: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}) =>
      page.screenshot({ path: join(OUT, locale, file), type: 'jpeg', quality: 62, ...options });
    /** One of the pictures that is not a screen of the menu; a failure costs that picture only. */
    const extra = async (route: string, view: Shot['view'], take: () => Promise<void>) => {
      if (!wants(route) || done(locale, view, route)) return;
      try {
        await take();
        console.log(`${locale} ${route} (${view})`);
      } catch (error) {
        console.log(`${locale} ${route}: skipped — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    };

    // ── signing in: the page as somebody who is not signed in yet meets it ──
    await signIn(page, () =>
      extra('/sign-in', 'form', async () => {
        await settle(page, false);
        const { marks } = await drawMarks(page, { scope: 'form', root: 'main', gridAsOne: false });
        await page.waitForTimeout(150);
        await shoot('sign_in-form.jpg');
        keep({ route: '/sign-in', locale, view: 'form', file: `${locale}/sign_in-form.jpg`, ...withMarks(marks) });
        await clearMarks(page);
      }),
    );
    const moduleName = labels(locale);

    /**
     * The dialogs this page opens — each opened, numbered, pictured and closed
     * again, so the page is left as it was found. Only an opener with a dialog
     * (or the export menu) behind it is pressed, and nothing inside a dialog is
     * pressed but the way out.
     */
    const dialogsOf = async (route: string, on: 'screen' | 'record'): Promise<number> => {
      const openers = ((await page.evaluate(FIND_OPENERS)) as Opener[]).slice(0, MAX_DIALOGS);
      const used = new Set<string>();
      let taken = 0;
      for (const opener of openers) {
        // The same key in both languages: the English picture's, found by the opener's place on the page.
        const english =
          locale === 'en' ? undefined : index.find((one) => one.view === 'dialog' && one.locale === 'en' && one.route === route && one.on === on && one.order === opener.order)?.key;
        let key = english ?? keyOf(opener);
        for (let again = 2; used.has(key); again += 1) key = `${english ?? keyOf(opener)}_${again}`;
        used.add(key);
        const file = `${slugOf(route)}${on === 'record' ? '-record' : ''}-dialog-${key}.jpg`;
        const control = page.locator(`[data-guide-dialog="${opener.order}"]`).first();
        try {
          if ((await control.count()) === 0) continue;
          await control.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
          await control.click({ timeout: 8_000 });
          const root = opener.menu ? 'details[open][data-export-menu]' : 'dialog[open]';
          const opened = await page.locator(root).first().waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
          if (opened) {
            await page.waitForTimeout(250);
            if (!opener.menu) await prepareDialog(page);
            // The window first, the marks after: they are laid over the page where things are NOW.
            const over = opener.menu ? 0 : Number(await page.evaluate(DIALOG_OVERFLOW).catch(() => 0)) || 0;
            if (over > 4) await page.setViewportSize({ width: WIDTH, height: Math.min(2400, HEIGHT + Math.ceil(over) + 40) });
            await page.waitForTimeout(180);
            const { marks } = await drawMarks(page, { scope: 'dialog', root });
            await page.waitForTimeout(120);
            await shoot(file);
            keep({ route, locale, view: 'dialog', on, name: opener.name, key, order: opener.order, file: `${locale}/${file}`, ...withMarks(marks) });
            taken += 1;
            if (over > 4) await page.setViewportSize({ width: WIDTH, height: HEIGHT });
          }
        } catch (error) {
          used.delete(key);
          console.log(`${locale} ${route}: dialog "${opener.name}" skipped — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        } finally {
          await clearMarks(page);
          await restoreDialog(page);
          await page.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {});
          // Closed again, whatever happened: the next picture must not have this one over it.
          if (opener.menu) {
            await page.evaluate(`(function () { var all = document.querySelectorAll('details[open][data-export-menu]'); for (var i = 0; i < all.length; i += 1) all[i].open = false; })()`).catch(() => {});
          } else {
            await page.keyboard.press('Escape').catch(() => {});
            const shut = await page.locator('dialog[open]').first().waitFor({ state: 'detached', timeout: 2_500 }).then(() => true, () => false);
            if (!shut) await page.evaluate(`(function () { var all = document.querySelectorAll('dialog[open]'); for (var i = 0; i < all.length; i += 1) all[i].close(); })()`).catch(() => {});
          }
          await page.waitForTimeout(120);
        }
      }
      dropDialogs(locale, route, on, used);
      await page.evaluate(`(function () { var all = document.querySelectorAll('[data-guide-dialog]'); for (var i = 0; i < all.length; i += 1) all[i].removeAttribute('data-guide-dialog'); })()`).catch(() => {});
      return taken;
    };

    // ── menu: each module's dropdown, with one entry ringed at a time ──
    await page.goto(`${BASE}/`, { timeout: 180_000 });
    await settle(page);
    for (const module of MODULES) {
      const mine = screens.filter((screen) => screen.moduleKey === module.key && !done(locale, 'menu', screen.route));
      if (mine.length === 0) continue;
      const trigger = page.locator(`button.erp-nav__trigger[title="${moduleName[module.key] ?? module.key}"]`).first();
      if ((await trigger.count()) === 0) continue;
      await trigger.click();
      const popover = page.locator('.erp-module-popover').first();
      await popover.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
      for (const screen of mine) {
        const link = popover.locator(`a[href="${screen.route}"]`).first();
        if ((await link.count()) === 0) continue;
        await link.evaluate((element, ring) => {
          (element as HTMLElement).dataset.was = (element as HTMLElement).getAttribute('style') ?? '';
          (element as HTMLElement).setAttribute('style', `${(element as HTMLElement).dataset.was};${ring}`);
          element.scrollIntoView({ block: 'nearest' });
        }, RING);
        const box = await popover.boundingBox();
        const file = `${slugOf(screen.route)}-menu.jpg`;
        await shoot(file, { clip: { x: 0, y: 0, width: WIDTH, height: Math.min(HEIGHT, Math.ceil((box ? box.y + box.height : HEIGHT) + 14)) } });
        await link.evaluate((element) => (element as HTMLElement).setAttribute('style', (element as HTMLElement).dataset.was ?? ''));
        keep({ route: screen.route, locale, view: 'menu', file: `${locale}/${file}` });
      }
      await page.keyboard.press('Escape');
      await popover.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
      console.log(`${locale} menu  ${module.key}: ${mine.length}`);
    }

    // ── the top bar: what each part of it is ──
    await extra('top-bar', 'screen', async () => {
      await page.goto(`${BASE}/`, { timeout: 180_000 });
      await settle(page);
      const { marks } = await drawMarks(page, { scope: 'top-bar' });
      await page.waitForTimeout(150);
      await shoot('top_bar-screen.jpg');
      keep({ route: 'top-bar', locale, view: 'screen', file: `${locale}/top_bar-screen.jpg`, ...withMarks(marks) });
      await clearMarks(page);
    });

    // ── the menu behind the avatar ──
    await extra('user-menu', 'menu', async () => {
      await page.goto(`${BASE}/`, { timeout: 180_000 });
      await settle(page);
      await page.locator('.erp-header__utilities .erp-user-trigger').first().click();
      const panel = page.locator('#erp-user-panel');
      await panel.waitFor({ state: 'visible', timeout: 15_000 });
      const { marks } = await drawMarks(page, { scope: 'user-menu' });
      await page.waitForTimeout(150);
      const box = await panel.boundingBox();
      await shoot('user_menu-menu.jpg', { clip: { x: 0, y: 0, width: WIDTH, height: Math.min(HEIGHT, Math.ceil((box ? box.y + box.height : HEIGHT) + 14)) } });
      keep({ route: 'user-menu', locale, view: 'menu', file: `${locale}/user_menu-menu.jpg`, ...withMarks(marks) });
      await clearMarks(page);
      await page.keyboard.press('Escape');
    });

    // ── changing the password: its own page, outside the menu ──
    await extra('/password', 'form', async () => {
      await page.goto(`${BASE}/password`, { timeout: 180_000 });
      await page.locator('input[name="currentPassword"]').waitFor({ timeout: 120_000 });
      await settle(page, false);
      const { marks } = await drawMarks(page, { scope: 'form', root: 'main', gridAsOne: false });
      await page.waitForTimeout(150);
      await shoot('password-form.jpg');
      keep({ route: '/password', locale, view: 'form', file: `${locale}/password-form.jpg`, ...withMarks(marks) });
      await clearMarks(page);
    });

    // ── screen and form ──
    for (const screen of screens) {
      if (done(locale, 'screen', screen.route)) continue;
      try {
        await page.goto(`${BASE}${screen.route}`, { timeout: 180_000 });
        await settle(page);

        // The way in to a new record: a link to its own page, or the button that opens its dialog.
        const link = page.locator('main a[href$="/new"]').first();
        // Not a door: the printer, paperclip, notes and clock open dialogs too, and none of them is a new record.
        const button = page.locator('main button:has(+ dialog):not([class*="sapIconButton"])').first();
        const opener = (await link.count()) > 0 ? link : (await button.count()) > 0 ? button : null;
        // A "+ New …" button that does its work at once (it raises the draft and
        // opens it) is pointed at but never pressed: this script saves nothing.
        const plus = page.locator('main header [class*="headerActions"] :is(a, button)[class*="primary"]:has(svg)').first();
        const starter = opener ?? ((await plus.count()) > 0 ? plus : null);
        // The way to a new one is what this picture is about: the thick box and the arrow.
        if (starter) await starter.evaluate((element, attribute) => element.setAttribute(attribute, ''), POINT);
        const file = `${slugOf(screen.route)}-screen.jpg`;
        const { marks } = await drawMarks(page, { scope: 'screen' });
        const ringed = marks.some((mark) => mark.pointed);
        await page.waitForTimeout(120);
        await shoot(file);
        keep({ route: screen.route, locale, view: 'screen', file: `${locale}/${file}`, ...(ringed ? { ringed: true } : {}), ...withMarks(marks) });
        await clearMarks(page);
        if (starter) await starter.evaluate((element, attribute) => element.removeAttribute(attribute), POINT);
        // A row of the list that opens a record of this screen, if the sample data has one.
        const recordHref = done(locale, 'record', screen.route) || screen.route === '/' ? null : await page.evaluate(`(function (route) {
          var links = document.querySelectorAll('main table tbody tr a[href]');
          for (var i = 0; i < links.length; i += 1) {
            var href = links[i].getAttribute('href') || '';
            if (href.indexOf(route + '/') === 0 && !/\\/new(\\?|$)/.test(href)) return href;
          }
          return null;
        })(${JSON.stringify(screen.route)})`) as string | null;

        // ── what else this screen opens: its other dialogs, and its export menu ──
        // The button that opens the form is the form's picture, not a dialog's.
        if (opener && opener === button) await opener.evaluate((element) => element.setAttribute('data-guide-form-opener', ''));
        const screenDialogs = await dialogsOf(screen.route, 'screen');

        /*
         * A form is a picture of fields to fill. A page that opens with only a
         * reason it cannot start yet ("Post a sales invoice first") has none,
         * and is not kept as one: sent as "the form", it would explain nothing.
         */
        let formed = false;
        if (!opener) drop(locale, 'form', screen.route);
        if (opener && !done(locale, 'form', screen.route)) {
          const formFile = `${slugOf(screen.route)}-form.jpg`;
          if (opener === link) {
            const href = await link.getAttribute('href');
            await page.goto(`${BASE}${href}`, { timeout: 180_000 });
            await settle(page);
            // The whole page is pictured, so what is below the first screenful is numbered too.
            const { marks } = await drawMarks(page, { scope: 'form', root: 'main', fullPage: true });
            if (marks.length > 0) {
              await page.waitForTimeout(150);
              await shoot(formFile, { fullPage: true });
              keep({ route: screen.route, locale, view: 'form', file: `${locale}/${formFile}`, marks });
              formed = true;
            } else {
              drop(locale, 'form', screen.route);
            }
            await clearMarks(page);
          } else {
            await opener.click();
            const dialog = page.locator('dialog[open]').first();
            if (await dialog.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
              await page.waitForTimeout(250);
              await prepareDialog(page);
              // A long form scrolls inside its dialog: the window is made taller
              // for the picture, so every numbered field is in it — and the marks
              // are drawn after, because they are laid where things are now.
              const over = Number(await page.evaluate(DIALOG_OVERFLOW).catch(() => 0)) || 0;
              if (over > 4) await page.setViewportSize({ width: WIDTH, height: Math.min(2400, HEIGHT + Math.ceil(over) + 40) });
              await page.waitForTimeout(200);
              const { marks } = await drawMarks(page, { scope: 'form' });
              if (marks.length > 0) {
                await page.waitForTimeout(150);
                await shoot(formFile);
                keep({ route: screen.route, locale, view: 'form', file: `${locale}/${formFile}`, marks });
                formed = true;
              } else {
                drop(locale, 'form', screen.route);
              }
              await clearMarks(page);
              await restoreDialog(page);
              if (over > 4) await page.setViewportSize({ width: WIDTH, height: HEIGHT });
              await page.keyboard.press('Escape');
            } else {
              drop(locale, 'form', screen.route);
            }
          }
        }
        // ── one record of the list, opened ──
        let recorded = false;
        let recordDialogs = 0;
        if (recordHref) {
          await page.goto(`${BASE}${recordHref}`, { timeout: 180_000 });
          await settle(page);
          const { marks } = await drawMarks(page, { scope: 'record' });
          await page.waitForTimeout(120);
          const recordFile = `${slugOf(screen.route)}-record.jpg`;
          await shoot(recordFile);
          keep({ route: screen.route, locale, view: 'record', file: `${locale}/${recordFile}`, ...withMarks(marks) });
          await clearMarks(page);
          recorded = true;
          recordDialogs = await dialogsOf(screen.route, 'record');
        } else if (!done(locale, 'record', screen.route)) {
          drop(locale, 'record', screen.route);
          dropDialogs(locale, screen.route, 'record', new Set());
        }
        const dialogs = screenDialogs + recordDialogs;
        console.log(
          `${locale} ${screen.route}${formed ? ' (+form)' : ringed ? ' (pointed)' : ''}${recorded ? ' (+record)' : ''}${dialogs > 0 ? ` (+${dialogs} dialog${dialogs === 1 ? '' : 's'})` : ''}`,
        );
      } catch (error) {
        await page.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {});
        console.log(`${locale} ${screen.route}: skipped — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    await context.close();
  }
  await browser.close();
  console.log(`${index.length} picture(s) in ${OUT}`);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/guide/make-screens.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
