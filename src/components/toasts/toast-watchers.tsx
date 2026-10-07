'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  TOAST_MAX_VISIBLE,
  addressResult,
  bannerWords,
  incomingRows,
  isActionAnswer,
  newNotices,
  onceWithin,
  pickResult,
  readableError,
  resultGate,
  toastOfBanner,
  type ResultKind,
} from '@/lib/toast-rules';
import type { FeedItem } from '@/server/services/notification-center';
import { presenceOfRow } from '../chat/chat-avatar';
import { onIncoming, openWindow, snapshot as chatSnapshot } from '../chat/chat-store';
import { noteText, type Words } from '../notifications/note-text';
import { onArrival, snapshot as bellSnapshot, useBell } from '../notifications/notification-store';
import { currentPopupMode } from './popup-setting';
import { toast } from './toast-queue';

/**
 * What raises the pop-up notifications — no screen is edited for them.
 *
 * Each of the three hears what the application already hears for its sound
 * (`result-sounds.tsx`, the bell's and the chat's polls) and plays nothing:
 * the sounds are theirs.
 */

// ---------------------------------------------------------------------------
// A form's result
// ---------------------------------------------------------------------------

const BANNERS = '[role="status"], [role="alert"]';

interface SeenBanner {
  readonly element: Element;
  readonly kind: ResultKind;
}

function shown(element: Element): boolean {
  const el = element as Element & { checkVisibility?: () => boolean };
  return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0;
}

/** The result banners (`Flash`) in these parts of the page, on screen, not a pop-up's own. */
function bannersIn(roots: Iterable<Element>): SeenBanner[] {
  const out: SeenBanner[] = [];
  for (const root of roots) {
    for (const element of [root, ...root.querySelectorAll(BANNERS)]) {
      if (!element.matches(BANNERS) || element.closest('[data-toast-region]')) continue;
      const kind = toastOfBanner({ role: element.getAttribute('role'), className: typeof element.className === 'string' ? element.className : '' });
      if (kind && shown(element)) out.push({ element, kind });
    }
  }
  return out;
}

/** A banner's own words: its bold heading and its sentence — never a `<code>` (a password shown once). */
function wordsOf(element: Element): { title: string; line: string } {
  const strong = element.querySelector('strong')?.textContent ?? '';
  const copy = element.cloneNode(true) as Element;
  for (const leave of copy.querySelectorAll('strong, code, kbd, svg, [aria-hidden="true"]')) leave.remove();
  return bannerWords({ strong, rest: copy.textContent ?? '' });
}

const here = (): string => `${window.location.pathname}${window.location.search}`;

/**
 * "Saved", or the refusal in its own words, after the person sends one of a
 * screen's forms — beside the banner the page shows, which stays exactly as
 * it is (the test suite and screen readers read it, and a refusal belongs
 * beside its form).
 *
 * Armed by the press, as the sounds are, for two minutes; the first result
 * ends it, so a result pops up once — never again on a reload (nothing is
 * armed on a fresh page), on back or forward, or after following a link. The
 * result is the banner that appears, else the address the action came back
 * to (`?saved=1`, `?error=…`, with the banner's words when it follows), else —
 * when the page comes back to the same address, as a second save on a record
 * does — the banner the page shows once the server has answered.
 */
export function ResultToasts() {
  const t = useTranslations('toasts');
  const words = useRef(t);
  useEffect(() => {
    words.current = t;
  });

  useEffect(() => {
    const gate = resultGate();
    const once = onceWithin(1_500);
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const stopWaiting = () => {
      if (waiting) clearTimeout(waiting);
      waiting = undefined;
    };
    const wait = (ms: number) => {
      stopWaiting();
      waiting = setTimeout(() => {
        waiting = undefined;
        readPage();
      }, ms);
    };

    const pop = (kind: ResultKind, found: { title: string; line: string } | null) => {
      stopWaiting();
      if (!gate.take()) return;
      const title = found?.title || words.current(kind === 'success' ? 'saved' : 'not_saved');
      const line = found?.title ? found.line : kind === 'error' ? (readableError(window.location.search) ?? '') : '';
      if (!once(`${kind}|${title}|${line}`)) return;
      if (kind === 'success') toast.success(title, { line, announce: false });
      else toast.error(title, { line, announce: false });
    };

    /** The page as it stands: its result banner, else what the address says, else nothing to tell. */
    const readPage = () => {
      const armed = gate.current();
      if (!armed) return;
      const expected = addressResult(here(), armed.address);
      const banners = bannersIn([document.body]);
      const index = pickResult(
        banners.map((b) => b.kind),
        expected,
      );
      if (index >= 0) pop(banners[index]!.kind, wordsOf(banners[index]!.element));
      else if (expected) pop(expected, null);
      // The server answered and the page shows no result: there is nothing to tell.
      else if (armed.answered) gate.forget();
    };

    const observer = new MutationObserver((records) => {
      const armed = gate.current();
      if (!armed) return;
      const added: Element[] = [];
      let inPage = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element) || node.closest('[data-toast-region]')) continue;
          added.push(node);
          if (!inPage && node.closest('main')) inPage = true;
        }
      }
      const expected = addressResult(here(), armed.address);
      const banners = bannersIn(added);
      if (banners.length > 0) {
        const index = pickResult(
          banners.map((b) => b.kind),
          expected,
        );
        pop(banners[index]!.kind, wordsOf(banners[index]!.element));
        return;
      }
      // The address came back with a result: its banner, when the page draws one, has its words.
      if (expected) wait(400);
      // The server has answered and the page is being drawn again.
      else if (armed.answered && inPage) wait(250);
    });

    // A server action posts to the page's own address: its answer is the moment the result is in.
    let answers: PerformanceObserver | null = null;
    try {
      answers = new PerformanceObserver((list) => {
        const armed = gate.current();
        if (!armed || armed.answered) return;
        if (!list.getEntries().some((entry) => isActionAnswer(entry as PerformanceResourceTiming, armed))) return;
        gate.answered();
        // Nothing on the page may change at all (the same "Saved" again): read it after a moment.
        if (!waiting) wait(1_500);
      });
      answers.observe({ type: 'resource', buffered: false });
    } catch {
      answers = null;
    }

    const onSubmit = (event: Event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      // A screen's own forms (and the windows they open): not the header's branch switch, whose page
      // may still carry an earlier "Saved"; not the chat's composer, which has its own sound and line.
      if (!form || !form.closest('main') || form.closest('[data-no-result-sound], [data-toast-region]')) return;
      if (currentPopupMode() === 'none') return;
      stopWaiting();
      gate.arm(window.location.href, here(), performance.now());
    };
    const forget = () => {
      stopWaiting();
      gate.forget();
    };
    // Following a link is a new errand: whatever shows next is not that form's result.
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) forget();
    };

    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', forget);
    return () => {
      stopWaiting();
      observer.disconnect();
      answers?.disconnect();
      document.removeEventListener('submit', onSubmit, true);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', forget);
    };
  }, []);

  return null;
}

