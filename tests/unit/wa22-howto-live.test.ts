/**
 * A how-to's pictures — all of them live: `services/howto-live.ts`,
 * `services/live-guide.ts`, and what `services/live-screenshot.ts` may do on a
 * page to take them.
 *
 * By direction (2026-10-05), twice: first that a how-to's "the screen" and "an
 * opened record" be pictured from the real system as the person asking; then,
 * the same day, "no more training picture … always live". So the camera now
 * also shows the menu, the form that opens and a window — and for that it may
 * press, in ONE place, only what opens and nothing that acts.
 *
 * No browser and no database here: what is asked of the camera for each view
 * (with the taker injected), the one-minute reuse, the rule for what may be
 * pressed (run against stand-in elements), and — read from the source — that
 * everything else is still only looking.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAPTION_MAX, kindNote, layOutAnswer, pictureLanguage } from '@/server/domain/whatsapp-pictures';
import { howToLiveReady, liveExtraPicture, liveHowToPicture } from '@/server/services/howto-live';
import { MAY_PRESS, TAG_TARGET, type LiveOpen, type LiveShotResult } from '@/server/services/live-screenshot';

const dir = mkdtempSync(join(tmpdir(), 'howto-live-'));
// A browser "installed", as `liveShotsReady` looks for one — without one being started.
mkdirSync(join(dir, 'browsers', 'chromium_headless_shell-1234'), { recursive: true });
const picture = join(dir, 'shot.jpg');
writeFileSync(picture, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

const KEYS = ['NOAH_HOWTO_LIVE', 'NOAH_LIVE_SHOTS', 'PLAYWRIGHT_BROWSERS_PATH'] as const;
const before = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.NOAH_HOWTO_LIVE = 'on';
  delete process.env.NOAH_LIVE_SHOTS;
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(dir, 'browsers');
});
afterEach(() => {
  for (const key of KEYS) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Asked = { userId: string; path: string; locale: 'en' | 'ar'; pointAt?: readonly string[]; firstRecord?: boolean; open?: LiveOpen; pointNew?: boolean; as?: 'form' };

/** A taker that pictures nothing: it says what it was asked for and hands back a picture that exists. */
function taker(result?: (asked: Asked) => LiveShotResult) {
  const calls: Asked[] = [];
  const take = async (asked: Asked): Promise<LiveShotResult> => {
    calls.push(asked);
    return result ? result(asked) : { ok: true, shot: { file: picture, path: asked.firstRecord ? `${asked.path}/SUP-00001` : asked.path, title: 'Suppliers', marks: [{ n: 1, label: 'New supplier', kind: 'button', pointed: true }], notFound: [] } };
  };
  return { calls, take };
}

let nextUser = 0;
/** A different asker for each case: the reuse is per person, and one case must not meet another's picture. */
const user = () => `00000000-0000-4000-8000-${String((nextUser += 1)).padStart(12, '0')}`;

describe('the switch', () => {
  it('needs no switch any more: it is on wherever a picture can be taken', () => {
    // 2026-10-05, the owner: "no more training picture … always live". NOAH_HOWTO_LIVE is no longer read.
    for (const value of [undefined, 'off', '', 'on']) {
      if (value === undefined) delete process.env.NOAH_HOWTO_LIVE;
      else process.env.NOAH_HOWTO_LIVE = value;
      expect(howToLiveReady(), String(value)).toEqual({ ok: true });
    }
  });

  it('is on only where a live picture can be taken at all: a browser there, and live pictures not switched off', () => {
    process.env.NOAH_LIVE_SHOTS = 'off';
    expect(howToLiveReady()).toEqual({ ok: false, reason: expect.stringMatching(/switched off/) });
    delete process.env.NOAH_LIVE_SHOTS;
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(dir, 'no-browsers-here');
    expect(howToLiveReady()).toEqual({ ok: false, reason: expect.stringMatching(/No browser is installed/) });
  });

  it('where no picture can be taken, nothing is asked of the browser — and the refusal is a value, not an error', async () => {
    process.env.NOAH_LIVE_SHOTS = 'off';
    const { calls, take } = taker();
    await expect(liveHowToPicture({ userId: user(), locale: 'en', route: '/payables/suppliers', view: 'screen' }, { take })).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/switched off/),
    });
    await expect(liveExtraPicture({ userId: user(), locale: 'en', which: 'top-bar' }, { take })).resolves.toEqual({ ok: false, reason: expect.stringMatching(/switched off/) });
    expect(calls).toEqual([]);
  });
});

