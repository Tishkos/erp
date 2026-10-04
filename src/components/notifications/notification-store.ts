'use client';

/**
 * The bell's one client-side state — the unread count in the header, the list
 * in its popover, and the one poll that keeps them true.
 *
 * Nothing is pushed. `/notifications/api/feed` is asked every half minute
 * (`domain/notification-center.pollIntervalMs`: slower in a hidden tab, backing
 * off when the connection fails) for the count; while the popover is open it is
 * asked for the list as well, for the scope and category the person chose.
 *
 * Read state is the database's. A tap on "mark as read" changes the screen at
 * once and asks the server; the server's answer (the true unread count) and the
 * next poll settle any difference. Marking a read one read, or an unread one
 * unread, changes nothing on either side.
 *
 * The state is the browser's: it is never written while rendering on the
 * server, where one process serves everybody. `useBell` draws from the seed
 * the shell passes while the server renders and while the browser hydrates.
 */
import { useSyncExternalStore } from 'react';
import { markAllReadAction, markReadAction, markUnreadAction } from '@/app/(app)/notifications/actions';
import { pollIntervalMs, type NotificationCategory } from '@domain/notification-center';
import type { FeedItem } from '@/server/services/notification-center';
import type { CategoryCount } from '@/server/services/notifications';

export type BellScope = 'unread' | 'all';

export interface BellSnapshot {
  readonly loaded: boolean;
  /** `ok`; `retrying` after a failed poll; `signed_out` and `unavailable` stop the poll. */
  readonly status: 'ok' | 'retrying' | 'signed_out' | 'unavailable';
  readonly unread: number;
  readonly categories: readonly CategoryCount[];
  /** The list for the current scope and category; null until the popover has been opened once. */
  readonly items: readonly FeedItem[] | null;
  readonly scope: BellScope;
  readonly category: NotificationCategory | null;
  readonly open: boolean;
  /** The books' time zone, for the hover time. */
  readonly zone: string;
}

export interface BellSeed {
  readonly unread: number;
  readonly zone: string;
}

const EMPTY: BellSnapshot = {
  loaded: false,
  status: 'ok',
  unread: 0,
  categories: [],
  items: null,
  scope: 'unread',
  category: null,
  open: false,
  zone: 'Asia/Baghdad',
};

let state: BellSnapshot = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<BellSnapshot>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const snapshot = (): BellSnapshot => state;

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

let mounts = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let again = false;
let failures = 0;

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (mounts === 0) return;
  if (state.status === 'signed_out' || state.status === 'unavailable') return;
  timer = setTimeout(() => void poll(), pollIntervalMs({ visible: visible(), failures }));
}

/** Ask now — the popover opened, a filter changed, the tab came back. */
export function pollNow(): void {
  if (mounts === 0) return;
  if (state.status === 'signed_out' || state.status === 'unavailable') return;
  if (timer) clearTimeout(timer);
  timer = undefined;
  void poll();
}

interface FeedAnswer {
  readonly unread: number;
  readonly categories: readonly CategoryCount[];
  readonly items: readonly FeedItem[] | null;
  readonly scope: BellScope;
  readonly category: NotificationCategory | null;
  readonly zone: string;
}

async function poll(): Promise<void> {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  const asked = { list: state.open, scope: state.scope, category: state.category };
  try {
    const response = await fetch('/notifications/api/feed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(asked),
    });
    if (response.status === 401) {
      set({ status: 'signed_out' });
      return;
    }
    if (response.status === 403) {
      set({ status: 'unavailable' });
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as FeedAnswer;
    failures = 0;
    // A list for a scope the person has since left is not shown.
    const current = body.items !== null && body.scope === state.scope && body.category === state.category;
    set({
      loaded: true,
      status: 'ok',
      unread: body.unread,
      categories: body.categories,
      zone: body.zone,
      ...(current ? { items: body.items } : {}),
    });
  } catch {
    failures += 1;
    if (state.status !== 'retrying') set({ status: 'retrying' });
  } finally {
    inFlight = false;
    if (again) {
      again = false;
      void poll();
    } else {
      schedule();
    }
  }
}

const onVisible = (): void => {
  if (visible()) pollNow();
};

/** The header's bell needs the poll running. Returns the way to let go. */
export function mount(): () => void {
  mounts += 1;
  if (mounts === 1) {
    if (state.status === 'retrying') set({ status: 'ok' });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);
    schedule();
  }
  return () => {
    mounts -= 1;
    if (mounts === 0) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onVisible);
    }
  };
}

/**
 * The count the server rendered (or re-rendered after an action), taken in from
 * a layout effect — never while rendering, where one server process serves
 * everybody. Called again whenever the shell is handed a fresher count.
 */
export function adopt(seed: BellSeed): void {
  if (state.loaded && state.unread === seed.unread && state.zone === seed.zone) return;
  set({ loaded: true, unread: seed.unread, zone: seed.zone });
}

// ---------------------------------------------------------------------------
// What the popover does
// ---------------------------------------------------------------------------

export function setOpen(open: boolean): void {
  if (open === state.open) return;
  set({ open });
  if (open) pollNow();
}

export function setScope(scope: BellScope): void {
  if (scope === state.scope) return;
  set({ scope, items: null });
  pollNow();
}

export function setCategory(category: NotificationCategory | null): void {
  if (category === state.category) return;
  set({ category, items: null });
  pollNow();
}

function patch(id: string, read: boolean): void {
  if (state.items === null) return;
  const was = state.items.find((item) => item.id === id);
  if (!was || was.read === read) return;
  set({
    items: state.items.map((item) => (item.id === id ? { ...item, read } : item)),
    unread: Math.max(0, state.unread + (read ? -1 : 1)),
  });
}

async function settle(result: Promise<{ ok: boolean; unread: number }>): Promise<void> {
  try {
    const answer = await result;
    if (answer.ok) set({ unread: answer.unread });
  } catch {
    // The next poll puts the screen right.
  }
  pollNow();
}

export function markRead(id: string): void {
  patch(id, true);
  void settle(markReadAction(id));
}

export function markUnread(id: string): void {
  patch(id, false);
  void settle(markUnreadAction(id));
}

/** Everything unread of the chosen category (or all of them) is read. */
export function markAllRead(): void {
  const category = state.category;
  set({
    items: state.items === null ? null : state.items.map((item) => (category === null || item.category === category ? { ...item, read: true } : item)),
    unread: category === null ? 0 : Math.max(0, state.unread - (state.categories.find((c) => c.category === category)?.unread ?? 0)),
  });
  void settle(markAllReadAction(category));
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

/** The snapshot, from the seed while the server renders and from the browser's store afterwards. */
export function useBell(server: BellSnapshot = EMPTY): BellSnapshot {
  return useSyncExternalStore(subscribe, snapshot, () => server);
}
