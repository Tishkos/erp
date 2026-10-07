'use client';

/**
 * The chat's one client-side state, shared by the header's badge and the chat
 * screen — and its one poll.
 *
 * Nothing here is pushed to the browser. A request goes to `/chat/api/sync`
 * every few seconds (`domain/chat.pollIntervalMs`: 2 s on an open thread, 6 s
 * on the list, 15 s on any other page, 30 s in a hidden tab, backing off when
 * the connection fails). Each request carries what this browser has to say —
 * what reached it (`ack`: the recipient's *delivered*), what was read on screen
 * (`seen`) and whether the person is typing — and each answer brings the list,
 * the open thread when its revision moved, and who is typing.
 *
 * A message being sent is a *pending* copy (state "sending") until the stored
 * one arrives carrying the same `clientId`; a retry after a lost answer finds
 * the stored message instead of sending a second (the server keys on it).
 *
 * The module's state is the browser's. It is never written while rendering on
 * the server, where one process serves everybody: `useChat` reads the server's
 * snapshot from props there.
 */
import { useSyncExternalStore } from 'react';
import { earlierAction, sendAction, statusAction } from '@/app/(app)/chat/actions';
import { CHAT_PAGE_SIZE, pollIntervalMs, type ChosenStatus } from '@domain/chat';
import { incomingChime } from '@/lib/sound-rules';
import { play, setQuiet } from '@/lib/sounds';
import type {
  ConversationRow,
  PersonView,
  QuoteView,
  SyncResponse,
  ThreadView,
} from '@/server/services/chat-read';

export interface PendingMessage {
  readonly clientId: string;
  readonly conversationId: string;
  readonly body: string;
  readonly fileNames: readonly string[];
  readonly replyTo: QuoteView | null;
  readonly createdAt: string;
  readonly state: 'sending' | 'sent' | 'failed';
  readonly error: string | null;
}

export interface LiveView {
  readonly typing: readonly string[];
  readonly members: readonly PersonView[];
}

export interface ChatSnapshot {
  /** The first answer has arrived (or the server rendered one in). */
  readonly loaded: boolean;
  /** `ok`; `retrying` after a failed poll; `signed_out` and `unavailable` stop the poll. */
  readonly status: 'ok' | 'retrying' | 'signed_out' | 'unavailable';
  readonly me: SyncResponse['me'] | null;
  readonly badge: number;
  readonly conversations: readonly ConversationRow[];
  readonly threads: Readonly<Record<string, ThreadView>>;
  readonly live: Readonly<Record<string, LiveView>>;
  readonly openId: string | null;
  /** Where "unread" began when the open conversation was opened; kept so the divider stays put while it is read. */
  readonly firstUnseen: Readonly<Record<string, number | null>>;
  readonly pending: readonly PendingMessage[];
  /** A conversation that was open and is no longer this person's. */
  readonly closed: string | null;
  /** The chat windows docked at the foot of other screens, oldest first (`chat-dock.tsx`). */
  readonly windows: readonly ChatWindow[];
  /** The window in front: the one the poll treats as the open conversation. */
  readonly focusedWindow: string | null;
}

/** A conversation open in a small window at the foot of the screen, or folded to its round head. */
export interface ChatWindow {
  readonly id: string;
  readonly minimised: boolean;
}

export interface ChatSeed {
  readonly me: SyncResponse['me'];
  readonly badge: number;
  readonly conversations: readonly ConversationRow[];
  readonly thread: ThreadView | null;
  readonly openId: string | null;
}

const EMPTY: ChatSnapshot = {
  loaded: false,
  status: 'ok',
  me: null,
  badge: 0,
  conversations: [],
  threads: {},
  live: {},
  openId: null,
  firstUnseen: {},
  pending: [],
  closed: null,
  windows: [],
  focusedWindow: null,
};

/** Threads kept for a quick return; the open one is always among them. */
const THREADS_KEPT = 6;
const ACTIVE_WITHIN_MS = 60_000;
const TYPING_RENEW_MS = 3_000;

export const uuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
};

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let state: ChatSnapshot = EMPTY;
const listeners = new Set<() => void>();
const forms = new Map<string, FormData>();

