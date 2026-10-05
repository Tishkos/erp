/**
 * A how-to's pictures — every one of them live.
 *
 * By direction, twice on 2026-10-05. First the owner chose that "the screen"
 * and "an opened record" be pictured from the real system as the person
 * asking, with the pictures made ahead of time kept for what has no data in
 * it. Then, the same day, after an answer arrived with a training picture of
 * somebody else's suppliers: "he doesn't need temporary screenshots any more —
 * always live, no more training picture … explain with a picture if needed,
 * real time".
 *
 * So there is one source of pictures now, `live-screenshot.ts`, and this file
 * only decides WHAT to ask it for:
 *
 *   menu     the screen's own page, with its module's dropdown opened and its
 *            entry ringed
 *   screen   the screen as it opens, the way to a new record pointed at
 *   form     what opens for a new record — its own page, or the window its
 *            button opens
 *   record   the first record the screen lists for this person
 *   dialog   one of the windows the screen (or that record) opens
 *
 * and, outside the menu: the sign-in page (as nobody), the top bar, the
 * account menu, the password page.
 *
 * It adds no power to the camera and loosens none of its rules. Every failure
 * is a value with a sentence: a how-to is never lost to a picture — it is
 * explained in words instead, and never with a picture of anything else.
 */
import { existsSync } from 'node:fs';
import type { Mark } from '../guide/markers';
import { checkPath, liveScreenshot, liveShotsReady, liveSignIn, type LiveShotResult } from './live-screenshot';

export type HowToView = 'menu' | 'screen' | 'form' | 'record' | 'dialog';
export type HowToExtra = '/sign-in' | 'top-bar' | 'user-menu' | '/password';

export type HowToLive =
  | {
      readonly ok: true;
      readonly file: string;
      readonly path: string;
      readonly title: string;
      readonly marks: readonly Mark[];
      readonly notFound: readonly string[];
      readonly windows?: ReadonlyArray<{ readonly key: string; readonly name: string }>;
      readonly ringed?: string;
      readonly opened?: string;
    }
  | { readonly ok: false; readonly reason: string };

/** A picture can be taken here: a browser is installed and nobody switched live pictures off. */
export function howToLiveReady(): { readonly ok: boolean; readonly reason?: string } {
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

function menuRoute(raw: string): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const checked = checkPath(raw);
  if (!checked.ok) return checked;
  if (!MENU_ROUTE.test(checked.path)) {
    return { ok: false, reason: 'A how-to pictures a screen of the menu: give its own address, such as /payables/suppliers — not a record, and nothing after a "?". One record is pictured with the screenshot tool.' };
  }
  return checked;
}

/** How long two identical requests are one picture: a how-to often asks for the same screen twice in one answer. */
const REUSE_MS = 60_000;
const taken = new Map<string, { readonly at: number; readonly result: Promise<HowToLive> }>();

type Taker = typeof liveScreenshot;
type SignInTaker = typeof liveSignIn;
interface Deps {
  readonly take?: Taker;
  readonly signIn?: SignInTaker;
  readonly now?: () => number;
}

const said = (error: unknown) => `The live picture could not be taken (${(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error)).slice(0, 160)}).`;

function unwrap(shot: LiveShotResult): HowToLive {
  if (!shot.ok) return { ok: false, reason: shot.reason };
  const { file, path, title, marks, notFound, windows, ringed, opened } = shot.shot;
  return { ok: true, file, path, title, marks, notFound, ...(windows ? { windows } : {}), ...(ringed ? { ringed } : {}), ...(opened ? { opened } : {}) };
}

/** One picture, once: the same request inside a minute is the same file. */
async function once(key: string, now: number, work: () => Promise<HowToLive>): Promise<HowToLive> {
  for (const [old, entry] of taken) if (now - entry.at >= REUSE_MS) taken.delete(old);
  const before = taken.get(key);
  if (before) {
    const same = await before.result;
    // The picture is a file somebody may have swept: one that is gone is taken again.
    if (!same.ok || existsSync(same.file)) return same;
    taken.delete(key);
  }
  const result = work().catch((error): HowToLive => ({ ok: false, reason: said(error) }));
  taken.set(key, { at: now, result });
  return result;
}