describe('what it asks the live picture service for', () => {
  it('a screen is its menu address, with the arrow at the way to a new one', async () => {
    const { calls, take } = taker();
    const asker = user();
    const shown = await liveHowToPicture({ userId: asker, locale: 'ar', route: ' /payables/suppliers ', view: 'screen', pointAt: [' New supplier ', '', 'a', 'b', 'c', 'd'] }, { take });
    expect(calls).toEqual([{ userId: asker, path: '/payables/suppliers', locale: 'ar', pointNew: true, pointAt: ['New supplier', 'a', 'b', 'c'] }]);
    expect(shown).toEqual({ ok: true, file: picture, path: '/payables/suppliers', title: 'Suppliers', marks: [{ n: 1, label: 'New supplier', kind: 'button', pointed: true }], notFound: [] });
  });

  it('a record is "the first record that screen lists": the list address, and firstRecord', async () => {
    const { calls, take } = taker();
    const asker = user();
    const shown = await liveHowToPicture({ userId: asker, locale: 'en', route: '/payables/suppliers', view: 'record' }, { take });
    expect(calls).toEqual([{ userId: asker, path: '/payables/suppliers', locale: 'en', firstRecord: true }]);
    expect(shown).toMatchObject({ ok: true, path: '/payables/suppliers/SUP-00001' });
  });

  it('takes every shape a menu route has, and nothing else', async () => {
    const { calls, take } = taker();
    for (const route of ['/', '/tasks', '/payables/invoices', '/payables/pd/asycuda', '/master-data/chart-of-accounts']) {
      expect((await liveHowToPicture({ userId: user(), locale: 'en', route, view: 'screen' }, { take })).ok, route).toBe(true);
    }
    const asked = calls.length;
    for (const route of [
      '',
      'payables/suppliers',
      'https://example.com/payables/suppliers',
      '//example.com/x',
      '/api/health',
      '/sign-in',
      '/export/purchase_invoice/API-HQ-2026-000001',
      '/payables/../api',
      '/payables/suppliers?role=supplier',
      '/payables/invoices/API-HQ-2026-000005',
      '/payables/suppliers/SUP-00001',
      '/administration/users/7c0e1c1e-0000-4000-8000-000000000000',
      '/a/b/c/d/e',
      '/Payables/Suppliers',
    ]) {
      const refused = await liveHowToPicture({ userId: user(), locale: 'en', route, view: 'screen' }, { take });
      expect(refused.ok, route).toBe(false);
      if (!refused.ok) expect(refused.reason.length, route).toBeGreaterThan(20);
    }
    // Refused on the text alone: the browser was never asked.
    expect(calls).toHaveLength(asked);
  });

  it('the menu, the form and a window are asked of the same camera, each by what it may open', async () => {
    const { calls, take } = taker();
    const asker = user();
    const base = { userId: asker, locale: 'en' as const, route: '/payables/suppliers' };
    await liveHowToPicture({ ...base, view: 'menu', moduleTitles: ['Payables', 'الذمم الدائنة'] }, { take });
    await liveHowToPicture({ ...base, view: 'form' }, { take });
    await liveHowToPicture({ ...base, view: 'dialog', dialog: ' Attachments ' }, { take });
    await liveHowToPicture({ ...base, view: 'dialog', dialog: 'add bank account', on: 'record' }, { take });
    await liveHowToPicture({ ...base, view: 'dialog' }, { take });
    const at = { userId: asker, path: '/payables/suppliers', locale: 'en' };
    expect(calls).toEqual([
      { ...at, open: { kind: 'menu', route: '/payables/suppliers', moduleTitles: ['Payables', 'الذمم الدائنة'] } },
      { ...at, open: { kind: 'form' } },
      { ...at, open: { kind: 'dialog', which: 'Attachments' } },
      { ...at, open: { kind: 'dialog', which: 'add bank account' }, firstRecord: true },
      // Asked for no window by name: the camera answers with the windows there are.
      { ...at, open: { kind: 'dialog', which: '' } },
    ]);
  });

  it('one record is not a screen of the menu, and a view that does not exist is not pictured', async () => {
    const { calls, take } = taker();
    for (const route of ['/payables/invoices/API-HQ-2026-000005', '/payables/suppliers/SUP-00001', '/inventory/items/ITM-SEED']) {
      for (const view of ['screen', 'record', 'form', 'menu'] as const) {
        await expect(liveHowToPicture({ userId: user(), locale: 'en', route, view }, { take })).resolves.toEqual({
          ok: false,
          reason: expect.stringMatching(/a screen of the menu/),
        });
      }
    }
    await expect(liveHowToPicture({ userId: user(), locale: 'en', route: '/payables/suppliers', view: 'all' as 'screen' }, { take })).resolves.toEqual({
      ok: false,
      reason: 'There is no such picture of a screen.',
    });
    expect(calls).toEqual([]);
  });

  it('the way in, and the bar every screen sits under: sign-in as nobody, the rest as the asker', async () => {
    const { calls, take } = taker();
    const signIns: unknown[] = [];
    const signIn = async (asked: { userId: string; locale: 'en' | 'ar' }): Promise<LiveShotResult> => {
      signIns.push(asked);
      return { ok: true, shot: { file: picture, path: '/sign-in', title: 'Sign in', marks: [], notFound: [] } };
    };
    const asker = user();
    await expect(liveExtraPicture({ userId: asker, locale: 'ar', which: '/sign-in' }, { take, signIn })).resolves.toMatchObject({ ok: true, path: '/sign-in' });
    await liveExtraPicture({ userId: asker, locale: 'en', which: 'top-bar' }, { take, signIn });
    await liveExtraPicture({ userId: asker, locale: 'en', which: 'user-menu' }, { take, signIn });
    await liveExtraPicture({ userId: asker, locale: 'en', which: '/password' }, { take, signIn });
    // The sign-in page is asked for without a path, a session or anything that could be opened as somebody.
    expect(signIns).toEqual([{ userId: asker, locale: 'ar' }]);
    expect(calls).toEqual([
      { userId: asker, path: '/notifications', locale: 'en', open: { kind: 'top-bar' } },
      { userId: asker, path: '/notifications', locale: 'en', open: { kind: 'user-menu' } },
      { userId: asker, path: '/password', locale: 'en', as: 'form' },
    ]);
  });
});

