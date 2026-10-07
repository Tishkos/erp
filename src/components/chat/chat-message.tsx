'use client';

import { useTranslations } from 'next-intl';
import {
  Check,
  CheckCheck,
  Clock,
  CircleCheck,
  CornerUpLeft,
  Download,
  Eye,
  FileText,
  HandHeart,
  Heart,
  Image as ImageIcon,
  Laugh,
  RotateCcw,
  SmilePlus,
  ThumbsUp,
  Trash2,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { admin as s } from '@/components/admin';
import { cn } from '@/components/intent/cn';
import { CHAT_REACTIONS, sizeText } from '@domain/chat';
import type { FileView, MessageView, QuoteView } from '@/server/services/chat-read';
import type { PendingMessage } from './chat-store';
import { dateTimeOf, dayKey, renderBody, timeOf } from './format';

const REACTION_ICON: Record<(typeof CHAT_REACTIONS)[number], LucideIcon> = {
  like: ThumbsUp,
  love: Heart,
  laugh: Laugh,
  thanks: HandHeart,
  done: CircleCheck,
  eyes: Eye,
};

/*
 * The messenger's look (the Intent UI redesign, 2026-10-06): a message is a
 * bubble — one's own at the end of the line in the accent, everybody else's
 * at the start in the secondary fill — with the name, the time and the
 * receipt above it in small muted type. The message's own buttons (react,
 * reply, withdraw) wait beside the name and come forward when the message is
 * pointed at or focused; on a touch screen, where nothing is pointed at, they
 * stay in view.
 */
const META = 'flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-fg';
const ACTION =
  'size-7 min-h-7 min-w-7 rounded-full p-0 text-muted-fg transition-opacity [&_svg]:size-3.5 pointer-fine:opacity-0 pointer-fine:group-hover/msg:opacity-100 pointer-fine:group-focus-within/msg:opacity-100 pointer-fine:aria-expanded:opacity-100';
const BUBBLE = 'max-w-full rounded-2xl px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]';
const MINE = 'rounded-se-md bg-primary text-primary-fg [&_a]:text-primary-fg [&_a]:underline [&_a]:underline-offset-2';
const THEIRS =
  'rounded-ss-md bg-secondary text-secondary-fg [&_a]:text-primary-subtle-fg [&_a]:underline [&_a]:underline-offset-2';
const QUOTE =
  'inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border-s-2 border-primary bg-muted px-2.5 py-1 text-xs text-muted-fg no-underline hover:text-fg [&_svg]:shrink-0';
const FILES = 'm-0 w-full min-w-0 max-w-sm rounded-xl border border-border bg-overlay px-3 py-0.5 shadow-xs';

export interface RowEnv {
  readonly locale: string;
  readonly timeZone: string;
  readonly now: Date;
  readonly mayWrite: boolean;
  readonly reactFor: string | null;
  readonly onReactMenu: (messageId: string | null) => void;
  readonly onReact: (messageId: string, reaction: string, on: boolean) => void;
  readonly onReply: (quote: QuoteView) => void;
  readonly onWithdraw: (message: MessageView) => void;
  readonly onJump: (messageId: string) => void;
}

/** How long ago, in words the time column can hold: the time today, the date and time before. */
function stamp(iso: string, env: RowEnv): string {
  const sameDay = dayKey(iso, env.timeZone) === dayKey(env.now.toISOString(), env.timeZone);
  return sameDay ? timeOf(iso, env.locale, env.timeZone) : dateTimeOf(iso, env.locale, env.timeZone);
}

// ---------------------------------------------------------------------------
// A line the system wrote
// ---------------------------------------------------------------------------

export function SystemRow({ message, env }: { readonly message: MessageView; readonly env: RowEnv }) {
  const t = useTranslations('chat');
  const meta = (message.meta ?? {}) as { names?: string[]; title?: string };
  const names = (meta.names ?? []).join(', ');
  const known = ['created', 'added', 'removed', 'left', 'renamed'].includes(message.body);
  return (
    <li className="flex justify-center" id={`m-${message.id}`}>
      <div className="max-w-full rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-fg">
        <span className="tabular-nums">{stamp(message.createdAt, env)}</span>{' '}
        {known ? t(`system.${message.body}`, { actor: message.senderName, names, title: meta.title ?? '' }) : ''}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// A message a person wrote
// ---------------------------------------------------------------------------

function StatusMark({ message }: { readonly message: MessageView }) {
  const t = useTranslations('chat');
  const status = message.status;
  if (!status) return null;
  const Icon = status.state === 'seen' ? Eye : status.state === 'delivered' ? CheckCheck : Check;
  const group = status.total > 1;
  const count = status.state === 'seen' ? status.seen : status.delivered;
  const detail = message.receipts
    .map((r) => `${r.name}: ${r.seenAt ? t('status.seen') : r.deliveredAt ? t('status.delivered') : t('status.sent')}`)
    .join('\n');
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-fg data-[status=seen]:text-primary-subtle-fg"
      data-status={status.state}
      title={detail}
    >
      <Icon aria-hidden="true" size={13} /> {t(`status.${status.state}`)}
      {group && status.state !== 'sent' ? ` ${count}/${status.total}` : ''}
    </span>
  );
}

function FileRow({ file }: { readonly file: FileView }) {
  const t = useTranslations('chat');
  const open = `/chat/files/${file.id}${file.kind === 'file' ? '' : '?inline=1'}`;
  const Icon = file.kind === 'image' ? ImageIcon : FileText;
  return (
    <li className="last:border-b-0">
      <span className={s.fileIcon}>
        <Icon aria-hidden="true" />
      </span>
      <span className={cn(s.fileBody, 'min-w-0')}>
        <a className="truncate" href={open} rel="noreferrer" target={file.kind === 'file' ? undefined : '_blank'}>
          <bdi dir="auto">{file.fileName}</bdi>
        </a>
        <span className={cn(s.fileMeta, 'truncate')}>
          {sizeText(file.sizeBytes)} · {file.contentType}
        </span>
      </span>
      {file.kind === 'file' ? null : (
        <a aria-label={`${t('download')}: ${file.fileName}`} className={s.sapIconButton} href={`/chat/files/${file.id}`} title={t('download')}>
          <Download aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

export function MessageRow({ message, env, quoteOf }: { readonly message: MessageView; readonly env: RowEnv; readonly quoteOf: QuoteView }) {
  const t = useTranslations('chat');
  const images = message.files.filter((f) => f.kind === 'image');
  const picking = env.reactFor === message.id;
  const ownName = t('you');
  const side = message.mine ? 'items-end' : 'items-start';

  return (
    <li className={cn('group/msg flex flex-col', side)} data-mine={message.mine ? 'true' : undefined} id={`m-${message.id}`}>
      <div className={cn('flex min-w-0 max-w-[min(40rem,88%)] flex-col gap-1', side)}>
        <div className={cn(META, message.mine ? 'justify-end' : 'justify-start')}>
          <strong className="text-xs font-semibold text-fg">
            <bdi dir="auto">{message.mine ? ownName : message.senderName}</bdi>
          </strong>
          <span className="tabular-nums" title={dateTimeOf(message.createdAt, env.locale, env.timeZone)}>
            {stamp(message.createdAt, env)}
          </span>
          {message.mentionsMe && !message.mine ? <span className={cn(s.sapIconCount, 'rounded-full')}>@</span> : null}
          {message.mine ? <StatusMark message={message} /> : null}
          {message.retracted || !env.mayWrite ? null : (
            <span className="inline-flex items-center gap-0.5">
              <button
                aria-expanded={picking}
                aria-label={t('react')}
                className={cn(s.sapIconButton, ACTION)}
                onClick={() => env.onReactMenu(picking ? null : message.id)}
                title={t('react')}
                type="button"
              >
                <SmilePlus aria-hidden="true" />
              </button>
              <button aria-label={t('reply')} className={cn(s.sapIconButton, ACTION)} onClick={() => env.onReply(quoteOf)} title={t('reply')} type="button">
                <CornerUpLeft aria-hidden="true" className="rtl:-scale-x-100" />
              </button>
              {message.mine ? (
                <button aria-label={t('withdraw')} className={cn(s.sapIconButton, ACTION)} onClick={() => env.onWithdraw(message)} title={t('withdraw')} type="button">
                  <Trash2 aria-hidden="true" />
                </button>
              ) : null}
            </span>
          )}
        </div>

        {message.replyTo ? (
          <a
            className={QUOTE}
            href={`#m-${message.replyTo.id}`}
            onClick={(event) => {
              event.preventDefault();
              env.onJump(message.replyTo!.id);
            }}
          >
            <CornerUpLeft aria-hidden="true" size={12} className="rtl:-scale-x-100" />{' '}
            {message.replyTo.available ? (
              message.replyTo.retracted ? (
                t('quote_withdrawn')
              ) : (
                <span className="truncate">
                  <bdi dir="auto">{message.replyTo.senderName}</bdi>: <bdi dir="auto">{message.replyTo.preview}</bdi>
                </span>
              )
            ) : (
              t('quote_unavailable')
            )}
          </a>
        ) : null}

        {message.retracted ? (
          <div className="inline-flex max-w-full items-center gap-1.5 rounded-2xl border border-dashed border-input px-3.5 py-2 text-sm italic text-muted-fg">
            <Undo2 aria-hidden="true" className="shrink-0" size={13} />
            <span>
              {t('retracted', { name: message.retracted.byName })}
              {message.retracted.reason ? ` — ${message.retracted.reason}` : ''}
            </span>
          </div>
        ) : message.body ? (
          <div className={cn(BUBBLE, message.mine ? MINE : THEIRS)} dir="auto">
            {renderBody(message.body, message.mentionNames)}
          </div>
        ) : null}

        {images.length > 0 ? (
          <div className={cn('flex flex-wrap gap-2', message.mine ? 'justify-end' : 'justify-start')}>
            {images.map((file) => (
              <a className="block overflow-hidden rounded-xl border border-border bg-muted" href={`/chat/files/${file.id}?inline=1`} key={file.id} rel="noreferrer" target="_blank">
                {/* A box of its own while the picture is still on its way, so the message does not jump, and the picture is there to point at. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={file.fileName} className="block h-auto min-h-16 min-w-16 max-h-64 w-auto max-w-60 object-cover" loading="lazy" src={`/chat/files/${file.id}?inline=1`} width={240} />
              </a>
            ))}
          </div>
        ) : null}
        {message.files.length > 0 ? (
          <ul className={cn(s.fileList, FILES)}>
            {message.files.map((file) => (
              <FileRow file={file} key={file.id} />
            ))}
          </ul>
        ) : null}

        {picking ? (
          <div className="flex flex-wrap items-center gap-0.5 rounded-full border border-border bg-overlay p-1 shadow-lg">
            {CHAT_REACTIONS.map((code) => {
              const Icon = REACTION_ICON[code];
              const mine = message.reactions.find((r) => r.reaction === code)?.mine ?? false;
              return (
                <button
                  aria-label={t(`reaction.${code}`)}
                  aria-pressed={mine}
                  className={cn(
                    s.sapIconButton,
                    'size-8 min-h-8 min-w-8 rounded-full p-0 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-fg',
                  )}
                  key={code}
                  onClick={() => {
                    env.onReact(message.id, code, !mine);
                    env.onReactMenu(null);
                  }}
                  title={t(`reaction.${code}`)}
                  type="button"
                >
                  <Icon aria-hidden="true" />
                </button>
              );
            })}
          </div>
        ) : null}
        {message.reactions.length > 0 ? (
          <div className={cn('flex flex-wrap gap-1', message.mine ? 'justify-end' : 'justify-start')}>
            {message.reactions.map((reaction) => {
              const code = reaction.reaction as (typeof CHAT_REACTIONS)[number];
              const Icon = REACTION_ICON[code] ?? SmilePlus;
              return (
                <button
                  aria-label={`${t(`reaction.${code}`)}: ${reaction.names.join(', ')}`}
                  aria-pressed={reaction.mine}
                  className={cn(
                    s.sapIconButton,
                    'h-7 min-h-7 min-w-0 gap-1 rounded-full border-border bg-overlay px-2 text-xs font-medium text-fg tabular-nums [&_svg]:size-3.5',
                    'aria-pressed:border-primary/40 aria-pressed:bg-primary-subtle aria-pressed:text-primary-subtle-fg',
                  )}
                  disabled={!env.mayWrite}
                  key={reaction.reaction}
                  onClick={() => env.onReact(message.id, reaction.reaction, !reaction.mine)}
                  title={reaction.names.join(', ')}
                  type="button"
                >
                  <Icon aria-hidden="true" />
                  <span>{reaction.count}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// A message on its way
// ---------------------------------------------------------------------------

export function PendingRow({
  pending,
  env,
  onRetry,
  onDiscard,
}: {
  readonly pending: PendingMessage;
  readonly env: RowEnv;
  readonly onRetry: (clientId: string) => void;
  readonly onDiscard: (clientId: string) => void;
}) {
  const t = useTranslations('chat');
  const failed = pending.state === 'failed';
  const Icon = failed ? TriangleAlert : pending.state === 'sent' ? Check : Clock;
  return (
    <li className="flex flex-col items-end" data-pending={pending.state}>
      <div className="flex min-w-0 max-w-[min(40rem,88%)] flex-col items-end gap-1">
        <div className={cn(META, 'justify-end')}>
          <strong className="text-xs font-semibold text-fg">{t('you')}</strong>
          <span className="tabular-nums">{timeOf(pending.createdAt, env.locale, env.timeZone)}</span>
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-fg data-[status=failed]:text-danger-subtle-fg"
            data-status={pending.state}
          >
            <Icon aria-hidden="true" size={13} /> {t(`status.${pending.state === 'failed' ? 'failed' : pending.state}`)}
          </span>
          {failed ? (
            <span className="inline-flex items-center gap-0.5">
              <button aria-label={t('retry')} className={cn(s.sapIconButton, 'size-7 min-h-7 min-w-7 rounded-full p-0 [&_svg]:size-3.5')} onClick={() => onRetry(pending.clientId)} title={t('retry')} type="button">
                <RotateCcw aria-hidden="true" />
              </button>
              <button aria-label={t('discard')} className={cn(s.sapIconButton, 'size-7 min-h-7 min-w-7 rounded-full p-0 [&_svg]:size-3.5')} onClick={() => onDiscard(pending.clientId)} title={t('discard')} type="button">
                <Trash2 aria-hidden="true" />
              </button>
            </span>
          ) : null}
        </div>
        {pending.replyTo ? (
          <div className={QUOTE}>
            <CornerUpLeft aria-hidden="true" size={12} className="rtl:-scale-x-100" />{' '}
            <span className="truncate">
              <bdi dir="auto">{pending.replyTo.senderName}</bdi>: <bdi dir="auto">{pending.replyTo.preview}</bdi>
            </span>
          </div>
        ) : null}
        {pending.body ? (
          <div
            className={cn(BUBBLE, MINE, failed ? 'opacity-100 ring-2 ring-danger/60' : 'opacity-75')}
            dir="auto"
          >
            {renderBody(pending.body, [])}
          </div>
        ) : null}
        {pending.fileNames.length > 0 ? (
          <ul className={cn(s.fileList, FILES)}>
            {pending.fileNames.map((name, index) => (
              <li className="last:border-b-0" key={`${name}-${index}`}>
                <span className={s.fileIcon}>
                  <FileText aria-hidden="true" />
                </span>
                <span className={cn(s.fileBody, 'min-w-0')}>
                  <bdi className="truncate" dir="auto">{name}</bdi>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {failed && pending.error ? (
          <div className="rounded-lg bg-danger-subtle px-2.5 py-1 text-xs text-danger-subtle-fg" role="alert">
            {pending.error}
          </div>
        ) : null}
      </div>
    </li>
  );
}