/**
 * One live picture of a menu screen, as the asker.
 *
 * `deps` is for the tests: the service that takes the picture, and the clock.
 */
export async function liveHowToPicture(
  input: {
    readonly userId: string;
    readonly locale: 'en' | 'ar';
    /** A menu screen's address, e.g. /payables/suppliers. */
    readonly route: string;
    readonly view: HowToView;
    /** `menu`: the module's name in the top bar, in either language. */
    readonly moduleTitles?: readonly string[];
    /** `dialog`: which window, by its key or words of its name; nothing asks which there are. */
    readonly dialog?: string | null;
    /** `dialog`: on the screen itself, or on the first record it lists. */
    readonly on?: 'screen' | 'record';
    readonly pointAt?: readonly string[];
  },
  deps: Deps = {},
): Promise<HowToLive> {
  try {
    const ready = howToLiveReady();
    if (!ready.ok) return { ok: false, reason: ready.reason ?? 'Live pictures are not available here.' };
    if (!['menu', 'screen', 'form', 'record', 'dialog'].includes(input.view)) return { ok: false, reason: 'There is no such picture of a screen.' };
    const route = menuRoute(String(input.route ?? ''));
    if (!route.ok) return { ok: false, reason: route.reason };

    const locale = input.locale === 'ar' ? 'ar' : 'en';
    const pointAt = (input.pointAt ?? []).map((one) => String(one).trim()).filter(Boolean).slice(0, 4);
    const titles = (input.moduleTitles ?? []).map((one) => String(one).trim()).filter(Boolean).slice(0, 6);
    const which = String(input.dialog ?? '').trim().slice(0, 80);
    const on = input.on === 'record' ? 'record' : 'screen';
    const now = (deps.now ?? Date.now)();
    const key = [input.userId, route.path, input.view, locale, on, which, ...titles, '|', ...pointAt].join('\u0001');
    const take = deps.take ?? liveScreenshot;

    return await once(key, now, async () => {
      const base = { userId: input.userId, path: route.path, locale } as const;
      switch (input.view) {
        case 'menu':
          return unwrap(await take({ ...base, open: { kind: 'menu', route: route.path, moduleTitles: titles } }));
        case 'screen':
          return unwrap(await take({ ...base, pointNew: true, ...(pointAt.length > 0 ? { pointAt } : {}) }));
        case 'form':
          return unwrap(await take({ ...base, open: { kind: 'form' } }));
        case 'record':
          return unwrap(await take({ ...base, firstRecord: true, ...(pointAt.length > 0 ? { pointAt } : {}) }));
        default:
          return unwrap(await take({ ...base, open: { kind: 'dialog', which }, ...(on === 'record' ? { firstRecord: true } : {}) }));
      }
    });
  } catch (error) {
    return { ok: false, reason: said(error) };
  }
}

/** One of the pictures that is not a screen of the menu: the way in, and the bar every screen sits under. */
export async function liveExtraPicture(input: { readonly userId: string; readonly locale: 'en' | 'ar'; readonly which: HowToExtra }, deps: Deps = {}): Promise<HowToLive> {
  try {
    const ready = howToLiveReady();
    if (!ready.ok) return { ok: false, reason: ready.reason ?? 'Live pictures are not available here.' };
    const locale = input.locale === 'ar' ? 'ar' : 'en';
    const now = (deps.now ?? Date.now)();
    const take = deps.take ?? liveScreenshot;
    const signIn = deps.signIn ?? liveSignIn;
    return await once([input.userId, 'extra', input.which, locale].join('\u0001'), now, async () => {
      // The sign-in page is everybody's: it is pictured as nobody, with no session at all.
      if (input.which === '/sign-in') return unwrap(await signIn({ userId: input.userId, locale }));
      if (input.which === '/password') return unwrap(await take({ userId: input.userId, path: '/password', locale, as: 'form' }));
      // The bar is on every screen; the notifications list is a light one to stand under it.
      return unwrap(await take({ userId: input.userId, path: BAR_PAGE, locale, open: { kind: input.which === 'user-menu' ? 'user-menu' : 'top-bar' } }));
    });
  } catch (error) {
    return { ok: false, reason: said(error) };
  }
}

/** The page the top bar and the account menu are pictured on: every role may open it, and it draws quickly. */
const BAR_PAGE = '/notifications';
