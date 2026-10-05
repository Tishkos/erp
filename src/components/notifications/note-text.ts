import { kindKey, relativeParts, type LabelParams } from '@domain/notification-center';

/**
 * Words and times for a notification, one place for the server screen and the
 * bell's popover.
 *
 * A kind with a label of its own (`notifications.kind.<key>.title`) is drawn
 * from it, in the reader's language, with the facts the notification carries.
 * A kind without one (an HR sweep's, a module's that is not labelled yet) is
 * drawn from the text stored when it was raised — never from its code. A
 * notification whose record the reader can no longer open is drawn as "no
 * longer available" and says nothing else: the stored text may name a party or
 * an amount that is no longer theirs to see.
 */
export interface Words {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

export interface NoteSource {
  readonly kind: string;
  readonly subject: string;
  readonly body: string;
  readonly params: LabelParams;
  readonly userText: boolean;
  readonly reason: 'no_target' | 'no_access' | 'not_found' | 'not_served' | null;
}

export interface NoteText {
  readonly title: string;
  readonly detail: string;
  /** The notification's record can no longer be opened by this reader. */
  readonly gone: boolean;
}

const tidy = (value: string): string => value.replace(/^[\s·\-—:]+|[\s·\-—:]+$/g, '').replace(/\s{2,}/g, ' ');

export function noteText(t: Words, note: NoteSource): NoteText {
  if (note.reason === 'no_access' || note.reason === 'not_found') {
    return { title: t('gone'), detail: t('gone_hint'), gone: true };
  }
  const gone = note.reason === 'not_served';
  const key = `kind.${kindKey(note.kind)}`;
  if (!note.userText && t.has(`${key}.title`)) {
    const values: Record<string, string | number> = { ...note.params };
    const detail = t.has(`${key}.detail`) ? tidy(t(`${key}.detail`, values)) : '';
    return { title: tidy(t(`${key}.title`, values)), detail, gone };
  }
  return { title: note.subject, detail: note.body, gone };
}

export interface When {
  readonly relative: string;
  readonly absolute: string;
}

/** "5 minutes ago" for the line and the exact moment for its hover title, in the books' time zone. */
export function whenText(iso: string, now: Date, locale: string, zone: string): When {
  const then = new Date(iso);
  const { value, unit } = relativeParts(then, now);
  return {
    relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-value, unit),
    absolute: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(then),
  };
}
