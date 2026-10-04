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
    <li id={`m-${message.id}`}>
      <span className={s.timelineWhen}>{stamp(message.createdAt, env)}</span>
      <div className={s.sapNote}>
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
    <span className={s.sapNote} title={detail} data-status={status.state}>
      <Icon aria-hidden="true" size={13} />{' '}
      {t(`status.${status.state}`)}
      {group && status.state !== 'sent' ? ` ${count}/${status.total}` : ''}
    </span>
  );
}

function FileRow({ file }: { readonly file: FileView }) {
  const t = useTranslations('chat');
  const open = `/chat/files/${file.id}${file.kind === 'file' ? '' : '?inline=1'}`;
  const Icon = file.kind === 'image' ? ImageIcon : FileText;
  return (
    <li>
      <span className={s.fileIcon}>
        <Icon aria-hidden="true" />
      </span>
      <span className={s.fileBody}>
        <a href={open} rel="noreferrer" target={file.kind === 'file' ? undefined : '_blank'}>
          <bdi dir="auto">{file.fileName}</bdi>
        </a>
        <span className={s.fileMeta}>
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

  return (
    <li id={`m-${message.id}`} data-mine={message.mine ? 'true' : undefined}>
      <span className={s.timelineWhen} title={dateTimeOf(message.createdAt, env.locale, env.timeZone)}>
        {stamp(message.createdAt, env)}
      </span>
      <div>
        <div className={s.sapTitleActions}>
          <strong className={s.timelineAction}>
            <bdi dir="auto">{message.mine ? ownName : message.senderName}</bdi>
          </strong>
          {message.mentionsMe && !message.mine ? <span className={s.sapIconCount}>@</span> : null}
          {message.mine ? <StatusMark message={message} /> : null}
          {message.retracted || !env.mayWrite ? null : (
            <>
              <button
                aria-expanded={picking}
                aria-label={t('react')}
                className={s.sapIconButton}
                onClick={() => env.onReactMenu(picking ? null : message.id)}
                title={t('react')}
                type="button"
              >
                <SmilePlus aria-hidden="true" />
              </button>
              <button aria-label={t('reply')} className={s.sapIconButton} onClick={() => env.onReply(quoteOf)} title={t('reply')} type="button">
                <CornerUpLeft aria-hidden="true" />
              </button>
              {message.mine ? (
                <button aria-label={t('withdraw')} className={s.sapIconButton} onClick={() => env.onWithdraw(message)} title={t('withdraw')} type="button">
                  <Trash2 aria-hidden="true" />
                </button>
              ) : null}
            </>
          )}
        </div>

        {message.replyTo ? (
          <a
            className={s.sapNote}
            href={`#m-${message.replyTo.id}`}
            onClick={(event) => {
              event.preventDefault();
              env.onJump(message.replyTo!.id);
            }}
          >
            <CornerUpLeft aria-hidden="true" size={12} />{' '}
            {message.replyTo.available ? (
              message.replyTo.retracted ? (
                t('quote_withdrawn')
              ) : (
                <>
                  <bdi dir="auto">{message.replyTo.senderName}</bdi>: <bdi dir="auto">{message.replyTo.preview}</bdi>
                </>
              )
            ) : (
              t('quote_unavailable')
            )}
          </a>
        ) : null}

        {message.retracted ? (
          <div className={s.sapNote}>
            <Undo2 aria-hidden="true" size={12} />{' '}
            {t('retracted', { name: message.retracted.byName })}
            {message.retracted.reason ? ` — ${message.retracted.reason}` : ''}
          </div>
        ) : (
          <div dir="auto">{renderBody(message.body, message.mentionNames)}</div>
        )}

        {images.map((file) => (
          <a href={`/chat/files/${file.id}?inline=1`} key={file.id} rel="noreferrer" target="_blank">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt={file.fileName} loading="lazy" src={`/chat/files/${file.id}?inline=1`} width={240} />
          </a>
        ))}
        {message.files.length > 0 ? (
          <ul className={s.fileList}>
            {message.files.map((file) => (
              <FileRow file={file} key={file.id} />
            ))}
          </ul>
        ) : null}

        {picking ? (
          <div className={s.sapTitleActions}>
            {CHAT_REACTIONS.map((code) => {
              const Icon = REACTION_ICON[code];
              const mine = message.reactions.find((r) => r.reaction === code)?.mine ?? false;
              return (
                <button
                  aria-label={t(`reaction.${code}`)}
                  aria-pressed={mine}
                  className={s.sapIconButton}
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
          <div className={s.sapTitleActions}>
            {message.reactions.map((reaction) => {
              const code = reaction.reaction as (typeof CHAT_REACTIONS)[number];
              const Icon = REACTION_ICON[code] ?? SmilePlus;
              return (
                <button
                  aria-label={`${t(`reaction.${code}`)}: ${reaction.names.join(', ')}`}
                  aria-pressed={reaction.mine}
                  className={s.sapIconButton}
                  disabled={!env.mayWrite}
                  key={reaction.reaction}
                  onClick={() => env.onReact(message.id, reaction.reaction, !reaction.mine)}
                  title={reaction.names.join(', ')}
                  type="button"
                >
                  <Icon aria-hidden="true" />
                  <span className={reaction.mine ? s.sapIconCount : undefined}>{reaction.count}</span>
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
    <li data-pending={pending.state}>
      <span className={s.timelineWhen}>{timeOf(pending.createdAt, env.locale, env.timeZone)}</span>
      <div>
        <div className={s.sapTitleActions}>
          <strong className={s.timelineAction}>{t('you')}</strong>
          <span className={s.sapNote} data-status={pending.state}>
            <Icon aria-hidden="true" size={13} /> {t(`status.${pending.state === 'failed' ? 'failed' : pending.state}`)}
          </span>
          {failed ? (
            <>
              <button aria-label={t('retry')} className={s.sapIconButton} onClick={() => onRetry(pending.clientId)} title={t('retry')} type="button">
                <RotateCcw aria-hidden="true" />
              </button>
              <button aria-label={t('discard')} className={s.sapIconButton} onClick={() => onDiscard(pending.clientId)} title={t('discard')} type="button">
                <Trash2 aria-hidden="true" />
              </button>
            </>
          ) : null}
        </div>
        {pending.replyTo ? (
          <div className={s.sapNote}>
            <CornerUpLeft aria-hidden="true" size={12} /> <bdi dir="auto">{pending.replyTo.senderName}</bdi>: <bdi dir="auto">{pending.replyTo.preview}</bdi>
          </div>
        ) : null}
        {pending.body ? <div dir="auto">{renderBody(pending.body, [])}</div> : null}
        {pending.fileNames.length > 0 ? (
          <ul className={s.fileList}>
            {pending.fileNames.map((name, index) => (
              <li key={`${name}-${index}`}>
                <span className={s.fileIcon}>
                  <FileText aria-hidden="true" />
                </span>
                <span className={s.fileBody}>
                  <bdi dir="auto">{name}</bdi>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {failed && pending.error ? (
          <div className={s.sapNote} role="alert">
            {pending.error}
          </div>
        ) : null}
      </div>
    </li>
  );
}