// ---------------------------------------------------------------------------
// A new notification
// ---------------------------------------------------------------------------

/**
 * A new notification reaching the bell, as its chime plays: its title and the
 * way to it (`/notifications/open/<id>`, a plain link — it is worked out when
 * followed and reads it). Never for what was waiting when the page opened,
 * never while the bell's popover is open (the person is reading the list) —
 * opening it takes them away — and not while the person is Busy, as the chime.
 */
export function NotificationToasts() {
  const t = useTranslations('notifications');
  const own = useTranslations('toasts');
  const bell = useBell();
  const words = useRef({ t: t as unknown as Words, own });
  const shownIds = useRef(new Set<string>());
  useEffect(() => {
    words.current = { t: t as unknown as Words, own };
  });

  useEffect(() => {
    const told = new Set<string>();
    let alive = true;
    const stop = onArrival((arrival) => {
      // Nothing to show (switched off, a program that did not ask, Noah's camera): not even the list is asked for.
      if (currentPopupMode() !== 'all') return;
      if (arrival.open || chatSnapshot().me?.status === 'busy') return;
      void (async () => {
        let items: readonly FeedItem[] = [];
        try {
          const response = await fetch('/notifications/api/feed', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            body: JSON.stringify({ list: true, scope: 'unread', category: null }),
          });
          if (!response.ok) return;
          items = ((await response.json()) as { items: readonly FeedItem[] | null }).items ?? [];
        } catch {
          return;
        }
        if (!alive || bellSnapshot().open) return;
        // Oldest first, so the newest ends nearest the corner.
        for (const item of newNotices(arrival.before, arrival.after, items, told).reverse()) {
          told.add(item.id);
          const text = noteText(words.current.t, item);
          const id = `notification:${item.id}`;
          const shown = toast.notification(text.title, {
            line: text.detail,
            category: item.category,
            id,
            action: item.openable ? { label: words.current.own('open'), href: `/notifications/open/${encodeURIComponent(item.id)}` } : null,
          });
          if (shown) shownIds.current.add(id);
        }
      })();
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);

  // The popover opened: what popped up is in the list now.
  useEffect(() => {
    if (!bell.open) return;
    for (const id of shownIds.current) toast.close(id);
    shownIds.current.clear();
  }, [bell.open]);

  return null;
}

// ---------------------------------------------------------------------------
// A new chat message
// ---------------------------------------------------------------------------

/**
 * A new message in a conversation that is not open in front: the sender's
 * face, the line, and Reply — which opens the conversation as a chat window
 * at the foot of the screen (`/chat?c=…` for a new tab). One card per
 * conversation: a newer message replaces it, and reading the conversation
 * takes it away. Not on the chat screen, not for a muted conversation, not
 * while the person is Busy — the message sound's own rule.
 */
export function ChatToasts() {
  const t = useTranslations('chat');
  const own = useTranslations('toasts');
  const words = useRef({ t, own });
  useEffect(() => {
    words.current = { t, own };
  });

  useEffect(() => {
    const told = new Map<string, number>();
    return onIncoming((arrival) => {
      // Where nothing can pop up, the chat's answer is not even looked at: the chat runs exactly as without pop-ups.
      if (currentPopupMode() !== 'all') return;
      // A conversation read, or opened in front, takes its pop-up away.
      for (const row of arrival.after) {
        const id = `chat:${row.id}`;
        if ((row.unread === 0 || row.id === arrival.inFront) && toast.has(id)) toast.close(id);
      }
      const onChatScreen = arrival.onChatScreen || /^\/chat(\/|$)/.test(window.location.pathname);
      const rows = incomingRows(arrival.before, arrival.after, { ...arrival, onChatScreen });
      for (const row of rows.slice(0, TOAST_MAX_VISIBLE)) {
        const last = row.lastMessage;
        if (!last || told.get(row.id) === last.seq) continue;
        told.set(row.id, last.seq);
        const { t: chat, own: mine } = words.current;
        const body = last.retracted ? chat('retracted_short') : last.preview || (last.fileCount > 0 ? chat('sent_file') : '');
        toast.message(row.name, {
          line: row.kind === 'group' ? `${last.senderName}: ${body}` : body,
          id: `chat:${row.id}`,
          avatar: { name: row.name, group: row.kind === 'group', presence: presenceOfRow(row) },
          action: { label: mine('reply'), href: `/chat?c=${encodeURIComponent(row.id)}`, onOpen: () => openWindow(row.id) },
        });
      }
    });
  }, []);

  return null;
}
