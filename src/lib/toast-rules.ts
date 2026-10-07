/**
 * When the application pops a small card up in the corner — the pure half of
 * the pop-up notifications (`components/toasts`, 2026-10-07, by direction:
 * "implement notification toasts (like toastify) please, but matching the rest
 * of the design — highlight colours and theme").
 *
 * Nothing here reads the browser or draws anything: the watchers hand in what
 * they saw (the address, a banner, the bell's counts, the chat's list) and
 * these say whether it deserves a pop-up and what it says. The form-result
 * reading is the sounds' own (`sound-rules.ts` › `resultOfAddress`,
 * `resultOfBanner`), so a sound and a pop-up always agree about a result.
 * `tests/unit/toasts.test.ts` holds them.
 */
import {
  resultOfAddress,
  resultOfBanner,
  type CategoryTick,
  type ConversationTick,
  type IncomingContext,
} from './sound-rules';

export const TOAST_KINDS = ['success', 'error', 'info', 'notification', 'message'] as const;
export type ToastKind = (typeof TOAST_KINDS)[number];

/** At most this many on the screen; the rest wait their turn. */
export const TOAST_MAX_VISIBLE = 3;
/** How long a pop-up stays: five seconds, an error eight — or until it is closed. */
export const TOAST_TIMEOUT_MS = 5_000;
export const ERROR_TIMEOUT_MS = 8_000;