describe('it never costs the how-to its answer', () => {
  it('hands a refusal on as a sentence — that part is then explained in words', async () => {
    const { take } = taker(() => ({ ok: false, reason: 'There is no record on that screen yet to open.' }));
    await expect(liveHowToPicture({ userId: user(), locale: 'en', route: '/sales/sales-returns', view: 'record' }, { take })).resolves.toEqual({
      ok: false,
      reason: 'There is no record on that screen yet to open.',
    });
  });

  it('does not throw when the service does', async () => {
    const take = async (): Promise<LiveShotResult> => {
      throw new Error('browserType.launch: Executable does not exist\nat somewhere');
    };
    await expect(liveHowToPicture({ userId: user(), locale: 'en', route: '/payables/suppliers', view: 'screen' }, { take })).resolves.toEqual({
      ok: false,
      reason: 'The live picture could not be taken (browserType.launch: Executable does not exist).',
    });
  });
});

describe('the same picture asked for twice within a minute is one picture', () => {
  it('opens the browser once for two identical requests, and again for anything different', async () => {
    const { calls, take } = taker();
    const asker = user();
    let clock = 1_000_000;
    const deps = { take, now: () => clock };
    const ask = (over: Partial<Parameters<typeof liveHowToPicture>[0]> = {}) =>
      liveHowToPicture({ userId: asker, locale: 'en', route: '/payables/suppliers', view: 'screen', pointAt: ['New supplier'], ...over }, deps);

    const first = await ask();
    clock += 59_000;
    expect(await ask()).toEqual(first);
    expect(calls).toHaveLength(1);

    // Another view, language, arrow or person is another picture.
    await ask({ view: 'record' });
    await ask({ locale: 'ar' });
    await ask({ pointAt: ['Search'] });
    await ask({ pointAt: [] });
    await ask({ userId: user() });
    expect(calls).toHaveLength(6);

    // And after the minute, it is taken again.
    clock += 2_000;
    await ask();
    expect(calls).toHaveLength(7);
  });

  it('two at the same moment share one, and a picture that has since been swept away is taken again', async () => {
    const asker = user();
    let made = 0;
    const gone = join(dir, 'gone.jpg');
    const take = async (asked: Asked): Promise<LiveShotResult> => {
      made += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, shot: { file: made === 1 ? gone : picture, path: asked.path, title: '', marks: [], notFound: [] } };
    };
    writeFileSync(gone, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const input = { userId: asker, locale: 'en' as const, route: '/payables/invoices', view: 'screen' as const };
    const [one, two] = await Promise.all([liveHowToPicture(input, { take }), liveHowToPicture(input, { take })]);
    expect(made).toBe(1);
    expect(one).toEqual(two);

    rmSync(gone);
    const again = await liveHowToPicture(input, { take });
    expect(made).toBe(2);
    expect(again).toMatchObject({ ok: true, file: picture });
  });

  it('a refusal is not asked for twice in the same minute either', async () => {
    const { calls, take } = taker(() => ({ ok: false, reason: 'There is no record on that screen yet to open.' }));
    const input = { userId: user(), locale: 'en' as const, route: '/sales/sales-returns', view: 'record' as const };
    await liveHowToPicture(input, { take });
    await liveHowToPicture(input, { take });
    expect(calls).toHaveLength(1);
  });
});

