/**
 * A how-to's pictures, live — for the two that have the company's own data in
 * them.
 *
 * By direction (2026-10-05). The owner asked whether, once the training
 * sessions are over, a how-to could show the REAL database, and chose this:
 * for "the screen" and "an opened record" Noah takes a fresh picture of the
 * live application AS THE PERSON ASKING — their permissions, their branches,
 * always current — and the pictures made ahead of time stay for everything
 * that has no data in it: where a screen is in the menu, an empty form, the
 * sign-in page, the top bar ("still keep the original images, sometimes they
 * are needed … keep it as it is and keep the generation running").
 *
 * So this is an addition, behind a switch that is OFF until he says the
 * testing phase is over (`NOAH_HOWTO_LIVE=on` in the bridge's environment):
 *
 *   on    a how-to's `screen` and `record` pictures are asked for here first;
 *   off   — or whenever a live picture cannot be taken, for any reason — the
 *         caller uses the ready-made picture exactly as before, and says
 *         nothing about it.
 *
 * It adds no power to `live-screenshot.ts` and loosens none of its rules: it
 * only decides WHICH address to ask that service for. A screen is its menu
 * address; a record is "the first record that screen lists for this person"
 * (`firstRecord`), found by reading the list, never by pressing anything.
 *
 * Every failure is a value with a sentence. Nothing here throws: a how-to
 * must never be lost to a picture.
 */
import { existsSync } from 'node:fs';
import type { Mark } from '../guide/markers';
import { checkPath, liveScreenshot, liveShotsReady, type LiveShotResult } from './live-screenshot';

export type HowToLive =
  | { readonly ok: true; readonly file: string; readonly path: string; readonly title: string; readonly marks: readonly Mark[]; readonly notFound: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * On only when the owner has switched it on AND a browser is there:
 * `NOAH_HOWTO_LIVE=on` and `liveShotsReady().ok`.
 */
export function howToLiveReady(): { readonly ok: boolean; readonly reason?: string } {
  if ((process.env.NOAH_HOWTO_LIVE ?? '').trim().toLowerCase() !== 'on') {
    return { ok: false, reason: 'Live how-to pictures are not switched on (NOAH_HOWTO_LIVE=on turns them on): the pictures made ahead of time are used.' };
  }
  const ready = liveShotsReady();
  return ready.ok ? { ok: true } : { ok: false, reason: ready.reason ?? 'Live pictures cannot be taken on this server.' };
}

/**
 * A menu screen's own address: `/`, `/tasks`, `/payables/suppliers`,
 * `/payables/pd/asycuda` — lower-case words and hyphens, at most four deep,
 * no query. Every route of the menu has this shape (`domain/menu.ts`); a
 * record's address does not (a number, a code in capitals).
 */
const MENU_ROUTE = /^\/(?:[a-z][a-z-]*(?:\/[a-z][a-z-]*){0,3})?$/;

/** A document number or a code as its last word: `/payables/invoices/API-HQ-2026-000005`, `/payables/suppliers/SUP-00001`. */
function looksLikeRecord(path: string): boolean {
  const last = path.split('?')[0]!.split('/').filter(Boolean).pop() ?? '';
  return /\d/.test(last) || /[A-Z]/.test(last);
}

function menuRoute(raw: string, view: 'screen' | 'record'): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const checked = checkPath(raw);
  if (!checked.ok) return checked;
  if (view === 'record' && looksLikeRecord(checked.path)) {
    return { ok: false, reason: 'That address is already one record: a how-to asks for a screen of the menu, and its first record is found from there.' };
  }
  if (!MENU_ROUTE.test(checked.path)) {
    return { ok: false, reason: 'A how-to pictures a screen of the menu: give its own address, such as /payables/suppliers — not a record, and nothing after a "?".' };
  }
  return checked;
}

/** How long two identical requests are one picture: a how-to often asks for the same screen twice in one answer. */
const REUSE_MS = 60_000;
const taken = new Map<string, { readonly at: number; readonly result: Promise<HowToLive> }>();

type Taker = (input: { readonly userId: string; readonly path: string; readonly locale: 'en' | 'ar'; readonly pointAt?: readonly string[]; readonly firstRecord?: boolean }) => Promise<LiveShotResult>;

/**
 * One live picture for a how-to, as the asker: the screen at `route` (with an
 * arrow at `pointAt`, normally its New button as the ready-made picture names
 * it), or — `view: 'record'` — the first record that screen lists.
 *
 * `deps` is for the tests: the service that takes the picture, and the clock.
 */
export async function liveHowToPicture(
  input: {
    readonly userId: string;
    readonly locale: 'en' | 'ar';
    /** A menu screen's address, e.g. /payables/suppliers. */
    readonly route: string;
    readonly view: 'screen' | 'record';
    readonly pointAt?: readonly string[];
  },
  deps: { readonly take?: Taker; readonly now?: () => number } = {},
): Promise<HowToLive> {
  try {
    const ready = howToLiveReady();
    if (!ready.ok) return { ok: false, reason: ready.reason ?? 'Live how-to pictures are not available here.' };
    if (input.view !== 'screen' && input.view !== 'record') return { ok: false, reason: 'A how-to is pictured live for "the screen" and "an opened record" only.' };
    const route = menuRoute(String(input.route ?? ''), input.view);
    if (!route.ok) return { ok: false, reason: route.reason };

    const locale = input.locale === 'ar' ? 'ar' : 'en';
    const pointAt = (input.pointAt ?? []).map((one) => String(one).trim()).filter(Boolean).slice(0, 4);
    const now = (deps.now ?? Date.now)();
    for (const [key, entry] of taken) if (now - entry.at >= REUSE_MS) taken.delete(key);

    const key = [input.userId, route.path, input.view, locale, ...pointAt].join('\u0001');
    const before = taken.get(key);
    if (before) {
      const same = await before.result;
      // The picture is a file somebody may have swept: one that is gone is taken again.
      if (!same.ok || existsSync(same.file)) return same;
      taken.delete(key);
    }

    const take = deps.take ?? liveScreenshot;
    const result = (async (): Promise<HowToLive> => {
      try {
        const shot = await take({
          userId: input.userId,
          path: route.path,
          locale,
          ...(pointAt.length > 0 ? { pointAt } : {}),
          ...(input.view === 'record' ? { firstRecord: true } : {}),
        });
        if (!shot.ok) return { ok: false, reason: shot.reason };
        return { ok: true, file: shot.shot.file, path: shot.shot.path, title: shot.shot.title, marks: shot.shot.marks, notFound: shot.shot.notFound };
      } catch (error) {
        return { ok: false, reason: `The live picture could not be taken (${(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)).slice(0, 160)}).` };
      }
    })();
    taken.set(key, { at: now, result });
    return await result;
  } catch (error) {
    return { ok: false, reason: `The live picture could not be taken (${(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)).slice(0, 160)}).` };
  }
}
