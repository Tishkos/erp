'use client';

import './toasts.css';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Bell, CircleAlert, CircleCheck, Info, X, type LucideIcon } from 'lucide-react';
import { Button } from 'react-aria-components/Button';
import { I18nProvider } from 'react-aria-components/I18nProvider';
import { Text } from 'react-aria-components/Text';
import {
  UNSTABLE_Toast as Toast,
  UNSTABLE_ToastContent as ToastContent,
  UNSTABLE_ToastRegion as ToastRegion,
  type QueuedToast,
} from 'react-aria-components/Toast';
import { cn } from '@/components/intent/cn';
import type { ToastKind } from '@/lib/toast-rules';
import { ChatAvatar } from '../chat/chat-avatar';
import { useChat } from '../chat/chat-store';
import { silencePopupsForCamera } from './popup-setting';
import { toastQueue, type ToastContent as Content } from './toast-queue';
import { ChatToasts, NotificationToasts, ResultToasts } from './toast-watchers';

/**
 * The pop-up notifications (2026-10-07, by direction: "implement notification
 * toasts (like toastify) please, but matching the rest of the design —
 * highlight colours and theme"). Mounted once, in the signed-in layout, with
 * the three things that raise them:
 *
 *   ResultToasts        a form's result — "Saved", or the refusal in its own
 *                       words — beside the banner the page already shows
 *   NotificationToasts  a new notification reaching the bell
 *   ChatToasts          a new message in a conversation that is not in front
 *
 * Each is an Intent card on the overlay surface: an icon in a tinted circle
 * (success the theme's success tint, an error its danger tint, information the
 * shell's highlight — `--erp-chosen-*` — a notification the accent itself, a
 * message the sender's face), a title, one line, a link when there is
 * somewhere to go, a close button, and a thin line along the foot for the
 * time left (five seconds, an error eight; the pointer or the keyboard on
 * them, or the tab away, holds them). React Aria's toast region is the
 * landmark (F6) and reads a notification or a message out as it arrives; a
 * form's result is not read twice — its banner already was.
 */
export function Toasts({ camera = false }: { readonly camera?: boolean }) {
  // A layout effect runs before every passive one, so before the watchers listen for anything.
  useLayoutEffect(() => {
    if (camera) silencePopupsForCamera();
  }, [camera]);
  return (
    <>
      <ToastShelf />
      <ResultToasts />
      <NotificationToasts />
      <ChatToasts />
    </>
  );
}

const subscribeQueue = (listener: () => void) => toastQueue.subscribe(listener);
const visibleNow = () => toastQueue.visibleToasts;
const noneVisible = () => EMPTY;
const EMPTY: readonly QueuedToast<Content>[] = [];

/** The region: where the cards stand, and the room the foot of the screen leaves them. */
function ToastShelf() {
  const t = useTranslations('toasts');
  const locale = useLocale();
  const visible = useSyncExternalStore(subscribeQueue, visibleNow, noneVisible);
  const room = useFootRoom(visible.length > 0);
  const [away, setAway] = useState(false);

  // A tab in the background holds its pop-ups until it is looked at again.
  useEffect(() => {
    const onVisibility = () => {
      const hidden = document.visibilityState === 'hidden';
      setAway(hidden);
      if (hidden) toastQueue.pauseAll();
      else if (!document.querySelector('[data-toast-region]:is([data-hovered], :focus-within)')) toastQueue.resumeAll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <I18nProvider locale={locale}>
      <ToastRegion
        aria-label={t('region')}
        className="erp-toasts print:hidden"
        data-paused={away ? '' : undefined}
        data-toast-region=""
        queue={toastQueue}
        style={{ '--erp-toast-lift': `${room.lift}px`, '--erp-toast-top': `${room.top}px` } as CSSProperties}
      >
        {({ toast }) => <ToastCard toast={toast} />}
      </ToastRegion>
    </I18nProvider>
  );
}

interface FootRoom {
  /** How far up the foot of the screen is taken — the chat windows and heads, the bottom bar. */
  readonly lift: number;
  /** Where the header ends, for the phone's top stack. */
  readonly top: number;
}

/** What sits at the foot of the screen, measured while a pop-up is up, so nothing overlaps it. */
function useFootRoom(active: boolean): FootRoom {
  const chat = useChat();
  const [room, setRoom] = useState<FootRoom>({ lift: 0, top: 0 });

  useLayoutEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = window.innerHeight;
      let lift = 0;
      for (const el of document.querySelectorAll('[data-chat-dock], .erp-dock')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        lift = Math.max(lift, height - rect.top);
      }
      // Room for one card at least: on a short screen they overlap a window rather than leave it.
      lift = Math.max(0, Math.min(lift, height - 160));
      const header = document.querySelector('.erp-header');
      const top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
      setRoom((was) => (was.lift === lift && was.top === top ? was : { lift, top }));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(later);
    for (const el of document.querySelectorAll('[data-chat-dock], .erp-dock, .erp-header')) resize.observe(el);
    window.addEventListener('resize', later);
    window.addEventListener('scroll', later, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('resize', later);
      window.removeEventListener('scroll', later);
    };
  }, [active, chat.windows, chat.loaded]);

  return room;
}

