'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  Link2,
  MessageSquare,
  Paperclip,
  Search,
  SendHorizontal,
  Users,
  X,
} from 'lucide-react';
import { Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { IconDialog } from '@/components/admin/icon-dialog';
import { cn } from '@/components/intent/cn';
import {
  busyAction,
  muteAction,
  openRecordAction,
  reactAction,
  retractAction,
  searchAction,
} from '@/app/(app)/chat/actions';
import { CHAT_MAX_FILES_PER_MESSAGE, CHAT_MESSAGE_MAX_LENGTH, preview as previewOf } from '@domain/chat';
import type { ConversationRow, MessageView, QuoteView, SearchHit, ThreadView } from '@/server/services/chat-read';
import { ChatDialog } from './chat-dialog';
import { ConversationInfo } from './chat-info';
import { MessageRow, PendingRow, SystemRow, type RowEnv } from './chat-message';
import { PeoplePicker } from './chat-people';
import { PresencePill } from './chat-presence';
import {
  discard,
  hydrate,
  loadEarlier,
  markReadLocally,
  mount,
  open as openConversation,
  pollNow,
  reach,
  retry,
  seed,
  send,
  setSeen,
  setTyping,
  snapshotOf,
  useChat,
  type ChatSeed,
} from './chat-store';
import { AVATAR_CLASS, initials, listStamp } from './format';

export interface RecordIntent {
  readonly type: string;
  readonly id: string;
  /** Present only when this person can open the record. */
  readonly label: string | null;
  readonly href: string | null;
  readonly accessible: boolean;
  readonly existing: readonly { readonly id: string; readonly name: string; readonly unread: number }[];
}

const TYPING_IDLE_MS = 4_000;
const NEAR_BOTTOM_PX = 96;

/** A line kept to what the narrow list can hold; the whole text stays in the title. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

function useTabVisible(): boolean {
  return useSyncExternalStore(
    (notify) => {
      document.addEventListener('visibilitychange', notify);
      return () => document.removeEventListener('visibilitychange', notify);
    },
    () => document.visibilityState === 'visible',
    () => true,
  );
}

export function ChatWorkspace({
  initial,
  locale,
  timeZone,
  mayWrite,
  draft,
  record,
}: {
  readonly initial: ChatSeed;
  readonly locale: string;
  readonly timeZone: string;
  readonly mayWrite: boolean;
  readonly draft: string;
  readonly record: RecordIntent | null;
}) {
  const t = useTranslations('chat');
  const server = useMemo(() => snapshotOf(initial), [initial]);
  // The browser's store starts from what the server drew; assigned in render so the first client render agrees with it.
  if (typeof window !== 'undefined') hydrate(initial);
  const snap = useChat(server);

  useEffect(() => {
    seed(initial);
    return mount('screen');
  }, [initial]);

  const narrow = useMedia('(max-width: 78rem)');
  const visible = useTabVisible();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const openId = snap.openId;
  const thread: ThreadView | undefined = openId ? snap.threads[openId] : undefined;
  const row: ConversationRow | undefined = openId ? snap.conversations.find((c) => c.id === openId) : undefined;
  const live = openId ? snap.live[openId] : undefined;
  const [actionError, setActionError] = useState<string | null>(null);

  // The address follows the conversation open, so a refresh or a shared link comes back to it.
  useEffect(() => {
    const wanted = openId ? `/chat?c=${openId}` : '/chat';
    if (`${window.location.pathname}${window.location.search}` !== wanted && !(openId === initial.openId && window.location.search.includes('draft='))) {
      window.history.replaceState(window.history.state, '', wanted);
    }
  }, [openId, initial.openId]);

  // ---- the list ------------------------------------------------------------
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const needle = q.trim().toLowerCase();

  useEffect(() => {
    if (needle.length < 2) {
      setHits(null);
      return;
    }
    let current = true;
    const wait = setTimeout(async () => {
      const result = await searchAction(q, null).catch(() => null);
      if (!current) return;
      setSearchFailed(!result?.ok);
      setHits(result?.ok ? (result.value ?? []) : []);
    }, 300);
    return () => {
      current = false;
      clearTimeout(wait);
    };
  }, [q, needle]);

  const rows = snap.conversations.filter(
    (c) => needle === '' || c.name.toLowerCase().includes(needle) || (c.lastMessage?.preview ?? '').toLowerCase().includes(needle),
  );

  // ---- the thread ----------------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const scrolledFor = useRef<string | null>(null);
  const lastSeqSeen = useRef(0);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [reactFor, setReactFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<QuoteView | null>(null);
  const [withdrawing, setWithdrawing] = useState<MessageView | null>(null);

  const onScroll = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);

  const scrollToEnd = useCallback(() => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  // Scrolls the thread's own box, never the page behind it.
  const scrollToEl = useCallback((el: HTMLElement, align: 'start' | 'center') => {
    const box = scroller.current;
    if (!box) return;
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += align === 'center' ? delta - box.clientHeight / 2 + el.clientHeight / 2 : delta;
  }, []);

  const jump = useCallback(
    (messageId: string) => {
      const el = document.getElementById(`m-${messageId}`);
      if (el) scrollToEl(el, 'center');
    },
    [scrollToEl],
  );

  // A conversation opened: the first unread message, else the end.
  useEffect(() => {
    setReplyTo(null);
    setReactFor(null);
    scrolledFor.current = null;
    lastSeqSeen.current = 0;
  }, [openId]);

  const messageCount = thread?.messages.length ?? 0;
  const pendingHere = snap.pending.filter((p) => p.conversationId === openId);
  useLayoutEffect(() => {
    if (!thread || !openId) return;
    const box = scroller.current;
    if (!box) return;
    if (scrolledFor.current !== openId) {
      scrolledFor.current = openId;
      lastSeqSeen.current = thread.lastSeq;
      const firstUnseen = snap.firstUnseen[openId];
      const divider = firstUnseen ? document.getElementById('chat-unread-divider') : null;
      if (divider) scrollToEl(divider, 'start');
      else scrollToEnd();
      onScroll();
      return;
    }
    if (thread.lastSeq > lastSeqSeen.current || pendingHere.length > 0) {
      const mineLast = pendingHere.length > 0 || thread.messages.at(-1)?.mine;
      lastSeqSeen.current = thread.lastSeq;
      if (atBottomRef.current || mineLast) scrollToEnd();
    }
  }, [thread, openId, messageCount, pendingHere.length, snap.firstUnseen, scrollToEnd, scrollToEl, onScroll]);

  // Jumping to a message found by search or named in a quote.
  useEffect(() => {
    if (!jumpTo || !thread) return;
    if (document.getElementById(`m-${jumpTo}`)) {
      jump(jumpTo);
      setJumpTo(null);
    }
  }, [jumpTo, thread, messageCount, jump]);

  // Read on screen: the tab is in front, and the end of the conversation is in view.
  useEffect(() => {
    if (openId && thread && visible && atBottom) {
      setSeen({ id: openId, upTo: thread.lastSeq });
      markReadLocally(openId);
    } else {
      setSeen(null);
    }
  }, [openId, thread, visible, atBottom]);

  // ---- the composer --------------------------------------------------------
  const [text, setText] = useState(draft);
  const [files, setFiles] = useState<File[]>([]);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => clearTimeout(typingTimer.current), []);
  useEffect(() => {
    if (openId && draft && openId === initial.openId) box.current?.focus();
  }, [openId, draft, initial.openId]);

  const typed = (value: string) => {
    setText(value);
    clearTimeout(typingTimer.current);
    if (value.trim() === '') {
      setTyping(false);
      return;
    }
    setTyping(true);
    typingTimer.current = setTimeout(() => setTyping(false), TYPING_IDLE_MS);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!openId || !mayWrite) return;
    const body = text.trim();
    if (body === '' && files.length === 0) return;
    if (body.length > CHAT_MESSAGE_MAX_LENGTH) {
      setActionError(t('too_long', { max: CHAT_MESSAGE_MAX_LENGTH }));
      return;
    }
    setActionError(null);
    send({ conversationId: openId, body, files, replyTo });
    setText('');
    setFiles([]);
    setReplyTo(null);
    clearTimeout(typingTimer.current);
    setTyping(false);
    atBottomRef.current = true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const pickFiles = (picked: FileList | null) => {
    if (!picked) return;
    const next = [...files, ...Array.from(picked)];
    if (next.length > CHAT_MAX_FILES_PER_MESSAGE) setActionError(t('too_many_files', { max: CHAT_MAX_FILES_PER_MESSAGE }));
    setFiles(next.slice(0, CHAT_MAX_FILES_PER_MESSAGE));
  };

  // ---- actions on a message ------------------------------------------------
  const env: RowEnv = {
    locale,
    timeZone,
    now,
    mayWrite,
    reactFor,
    onReactMenu: setReactFor,
    onReact: async (messageId, reaction, on) => {
      const result = await reactAction(messageId, reaction, on);
      if (!result.ok) setActionError(result.error ?? t('failed'));
      pollNow();
    },
    onReply: (quote) => {
      setReplyTo(quote);
      box.current?.focus();
    },
    onWithdraw: setWithdrawing,
    onJump: (messageId) => {
      if (document.getElementById(`m-${messageId}`)) jump(messageId);
      else if (openId) {
        const target = thread?.messages.find((m) => m.replyTo?.id === messageId)?.replyTo;
        if (target && target.seq > 0) reach(openId, target.seq);
        setJumpTo(messageId);
      }
    },
  };

  const mute = async () => {
    if (!openId || !thread) return;
    const result = await muteAction(openId, !thread.muted);
    if (!result.ok) setActionError(result.error ?? t('failed'));
    pollNow();
  };

  const showAside = !(narrow && openId);
  const hasUnreadDivider = openId ? snap.firstUnseen[openId] : null;
  const typingNames = live?.typing ?? [];
  const direct = thread?.kind === 'direct' ? thread.members.find((m) => m.userId !== snap.me?.userId) : undefined;

  return (
    <>
      <Flash error={actionError} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {snap.status === 'retrying' ? (
        <p className={s.sapNote} role="status">
          {t('reconnecting')}
        </p>
      ) : null}
      {snap.status === 'signed_out' ? (
        <p className={s.sapNote} role="alert">
          <a href="/sign-in">{t('signed_out')}</a>
        </p>
      ) : null}
      {snap.closed && !openId ? (
        <p className={s.sapNote} role="status">
          {t('conversation_closed')}
        </p>
      ) : null}

      {record ? <RecordStarter record={record} /> : null}

      <div className={s.sapSplit}>
        {showAside ? (
          <aside aria-label={t('conversations')} className={s.sapSplitAside}>
            <section aria-labelledby="chat-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
              <div className={s.sapWindow}>
                <div className={s.sapTitle}>
                  <span id="chat-list-title">{t('conversations')}</span>
                  <span className={s.sapTitleActions}>
                    {snap.me ? (
                      <button
                        aria-pressed={snap.me.busy}
                        className={s.sapIconButton}
                        onClick={async () => {
                          const result = await busyAction(!snap.me!.busy);
                          if (!result.ok) setActionError(result.error ?? t('failed'));
                          pollNow();
                        }}
                        title={snap.me.busy ? t('busy_off_hint') : t('busy_on_hint')}
                        type="button"
                      >
                        <Ban aria-hidden="true" />
                        <span>{snap.me.busy ? t('busy_off') : t('busy_on')}</span>
                      </button>
                    ) : null}
                  </span>
                </div>

                <div className={s.toolbar}>
                  <form
                    className={s.toolbarSearch}
                    onSubmit={(event) => event.preventDefault()}
                    role="search"
                  >
                    <input
                      aria-label={t('search')}
                      onChange={(event) => setQ(event.target.value)}
                      placeholder={t('search_placeholder')}
                      type="search"
                      value={q}
                    />
                    <button aria-label={t('search')} type="submit">
                      <Search aria-hidden="true" />
                    </button>
                  </form>
                </div>

                <div className={`${s.sapTableWrap} ${s.sapAsideTableWrap}`}>
                  {rows.length === 0 && (hits === null || hits.length === 0) ? (
                    <div className={s.emptyState}>
                      <MessageSquare aria-hidden="true" />
                      <strong>{snap.loaded ? (needle ? t('no_match') : t('no_conversations')) : t('loading')}</strong>
                    </div>
                  ) : null}
                  {rows.length > 0 ? (
                    <table aria-labelledby="chat-list-title" className={cn(s.sapTable, s.sapRegisterTable, s.sapAsideTable, 'w-full')}>
                      <thead className="sr-only">
                        <tr>
                          <th scope="col">{t('col_conversation')}</th>
                          <th className={s.sapNum} scope="col">
                            {t('col_unread')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((c) => (
                          <ConversationItem
                            c={c}
                            key={c.id}
                            locale={locale}
                            meId={snap.me?.userId ?? ''}
                            now={now}
                            selected={c.id === openId}
                            timeZone={timeZone}
                          />
                        ))}
                      </tbody>
                    </table>
                  ) : null}

                  {hits !== null && hits.length > 0 ? (
                    <table aria-label={t('messages_found')} className={`${s.sapTable} ${s.sapRegisterTable} ${s.sapAsideTable}`}>
                      <thead>
                        <tr>
                          <th scope="col">{t('messages_found')}</th>
                          <th scope="col">{t('col_when')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hits.map((hit) => (
                          <tr key={hit.messageId}>
                            <td>
                              <a
                                href={`/chat?c=${hit.conversationId}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  openConversation(hit.conversationId);
                                  reach(hit.conversationId, hit.seq);
                                  setJumpTo(hit.messageId);
                                }}
                              >
                                <strong>
                                  <bdi dir="auto">{hit.conversationName}</bdi>
                                </strong>
                              </a>
                              <span className={s.sapNote}>
                                <bdi dir="auto">
                                  {clip(`${hit.mine ? t('you') : hit.senderName}: ${hit.snippet}`, 30)}
                                </bdi>
                              </span>
                            </td>
                            <td>{listStamp(hit.createdAt, now, locale, timeZone)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : null}
                  {searchFailed ? (
                    <p className={s.sapNote} role="alert">
                      {t('search_failed')}
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          </aside>
        ) : null}

        {narrow && !openId ? null : (
        <div className={s.sapSplitMain}>
          {openId && thread ? (
            <section aria-label={thread.name} className={s.sapDoc}>
              <div className={s.sapWindow}>
                <div className={s.sapTitle}>
                  <span>
                    {narrow ? (
                      <button
                        aria-label={t('back_to_list')}
                        className={s.sapIconButton}
                        onClick={() => openConversation(null)}
                        title={t('back_to_list')}
                        type="button"
                      >
                        <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
                      </button>
                    ) : null}{' '}
                    <bdi dir="auto">{thread.name}</bdi>{' '}
                    <span className={s.sapTitleMeta}>
                      {thread.kind === 'group' ? (
                        t('members_count', { count: thread.members.length })
                      ) : direct ? (
                        <PresencePill locale={locale} now={now} person={live?.members.find((m) => m.userId === direct.userId) ?? direct} timeZone={timeZone} />
                      ) : null}
                    </span>
                  </span>
                  <span className={s.sapTitleActions}>
                    <button
                      aria-label={thread.muted ? t('unmute') : t('mute')}
                      aria-pressed={thread.muted}
                      className={s.sapIconButton}
                      onClick={mute}
                      title={thread.muted ? t('unmute') : t('mute')}
                      type="button"
                    >
                      {thread.muted ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
                    </button>
                    <IconDialog
                      closeLabel={t('close')}
                      icon={<Users aria-hidden="true" />}
                      label={thread.kind === 'group' ? t('members') : t('details')}
                      title={thread.kind === 'group' ? t('members') : t('details')}
                    >
                      <ConversationInfo
                        locale={locale}
                        meId={snap.me?.userId ?? ''}
                        thread={{ ...thread, members: [...(live?.members ?? thread.members)] }}
                        timeZone={timeZone}
                      />
                    </IconDialog>
                  </span>
                </div>

                {thread.record ? (
                  <div className={cn(s.sapBody, 'px-5 py-2.5')}>
                    {thread.record.accessible ? (
                      <span className={cn(s.sapNote, 'inline-flex flex-wrap items-center gap-1')}>
                        <Link2 aria-hidden="true" size={12} /> {t('about_record')}:{' '}
                        {thread.record.href ? (
                          <a className={s.sapLink} href={thread.record.href}>
                            <bdi dir="auto">{thread.record.label}</bdi>
                          </a>
                        ) : (
                          <bdi dir="auto">{thread.record.label}</bdi>
                        )}
                      </span>
                    ) : (
                      <span className={s.sapNote}>{t('record_hidden')}</span>
                    )}
                  </div>
                ) : null}

                <div
                  className={cn(s.sapTableWrap, s.sapRegisterTableWrap, 'h-[min(40rem,62vh)] rounded-none border-x-0 border-b-0 bg-muted/40')}
                  onScroll={onScroll}
                  ref={scroller}
                >
                  <div className={cn(s.sapBody, 'px-3 py-4 sm:px-5')}>
                    {thread.hasMore ? (
                      <p className="mb-4 flex justify-center">
                        <button
                          className={cn(s.sapIconButton, 'h-8 min-h-8 rounded-full border-border bg-overlay px-3 text-xs text-fg shadow-xs')}
                          onClick={async () => {
                            const before = scroller.current?.scrollHeight ?? 0;
                            const ok = await loadEarlier(thread.id);
                            if (!ok) setActionError(t('failed'));
                            requestAnimationFrame(() => {
                              const el = scroller.current;
                              if (el) el.scrollTop += el.scrollHeight - before;
                            });
                          }}
                          type="button"
                        >
                          {t('load_earlier')}
                        </button>
                      </p>
                    ) : null}
                    {thread.messages.length === 0 && pendingHere.length === 0 ? (
                      <div className={s.emptyState}>
                        <MessageSquare aria-hidden="true" />
                        <strong>{t('say_hello')}</strong>
                      </div>
                    ) : (
                      <ul aria-label={t('messages')} aria-live="polite" className="m-0 flex list-none flex-col gap-4 p-0">
                        {thread.messages.map((message) => (
                          <MessageItem
                            dividerAt={hasUnreadDivider ?? null}
                            env={env}
                            key={message.id}
                            message={message}
                          />
                        ))}
                        {pendingHere.map((pending) => (
                          <PendingRow env={env} key={pending.clientId} onDiscard={discard} onRetry={retry} pending={pending} />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div className={cn(s.sapBody, 'border-t border-border px-3 pb-4 pt-2 sm:px-5')}>
                  {typingNames.length > 0 ? (
                    <p className={cn(s.sapNote, 'mb-1.5 px-1 italic')} role="status">
                      {typingNames.length === 1 ? t('typing_one', { name: typingNames[0]! }) : t('typing_many', { names: typingNames.join(', ') })}
                    </p>
                  ) : null}

                  {mayWrite ? (
                    <form className="flex flex-col gap-2" onSubmit={submit}>
                      {replyTo ? (
                        <div className="flex items-center gap-2 rounded-lg border-s-2 border-primary bg-muted py-1 pe-1 ps-3">
                          <span className={cn(s.sapNote, 'min-w-0 flex-1 truncate')}>
                            {t('replying_to')} <bdi dir="auto">{replyTo.senderName}</bdi>: <bdi dir="auto">{replyTo.preview}</bdi>
                          </span>
                          <button
                            aria-label={t('cancel')}
                            className={cn(s.sapIconButton, 'size-7 min-h-7 min-w-7 rounded-full p-0')}
                            onClick={() => setReplyTo(null)}
                            title={t('cancel')}
                            type="button"
                          >
                            <X aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}
                      {/* One rounded box: the text, the files picked, then the buttons. */}
                      <div className="rounded-xl border border-input bg-[var(--w-field,var(--ui-bg))] shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-4 focus-within:ring-ring/20">
                      <textarea
                        aria-label={t('message')}
                        className="block min-h-14 w-full resize-none rounded-xl border-0 bg-transparent px-3.5 pb-1 pt-3 shadow-none hover:border-0 focus:border-0 focus:bg-transparent focus:shadow-none"
                        maxLength={CHAT_MESSAGE_MAX_LENGTH}
                        onBlur={() => {
                          clearTimeout(typingTimer.current);
                          setTyping(false);
                        }}
                        onChange={(event) => typed(event.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={t('message_placeholder')}
                        ref={box}
                        rows={2}
                        value={text}
                      />
                      {files.length > 0 ? (
                        <ul className={cn(s.fileList, 'mx-3 mb-1 mt-0')}>
                          {files.map((file, index) => (
                            <li key={`${file.name}-${index}`}>
                              <span className={s.fileIcon}>
                                <Paperclip aria-hidden="true" />
                              </span>
                              <span className={s.fileBody}>
                                <bdi dir="auto">{file.name}</bdi>
                              </span>
                              <button
                                aria-label={`${t('remove_file')}: ${file.name}`}
                                className={s.sapIconButton}
                                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                                title={t('remove_file')}
                                type="button"
                              >
                                <X aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <div className={cn(s.sapEntryBar, 'm-0 gap-2 px-2 pb-2')}>
                        <label
                          className={cn(
                            s.uploadPicker,
                            'order-0 h-8 rounded-lg border-0 bg-transparent px-2.5 py-0 text-sm font-medium text-muted-fg hover:bg-secondary hover:text-fg focus-within:outline-2 focus-within:outline-ring',
                          )}
                        >
                          <Paperclip aria-hidden="true" />
                          <span>{t('attach')}</span>
                          <input
                            className="sr-only"
                            multiple
                            onChange={(event) => {
                              pickFiles(event.target.files);
                              event.target.value = '';
                            }}
                            type="file"
                          />
                        </label>
                        <button className={cn(s.primary, 'order-2 h-8 min-h-8 rounded-lg px-3')} type="submit">
                          <SendHorizontal aria-hidden="true" className="rtl:-scale-x-100" />
                          <span>{t('send')}</span>
                        </button>
                        <span className={cn(s.sapNote, 'order-1 me-auto hidden min-w-0 truncate sm:inline')}>{t('composer_hint')}</span>
                      </div>
                      </div>
                    </form>
                  ) : (
                    <p className={s.sapNote}>{t('read_only')}</p>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <section aria-label={t('conversation')} className={s.sapDoc}>
              <div className={s.sapWindow}>
                <div className={s.sapTitle}>
                  <span>{openId ? t('loading') : t('no_conversation_open')}</span>
                </div>
                <div className={s.sapBody}>
                  <div className={s.emptyState}>
                    <MessageSquare aria-hidden="true" />
                    <strong>{openId ? t('loading') : t('pick_conversation')}</strong>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
        )}
      </div>

      <ChatDialog closeLabel={t('close')} onClose={() => setWithdrawing(null)} open={withdrawing !== null} title={t('withdraw_title')}>
        {withdrawing ? (
          <Form
            action={async (form) => {
              const result = await retractAction(withdrawing.id, String(form.get('reason') ?? ''));
              if (result.ok) {
                setActionError(null);
                setWithdrawing(null);
                pollNow();
              } else {
                setActionError(result.error ?? t('failed'));
              }
            }}
          >
            <p className={s.hint}>{t('withdraw_hint')}</p>
            <Grid>
              <Field label={t('withdraw_reason')} maxLength={200} name="reason" required requiredLabel={t('required')} />
            </Grid>
            <SubmitRow>
              <Submit label={t('withdraw')} tone="danger" />
            </SubmitRow>
          </Form>
        ) : null}
      </ChatDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function MessageItem({ message, env, dividerAt }: { readonly message: MessageView; readonly env: RowEnv; readonly dividerAt: number | null }) {
  const t = useTranslations('chat');
  const quote: QuoteView = {
    id: message.id,
    seq: message.seq,
    senderName: message.senderName,
    preview: previewOf(message.body, 140),
    retracted: Boolean(message.retracted),
    available: true,
  };
  return (
    <>
      {dividerAt !== null && message.seq === dividerAt ? (
        <li className="flex items-center gap-3" id="chat-unread-divider">
          <span aria-hidden="true" className="h-px flex-1 bg-primary/40" />
          <div className="text-xs text-primary-subtle-fg">
            <strong className="font-semibold">{t('unread_from_here')}</strong>
          </div>
          <span aria-hidden="true" className="h-px flex-1 bg-primary/40" />
        </li>
      ) : null}
      {message.kind === 'system' ? <SystemRow env={env} message={message} /> : <MessageRow env={env} message={message} quoteOf={quote} />}
    </>
  );
}

function ConversationItem({
  c,
  selected,
  meId,
  locale,
  timeZone,
  now,
}: {
  readonly c: ConversationRow;
  readonly selected: boolean;
  readonly meId: string;
  readonly locale: string;
  readonly timeZone: string;
  readonly now: Date;
}) {
  const t = useTranslations('chat');
  const last = c.lastMessage;
  let line = '';
  if (last) {
    if (last.kind === 'system') line = t(`system_short.${last.preview}` as never);
    else if (last.retracted) line = t('retracted_short');
    else {
      const who = last.senderId === meId ? t('you') : c.kind === 'group' ? last.senderName : '';
      const body = last.preview || (last.fileCount > 0 ? t('sent_file') : '');
      line = who ? `${who}: ${body}` : body;
    }
  }
  // A messenger's row: the round avatar, the name with what is known about it, the last line under it;
  // the whole row opens the conversation (the link is stretched over its cell), the open one in the accent's tint.
  const cell = selected ? 'bg-primary-subtle' : '';
  return (
    <tr aria-current={selected ? 'true' : undefined} className="[&>td]:border-border">
      <td className={cn('relative w-full max-w-0 py-2.5 ps-4', cell)}>
        <div className="flex min-w-0 items-center gap-1.5">
          <a
            className="flex min-w-0 items-center gap-3 text-fg no-underline after:absolute after:inset-0 after:content-[''] hover:text-fg"
            href={`/chat?c=${c.id}`}
            onClick={(event) => {
              event.preventDefault();
              openConversation(c.id);
            }}
          >
            <span className={cn(s.avatarSmall, AVATAR_CLASS, 'size-9 text-xs')}>
              {c.kind === 'group' ? <Users aria-hidden="true" size={14} /> : initials(c.name)}
            </span>
            <strong className={cn('truncate text-sm', selected || c.unread > 0 ? 'font-semibold' : 'font-medium')} title={c.name}>
              <bdi dir="auto">{clip(c.name, 18)}</bdi>
            </strong>
          </a>
          {c.other && c.other.presence !== 'offline' ? (
            <PresencePill locale={locale} now={now} person={c.other} showLastSeen={false} timeZone={timeZone} />
          ) : null}
          {c.muted ? <BellOff aria-label={t('muted')} className="shrink-0 text-muted-fg" size={12} /> : null}
          {c.aboutRecord ? <Link2 aria-label={t('about_record')} className="shrink-0 text-muted-fg" size={12} /> : null}
        </div>
        {line || c.lastMessageAt ? (
          <span className={cn(s.sapNote, 'block truncate ps-12', c.unread > 0 ? 'text-fg' : '')} title={line}>
            {line ? <bdi dir="auto">{clip(line, 22)}</bdi> : null}
            {line && c.lastMessageAt ? ' · ' : ''}
            {c.lastMessageAt ? <span className="tabular-nums">{listStamp(c.lastMessageAt, now, locale, timeZone)}</span> : ''}
          </span>
        ) : null}
      </td>
      <td className={cn(s.sapNum, 'w-px whitespace-nowrap pe-4 ps-1 align-middle', cell)}>
        {c.unread > 0 ? (
          <span aria-label={t('unread_count', { count: c.unread })} className={cn(s.sapIconCount, 'min-h-5 min-w-5 rounded-full px-1.5 tabular-nums')}>
            {c.mentioned ? `@${c.unread}` : c.unread}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** "Discuss this record": reached with `/chat?record=type:id`, from another module's screen. */
function RecordStarter({ record }: { readonly record: RecordIntent }) {
  const t = useTranslations('chat');
  const [chosen, setChosen] = useState<{ userId: string; name: string; email: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  return (
    <section aria-labelledby="chat-record-title" className={s.sapDoc}>
      <div className={s.sapWindow}>
        <div className={s.sapTitle}>
          <span id="chat-record-title">
            {record.accessible ? t('record_start_title', { label: record.label ?? record.id }) : t('record_start_denied_title')}
          </span>
        </div>
        <div className={s.sapBody}>
          {!record.accessible ? (
            <p className={s.sapNote} role="alert">
              {t('record_start_denied')}
            </p>
          ) : (
            <>
              {record.existing.length > 0 ? (
                <ul className={s.fileList}>
                  {record.existing.map((c) => (
                    <li key={c.id}>
                      <span className={s.fileBody}>
                        <a
                          href={`/chat?c=${c.id}`}
                          onClick={(event) => {
                            event.preventDefault();
                            openConversation(c.id);
                          }}
                        >
                          <bdi dir="auto">{c.name}</bdi>
                        </a>
                        <span className={s.fileMeta}>{t('record_existing')}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Form
                action={async (form) => {
                  const result = await openRecordAction({
                    recordType: record.type,
                    recordId: record.id,
                    label: record.label,
                    href: record.href,
                    memberIds: chosen.map((p) => p.userId),
                    title: String(form.get('title') ?? '') || null,
                  });
                  if (result.ok && result.value) {
                    setError(null);
                    openConversation(result.value.id);
                  } else {
                    setError(result.error ?? t('failed'));
                  }
                }}
              >
                {chosen.length > 1 ? (
                  <Grid>
                    <Field label={t('group_name')} maxLength={80} name="title" />
                  </Grid>
                ) : null}
                {chosen.length > 0 ? <p className={s.hint}>{chosen.map((p) => p.name).join(', ')}</p> : null}
                <PeoplePicker
                  chosen={chosen}
                  mode="many"
                  onChoose={(person) => setChosen((current) => (current.some((p) => p.userId === person.userId) ? current : [...current, person]))}
                />
                {error ? (
                  <p className={s.hint} role="alert">
                    {error}
                  </p>
                ) : null}
                <SubmitRow>
                  <Submit label={t('record_start')} />
                </SubmitRow>
              </Form>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
