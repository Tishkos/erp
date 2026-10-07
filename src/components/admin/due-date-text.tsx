import { formatBusinessDate, type Locale } from '@/i18n/config';

/**
 * A purchase invoice's or an import application's due date, once there is one
 * (2026-10-07, by direction: "don't show the due date until we get the
 * SWIFT"). Until somebody sets it, a dash and why — "Set once the SWIFT is
 * received" — muted, in the reader's language; never the column's default.
 *
 * `waiting` is the sentence (the caller's `admin.balance_due.waiting`); left
 * out, an empty date is a plain dash (a document that has no due date at all).
 */
export function DueDateText({
  date,
  locale,
  waiting,
}: {
  /** The due date when it is known, else null. */
  readonly date: string | null | undefined;
  readonly locale: Locale | string;
  readonly waiting?: string | null | undefined;
}) {
  if (date) return <bdi dir="ltr">{formatBusinessDate(date, locale as Locale)}</bdi>;
  return (
    <span data-due-date="waiting">
      <span aria-hidden={waiting ? true : undefined}>—</span>
      {waiting ? <span className="block text-xs text-muted-fg">{waiting}</span> : null}
    </span>
  );
}
