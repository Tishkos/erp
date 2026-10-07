'use client';

import { useTranslations } from 'next-intl';
import { admin as s } from '@/components/admin';
import { cn } from '@/components/intent/cn';
import type { Presence } from '@domain/chat';
import type { PersonView } from '@/server/services/chat-read';
import { dateTimeOf, listStamp } from './format';

/** The dot's colour per state: green online, amber away, red busy, grey offline. */
export const PRESENCE_DOT: Readonly<Record<Presence, string>> = {
  online: 'bg-success',
  away: 'bg-warning',
  busy: 'bg-danger',
  offline: 'bg-muted-fg/60',
};

/**
 * The status dot on a round avatar's lower end corner (the avatar's wrapper is
 * `relative`). Offline draws nothing unless asked, so a list of colleagues is
 * not a column of grey dots. The word goes to screen readers beside it.
 */
export function PresenceDot({
  presence,
  className,
  showOffline = false,
}: {
  readonly presence: Presence;
  readonly className?: string | undefined;
  readonly showOffline?: boolean;
}) {
  const t = useTranslations('chat');
  if (presence === 'offline' && !showOffline) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn('absolute -bottom-px -end-px size-3 rounded-full ring-2 ring-overlay', PRESENCE_DOT[presence], className)}
        data-presence-dot={presence}
      />
      <span className="sr-only">{t(`presence.${presence}`)}</span>
    </>
  );
}

/**
 * Online / Away / Busy / Offline, in words — the colour only helps. Online is
 * the green pill, Busy the red one, the rest the plain one; Offline adds when
 * the person was last seen.
 */
export function PresencePill({
  person,
  locale,
  timeZone,
  now,
  showLastSeen = true,
}: {
  readonly person: Pick<PersonView, 'presence' | 'lastSeenAt'>;
  readonly locale: string;
  readonly timeZone: string;
  readonly now: Date;
  readonly showLastSeen?: boolean;
}) {
  const t = useTranslations('chat');
  const tone = person.presence === 'online' ? `${s.pill} ${s.pillOn}` : person.presence === 'busy' ? `${s.pill} ${s.pillOff}` : s.pill;
  // Intent's badge with a dot in front: green online, amber away, red busy, grey offline.
  const look = {
    online: 'bg-success-subtle text-success-subtle-fg before:bg-success',
    away: 'bg-warning-subtle text-warning-subtle-fg before:bg-warning',
    busy: 'bg-danger-subtle text-danger-subtle-fg before:bg-danger',
    offline: 'bg-secondary text-muted-fg before:bg-muted-fg',
  }[person.presence];
  return (
    <>
      <span
        className={cn(
          tone,
          'inline-flex h-5 min-h-5 shrink-0 items-center gap-1 rounded-full border-0 px-2 text-[0.6875rem] font-medium leading-none',
          "before:size-1.5 before:rounded-full before:content-['']",
          look,
        )}
        data-presence={person.presence}
      >
        {t(`presence.${person.presence}`)}
      </span>
      {showLastSeen && person.presence === 'offline' && person.lastSeenAt ? (
        <span className={s.sapNote} title={dateTimeOf(person.lastSeenAt, locale, timeZone)}>
          {t('last_seen', { when: listStamp(person.lastSeenAt, now, locale, timeZone) })}
        </span>
      ) : null}
    </>
  );
}
