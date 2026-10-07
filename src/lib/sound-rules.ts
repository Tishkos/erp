/**
 * When the application makes a sound — the pure half of `sounds.ts` (2026-10-06,
 * by direction: "like facebook chat with sounds … when invoicing a document
 * … nice sounds … when an error or unfilled something missing another sound").
 *
 * Nothing here plays anything or reads the browser: the store, the bell and
 * the result watcher hand in what they saw, and these say whether it deserves
 * a sound. `tests/unit/sound-rules.test.ts` holds them.
 */

export const SOUND_KINDS = ['message', 'sent', 'notification', 'success', 'error', 'missing'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/** Message and notification sounds are what Busy silences; the person's own results always sound. */
export function silencedByBusy(kind: SoundKind): boolean {
  return kind === 'message' || kind === 'notification';
}

// ---------------------------------------------------------------------------
// Chat: a message arrived
// ---------------------------------------------------------------------------

export interface ConversationTick {
  readonly id: string;
  readonly lastSeq: number;
  readonly unread: number;
  readonly muted: boolean;
  readonly lastMessage: { readonly senderId: string; readonly kind: 'text' | 'system' } | null;
}

export interface IncomingContext {
  readonly meId: string | null;
  /** The person chose Busy: no message sounds. */
  readonly busy: boolean;
  /** The conversation open and in front (on the chat screen, or the chat window with the focus), if any. */
  readonly inFront: string | null;
}

/**
 * A new message from somebody else has arrived in a conversation that is not
 * muted and not already being read. `before` is null on the first answer:
 * what was waiting when the page opened is not news.
 */
export function incomingChime(before: readonly ConversationTick[] | null, after: readonly ConversationTick[], context: IncomingContext): boolean {
  if (before === null || context.busy) return false;
  const known = new Map(before.map((row) => [row.id, row] as const));
  return after.some((row) => {
    if (row.muted || row.id === context.inFront) return false;
    const last = row.lastMessage;
    if (!last || last.kind !== 'text' || last.senderId === context.meId) return false;
    const was = known.get(row.id);
    return row.lastSeq > (was?.lastSeq ?? 0) && row.unread > (was?.unread ?? 0);
  });
}

// ---------------------------------------------------------------------------
// The bell: a notification arrived
// ---------------------------------------------------------------------------

export interface CategoryTick {
  readonly category: string;
  readonly unread: number;
}

/**
 * More unread notifications than at the last look — not counting the chat's,
 * which have their own sound. `before` is null until the bell has looked once.
 */
export function notificationChime(before: readonly CategoryTick[] | null, after: readonly CategoryTick[], context: { readonly busy: boolean }): boolean {
  if (before === null || context.busy) return false;
  const total = (rows: readonly CategoryTick[]) => rows.reduce((sum, row) => (row.category === 'chat' ? sum : sum + Math.max(0, row.unread)), 0);
  return total(after) > total(before);
}

// ---------------------------------------------------------------------------
// A form's result: saved, refused, or something missing
// ---------------------------------------------------------------------------

/** What the address says a server action came back with (`?saved=1`, `?error=…`). */
export function resultOfAddress(search: string): 'success' | 'error' | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const error = params.get('error');
  if (error !== null && error.trim() !== '') return 'error';
  if (params.get('saved') === '1') return 'success';
  return null;
}

/**
 * What a banner that has just appeared says: the result banner (`Flash`) is a
 * `role="status"` for saved and `role="alert"` for a refusal; any other alert a
 * form shows after a submit is a refusal too.
 */
export function resultOfBanner(banner: { readonly role: string | null; readonly className: string }): 'success' | 'error' | null {
  if (banner.role === 'alert') return 'error';
  if (banner.role === 'status' && /(^|[\s_-])flash($|[\s_-])/i.test(banner.className) && !/flashError/i.test(banner.className)) return 'success';
  return null;
}

/**
 * Once per burst: the first call answers true, the rest within `windowMs` of
 * the last one false. A submit with three empty required fields fires
 * `invalid` three times; it is one missing-field sound.
 */
export function burstGate(windowMs: number, clock: () => number = () => Date.now()): () => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const now = clock();
    const fresh = now - last > windowMs;
    last = now;
    return fresh;
  };
}

// ---------------------------------------------------------------------------
// Whether this page may make a sound at all
// ---------------------------------------------------------------------------

export interface SoundEnvironment {
  /** The person's switch in the account menu (on unless they turned it off). */
  readonly enabled: boolean;
  /** The person has pressed or typed on the page: browsers refuse sound before that, and so do we. */
  readonly activated: boolean;
  /** A browser driven by a program — the test suite, or Noah's camera. */
  readonly webdriver: boolean;
  readonly userAgent: string;
  /** The page was drawn for Noah's camera session (`user-appearance.isCameraSession`). */
  readonly camera: boolean;
}

export function soundAllowed(env: SoundEnvironment): boolean {
  if (!env.enabled || !env.activated || env.webdriver || env.camera) return false;
  return !/noah-live-screenshot/i.test(env.userAgent);
}
