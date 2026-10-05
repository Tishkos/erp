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
import { earlierAction, sendAction } from '@/app/(app)/chat/actions';
import { CHAT_PAGE_SIZE, pollIntervalMs } from '@domain/chat';
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

const mounts = { header: 0, screen: 0 };
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
  const ms = pollIntervalMs({
    visible: visible(),
    open: mounts.screen > 0 && state.openId !== null,
    elsewhere: mounts.screen === 0,
    failures,
  });
  timer = setTimeout(() => void poll(), ms);
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
  const open = mounts.screen > 0 ? state.openId : null;
  const thread = open ? state.threads[open] : undefined;
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
        revs: open && thread ? { [open]: thread.rev } : {},
        ack,
        seen,
        typing,
        limit: open ? limits.get(open) : undefined,
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

function apply(response: SyncResponse, open: string | null): void {
  const threads: Record<string, ThreadView> = { ...state.threads };
  const live: Record<string, LiveView> = { ...state.live };
  const firstUnseen = { ...state.firstUnseen };

  if (response.thread) {
    const id = response.thread.id;
    const had = id in threads;
    delete threads[id];
    threads[id] = mergeThread(state.threads[id], response.thread);
    live[id] = { typing: response.thread.typing, members: response.thread.members };
    if (!had || firstUnseen[id] === undefined) firstUnseen[id] = response.thread.firstUnseenSeq;
  } else if (response.live) {
    live[response.live.id] = { typing: response.live.typing, members: response.live.members };
  }
  // Keep the last few conversations read, not every one ever opened.
  const keys = Object.keys(threads);
  for (const key of keys.slice(0, Math.max(0, keys.length - THREADS_KEPT))) {
    if (key !== open) delete threads[key];
  }

  const pending = state.pending.filter((p) => !threads[p.conversationId]?.messages.some((m) => m.clientId === p.clientId));
  for (const gone of state.pending) if (!pending.includes(gone)) forms.delete(gone.clientId);

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
  });
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
      pollNow();
    } else {
      patchPending(clientId, { state: 'failed', error: result.error ?? null });
    }
  } catch {
    patchPending(clientId, { state: 'failed', error: null });
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
// React
// ---------------------------------------------------------------------------

/** The snapshot, from props while the server renders and from the browser's store afterwards. */
export function useChat(server: ChatSnapshot = EMPTY): ChatSnapshot {
  return useSyncExternalStore(subscribe, snapshot, () => server);
}

/** What the server hands the first render: its own list and thread, as a snapshot. */
export const snapshotOf = fromSeed;