function set(next: Partial<ChatSnapshot>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function snapshot(): ChatSnapshot {
  return state;
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

const mounts = { header: 0, screen: 0, dock: 0 };
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let again = false;
let failures = 0;
let lastActivity = Date.now();
/** Highest message number each conversation's browser has acknowledged to the server. */
const acked = new Map<string, number>();
let wantTyping = false;
let sentTyping = false;
let sentTypingAt = 0;
let seenTarget: { id: string; upTo: number } | null = null;
const limits = new Map<string, number>();

const visible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible';

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (mounts.header + mounts.screen === 0) return;
  if (state.status === 'signed_out' || state.status === 'unavailable') return;
  const windowOpen = mounts.screen === 0 && expandedWindows().length > 0;
  const ms = pollIntervalMs({
    visible: visible(),
    open: (mounts.screen > 0 && state.openId !== null) || windowOpen,
    elsewhere: mounts.screen === 0 && !windowOpen,
    failures,
  });
  timer = setTimeout(() => void poll(), ms);
}

/** The docked windows that are open (not folded to a head) — only while the dock is on the page. */
function expandedWindows(): readonly ChatWindow[] {
  return mounts.dock > 0 && mounts.screen === 0 ? state.windows.filter((w) => !w.minimised) : [];
}

/** The conversation the poll treats as open: the chat screen's, else the docked window in front. */
function openNow(): string | null {
  if (mounts.screen > 0) return state.openId;
  const expanded = expandedWindows();
  if (expanded.length === 0) return null;
  return expanded.some((w) => w.id === state.focusedWindow) ? state.focusedWindow : expanded[expanded.length - 1]!.id;
}

/** Open, and in front of the person: a message arriving there needs no sound. */
function inFrontNow(): string | null {
  if (typeof document === 'undefined' || !visible() || !document.hasFocus()) return null;
  return openNow();
}

/** Ask now (a send, a tap, the tab coming back), without waiting for the interval. */
export function pollNow(): void {
  if (mounts.header + mounts.screen === 0) return;
  if (state.status === 'signed_out' || state.status === 'unavailable') return;
  if (timer) clearTimeout(timer);
  timer = undefined;
  void poll();
}

async function poll(): Promise<void> {
  if (inFlight) {
    again = true;
    return;
  }
  inFlight = true;
  const open = openNow();
  const thread = open ? state.threads[open] : undefined;
  const others = expandedWindows()
    .map((w) => w.id)
    .filter((id) => id !== open)
    .slice(-3);
  const revs: Record<string, number> = {};
  if (open && thread) revs[open] = thread.rev;
  for (const id of others) {
    const held = state.threads[id];
    if (held) revs[id] = held.rev;
  }
  const now = Date.now();

  const ack: Record<string, number> = {};
  for (const row of state.conversations) {
    if (row.lastSeq > (acked.get(row.id) ?? 0) && row.unread > 0) ack[row.id] = row.lastSeq;
  }
  const seen = open && seenTarget && seenTarget.id === open && visible() ? seenTarget : null;
  const typingOn = open !== null && wantTyping;
  let typing: boolean | undefined;
  if (typingOn && (!sentTyping || now - sentTypingAt > TYPING_RENEW_MS)) typing = true;
  else if (!typingOn && sentTyping) typing = false;

  try {
    const response = await fetch('/chat/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({
        open,
        visible: visible(),
        active: visible() && now - lastActivity < ACTIVE_WITHIN_MS,
        revs,
        ack,
        seen,
        typing,
        limit: open ? limits.get(open) : undefined,
        ...(others.length > 0 ? { windows: others } : {}),
      }),
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
    const body = (await response.json()) as SyncResponse;
    failures = 0;
    for (const [id, upTo] of Object.entries(ack)) acked.set(id, Math.max(acked.get(id) ?? 0, upTo));
    if (typing !== undefined) {
      sentTyping = typing;
      sentTypingAt = now;
    }
    apply(body, open);
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

function mergeThread(old: ThreadView | undefined, next: ThreadView): ThreadView {
  if (!old || next.messages.length === 0) return next;
  const from = next.messages[0]!.seq;
  const older = old.messages.filter((m) => m.seq < from);
  if (older.length === 0) return next;
  return { ...next, messages: [...older, ...next.messages], hasMore: old.hasMore };
}

/** Whether the conversations held before this answer are a fair "before" — not on the page's first answer. */
let polledOnce = false;

/**
 * Each answer's list beside the one before it (null on the page's first
 * answer), and what the message sound is decided with — for the pop-up
 * notifications (`components/toasts`), which tell the same arrivals.
 */
export interface ChatArrival {
  readonly before: readonly ConversationRow[] | null;
  readonly after: readonly ConversationRow[];
  readonly meId: string;
  readonly busy: boolean;
  /** The conversation open and in front, if any. */
  readonly inFront: string | null;
  /** The chat screen is on the page. */
  readonly onChatScreen: boolean;
}

const incomingListeners = new Set<(arrival: ChatArrival) => void>();

/** Hear every answer of the poll. Returns the way to stop. */
export function onIncoming(listener: (arrival: ChatArrival) => void): () => void {
  incomingListeners.add(listener);
  return () => incomingListeners.delete(listener);
}

function tellIncoming(arrival: ChatArrival): void {
  for (const listener of incomingListeners) {
    try {
      listener(arrival);
    } catch {
      // A listener's trouble never stops the chat.
    }
  }
}

function apply(response: SyncResponse, open: string | null): void {
  const threads: Record<string, ThreadView> = { ...state.threads };
  const live: Record<string, LiveView> = { ...state.live };
  const firstUnseen = { ...state.firstUnseen };

  const take = (thread: ThreadView | null, liveView: SyncResponse['live']) => {
    if (thread) {
      const id = thread.id;
      const had = id in threads;
      delete threads[id];
      threads[id] = mergeThread(state.threads[id], thread);
      live[id] = { typing: thread.typing, members: thread.members };
      if (!had || firstUnseen[id] === undefined) firstUnseen[id] = thread.firstUnseenSeq;
    } else if (liveView) {
      live[liveView.id] = { typing: liveView.typing, members: liveView.members };
    }
  };
  take(response.thread, response.live);
  const gone = new Set<string>();
  for (const view of response.windows ?? []) {
    if (view.closed) gone.add(view.id);
    else take(view.thread, view.live);
  }
  if (response.closed) gone.add(response.closed);
  // Keep the last few conversations read, not every one ever opened — and every docked window's.
  const keep = new Set([open, ...state.windows.map((w) => w.id)].filter((id): id is string => Boolean(id)));
  const keys = Object.keys(threads);
  for (const key of keys.slice(0, Math.max(0, keys.length - THREADS_KEPT))) {
    if (!keep.has(key)) delete threads[key];
  }

  const pending = state.pending.filter((p) => !threads[p.conversationId]?.messages.some((m) => m.clientId === p.clientId));
  for (const sent of state.pending) if (!pending.includes(sent)) forms.delete(sent.clientId);

  // A sound for a message from somebody else, unless the person is Busy or already reading it.
  const busy = response.me.status === 'busy';
  setQuiet(busy);
  const before = polledOnce ? state.conversations : null;
  const inFront = inFrontNow();
  if (incomingChime(before, response.conversations, { meId: response.me.userId, busy, inFront })) {
    play('message');
  }
  tellIncoming({ before, after: response.conversations, meId: response.me.userId, busy, inFront, onChatScreen: mounts.screen > 0 });
  polledOnce = true;

  const windows = state.windows.filter((w) => !gone.has(w.id));
  const windowsChanged = windows.length !== state.windows.length;
  set({
    loaded: true,
    status: 'ok',
    me: response.me,
    badge: response.badge,
    conversations: response.conversations,
    threads,
    live,
    firstUnseen,
    pending,
    ...(response.closed && state.openId === response.closed ? { openId: null, closed: response.closed } : {}),
    ...(windowsChanged
      ? { windows, focusedWindow: windows.some((w) => w.id === state.focusedWindow) ? state.focusedWindow : (windows.at(-1)?.id ?? null) }
      : {}),
  });
  if (windowsChanged) saveWindows();
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

function onActivity(): void {
  lastActivity = Date.now();
}

function onVisible(): void {
  onActivity();
  if (visible()) pollNow();
}

function start(): void {
  lastActivity = Date.now();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('online', onVisible);
  window.addEventListener('pointerdown', onActivity, { passive: true });
  window.addEventListener('keydown', onActivity, { passive: true });
  window.addEventListener('pointermove', onActivity, { passive: true });
  void poll();
}

function stop(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
  window.removeEventListener('online', onVisible);
  window.removeEventListener('pointerdown', onActivity);
  window.removeEventListener('keydown', onActivity);
  window.removeEventListener('pointermove', onActivity);
}

/**
 * The docked chat windows are on the page (`chat-dock.tsx`). They ride on the
 * header's poll — a person without chat has no header poll and so no windows —
 * and make it ask about the open windows as often as about an open thread.
 * The windows the person had open are taken back from this tab's session.
 */
export function mountDock(): () => void {
  mounts.dock += 1;
  if (mounts.dock === 1 && state.windows.length === 0) {
    const restored = loadWindows();
    if (restored.length > 0) set({ windows: restored, focusedWindow: restored.at(-1)!.id });
  }
  pollNow();
  return () => {
    mounts.dock -= 1;
    if (mounts.dock === 0) {
      wantTyping = false;
      seenTarget = null;
    }
    schedule();
  };
}

/** A component that needs the poll running: the header's badge, or the chat screen. Returns the way to let go. */
export function mount(kind: 'header' | 'screen'): () => void {
  const wasRunning = mounts.header + mounts.screen > 0;
  mounts[kind] += 1;
  if (!wasRunning) {
    if (state.status === 'retrying') set({ status: 'ok' });
    start();
  } else if (kind === 'screen') {
    pollNow();
  }
  return () => {
    mounts[kind] -= 1;
    if (kind === 'screen' && mounts.screen === 0) {
      wantTyping = false;
      seenTarget = null;
    }
    if (mounts.header + mounts.screen === 0) stop();
    else schedule();
  };
}

// ---------------------------------------------------------------------------
// What the screen does to the state
// ---------------------------------------------------------------------------

function fromSeed(initial: ChatSeed): ChatSnapshot {
  return {
    ...EMPTY,
    loaded: true,
    me: initial.me,
    badge: initial.badge,
    conversations: initial.conversations,
    threads: initial.thread ? { [initial.thread.id]: initial.thread } : {},
    live: initial.thread ? { [initial.thread.id]: { typing: initial.thread.typing, members: initial.thread.members } } : {},
    firstUnseen: initial.thread ? { [initial.thread.id]: initial.thread.firstUnseenSeq } : {},
    openId: initial.openId,
  };
}

/**
 * The server-rendered first view, taken in while rendering: assigned without
 * telling anyone, so the first browser render draws what the server drew.
 * Once the store has anything of its own it is left alone.
 */
export function hydrate(initial: ChatSeed): void {
  if (!state.loaded) state = fromSeed(initial);
}

/** After mounting: tell the header, and follow the address when it names another conversation. */
export function seed(initial: ChatSeed): void {
  hydrate(initial);
  if (initial.openId !== state.openId) open(initial.openId);
  else for (const listener of listeners) listener();
}

export function open(id: string | null): void {
  if (id === state.openId) return;
  wantTyping = false;
  seenTarget = null;
  const firstUnseen = { ...state.firstUnseen };
  if (id) delete firstUnseen[id];
  set({ openId: id, firstUnseen, closed: null });
  pollNow();
}

/** Ask for a larger window of the open conversation — to reach an older message found by search. */
export function reach(id: string, seq: number): void {
  const thread = state.threads[id];
  const lastSeq = thread?.lastSeq ?? state.conversations.find((c) => c.id === id)?.lastSeq ?? seq;
  limits.set(id, Math.min(200, Math.max(CHAT_PAGE_SIZE, lastSeq - seq + 12)));
  // The cached copy is too short: forget it, so the next answer is the whole, larger window.
  const threads = { ...state.threads };
  delete threads[id];
  const firstUnseen = { ...state.firstUnseen };
  delete firstUnseen[id];
  set({ threads, firstUnseen });
  pollNow();
}

export function setTyping(on: boolean): void {
  if (on === wantTyping) {
    if (on && !sentTyping) pollNow();
    return;
  }
  wantTyping = on;
  if (on || sentTyping) pollNow();
}

/** The open conversation is on screen and read up to `upTo` (or not at all: null). */
export function setSeen(target: { id: string; upTo: number } | null): void {
  const same = seenTarget?.id === target?.id && seenTarget?.upTo === target?.upTo;
  seenTarget = target;
  if (target && !same) pollNow();
}

export interface SendArgs {
  readonly conversationId: string;
  readonly body: string;
  readonly files: readonly File[];
  readonly replyTo: QuoteView | null;
}

export function send(args: SendArgs): string {
  const clientId = uuid();
  const form = new FormData();
  form.set('conversation_id', args.conversationId);
  form.set('body', args.body);
  form.set('client_id', clientId);
  if (args.replyTo) form.set('reply_to', args.replyTo.id);
  for (const file of args.files) form.append('files', file);
  forms.set(clientId, form);
  set({
    pending: [
      ...state.pending,
      {
        clientId,
        conversationId: args.conversationId,
        body: args.body,
        fileNames: args.files.map((f) => f.name),
        replyTo: args.replyTo,
        createdAt: new Date().toISOString(),
        state: 'sending',
        error: null,
      },
    ],
  });
  void deliver(clientId);
  return clientId;
}

async function deliver(clientId: string): Promise<void> {
  const form = forms.get(clientId);
  if (!form) return;
  patchPending(clientId, { state: 'sending', error: null });
  try {
    const result = await sendAction(form);
    if (result.ok) {
      // Stored. The stored copy arrives with the next answer and takes this one's place.
      patchPending(clientId, { state: 'sent', error: null });
      play('sent');
      pollNow();
    } else {
      patchPending(clientId, { state: 'failed', error: result.error ?? null });
      play('error');
    }
  } catch {
    patchPending(clientId, { state: 'failed', error: null });
    play('error');
  }
}

export function retry(clientId: string): void {
  void deliver(clientId);
}

export function discard(clientId: string): void {
  forms.delete(clientId);
  set({ pending: state.pending.filter((p) => p.clientId !== clientId) });
}

function patchPending(clientId: string, patch: Partial<PendingMessage>): void {
  set({ pending: state.pending.map((p) => (p.clientId === clientId ? { ...p, ...patch } : p)) });
}

/** Older messages of the open conversation, put before the ones held. */
export async function loadEarlier(id: string): Promise<boolean> {
  const thread = state.threads[id];
  const first = thread?.messages[0];
  if (!thread || !first) return false;
  const result = await earlierAction(id, first.seq);
  if (!result.ok || !result.value) return false;
  const current = state.threads[id];
  if (!current) return false;
  const known = new Set(current.messages.map((m) => m.id));
  const added = result.value.messages.filter((m) => !known.has(m.id));
  set({
    threads: {
      ...state.threads,
      [id]: { ...current, messages: [...added, ...current.messages], hasMore: result.value.hasMore },
    },
  });
  return true;
}

/** Treats a conversation as read on screen right away: the list's count falls before the answer confirms it. */
export function markReadLocally(id: string): void {
  const row = state.conversations.find((c) => c.id === id);
  if (!row || row.unread === 0) return;
  const conversations = state.conversations.map((c) => (c.id === id ? { ...c, unread: 0, mentioned: false } : c));
  const lost = row.muted ? 0 : row.unread;
  set({ conversations, badge: Math.max(0, state.badge - lost) });
}

// ---------------------------------------------------------------------------
// The person's own status (the account menu)
// ---------------------------------------------------------------------------

/** Available, Busy, Away or Appear offline: shown at once, kept by the server, put right by the next answer. */
export async function chooseStatus(status: ChosenStatus): Promise<boolean> {
  const before = state.me;
  if (before) set({ me: { ...before, status, busy: status === 'busy' } });
  setQuiet(status === 'busy');
  try {
    const result = await statusAction(status);
    if (!result.ok && before) set({ me: before });
    pollNow();
    return result.ok;
  } catch {
    if (before) set({ me: before });
    return false;
  }
}

// ---------------------------------------------------------------------------
// The docked chat windows (`chat-dock.tsx`)
// ---------------------------------------------------------------------------

/** At most this many windows stand open; the next one folds the oldest to its head. */
export const WINDOWS_OPEN_MAX = 3;
/** Heads kept beside them; past this the oldest closes. */
export const WINDOWS_KEPT_MAX = 8;
const WINDOWS_KEY = 'erp-chat-windows';

function saveWindows(): void {
  try {
    window.sessionStorage.setItem(WINDOWS_KEY, JSON.stringify({ windows: state.windows, focused: state.focusedWindow }));
  } catch {
    // A private window keeps them for the page only.
  }
}

function loadWindows(): ChatWindow[] {
  try {
    const raw = window.sessionStorage.getItem(WINDOWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { windows?: unknown };
    if (!Array.isArray(parsed.windows)) return [];
    return parsed.windows
      .filter((w): w is ChatWindow => typeof w === 'object' && w !== null && typeof (w as ChatWindow).id === 'string')
      .map((w) => ({ id: w.id, minimised: Boolean(w.minimised) }))
      .slice(-WINDOWS_KEPT_MAX);
  } catch {
    return [];
  }
}

/** The window the person opened last, until its box has taken the cursor. */
let justOpened: string | null = null;

/** Whether this window was just opened by the person (once): a window restored with the page does not take the cursor. */
export function takeJustOpened(id: string): boolean {
  if (justOpened !== id) return false;
  justOpened = null;
  return true;
}

/** Opens a conversation as a window in front (or brings its window forward), folding the oldest past three. */
export function openWindow(id: string): void {
  justOpened = id;
  const rest = state.windows.filter((w) => w.id !== id);
  let windows: ChatWindow[] = [...rest, { id, minimised: false }];
  const expanded = windows.filter((w) => !w.minimised);
  if (expanded.length > WINDOWS_OPEN_MAX) {
    const fold = new Set(expanded.slice(0, expanded.length - WINDOWS_OPEN_MAX).map((w) => w.id));
    windows = windows.map((w) => (fold.has(w.id) ? { ...w, minimised: true } : w));
  }
  if (windows.length > WINDOWS_KEPT_MAX) windows = windows.slice(-WINDOWS_KEPT_MAX);
  wantTyping = false;
  seenTarget = null;
  const firstUnseen = { ...state.firstUnseen };
  delete firstUnseen[id];
  set({ windows, focusedWindow: id, firstUnseen });
  saveWindows();
  pollNow();
}

/** The window the person is writing in or reading: the poll's open conversation. */
export function focusWindow(id: string): void {
  if (state.focusedWindow === id) return;
  wantTyping = false;
  seenTarget = null;
  set({ focusedWindow: id });
  saveWindows();
  pollNow();
}

export function minimiseWindow(id: string): void {
  const windows = state.windows.map((w) => (w.id === id ? { ...w, minimised: true } : w));
  const expanded = windows.filter((w) => !w.minimised);
  if (state.focusedWindow === id) {
    wantTyping = false;
    seenTarget = null;
  }
  set({ windows, focusedWindow: state.focusedWindow === id ? (expanded.at(-1)?.id ?? null) : state.focusedWindow });
  saveWindows();
  schedule();
}

export function closeWindow(id: string): void {
  const windows = state.windows.filter((w) => w.id !== id);
  if (state.focusedWindow === id) {
    wantTyping = false;
    seenTarget = null;
  }
  const expanded = windows.filter((w) => !w.minimised);
  set({ windows, focusedWindow: state.focusedWindow === id ? (expanded.at(-1)?.id ?? null) : state.focusedWindow });
  saveWindows();
  schedule();
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

/** The snapshot, from props while the server renders and from the browser's store afterwards. */
export function useChat(server: ChatSnapshot = EMPTY): ChatSnapshot {
  return useSyncExternalStore(subscribe, snapshot, () => server);
}

/** What the server hands the first render: its own list and thread, as a snapshot. */
export const snapshotOf = fromSeed;