describe('what the camera may do on a page: read, open what only opens, and nothing else', () => {
  const service = readFileSync('src/server/services/live-screenshot.ts', 'utf8');
  const howTo = readFileSync('src/server/services/howto-live.ts', 'utf8');
  const liveGuide = readFileSync('src/server/services/live-guide.ts', 'utf8');

  it('a record is found by reading: an href, checked like any address, and opened with a plain GET', () => {
    // The link is read off the page…
    expect(service).toMatch(/document\.querySelectorAll\('main table tbody tr a\[href\]'\)/);
    expect(service).toMatch(/getAttribute\('href'\)/);
    // …must be on this origin and UNDER the list's own address, and never "new", an export or an edit…
    expect(service).toMatch(/if \(url\.origin !== location\.origin\) continue;/);
    expect(service).toMatch(/if \(url\.pathname\.indexOf\(under\) !== 0\) continue;/);
    expect(service).toMatch(/\(new\|export\|edit\)/);
    // …passes the same address rules as one that was asked for…
    expect(service).toMatch(/const checked = typeof found === 'string' && found \? checkPath\(found\) : null;/);
    expect(service).toMatch(/if \(!checked \|\| !checked\.ok\) return refuse\('denied', 'There is no record on that screen yet to open\.'\);/);
    // …and is opened by the one way a signed-in page is opened here. (The other `goto` is the sign-in page's, as nobody.)
    expect(service).toMatch(/opened = await visit\(checked\.path\);/);
    expect(service.match(/page\.goto\(/g)).toHaveLength(2);
    expect(service).toMatch(/await page\.goto\(`\$\{base\}\/sign-in`,/);
  });

  it('a form on its own page is reached the same way: its link is read, checked, and opened with a GET', () => {
    expect(service).toMatch(/if \(way\?\.way === 'link' && way\.href\) \{\s+const checked = checkPath\(/);
    expect(service).toMatch(/const next = await visit\(checked\.path\);/);
  });

  it('presses in ONE place, and only what the page itself agrees is a menu or a button that opens a window', () => {
    for (const source of [howTo, liveGuide]) {
      expect(source).not.toMatch(/\.(click|dblclick|tap|fill|type|press|check|uncheck|selectOption|setInputFiles|dispatchEvent|dragTo)\(/);
      expect(source).not.toMatch(/keyboard\.|mouse\.|page\.goto|playwright|chromium|auth_session|authSession/);
    }
    expect(service.match(/\.(click|dblclick|tap)\(/g)).toEqual(['.click(']);
    const press = service.slice(service.indexOf('async function press(page: Page, budget: number): Promise<string> {'), service.indexOf('/** A long window scrolls inside itself'));
    expect(press).toMatch(/const verdict = \(await page\.evaluate\(MAY_PRESS\)\.catch\(\(\) => 'none'\)\) as string;\s+if \(verdict !== 'ok'\) \{\s+return 'Nothing was pressed/);
    expect(press).toMatch(/await page\.locator\('\[data-noah-press\]'\)\.first\(\)\.click\(/);
    // The agreement comes before the press, and the page must still be the same page after it.
    expect(press.indexOf('MAY_PRESS')).toBeLessThan(press.indexOf('.click('));
    expect(press).toMatch(/if \(page\.url\(\) !== before\) return 'Pressing it left the page/);
    // No key, no typing, no form filled, no file given, nothing dragged — anywhere in the service.
    expect(service).not.toMatch(/\.(fill|type|press|check|uncheck|selectOption|setInputFiles|dispatchEvent|dragTo)\(/);
    expect(service).not.toMatch(/keyboard\.|mouse\./);
  });

  it('the page says no to anything that acts: a submit button, a button with no window after it, a link', () => {
    type Fake = Record<string, unknown>;
    const element = (over: Fake): Fake => ({
      tagName: 'BUTTON',
      className: 'button primary',
      disabled: false,
      form: null,
      parentElement: null,
      nextElementSibling: null,
      getAttribute: () => null,
      closest: () => null,
      ...over,
    });
    const verdict = (tagged: Fake[]) => new Function('document', `return ${MAY_PRESS};`)({ querySelectorAll: () => tagged }) as string;
    const dialog = { tagName: 'DIALOG' };
    const inHeader = (selector: string) => (selector === '.erp-header' ? {} : null);

    // The three that only open.
    expect(verdict([element({ nextElementSibling: dialog })])).toBe('ok');
    expect(verdict([element({ className: 'erp-nav__trigger', closest: inHeader })])).toBe('ok');
    expect(verdict([element({ className: 'erp-user-trigger', closest: inHeader })])).toBe('ok');
    expect(verdict([element({ tagName: 'SUMMARY', parentElement: { tagName: 'DETAILS', hasAttribute: (name: string) => name === 'data-export-menu' } })])).toBe('ok');
    // Inside a form it must say it is only a button.
    expect(verdict([element({ nextElementSibling: dialog, form: {}, getAttribute: (name: string) => (name === 'type' ? 'button' : null) })])).toBe('ok');

    // Everything that acts.
    expect(verdict([element({})]), 'a button with no window after it acts at once').toBe('refused');
    expect(verdict([element({ nextElementSibling: { tagName: 'DIV' } })])).toBe('refused');
    expect(verdict([element({ nextElementSibling: dialog, form: {} })]), 'a form\'s own button').toBe('refused');
    expect(verdict([element({ nextElementSibling: dialog, disabled: true })])).toBe('refused');
    expect(verdict([element({ nextElementSibling: dialog, closest: (selector: string) => (selector === 'dialog' ? {} : null) })]), 'nothing inside an open window').toBe('refused');
    expect(verdict([element({ tagName: 'A', nextElementSibling: dialog })]), 'a link').toBe('refused');
    expect(verdict([element({ className: 'erp-nav__trigger' })]), 'a look-alike outside the top bar').toBe('refused');
    expect(verdict([element({ tagName: 'SUMMARY', parentElement: { tagName: 'DETAILS', hasAttribute: () => false } })])).toBe('refused');
    expect(verdict([element({ tagName: 'INPUT', nextElementSibling: dialog })])).toBe('refused');
    // And it must be exactly one thing that was tagged.
    expect(verdict([])).toBe('none');
    expect(verdict([element({ nextElementSibling: dialog }), element({ nextElementSibling: dialog })])).toBe('none');
  });

  it('the in-page code is text a page can run as it stands', () => {
    const start = service.indexOf('const firstRecordCall = (listPath: string): string => `');
    const end = service.indexOf('})(${JSON.stringify(listPath)})`;', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const script = service.slice(start, end);
    expect(script).not.toContain('=>\n');
    expect(script.slice(script.indexOf('`') + 1)).not.toMatch(/=>|\bconst\s|\blet\s|\basync\s|\bawait\s/);
    // The snippets that find and judge what may be opened: ES5, and they parse.
    for (const snippet of [MAY_PRESS, TAG_TARGET]) {
      expect(snippet).not.toMatch(/=>|\bconst\s|\blet\s|\basync\s|\bawait\s|`/);
      expect(() => new Function(`return ${snippet};`)).not.toThrow();
    }
  });

  it('it is still one session per picture, ended in the finally, and one audit row that says what was opened', () => {
    expect(service.match(/await mintSession\(/g)).toHaveLength(1);
    expect(service).toMatch(/\} finally \{[\s\S]{0,260}await endSession\(input\.userId, minted\.sessionId\)/);
    expect(service).toMatch(/await auditShot\(input\.userId, \{\s+path: pictured \|\| input\.path,\s+outcome,/);
    expect(service).toMatch(/\.\.\.\(what \|\| input\.open \? \{ opened: what \|\| input\.open!\.kind \} : \{\}\),/);
    // Each further step — a record found on a list, a thing opened — is given one more share of the time, and no more.
    expect(service).toMatch(/const timeout = shotTimeout\(\) \* \(1 \+ \(input\.firstRecord \? 1 : 0\) \+ \(input\.open \? 1 : 0\)\);/);
  });

  it('the sign-in page is pictured as nobody: no session is made, and the browser may open that one address', () => {
    const signIn = service.slice(service.indexOf('async function takeSignIn('), service.indexOf('export async function liveSignIn('));
    expect(signIn.length).toBeGreaterThan(500);
    expect(signIn).not.toMatch(/mintSession|LIVE_SESSION_COOKIE|minted/);
    expect(signIn).toMatch(/if \(method !== 'GET' && method !== 'HEAD'\) return route\.abort\('blockedbyclient'\);/);
    expect(signIn).toMatch(/if \(request\.isNavigationRequest\(\) && url\.pathname !== '\/sign-in'\) return route\.abort\('blockedbyclient'\);/);
    expect(signIn).toMatch(/acceptDownloads: false/);
    // Nobody's values are read off it.
    expect(signIn).not.toMatch(/withValues/);
  });

  it('the how-to adds no way in of its own: it asks the camera, and only that', () => {
    expect(howTo).toMatch(/import \{ checkPath, liveScreenshot, liveShotsReady, liveSignIn, type LiveShotResult \} from '\.\/live-screenshot';/);
    expect(howTo).not.toMatch(/email|impersonat/i);
    expect(liveGuide).not.toMatch(/email|impersonat|guide-shots|screenPictures|kind: 'training'/i);
    expect(liveGuide).toMatch(/import \{ howToLiveReady, liveExtraPicture, liveHowToPicture, type HowToLive, type HowToView \} from '\.\/howto-live';/);
  });
});

describe('a picture speaks the language that was asked for, and says whose data it shows', () => {
  it('"show me in arabic" is an English sentence asking for Arabic pictures', () => {
    // 2026-10-05: an Arabic explanation arrived under the English picture.
    expect(pictureLanguage(undefined, 'show me in arabic', 'en')).toBe('ar');
    expect(pictureLanguage('en', 'show me in arabic', 'en')).toBe('ar');
    expect(pictureLanguage(undefined, 'the arabic version please', 'en')).toBe('ar');
    expect(pictureLanguage(undefined, 'وريني بالانكليزي', 'ar')).toBe('en');
    expect(pictureLanguage(undefined, 'show it in English', 'ar')).toBe('en');
  });

  it('otherwise the language he is answering in, and failing that the conversation\'s', () => {
    expect(pictureLanguage('ar', 'how do I add a bank account to a supplier?', 'en')).toBe('ar');
    expect(pictureLanguage(undefined, 'how do I add a bank account to a supplier?', 'en')).toBe('en');
    expect(pictureLanguage(undefined, 'شلون اضيف حساب مصرفي للمورد؟', 'ar')).toBe('ar');
    expect(pictureLanguage('fr', null, 'en')).toBe('en');
    // Asked for both at once says nothing: his own choice stands.
    expect(pictureLanguage('ar', 'in english and in arabic', 'en')).toBe('ar');
  });

  it('every training picture carries the note, in the language of the answer; a live one says it is real', () => {
    const training = { file: '/shots/en/payables_suppliers-form.jpg', caption: 'Suppliers: the form', kind: 'training' as const };
    const live = { file: '/shots/live/abc123.jpg', caption: 'Suppliers: your real screen', kind: 'live' as const };
    const english = layOutAnswer(['[picture: abc123]', '*Step 1*: press New supplier.', '[picture: payables_suppliers-form]', '*Step 2*: fill in the form.'].join('\n'), [live, training]);
    expect(english.parts.map((part) => part.text)).toEqual([
      `*Step 1*: press New supplier.\n\n${kindNote('live', false)}`,
      `*Step 2*: fill in the form.\n\n${kindNote('training', false)}`,
    ]);
    expect(kindNote('training', false)).toMatch(/Training picture: taken during the training session with sample data — not your real, current data/);
    expect(kindNote('live', false)).toMatch(/Live picture: your real screen/);

    // An Arabic answer full of English field names is still an Arabic answer.
    const arabic = layOutAnswer(['[picture: payables_suppliers-form]', 'املي الحقول: 1 Bank (البنك) اختاره من القائمة، 2 Bank name (اسم البنك) اكتبه مثل ما مكتوب بالرسالة.'].join('\n'), [training]);
    expect(arabic.parts[0]!.text.endsWith(kindNote('training', true))).toBe(true);
    expect(kindNote('training', true)).toMatch(/صورة تدريبية/);

    // A picture he did not place, and one whose words are too long to sit under it, are labelled too.
    const unplaced = layOutAnswer('Here it is.', [training]);
    expect(unplaced.parts.at(-1)!.text).toBe(`Suppliers: the form\n\n${kindNote('training', false)}`);
    const long = layOutAnswer(['[picture: payables_suppliers-form]', 'x'.repeat(CAPTION_MAX + 1)].join('\n'), [training]);
    expect(long.parts[0]!.text).toBe(`Suppliers: the form\n\n${kindNote('training', false)}`);
    expect(long.parts[0]!.text.length).toBeLessThan(1024);

    // A picture of no kind (a chart, a file's page) gets no note; the whole answer's text never carries one.
    expect(layOutAnswer('[picture: x]\nwords', [{ file: '/a/x.jpg', caption: 'c' }]).parts[0]!.text).toBe('words');
    expect(english.text).not.toMatch(/Training picture|Live picture/);
  });

  it('show_screen and screenshot both ask the live camera, in the language asked for, and every picture they hand over is live', () => {
    const service = readFileSync(join(process.cwd(), 'src/server/services/whatsapp-agent.ts'), 'utf8');
    expect(service.match(/const shownIn = pictureLanguage\(args\.language, meta\?\.question, ctx\.locale\);/g)).toHaveLength(2);
    expect(service).toMatch(/const shown = await liveGuide\.showLive\(\{/);
    expect(service).toMatch(/locale: shownIn,/);
    expect(service).toMatch(/group: `live:\$\{shot\.path\}`, kind: 'live' \}/);
    // Nothing is read from a folder made ahead of time, and nothing can ask for a training picture.
    expect(service).not.toMatch(/screenPictures|asksForTrainingPicture|NOAH_HOWTO_LIVE|args\.data\b/);
    const liveGuide = readFileSync(join(process.cwd(), 'src/server/services/live-guide.ts'), 'utf8');
    expect(liveGuide).toMatch(/kind: 'live'/);
    expect(liveGuide).not.toMatch(/'training'/);
  });
});
