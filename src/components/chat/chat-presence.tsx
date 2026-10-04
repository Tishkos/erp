'use client';

import { useTranslations } from 'next-intl';
import { admin as s } from '@/components/admin';
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
  return (
    <>
      <span className={tone} data-presence={person.presence}>
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
