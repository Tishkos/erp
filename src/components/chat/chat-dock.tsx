'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AtSign, Check, CheckCheck, Clock, FileText, Maximize2, Minus, Paperclip, RotateCcw, SendHorizontal, Smile, Trash2, TriangleAlert, X } from 'lucide-react';
import { badgeText, CHAT_MAX_FILES_PER_MESSAGE, CHAT_MESSAGE_MAX_LENGTH, type Presence } from '@domain/chat';
import { cn } from '@/components/intent/cn';
import type { ConversationRow, MessageView } from '@/server/services/chat-read';
import { useBell } from '../notifications/notification-store';
import { ChatAvatar, presenceOfRow } from './chat-avatar';
import {
  closeWindow,
  discard,
  focusWindow,
  loadEarlier,
  markReadLocally,
  minimiseWindow,
  mountDock,
  openWindow,
  retry,
  send,
  setSeen,
  setTyping,
  takeJustOpened,
  useChat,
  type PendingMessage,
} from './chat-store';
import { dayKey, dateOf, renderBody, timeOf } from './format';

/**
 * The chat windows docked at the foot of every screen but the chat screen
 * (2026-10-06, by direction: "the chat system is good but we need like
 * facebook chat"): a conversation opened from the header's drawer opens here
 * instead of leaving the page — up to three windows side by side at the end of
 * the screen, the rest folded to round "chat heads" with the unread count.
 * They stay open from screen to screen (the chat store, and this tab's session
 * across a full reload). On a phone the window in front takes the whole screen.
 *
 * Nothing here is a transport of its own: the store's one poll asks about the
 * window in front as the open conversation (receipts, Seen, typing) and about
 * the others beside it (`chat-read.sync` › `windows`); a message goes through
 * the same `send` the chat screen uses, files through the same attachment
 * store, and is Sending → Sent → Delivered → Seen exactly as there.
 */

const EMOJIS = ['😀', '😂', '😊', '😍', '🙂', '😉', '😅', '🤔', '😮', '😢', '🙏', '👍', '👏', '🙌', '💪', '🤝', '👌', '🎉', '🔥', '💯', '❤️', '✅', '☕', '📎'] as const;

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}

