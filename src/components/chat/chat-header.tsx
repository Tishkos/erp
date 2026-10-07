'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, AtSign, BellOff, Mail, Maximize2, MessagesSquare } from 'lucide-react';
import { badgeText } from '@domain/chat';
import { cn } from '@/components/intent/cn';
import type { ConversationRow } from '@/server/services/chat-read';
import { useBell } from '../notifications/notification-store';
import { PANEL_FOOTER_LINK, PANEL_HEADER, UTILITY_PANEL } from '../notifications/utility-panel';
import { ChatAvatar, presenceOfRow, useLastLine } from './chat-avatar';
import { mount, openWindow, useChat } from './chat-store';
import { listStamp } from './format';

/**
 * The chat's three small parts in the application header (`erp-shell.tsx`).
 *
 * The header's messages button was an empty drawer. It now carries the unread
 * count, the drawer lists the conversations that want reading, and the same
 * poll that fills them (`chat-store`) keeps the person present for the people
 * they talk to. The count is a small badge on the envelope
 * (`erp-icon-button__badge`, Intent UI 2026-10-06).
 *
 * The drawer (Intent UI, 2026-10-06) is a messenger's list: each conversation
 * a round avatar with the person's initials (a group's people icon) and, for a
 * colleague who is about, a presence dot; the name and when it last moved; the
 * last line under it; the unread count at the end. Times are the books' clock
 * (the bell's zone), as on the chat screen. Pressing a conversation opens it
 * as a chat window at the foot of the screen (`chat-dock.tsx`, by direction
 * 2026-10-06: "like facebook chat"); the square at its end opens the chat
 * screen.
 *
 * A person without chat (`enabled` false) gets the button as it was.
 */

/** The label the messages button carries: its name, and how many are unread. */
export function useChatLabel(enabled: boolean, base: string): string {
  const t = useTranslations('chat');
  const snap = useChat();
  return enabled && snap.badge > 0 ? `${base}: ${t('unread_count', { count: snap.badge })}` : base;
}

/** The button's face: the envelope, and — when there is something to read — the count as a small badge on it. */
export function ChatGlyph({ enabled }: { readonly enabled: boolean }) {
  const snap = useChat();
  useEffect(() => (enabled ? mount('header') : undefined), [enabled]);
  return (
    <>
      <Mail aria-hidden="true" />
      {enabled && snap.badge > 0 ? (
        <span aria-hidden="true" className="coa-count-badge erp-icon-button__badge" data-chat-badge={snap.badge}>
          {badgeText(snap.badge)}
        </span>
      ) : null}
    </>
  );
}

/** The mobile drawer's row for messages: the count beside the label. */
export function ChatCount({ enabled }: { readonly enabled: boolean }) {
  const snap = useChat();
  if (!enabled || snap.badge === 0) return null;
  return (
    <span aria-hidden="true" className="coa-count-badge">
      {badgeText(snap.badge)}
    </span>
  );
}

/** How many conversations the drawer lists; the rest are a click away on the chat screen. */
const DRAWER_ROWS = 7;

