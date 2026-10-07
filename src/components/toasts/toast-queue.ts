'use client';

/**
 * The pop-up notifications' one queue, and the small API every part of the
 * application calls:
 *
 *   toast.success('Saved')
 *   toast.error('That could not be saved.', { line: 'The period is closed.' })
 *   toast.info('Copied')
 *   toast.notification(title, { line, action: { label, href } })
 *   toast.message(sender, { line, avatar, action })
 *
 * React Aria's queue (`UNSTABLE_ToastQueue`) holds them; the one region in the
 * signed-in layout (`toast-region.tsx`) draws them. Three at a time, newest
 * nearest the corner; the rest wait and come in as one closes. A toast with an
 * `id` replaces the one with the same id (a conversation's newer message, not
 * a second card for it). Whether anything shows is the person's switch and
 * the page (`popup-setting.ts`): nothing on the server, nothing for Noah's
 * camera.
 */
import { UNSTABLE_ToastQueue as ToastQueue } from 'react-aria-components/Toast';
import type { Presence } from '@domain/chat';
import { TOAST_MAX_VISIBLE, mayPopUp, timeoutFor, type ToastKind } from '@/lib/toast-rules';
import { currentPopupMode } from './popup-setting';

export interface ToastAction {
  readonly label: string;
  /** A plain link (a notification's is `/notifications/open/<id>`, never a prefetching Link). */
  readonly href: string;
  /** Pressed without a modifier key: done here instead of following the link (a chat window opens). */
  readonly onOpen?: (() => void) | undefined;
}

export interface ToastAvatar {
  readonly name: string;
  readonly group: boolean;
  readonly presence: Presence | null;
}

export interface ToastContent {
  readonly kind: ToastKind;
  readonly title: string;
  readonly line: string;
  readonly action: ToastAction | null;
  readonly avatar: ToastAvatar | null;
  /** A notification's category, for its icon. */
  readonly category: string | null;
  /**
   * Read out by a screen reader when it appears. A form's result is not: its
   * banner on the page is already a status or an alert, and saying it twice
   * is noise. A notification or a message has nothing else that says it.
   */
  readonly announce: boolean;
  readonly id: string | null;
}

export interface ToastOptions {
  readonly line?: string | undefined;
  readonly action?: ToastAction | null | undefined;
  readonly avatar?: ToastAvatar | null | undefined;
  readonly category?: string | null | undefined;
  readonly announce?: boolean | undefined;
  readonly id?: string | null | undefined;
}

export const toastQueue = new ToastQueue<ToastContent>({ maxVisibleToasts: TOAST_MAX_VISIBLE });

/** The queue key of the toast each id is showing as. */
const keyOfId = new Map<string, string>();

function show(kind: ToastKind, title: string, options: ToastOptions = {}): string | null {
  if (typeof window === 'undefined') return null;
  if (!title.trim() || !mayPopUp(kind, currentPopupMode())) return null;
  const id = options.id ?? null;
  if (id) close(id);
  const content: ToastContent = {
    kind,
    title,
    line: options.line ?? '',
    action: options.action ?? null,
    avatar: options.avatar ?? null,
    category: options.category ?? null,
    announce: options.announce ?? (kind === 'notification' || kind === 'message'),
    id,
  };
  const key = toastQueue.add(content, {
    timeout: timeoutFor(kind),
    onClose: () => {
      if (id && keyOfId.get(id) === key) keyOfId.delete(id);
    },
  });
  if (id) keyOfId.set(id, key);
  return key;
}

/** Closes the toast shown under this id, if it is still there (or waiting). */
function close(id: string): void {
  const key = keyOfId.get(id);
  if (!key) return;
  keyOfId.delete(id);
  toastQueue.close(key);
}

/** Whether a toast with this id is showing or waiting. */
function has(id: string): boolean {
  return keyOfId.has(id);
}

type Shortcut = (title: string, options?: ToastOptions) => string | null;

export const toast = Object.assign((kind: ToastKind, title: string, options?: ToastOptions) => show(kind, title, options), {
  success: ((title, options) => show('success', title, options)) as Shortcut,
  error: ((title, options) => show('error', title, options)) as Shortcut,
  info: ((title, options) => show('info', title, options)) as Shortcut,
  notification: ((title, options) => show('notification', title, options)) as Shortcut,
  message: ((title, options) => show('message', title, options)) as Shortcut,
  close,
  has,
});
