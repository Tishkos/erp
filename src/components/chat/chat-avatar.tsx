'use client';

import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import { ownPresenceOf, type Presence } from '@domain/chat';
import type { ConversationRow } from '@/server/services/chat-read';
import { PresenceDot } from './chat-presence';
import { useChat } from './chat-store';
import { initials } from './format';

/**
 * The one avatar with the status dot (2026-10-06, by direction: "in [the]
 * bottom right of their profile picture show their status for users").
 *
 * A round picture — the photo, or the initials — with the person's presence as
 * a small dot on its lower end corner: bottom right, bottom left in Arabic
 * (`inset-inline-end`). Green available, red busy, amber away, grey offline or
 * "appear offline"; a ring in the surface colour so it reads on every palette,
 * and the word for a screen reader. Where the presence is not known (somebody
 * one shares no conversation with — the presence policy), there is no dot.
 *
 *   UserAvatar   any face, wearing the classes its screen gives it
 *   OwnAvatar    the signed-in person's: the status they chose, from the chat poll
 *   ChatAvatar   a conversation's: tinted by the name, a group's people icon
 */
export function UserAvatar({
  className,
  image,
  initials: letters,
  presence,
  dotClassName,
}: {
  /** The face's own classes (size, shape, colours) — kept as the screen had them. */
  readonly className?: string | undefined;
  readonly image?: string | null | undefined;
  readonly initials: string;
  /** Unknown: no dot. */
  readonly presence?: Presence | null | undefined;
  readonly dotClassName?: string | undefined;
}) {
  return (
    <span className="relative inline-flex shrink-0 align-middle" data-avatar="">
      <span aria-hidden="true" className={className}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {image ? <img alt="" src={image} /> : letters}
      </span>
      {presence ? <PresenceDot className={dotClassName} presence={presence} showOffline /> : null}
    </span>
  );
}

/** The signed-in person's avatar, with the dot of the status they chose (none for a person without chat). */
export function OwnAvatar({
  className,
  image,
  initials: letters,
  dotClassName,
}: {
  readonly className?: string | undefined;
  readonly image?: string | null | undefined;
  readonly initials: string;
  readonly dotClassName?: string | undefined;
}) {
  const snap = useChat();
  const presence = snap.me ? ownPresenceOf(snap.me.status) : null;
  return <UserAvatar className={className} dotClassName={dotClassName} image={image} initials={letters} presence={presence} />;
}

const TINTS = [
  'bg-primary-subtle text-primary-subtle-fg',
  'bg-success-subtle text-success-subtle-fg',
  'bg-info-subtle text-info-subtle-fg',
  'bg-warning-subtle text-warning-subtle-fg',
  'bg-secondary text-secondary-fg',
] as const;

/** A colleague keeps one colour: the theme's own tints, never a hex, chosen by the name. */
export function tintOf(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return TINTS[Math.abs(hash) % TINTS.length]!;
}

const SIZES = {
  sm: 'size-8 text-xs [&_svg]:size-3.5',
  list: 'size-9 text-xs [&_svg]:size-3.5',
  md: 'size-10 text-[0.8125rem] [&_svg]:size-4',
  lg: 'size-12 text-sm [&_svg]:size-5',
} as const;

export function ChatAvatar({
  name,
  group = false,
  presence,
  size = 'md',
  className,
}: {
  readonly name: string;
  readonly group?: boolean | undefined;
  /** Unknown: no dot. A group has none. */
  readonly presence?: Presence | null | undefined;
  readonly size?: keyof typeof SIZES | undefined;
  readonly className?: string | undefined;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} data-avatar="">
      <span aria-hidden="true" className={cn('grid place-items-center rounded-full font-semibold', SIZES[size], tintOf(name))}>
        {group ? <Users /> : initials(name)}
      </span>
      {group || !presence ? null : <PresenceDot className={size === 'sm' ? 'size-2.5' : undefined} presence={presence} showOffline />}
    </span>
  );
}

/** The presence a conversation's avatar wears: the other person's, for a direct one; none for a group. */
export function presenceOfRow(row: Pick<ConversationRow, 'kind' | 'other'>): Presence | null {
  return row.kind === 'direct' && row.other ? row.other.presence : null;
}

/** The last line under a conversation's name: "You: …", the sender in a group, a system line, a file. */
export function useLastLine(): (row: ConversationRow, meId: string) => string {
  const t = useTranslations('chat');
  return (row, meId) => {
    const last = row.lastMessage;
    if (!last) return '';
    if (last.kind === 'system') return t(`system_short.${last.preview}` as never);
    if (last.retracted) return t('retracted_short');
    const who = last.senderId === meId ? t('you') : row.kind === 'group' ? last.senderName : '';
    const body = last.preview || (last.fileCount > 0 ? t('sent_file') : '');
    return who ? `${who}: ${body}` : body;
  };
}
