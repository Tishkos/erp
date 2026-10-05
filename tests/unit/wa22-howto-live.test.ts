/**
 * A how-to's pictures, live — `services/howto-live.ts`, and the one thing it
 * needed from `services/live-screenshot.ts` (`firstRecord`).
 *
 * By direction (2026-10-05): once the training sessions are over, a how-to's
 * "the screen" and "an opened record" may be pictured from the real database,
 * as the person asking — behind a switch that is off until the owner says so,
 * with the pictures made ahead of time kept for everything else and as the
 * fallback whenever a live one cannot be taken.
 *
 * No browser and no database here: the switch, the addresses it will ask for,
 * the one-minute reuse (with the taker injected), and — read from the source —
 * that finding a record on a list is still only looking.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asksForTrainingPicture } from '@/server/domain/whatsapp-pictures';
import { howToLiveReady, liveHowToPicture } from '@/server/services/howto-live';
import type { LiveShotResult } from '@/server/services/live-screenshot';

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

type Asked = { userId: string; path: string; locale: 'en' | 'ar'; pointAt?: readonly string[]; firstRecord?: boolean };

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
  it('is off unless the owner turned it on — the pictures made ahead of time are used', () => {
    delete process.env.NOAH_HOWTO_LIVE;
    expect(howToLiveReady()).toEqual({ ok: false, reason: expect.stringMatching(/not switched on \(NOAH_HOWTO_LIVE=on/) });
    for (const value of ['off', '', '1', 'true', 'yes']) {
      process.env.NOAH_HOWTO_LIVE = value;
      expect(howToLiveReady().ok, value).toBe(false);
    }
    process.env.NOAH_HOWTO_LIVE = ' ON ';
    expect(howToLiveReady()).toEqual({ ok: true });
  });

  it('is on only where a live picture can be taken at all: a browser there, and live pictures not switched off', () => {
    process.env.NOAH_LIVE_SHOTS = 'off';
    expect(howToLiveReady()).toEqual({ ok: false, reason: expect.stringMatching(/switched off/) });
    delete process.env.NOAH_LIVE_SHOTS;
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(dir, 'no-browsers-here');
    expect(howToLiveReady()).toEqual({ ok: false, reason: expect.stringMatching(/No browser is installed/) });
  });

  it('switched off, nothing is asked of the browser — and the refusal is a value, not an error', async () => {
    process.env.NOAH_HOWTO_LIVE = 'off';
    const { calls, take } = taker();
    await expect(liveHowToPicture({ userId: user(), locale: 'en', route: '/payables/suppliers', view: 'screen' }, { take })).resolves.toEqual({
      ok: false,
      reason: expect.stringMatching(/not switched on/),
    });
    expect(calls).toEqual([]);
  });
});

describe('what it asks the live picture service for', () => {
  it('a screen is its menu address, with the arrow where the ready-made picture has it', async () => {
    const { calls, take } = taker();
    const asker = user();
    const shown = await liveHowToPicture({ userId: asker, locale: 'ar', route: ' /payables/suppliers ', view: 'screen', pointAt: [' New supplier ', '', 'a', 'b', 'c', 'd'] }, { take });
    expect(calls).toEqual([{ userId: asker, path: '/payables/suppliers', locale: 'ar', pointAt: ['New supplier', 'a', 'b', 'c'] }]);
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

  it('refuses "an opened record" of what is already a record, and any view it does not picture', async () => {
    const { calls, take } = taker();
    for (const route of ['/payables/invoices/API-HQ-2026-000005', '/payables/suppliers/SUP-00001', '/inventory/items/ITM-SEED']) {
      await expect(liveHowToPicture({ userId: user(), locale: 'en', route, view: 'record' }, { take })).resolves.toEqual({
        ok: false,
        reason: expect.stringMatching(/already one record/),
      });
    }
    for (const view of ['menu', 'form', 'dialog', 'all']) {
      const refused = await liveHowToPicture({ userId: user(), locale: 'en', route: '/payables/suppliers', view: view as 'screen' }, { take });
      expect(refused, view).toEqual({ ok: false, reason: expect.stringMatching(/"the screen" and "an opened record" only/) });
    }
    expect(calls).toEqual([]);
  });
});

describe('it never costs the how-to its answer', () => {
  it('hands a refusal on as a sentence — the caller falls back to the ready-made picture', async () => {
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

describe('finding a record on a list is still only looking', () => {
  const service = readFileSync('src/server/services/live-screenshot.ts', 'utf8');
  const howTo = readFileSync('src/server/services/howto-live.ts', 'utf8');

  it('nothing is pressed: an href is read, checked like any address, and opened with a plain GET', () => {
    // No click, no key, no form — in either file.
    for (const source of [service, howTo]) {
      expect(source).not.toMatch(/\.(click|dblclick|tap|fill|type|press|check|uncheck|selectOption|setInputFiles|dispatchEvent|dragTo)\(/);
      expect(source).not.toMatch(/keyboard\.|mouse\./);
    }
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
    // …and is opened by the one way anything is opened here.
    expect(service).toMatch(/opened = await visit\(checked\.path\);/);
    expect(service.match(/page\.goto\(/g)).toHaveLength(1);
  });

  it('the in-page reading is text a page can run as it stands', () => {
    const start = service.indexOf('const firstRecordCall = (listPath: string): string => `');
    const end = service.indexOf('})(${JSON.stringify(listPath)})`;', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const script = service.slice(start, end);
    expect(script).not.toContain('=>\n');
    expect(script.slice(script.indexOf('`') + 1)).not.toMatch(/=>|\bconst\s|\blet\s|\basync\s|\bawait\s/);
  });

  it('it is still one session, ended in the finally, and one audit row — for the record that was pictured', () => {
    expect(service.match(/await mintSession\(/g)).toHaveLength(1);
    expect(service).toMatch(/\} finally \{[\s\S]{0,260}await endSession\(input\.userId, minted\.sessionId\)/);
    expect(service).toMatch(/await auditShot\(input\.userId, \{ path: pictured \|\| input\.path, outcome,/);
    // Two pages are given twice the time, and no more.
    expect(service).toMatch(/const timeout = shotTimeout\(\) \* \(input\.firstRecord \? 2 : 1\);/);
  });

  it('the how-to adds no way in of its own: it asks the live picture service, and only that', () => {
    expect(howTo).toMatch(/import \{ checkPath, liveScreenshot, liveShotsReady, type LiveShotResult \} from '\.\/live-screenshot';/);
    expect(howTo).not.toMatch(/playwright|chromium|auth_session|authSession|page\.goto/);
    expect(howTo).not.toMatch(/email|impersonat/i);
  });
});

describe('whose data a how-to shows is the owner\'s setting — the training copy is the person\'s to ask for', () => {
  it('hears the person ask for the sample picture, in the languages they write in', () => {
    for (const asked of [
      'show me the suppliers screen, the sample one',
      'the training picture please, not my real data',
      'an example screenshot is enough',
      'without our data please',
      'اريد صورة تجريبية مو بياناتي',
      'مثال فقط',
    ]) {
      expect(asksForTrainingPicture(asked), asked).toBe(true);
    }
  });

  it('a plain how-to is not a request for the training copy', () => {
    for (const asked of [
      'how do I add a new supplier? show me step by step with pictures',
      'where do I post a purchase invoice',
      'show me the suppliers screen live',
      'شلون اضيف مورد جديد؟ وريني بالصور',
      '',
      null,
    ]) {
      expect(asksForTrainingPicture(asked), String(asked)).toBe(false);
    }
  });

  it('the model\'s own "training" counts only with those words: the tool is handed what the person wrote', () => {
    const service = readFileSync(join(process.cwd(), 'src/server/services/whatsapp-agent.ts'), 'utf8');
    expect(service).toMatch(/const trainingAsked = args\.data === 'training' && \(meta\?\.question == null \|\| asksForTrainingPicture\(meta\.question\)\);/);
    expect(service).toMatch(/args\.data === 'live' \? liveShots\.liveShotsReady\(\)\.ok : trainingAsked \? false : howTo\.howToLiveReady\(\)\.ok/);
    expect(service).toMatch(/lastExchange, question: input\.question \}/);
    // And he is told to leave the choice alone.
    const prompt = readFileSync(join(process.cwd(), 'src/server/domain/whatsapp-agent.ts'), 'utf8');
    expect(prompt).toMatch(/LEAVE `data` OUT of show_screen and the server decides/);
    expect(prompt).toMatch(/A plain "how do I …" is NOT a request for the training copy/);
  });
});
