'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Mail } from 'lucide-react';
import { badgeText } from '@domain/chat';
import { mount, useChat } from './chat-store';

/**
 * The chat's three small parts in the application header (`erp-shell.tsx`).
 *
 * The header's messages button was an empty drawer. It now carries the unread
 * count, the drawer lists the conversations that want reading, and the same
 * poll that fills them (`chat-store`) keeps the person present for the people
 * they talk to. The count is a small badge on the envelope
 * (`erp-icon-button__badge`, Intent UI 2026-10-06), the list the notifications
 * list's classes, the link the popover's link.
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

/** The drawer: what is waiting, newest first, and the way into the chat screen. */
export function ChatPopover({ onNavigate }: { readonly onNavigate: () => void }) {
  const t = useTranslations('chat');
  const snap = useChat();
  const waiting = [...snap.conversations]
    .sort((a, b) => Number(b.unread > 0 && !b.muted) - Number(a.unread > 0 && !a.muted))
    .slice(0, 6);

  return (
    <>
      {!snap.loaded ? (
        <p className="erp-utility-popover__empty">{t('loading')}</p>
      ) : waiting.length === 0 ? (
        <p className="erp-utility-popover__empty">{t('no_conversations')}</p>
      ) : (
        <ul className="erp-notifications__list">
          {waiting.map((c) => (
            <li className={c.unread > 0 ? 'erp-notifications__unread' : undefined} key={c.id}>
              <Link href={`/chat?c=${c.id}`} onClick={onNavigate}>
                <strong>
                  <bdi dir="auto">{c.name}</bdi>
                </strong>{' '}
                {c.unread > 0 ? <span className="coa-count-badge">{c.mentioned ? `@${c.unread}` : c.unread}</span> : null}
                {c.lastMessage ? (
                  <p>
                    <bdi dir="auto">
                      {c.lastMessage.retracted ? t('retracted_short') : c.lastMessage.kind === 'system' ? t(`system_short.${c.lastMessage.preview}` as never) : c.lastMessage.preview || t('sent_file')}
                    </bdi>
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link className="erp-utility-popover__link" href="/chat" onClick={onNavigate}>
        {t('open_chat')}
      </Link>
    </>
  );
}
