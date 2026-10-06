'use client';

import { useTranslations } from 'next-intl';
import { admin as s } from '@/components/admin';
import { cn } from '@/components/intent/cn';
import type { PersonView } from '@/server/services/chat-read';
import { dateTimeOf, listStamp } from './format';

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