export function timeoutFor(kind: ToastKind): number {
  return kind === 'error' ? ERROR_TIMEOUT_MS : TOAST_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Whether this page may pop anything up at all
// ---------------------------------------------------------------------------

/** The account menu's switch, kept in this browser: `on`, `off`, or never touched (null). */
export const POPUPS_STORAGE_KEY = 'erp-popups';

/** `all`; `errors` — the person turned pop-ups off, but a refusal still shows; `none`. */
export type PopupMode = 'all' | 'errors' | 'none';

export interface PopupEnvironment {
  readonly stored: string | null;
  /** A browser driven by a program — the test suite, or Noah's camera. */
  readonly webdriver: boolean;
  /** The page was drawn for Noah's camera session (`user-appearance.isCameraSession`). */
  readonly camera: boolean;
  readonly userAgent: string;
}

/**
 * Noah's camera never shows one: its pictures go to a group, and a pop-up
 * carries a person's own notification. A program that did not ask for them
 * (`erp-popups` = `on`) sees none either: the test suite reads the banners by
 * their words and roles, and a second copy of the words in a corner would be
 * a second match. Off is the person's choice for everything but errors — a
 * refusal is never only beside a form they may have scrolled away from.
 */
export function popupMode(env: PopupEnvironment): PopupMode {
  if (env.camera || /noah-live-screenshot/i.test(env.userAgent)) return 'none';
  if (env.stored === 'off') return 'errors';
  if (env.stored === 'on') return 'all';
  return env.webdriver ? 'none' : 'all';
}

export function mayPopUp(kind: ToastKind, mode: PopupMode): boolean {
  if (mode === 'all') return true;
  return mode === 'errors' && kind === 'error';
}

// ---------------------------------------------------------------------------
// A form's result
// ---------------------------------------------------------------------------

export type ResultKind = 'success' | 'error';

/**
 * The result banner (`Flash`) that just appeared, read as the sounds read it —
 * but only the result banner: a refusal pops up when it is the Flash's
 * (`role="alert"` with the `flash` class). A field's or a row's own error
 * stays beside its field, where it belongs.
 */
export function toastOfBanner(banner: { readonly role: string | null; readonly className: string }): ResultKind | null {
  const result = resultOfBanner(banner);
  if (result === 'success') return 'success';
  if (result === 'error' && /(^|[\s_-])flash/i.test(banner.className)) return 'error';
  return null;
}

/**
 * What the address says (`?saved=1`, `?error=…`), once it is not the address
 * the form was sent from. Both are a path with its query (`/x?saved=1`): a
 * save on a page that already says "Saved" comes back to the same address,
 * and the banner is what tells it then.
 */
export function addressResult(address: string, atSubmit: string): ResultKind | null {
  if (address === atSubmit) return null;
  const query = address.indexOf('?');
  return resultOfAddress(query >= 0 ? address.slice(query) : '');
}

/**
 * Which of the banners on the page is the result: the one the address agrees
 * with, else "saved" over a refusal that happened to share the screen (as the
 * sounds choose). -1 when there is none.
 */
export function pickResult(found: readonly ResultKind[], expected: ResultKind | null): number {
  if (found.length === 0) return -1;
  if (expected) {
    const agreeing = found.indexOf(expected);
    if (agreeing >= 0) return agreeing;
  }
  const saved = found.indexOf('success');
  return saved >= 0 ? saved : 0;
}

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/**
 * A banner's words as a pop-up's title and line: the bold heading (a
 * refusal's "That could not be saved.") is the title and the sentence the
 * line; a banner without one is its sentence alone. The caller leaves out any
 * `<code>` — a temporary password is shown once, on the page, never again in
 * a corner.
 */
export function bannerWords(parts: { readonly strong: string; readonly rest: string }, max = 180): { title: string; line: string } {
  const head = squash(parts.strong);
  const rest = squash(parts.rest);
  if (head) return { title: clip(head, max), line: clip(rest, max) };
  return { title: clip(rest, max), line: '' };
}

/**
 * The `?error=` sentence, when there is no banner to read it from — only if
 * it reads as a sentence. A bare code (`not_found`) is never shown: the
 * pop-up says "Not saved" and nothing more.
 */
export function readableError(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = squash(params.get('error') ?? '');
  if (!value || /^[\w.:-]+$/.test(value)) return null;
  return clip(value, 180);
}

/**
 * The answer to the form that was sent: a fetch to the address the form was
 * sent from, begun after it was sent (a server action posts to the page's
 * own address; Next's page and prefetch requests carry `_rsc`).
 */
export function isActionAnswer(
  entry: { readonly name: string; readonly initiatorType: string; readonly startTime: number },
  armed: { readonly url: string; readonly at: number },
): boolean {
  if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') return false;
  if (entry.startTime + 1 < armed.at) return false;
  const strip = (url: string) => url.split('#')[0]!;
  return strip(entry.name) === strip(armed.url);
}

/**
 * The wait for one form's result. A press on Send arms it for two minutes; the
 * first result ends it, so one result is told once. Back, forward, a reload
 * (the page starts with nothing armed) or following a link is never a result.
 */
export interface ArmedResult {
  readonly until: number;
  /** The page's full address when the form was sent (what its action posts to), and its path with the query. */
  readonly url: string;
  readonly address: string;
  /** `performance.now()` at the press — what a fetch's start is compared with. */
  readonly at: number;
  /** The server has answered the form. */
  readonly answered: boolean;
}

export interface ResultGate {
  arm(url: string, address: string, at: number): void;
  answered(): void;
  /** Back / forward, a link followed: whatever shows next is not this form's result. */
  forget(): void;
  /** What is being waited for, if anything (a wait past its two minutes is over). */
  current(): ArmedResult | null;
  /** A result arrived: true the first time, and the wait is over. */
  take(): boolean;
}

export const RESULT_WAIT_MS = 120_000;

export function resultGate(clock: () => number = () => Date.now(), windowMs: number = RESULT_WAIT_MS): ResultGate {
  let armed: ArmedResult | null = null;
  const current = (): ArmedResult | null => {
    if (armed && clock() > armed.until) armed = null;
    return armed;
  };
  return {
    arm(url, address, at) {
      armed = { until: clock() + windowMs, url, address, at, answered: false };
    },
    answered() {
      const now = current();
      if (now) armed = { ...now, answered: true };
    },
    forget() {
      armed = null;
    },
    current,
    take() {
      const was = current();
      armed = null;
      return was !== null;
    },
  };
}

/**
 * Once per key within a window: a result reached by two paths at once (the
 * banner, and the address a moment later) is one pop-up.
 */
export function onceWithin(windowMs: number, clock: () => number = () => Date.now()): (key: string) => boolean {
  const seen = new Map<string, number>();
  return (key) => {
    const now = clock();
    for (const [k, at] of seen) if (now - at > windowMs) seen.delete(k);
    if (seen.has(key)) return false;
    seen.set(key, now);
    return true;
  };
}

// ---------------------------------------------------------------------------
// The bell: which notifications are new
// ---------------------------------------------------------------------------

export interface NoticeTick {
  readonly id: string;
  readonly category: string;
  readonly read: boolean;
  /** `no_access` / `not_found`: the reader may no longer see what it was about. */
  readonly reason: string | null;
}

const unreadOutsideChat = (rows: readonly CategoryTick[]): number =>
  rows.reduce((sum, row) => (row.category === 'chat' ? sum : sum + Math.max(0, row.unread)), 0);

/**
 * The notifications that just reached the bell: as many of the newest unread
 * ones (the list is newest first) as the count rose by — the chat's own left
 * out, one already shown never again, one the reader can no longer see never.
 */
export function newNotices<T extends NoticeTick>(
  before: readonly CategoryTick[],
  after: readonly CategoryTick[],
  newestFirst: readonly T[],
  told: ReadonlySet<string>,
  max: number = TOAST_MAX_VISIBLE,
): T[] {
  const rose = unreadOutsideChat(after) - unreadOutsideChat(before);
  if (rose <= 0) return [];
  const fresh = newestFirst.filter((item) => !item.read && item.category !== 'chat' && !told.has(item.id)).slice(0, Math.min(rose, max));
  return fresh.filter((item) => item.reason !== 'no_access' && item.reason !== 'not_found');
}

// ---------------------------------------------------------------------------
// The chat: which conversations have a new message
// ---------------------------------------------------------------------------

/**
 * The conversations a new message from somebody else just arrived in — the
 * sound's own rule (`incomingChime`), told per conversation: not on the first
 * look, not one's own, not a system line, not a muted conversation or the one
 * being read, not while Busy; and never on the chat screen, which shows them.
 */
export function incomingRows<T extends ConversationTick>(
  before: readonly ConversationTick[] | null,
  after: readonly T[],
  context: IncomingContext & { readonly onChatScreen: boolean },
): T[] {
  if (before === null || context.busy || context.onChatScreen) return [];
  const known = new Map(before.map((row) => [row.id, row] as const));
  return after.filter((row) => {
    if (row.muted || row.id === context.inFront) return false;
    const last = row.lastMessage;
    if (!last || last.kind !== 'text' || last.senderId === context.meId) return false;
    const was = known.get(row.id);
    return row.lastSeq > (was?.lastSeq ?? 0) && row.unread > (was?.unread ?? 0);
  });
}