const ICONS: Readonly<Record<Exclude<ToastKind, 'message'>, LucideIcon>> = {
  success: CircleCheck,
  error: CircleAlert,
  info: Info,
  notification: Bell,
};

/** The tinted circle each kind wears: the theme's tints, the shell's highlight, the accent. */
const TONE: Readonly<Record<ToastKind, string>> = {
  success: 'bg-success-subtle text-success-subtle-fg',
  error: 'bg-danger-subtle text-danger-subtle-fg',
  info: 'bg-[var(--erp-chosen-bg)] text-[var(--erp-chosen-fg)] ring-1 ring-inset ring-[var(--erp-chosen-line)]',
  notification: 'bg-primary text-primary-fg',
  message: 'bg-primary text-primary-fg',
};

/** The time line in the same colour. */
const LINE: Readonly<Record<ToastKind, string>> = {
  success: 'bg-success-subtle-fg',
  error: 'bg-danger-subtle-fg',
  info: 'bg-[var(--erp-chosen-fg)]',
  notification: 'bg-primary',
  message: 'bg-primary',
};

const CARD = cn(
  'erp-toast group/toast relative flex w-full items-start gap-3 overflow-hidden rounded-xl border border-border bg-overlay py-3 ps-3 pe-2 text-overlay-fg',
  'shadow-lg dark:shadow-[0_10px_15px_-3px_rgb(0_0_0/0.4),0_4px_6px_-4px_rgb(0_0_0/0.35)]',
  // The person's Shadow "None" and Corner "Sharp" (Appearance) reach the corner too.
  '[html:has(.erp-root[data-shadow=none])_&]:shadow-none [html:has(.erp-root[data-radius=sharp])_&]:rounded-none',
  'outline-hidden focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/20',
);

function ToastCard({ toast }: { readonly toast: QueuedToast<Content> }) {
  const t = useTranslations('toasts');
  const ref = useRef<HTMLDivElement>(null);
  const { content } = toast;

  // React Aria starts a toast's timer as it mounts, even under a resting pointer: one
  // that arrives while the others are held waits with them (this runs after its effect).
  useEffect(() => {
    const region = ref.current?.closest('[data-toast-region]');
    if (!region) return;
    if (region.matches('[data-hovered], :focus-within') || document.visibilityState === 'hidden') toastQueue.pauseAll();
  }, []);

  const Icon = content.kind === 'message' ? null : ICONS[content.kind];
  const words = (
    <>
      <Text className="block text-sm/5 font-semibold text-fg" slot="title">
        <bdi className="line-clamp-2" dir="auto">
          {content.title}
        </bdi>
      </Text>
      {content.line ? (
        <Text className="mt-0.5 block text-xs/5 text-muted-fg" slot="description">
          <bdi className="line-clamp-2" dir="auto">
            {content.line}
          </bdi>
        </Text>
      ) : null}
    </>
  );

  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    const action = content.action;
    if (action?.onOpen && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      action.onOpen();
    }
    toastQueue.close(toast.key);
  };

  return (
    <Toast className={CARD} data-toast={content.kind} data-toast-id={content.id ?? undefined} ref={ref} toast={toast}>
      {content.avatar ? (
        <ChatAvatar group={content.avatar.group} name={content.avatar.name} presence={content.avatar.presence} size="list" />
      ) : Icon ? (
        <span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-full', TONE[content.kind])}>
          <Icon className="size-[1.1rem]" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1 pt-px">
        {content.announce ? <ToastContent>{words}</ToastContent> : words}
        {content.action ? (
          // A plain link on purpose: a notification's address is worked out when it is followed, never prefetched.
          <a
            className="mt-1.5 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary-subtle-fg no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            data-toast-action=""
            href={content.action.href}
            onClick={follow}
          >
            {content.action.label}
            <ArrowRight aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
          </a>
        ) : null}
      </div>
      <Button
        aria-label={t('dismiss')}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-fg transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        slot="close"
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
      {toast.timeout ? (
        <span aria-hidden="true" className={cn('erp-toast__time', LINE[content.kind])} style={{ animationDuration: `${toast.timeout}ms` }} />
      ) : null}
    </Toast>
  );
}