function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function ChatDock() {
  const t = useTranslations('chat');
  const pathname = usePathname();
  const snap = useChat();
  const phone = useIsPhone();
  useEffect(() => mountDock(), []);

  // The chat screen is the full chat: no windows over it.
  const onChatScreen = pathname === '/chat' || pathname.startsWith('/chat/');
  if (!snap.loaded || !snap.me || onChatScreen || snap.windows.length === 0) return null;

  const rows = new Map(snap.conversations.map((c) => [c.id, c] as const));
  const windows = snap.windows.filter((w) => rows.has(w.id));
  const expanded = windows.filter((w) => !w.minimised);
  const front = expanded.find((w) => w.id === snap.focusedWindow) ?? expanded.at(-1);
  // A phone shows one window, full screen; the others wait as heads.
  const shown = phone ? (front ? [front] : []) : expanded;
  const heads = windows.filter((w) => !shown.includes(w));
  if (shown.length === 0 && heads.length === 0) return null;

  return (
    <section
      aria-label={t('dock_label')}
      className={cn(
        'pointer-events-none fixed bottom-0 end-3 flex items-end gap-3 sm:end-4 print:hidden',
        // Under the header's menus on a desktop; a phone's full-screen window over everything but the search.
        phone && shown.length > 0 ? 'z-[80]' : 'z-[45]',
      )}
      data-chat-dock=""
    >
      {shown.map((w) => (
        <DockWindow focused={front?.id === w.id} key={w.id} phone={phone} row={rows.get(w.id)!} />
      ))}
      {heads.length > 0 ? (
        <ul aria-label={t('dock_heads')} className={cn('pointer-events-auto mb-4 flex flex-col-reverse gap-2.5', phone && shown.length > 0 && 'hidden')}>
          {heads.map((w) => (
            <DockHead key={w.id} row={rows.get(w.id)!} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** A folded window: the avatar, the unread count, and a way to close it. */
function DockHead({ row }: { readonly row: ConversationRow }) {
  const t = useTranslations('chat');
  const label = row.unread > 0 ? `${row.name}, ${t('unread_count', { count: row.unread })}` : row.name;
  return (
    <li className="group/head relative">
      <button
        aria-label={label}
        className="relative grid cursor-pointer place-items-center rounded-full shadow-lg ring-2 ring-overlay transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        onClick={() => openWindow(row.id)}
        title={row.name}
        type="button"
      >
        <ChatAvatar group={row.kind === 'group'} name={row.name} presence={presenceOfRow(row)} size="lg" />
        {row.unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -end-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[0.6875rem] font-semibold tabular-nums text-danger-fg ring-2 ring-overlay"
          >
            {badgeText(row.unread)}
          </span>
        ) : null}
      </button>
      <button
        aria-label={`${t('close')}: ${row.name}`}
        className="absolute -start-1 -top-1 grid size-5 cursor-pointer place-items-center rounded-full bg-overlay text-muted-fg shadow ring-1 ring-border transition-opacity hover:text-fg pointer-fine:opacity-0 pointer-fine:group-hover/head:opacity-100 focus-visible:opacity-100"
        onClick={() => closeWindow(row.id)}
        type="button"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}

const HEADER_BUTTON =
  'grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted-fg transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/** One open conversation: its header, its messages and the box to write in. */
function DockWindow({ row, focused, phone }: { readonly row: ConversationRow; readonly focused: boolean; readonly phone: boolean }) {
  const t = useTranslations('chat');
  const locale = useLocale();
  const zone = useBell().zone;
  const snap = useChat();
  const now = useNow();
  const thread = snap.threads[row.id];
  const live = snap.live[row.id];
  const pending = snap.pending.filter((p) => p.conversationId === row.id);
  const list = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const typing = live?.typing ?? [];
  const presence: Presence =
    row.kind === 'direct' ? (live?.members.find((m) => m.userId === row.other?.userId)?.presence ?? presenceOfRow(row) ?? 'offline') : 'offline';
  const subtitle =
    typing.length === 1
      ? t('typing_one', { name: typing[0]! })
      : typing.length > 1
        ? t('typing_many', { names: typing.join(', ') })
        : row.kind === 'group'
          ? t('members_count', { count: row.memberCount })
          : t(`presence.${presence}`);

  // Read on screen: the window in front, scrolled to its end, in a visible tab — the same rule as the chat screen.
  const lastSeq = thread?.lastSeq ?? 0;
  useEffect(() => {
    if (!focused || !thread || !atEnd) return;
    setSeen({ id: row.id, upTo: lastSeq });
    if (row.unread > 0) markReadLocally(row.id);
  }, [focused, thread, atEnd, lastSeq, row.id, row.unread]);

  // Follow the conversation down while the person is at its end.
  const count = (thread?.messages.length ?? 0) + pending.length + typing.length;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atEnd) el.scrollTop = el.scrollHeight;
  }, [count, atEnd]);

  return (
    <section
      aria-label={row.name}
      className={cn(
        'pointer-events-auto flex flex-col overflow-hidden bg-overlay text-overlay-fg shadow-2xl',
        phone
          ? 'fixed inset-0 z-[80] h-dvh w-full'
          : 'h-[30rem] max-h-[calc(100dvh-5rem)] w-[21.5rem] rounded-t-xl border border-b-0 border-border',
        !phone && focused && 'ring-1 ring-primary/35',
      )}
      data-chat-window={row.id}
      data-focused={focused ? 'true' : 'false'}
      onFocusCapture={() => focusWindow(row.id)}
      onPointerDownCapture={() => focusWindow(row.id)}
    >
      <header className={cn('flex items-center gap-2 border-b border-border px-2.5 py-2', focused ? 'bg-overlay' : 'bg-muted/60')}>
        <ChatAvatar group={row.kind === 'group'} name={row.name} presence={presence} size="sm" />
        <div className="min-w-0 flex-1 leading-tight">
          <bdi className="block truncate text-sm font-semibold" dir="auto">
            {row.name}
          </bdi>
          <span className={cn('block truncate text-xs', typing.length > 0 ? 'text-primary-subtle-fg' : 'text-muted-fg')}>{subtitle}</span>
        </div>
        {row.unread > 0 && !focused ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold tabular-nums text-primary-fg">
            {badgeText(row.unread)}
          </span>
        ) : null}
        {phone ? null : (
          <button aria-label={t('window_minimise')} className={HEADER_BUTTON} onClick={() => minimiseWindow(row.id)} title={t('window_minimise')} type="button">
            <Minus aria-hidden="true" className="size-4" />
          </button>
        )}
        <Link aria-label={t('open_full_named', { name: row.name })} className={HEADER_BUTTON} href={`/chat?c=${row.id}`} title={t('window_open_full')}>
          <Maximize2 aria-hidden="true" className="size-3.5 rtl:-scale-x-100" />
        </Link>
        <button aria-label={t('close')} className={HEADER_BUTTON} onClick={() => closeWindow(row.id)} title={t('close')} type="button">
          <X aria-hidden="true" className="size-4" />
        </button>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3"
        onScroll={(event) => {
          const el = event.currentTarget;
          setAtEnd(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        ref={list}
      >
        {thread === undefined ? (
          <div aria-hidden="true" className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div className={cn('flex', i % 2 ? 'justify-end' : 'justify-start')} key={i}>
                <span className={cn('h-8 animate-pulse rounded-2xl bg-secondary motion-reduce:animate-none', i % 2 ? 'w-1/2' : 'w-2/3')} />
              </div>
            ))}
          </div>
        ) : thread.messages.length === 0 && pending.length === 0 ? (
          <p className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-fg">
            <ChatAvatar group={row.kind === 'group'} name={row.name} presence={presence} size="lg" />
            {t('say_hello')}
          </p>
        ) : (
          <>
            {thread.hasMore ? (
              <div className="mb-2 flex justify-center">
                <button
                  className="cursor-pointer rounded-full px-3 py-1 text-xs font-medium text-primary-subtle-fg hover:bg-primary-subtle disabled:opacity-50"
                  disabled={loadingEarlier}
                  onClick={async () => {
                    setLoadingEarlier(true);
                    await loadEarlier(row.id);
                    setLoadingEarlier(false);
                  }}
                  type="button"
                >
                  {t('load_earlier')}
                </button>
              </div>
            ) : null}
            <ol aria-label={t('messages')} className="space-y-2">
              {thread.messages.map((message, index) => {
                const before = thread.messages[index - 1];
                const newDay = !before || dayKey(before.createdAt, zone) !== dayKey(message.createdAt, zone);
                const showName = row.kind === 'group' && !message.mine && (!before || before.senderId !== message.senderId || newDay);
                return (
                  <Bubble
                    day={newDay && now ? dateOf(message.createdAt, locale, zone) : null}
                    key={message.id}
                    locale={locale}
                    message={message}
                    showName={showName}
                    zone={zone}
                  />
                );
              })}
              {pending.map((p) => (
                <PendingBubble key={p.clientId} locale={locale} pending={p} zone={zone} />
              ))}
            </ol>
          </>
        )}
        {typing.length > 0 ? (
          <div aria-hidden="true" className="mt-2 flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-2xl rounded-es-md bg-secondary px-3 py-2.5">
              {[0, 1, 2].map((i) => (
                <span
                  className="size-1.5 animate-bounce rounded-full bg-muted-fg motion-reduce:animate-none"
                  key={i}
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          </div>
        ) : null}
      </div>

      <Composer conversationId={row.id} focused={focused} />
    </section>
  );
}

function Tick({ state }: { readonly state: string }) {
  const t = useTranslations('chat');
  const label = t(`status.${state}` as never);
  const Icon = state === 'seen' || state === 'delivered' ? CheckCheck : state === 'sending' ? Clock : state === 'failed' ? TriangleAlert : Check;
  return (
    <span
      className={cn('inline-flex items-center', state === 'seen' ? 'text-primary-subtle-fg' : state === 'failed' ? 'text-danger-subtle-fg' : 'text-muted-fg')}
      data-status={state}
      title={label}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

const BUBBLE = 'max-w-[85%] rounded-2xl px-3 py-1.5 text-sm leading-snug [overflow-wrap:anywhere]';
const MINE = 'rounded-ee-md bg-primary text-primary-fg [&_a]:text-primary-fg [&_a]:underline [&_a]:underline-offset-2';
const THEIRS = 'rounded-es-md bg-secondary text-secondary-fg [&_a]:text-primary-subtle-fg [&_a]:underline [&_a]:underline-offset-2';

function Bubble({
  message,
  showName,
  day,
  locale,
  zone,
}: {
  readonly message: MessageView;
  readonly showName: boolean;
  readonly day: string | null;
  readonly locale: string;
  readonly zone: string;
}) {
  const t = useTranslations('chat');
  const dayRow = day ? (
    <li aria-hidden="true" className="flex justify-center pb-1 pt-2">
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-[0.6875rem] text-muted-fg">{day}</span>
    </li>
  ) : null;
  if (message.kind === 'system') {
    return (
      <>
        {dayRow}
        <li className="text-center text-[0.6875rem] text-muted-fg">{t(`system_short.${message.body}` as never)}</li>
      </>
    );
  }
  const mine = message.mine;
  const images = message.files.filter((f) => f.kind === 'image');
  const others = message.files.filter((f) => f.kind !== 'image');
  return (
    <>
      {dayRow}
      <li className={cn('flex flex-col gap-0.5', mine ? 'items-end' : 'items-start')} data-message-id={message.id}>
        {showName ? (
          <bdi className="px-2 text-[0.6875rem] font-medium text-muted-fg" dir="auto">
            {message.senderName}
          </bdi>
        ) : null}
        {message.retracted ? (
          <div className={cn(BUBBLE, 'border border-dashed border-border bg-transparent italic text-muted-fg')}>{t('retracted_short')}</div>
        ) : (
          <>
            {message.body ? (
              <div className={cn(BUBBLE, mine ? MINE : THEIRS, message.mentionsMe && !mine && 'ring-2 ring-primary/40')}>
                {message.mentionsMe && !mine ? <AtSign aria-hidden="true" className="me-1 inline size-3.5 align-[-2px]" /> : null}
                {renderBody(message.body, message.mentionNames)}
              </div>
            ) : null}
            {images.map((file) => (
              <a className="block max-w-[85%] overflow-hidden rounded-2xl border border-border" href={`/chat/files/${file.id}?inline=1`} key={file.id} rel="noreferrer" target="_blank">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={file.fileName} className="block max-h-44 min-h-16 w-full bg-muted object-cover" src={`/chat/files/${file.id}?inline=1`} />
              </a>
            ))}
            {others.map((file) => (
              <a
                className="inline-flex max-w-[85%] items-center gap-2 rounded-xl border border-border bg-overlay px-2.5 py-1.5 text-xs text-fg no-underline hover:bg-muted"
                href={`/chat/files/${file.id}${file.kind === 'file' ? '' : '?inline=1'}`}
                key={file.id}
                rel="noreferrer"
                target={file.kind === 'file' ? undefined : '_blank'}
              >
                <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-fg" />
                <bdi className="truncate" dir="auto">
                  {file.fileName}
                </bdi>
              </a>
            ))}
          </>
        )}
        <span className="flex items-center gap-1 px-1 text-[0.6875rem] tabular-nums text-muted-fg">
          <time dateTime={message.createdAt}>{timeOf(message.createdAt, locale, zone)}</time>
          {mine && message.status ? <Tick state={message.status.state} /> : null}
        </span>
      </li>
    </>
  );
}

function PendingBubble({ pending, locale, zone }: { readonly pending: PendingMessage; readonly locale: string; readonly zone: string }) {
  const t = useTranslations('chat');
  const failed = pending.state === 'failed';
  return (
    <li className="flex flex-col items-end gap-0.5" data-pending={pending.state}>
      {pending.body ? <div className={cn(BUBBLE, MINE, 'opacity-80', failed && 'opacity-60')}>{pending.body}</div> : null}
      {pending.fileNames.map((name) => (
        <span className="inline-flex max-w-[85%] items-center gap-2 rounded-xl border border-border px-2.5 py-1.5 text-xs text-muted-fg" key={name}>
          <FileText aria-hidden="true" className="size-4 shrink-0" />
          <bdi className="truncate" dir="auto">
            {name}
          </bdi>
        </span>
      ))}
      <span className="flex items-center gap-1 px-1 text-[0.6875rem] tabular-nums text-muted-fg">
        <time dateTime={pending.createdAt}>{timeOf(pending.createdAt, locale, zone)}</time>
        <Tick state={pending.state} />
        {failed ? (
          <>
            <button aria-label={t('retry')} className="grid size-6 cursor-pointer place-items-center rounded-full hover:bg-secondary" onClick={() => retry(pending.clientId)} title={t('retry')} type="button">
              <RotateCcw aria-hidden="true" className="size-3.5" />
            </button>
            <button aria-label={t('discard')} className="grid size-6 cursor-pointer place-items-center rounded-full hover:bg-secondary" onClick={() => discard(pending.clientId)} title={t('discard')} type="button">
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          </>
        ) : null}
      </span>
    </li>
  );
}

const TOOL_BUTTON =
  'grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-muted-fg transition-colors hover:bg-secondary hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring';

/** The box to write in: Enter sends (Shift+Enter a new line), a file or two, an emoji. */
function Composer({ conversationId, focused }: { readonly conversationId: string; readonly focused: boolean }) {
  const t = useTranslations('chat');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canSend = body.trim().length > 0 || files.length > 0;

  // A window the person has just opened takes the cursor, as a messenger's does — never one restored with the page.
  useEffect(() => {
    if (focused && takeJustOpened(conversationId)) field.current?.focus({ preventScroll: true });
  }, [focused, conversationId]);

  // The box grows with what is written, to five lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 7 * 16)}px`;
  }, [body]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSend) return;
    send({ conversationId, body: body.trim(), files, replyTo: null });
    setBody('');
    setFiles([]);
    setTyping(false);
    field.current?.focus();
  };

  const insert = (emoji: string) => {
    const el = field.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${emoji}${body.slice(end)}`;
    setBody(next.slice(0, CHAT_MESSAGE_MAX_LENGTH));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  return (
    // Not a result the page sounds for (`result-sounds.tsx`): the chat has its own.
    <form className="border-t border-border p-2" data-no-result-sound="" onSubmit={submit}>
      {files.length > 0 ? (
        <ul className="mb-1.5 flex flex-wrap gap-1.5 px-1">
          {files.map((file, index) => (
            <li className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pe-1 ps-2.5 text-xs" key={`${file.name}-${index}`}>
              <bdi className="max-w-40 truncate" dir="auto">
                {file.name}
              </bdi>
              <button
                aria-label={`${t('remove_file')}: ${file.name}`}
                className="grid size-5 cursor-pointer place-items-center rounded-full text-muted-fg hover:bg-secondary hover:text-fg"
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
                type="button"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative flex items-end gap-0.5">
        <button aria-label={t('attach')} className={TOOL_BUTTON} onClick={() => picker.current?.click()} title={t('attach')} type="button">
          <Paperclip aria-hidden="true" className="size-4" />
        </button>
        <input
          className="hidden"
          multiple
          onChange={(event) => {
            const chosen = Array.from(event.target.files ?? []);
            setFiles([...files, ...chosen].slice(0, CHAT_MAX_FILES_PER_MESSAGE));
            event.target.value = '';
          }}
          ref={picker}
          tabIndex={-1}
          type="file"
        />
        <button
          aria-expanded={emojiOpen}
          aria-label={t('emoji')}
          className={cn(TOOL_BUTTON, emojiOpen && 'bg-secondary text-fg')}
          onClick={() => setEmojiOpen(!emojiOpen)}
          title={t('emoji')}
          type="button"
        >
          <Smile aria-hidden="true" className="size-4" />
        </button>
        {emojiOpen ? (
          <div
            aria-label={t('emoji')}
            className="absolute bottom-full start-0 z-10 mb-2 grid grid-cols-8 gap-0.5 rounded-xl border border-border bg-overlay p-1.5 shadow-lg"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setEmojiOpen(false);
                field.current?.focus();
              }
            }}
            role="group"
          >
            {EMOJIS.map((emoji) => (
              <button
                aria-label={emoji}
                className="grid size-8 cursor-pointer place-items-center rounded-lg text-lg hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
                key={emoji}
                onClick={() => insert(emoji)}
                type="button"
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label={t('message')}
          className={cn(
            'max-h-28 min-h-9 min-w-0 flex-1 resize-none rounded-2xl border-0 bg-muted px-3.5 py-2 text-sm leading-5 text-fg shadow-none',
            'placeholder:text-muted-fg focus:outline-hidden focus:ring-2 focus:ring-ring/25',
          )}
          maxLength={CHAT_MESSAGE_MAX_LENGTH}
          onBlur={() => setTyping(false)}
          onChange={(event) => {
            setBody(event.target.value);
            setTyping(event.target.value.trim().length > 0);
          }}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={t('window_placeholder')}
          ref={field}
          rows={1}
          value={body}
        />
        <button
          aria-label={t('send')}
          className={cn(TOOL_BUTTON, canSend ? 'text-primary hover:bg-primary-subtle hover:text-primary' : 'opacity-50')}
          disabled={!canSend}
          title={t('send')}
          type="submit"
        >
          <SendHorizontal aria-hidden="true" className="size-4 rtl:-scale-x-100" />
        </button>
      </div>
    </form>
  );
}