/** The drawer: what is waiting, newest first, and the way into the chat screen. */
export function ChatPopover({ onNavigate }: { readonly onNavigate: () => void }) {
  const t = useTranslations('chat');
  const shell = useTranslations('shell');
  const locale = useLocale();
  const snap = useChat();
  const zone = useBell().zone;
  const [now, setNow] = useState<Date | null>(null);
  // Times come from the browser's clock once mounted, and are kept fresh while the drawer is open.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const waiting = [...snap.conversations]
    .sort((a, b) => Number(b.unread > 0 && !b.muted) - Number(a.unread > 0 && !a.muted))
    .slice(0, DRAWER_ROWS);

  return (
    <div className={UTILITY_PANEL}>
      <div className={cn(PANEL_HEADER, 'border-b border-border pb-3')}>
        <h2 className="text-base font-semibold text-fg">{shell('messages')}</h2>
        {snap.badge > 0 ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold tabular-nums text-primary-fg">
            {badgeText(snap.badge)}
            <span className="sr-only"> {t('unread_count', { count: snap.badge })}</span>
          </span>
        ) : null}
      </div>

      {!snap.loaded ? (
        <div aria-live="polite" className="space-y-1 p-2" role="status">
          <span className="sr-only">{t('loading')}</span>
          {[0, 1, 2].map((i) => (
            <div aria-hidden="true" className="flex items-center gap-3 px-2.5 py-2" key={i}>
              <span className="size-10 shrink-0 animate-pulse rounded-full bg-secondary motion-reduce:animate-none" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-1/2 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                <span className="block h-2.5 w-3/4 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
              </span>
            </div>
          ))}
        </div>
      ) : waiting.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-primary-subtle text-primary-subtle-fg">
            <MessagesSquare className="size-5" />
          </span>
          <p className="max-w-64 text-sm text-muted-fg">{t('no_conversations')}</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain p-1.5">
          {waiting.map((c) => (
            <ConversationLine c={c} key={c.id} locale={locale} meId={snap.me?.userId ?? ''} now={now} onNavigate={onNavigate} zone={zone} />
          ))}
        </ul>
      )}

      <Link className={PANEL_FOOTER_LINK} href="/chat" onClick={onNavigate}>
        {t('open_chat')}
        <ArrowRight aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
      </Link>
    </div>
  );
}


/**
 * One conversation in the drawer. Pressing it opens the conversation as a chat
 * window at the foot of the screen (on the chat screen itself, in the screen);
 * the square beside it opens it on the chat screen instead.
 */
function ConversationLine({
  c,
  meId,
  locale,
  now,
  zone,
  onNavigate,
}: {
  readonly c: ConversationRow;
  readonly meId: string;
  readonly locale: string;
  readonly now: Date | null;
  readonly zone: string;
  readonly onNavigate: () => void;
}) {
  const t = useTranslations('chat');
  const router = useRouter();
  const pathname = usePathname();
  const lastLine = useLastLine();
  const line = lastLine(c, meId);
  const unread = c.unread > 0;
  const href = `/chat?c=${c.id}`;
  const onChatScreen = pathname === '/chat' || pathname.startsWith('/chat/');
  return (
    <li className="group/row relative flex items-center rounded-lg transition-colors hover:bg-muted/70 has-[button:focus-visible]:bg-muted/70">
      <button
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-start text-fg',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
        )}
        data-chat-open-window={c.id}
        onClick={() => {
          onNavigate();
          if (onChatScreen) router.push(href);
          else openWindow(c.id);
        }}
        type="button"
      >
        <ChatAvatar group={c.kind === 'group'} name={c.name} presence={presenceOfRow(c)} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <bdi className={cn('min-w-0 flex-1 truncate text-sm', unread ? 'font-semibold' : 'font-medium')} dir="auto">
              {c.name}
            </bdi>
            {c.lastMessageAt && now ? (
              <time
                className={cn('shrink-0 text-xs tabular-nums', unread ? 'font-medium text-primary-subtle-fg' : 'text-muted-fg')}
                dateTime={c.lastMessageAt}
              >
                {listStamp(c.lastMessageAt, now, locale, zone)}
              </time>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-xs', unread ? 'text-fg' : 'text-muted-fg')}>
              {line ? <bdi dir="auto">{line}</bdi> : ' '}
            </span>
            {c.muted ? <BellOff aria-label={t('muted')} className="size-3.5 shrink-0 text-muted-fg" /> : null}
            {unread ? (
              <span
                aria-label={t('unread_count', { count: c.unread })}
                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-0.5 rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold tabular-nums text-primary-fg"
              >
                {c.mentioned ? <AtSign aria-hidden="true" className="size-3" /> : null}
                {badgeText(c.unread)}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      <Link
        aria-label={t('open_full_named', { name: c.name })}
        className={cn(
          'me-1.5 grid size-7 shrink-0 place-items-center rounded-md text-muted-fg transition-opacity hover:bg-secondary hover:text-fg',
          'pointer-fine:opacity-0 pointer-fine:group-hover/row:opacity-100 focus-visible:opacity-100',
          'focus-visible:outline-2 focus-visible:outline-ring',
        )}
        href={href}
        onClick={onNavigate}
        title={t('window_open_full')}
      >
        <Maximize2 aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
      </Link>
    </li>
  );
}
