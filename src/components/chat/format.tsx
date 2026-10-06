import { Fragment, type ReactNode } from 'react';

/**
 * Small, pure helpers the chat components share: how a time is written, how a
 * name becomes initials, and how a message's text becomes elements.
 *
 * Times are written in the business zone (`ERP_TIMEZONE`, handed down from the
 * page), not the browser's, so the server's first render and the browser's
 * agree and a colleague abroad reads the same clock the books are kept on.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}|${locale}|${options.timeZone}`;
  let found = formatters.get(id);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options);
    formatters.set(id, found);
  }
  return found;
}

/** `YYYY-MM-DD` of an instant in the zone — a key to compare days by. */
export function dayKey(iso: string, zone: string): string {
  const parts = formatter('day', 'en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function timeOf(iso: string, locale: string, zone: string): string {
  return formatter('time', locale, { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function dateOf(iso: string, locale: string, zone: string): string {
  return formatter('date', locale, { timeZone: zone, day: 'numeric', month: 'short' }).format(new Date(iso));
}

export function dateTimeOf(iso: string, locale: string, zone: string): string {
  return formatter('datetime', locale, { timeZone: zone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** "09:41" today, "3 Oct" before: how the conversation list dates its rows. */
export function listStamp(iso: string, now: Date, locale: string, zone: string): string {
  return dayKey(iso, zone) === dayKey(now.toISOString(), zone) ? timeOf(iso, locale, zone) : dateOf(iso, locale, zone);
}

/** A person's or a group's round initials, in the accent's tint (the Intent UI redesign). */
export const AVATAR_CLASS =
  'shrink-0 rounded-full border-0 bg-primary-subtle font-semibold text-primary-subtle-fg [&_svg]:size-3.5';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = Array.from(parts[0]!)[0] ?? '';
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1]!)[0] ?? '') : '';
  return (first + last).toUpperCase();
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi;
const BREAK_AFTER = 28;

/** A long unbroken string is given places to wrap (`<wbr>` leaves the copied text as written). */
function breakable(text: string, key: string): ReactNode {
  if (text.length <= BREAK_AFTER) return text;
  const pieces: ReactNode[] = [];
  for (let i = 0; i < text.length; i += BREAK_AFTER) {
    if (i > 0) pieces.push(<wbr key={`${key}-w${i}`} />);
    pieces.push(text.slice(i, i + BREAK_AFTER));
  }
  return pieces;
}

function words(text: string, key: string): ReactNode[] {
  return text.split(/(\s+)/).map((token, i) => (/^\s+$/.test(token) ? token : <Fragment key={`${key}-${i}`}>{breakable(token, `${key}-${i}`)}</Fragment>));
}

/**
 * The text of a message as elements: line breaks kept, web links made links
 * (http and https only, opened in a new tab without the opener), the names of
 * the people mentioned set in bold, long strings made breakable. Nothing is
 * interpreted as markup — React escapes the rest.
 */
export function renderBody(body: string, mentionNames: readonly string[]): ReactNode {
  const names = [...mentionNames].filter(Boolean).sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mentionPattern = escaped.length > 0 ? new RegExp(`@(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;

  return body.split('\n').map((line, lineIndex) => {
    const key = `l${lineIndex}`;
    const marks: { start: number; end: number; kind: 'url' | 'mention' }[] = [];
    for (const match of line.matchAll(URL_PATTERN)) {
      const trimmed = match[0].replace(/[.,;:!?)\]}]+$/, '');
      marks.push({ start: match.index!, end: match.index! + trimmed.length, kind: 'url' });
    }
    if (mentionPattern) {
      for (const match of line.matchAll(mentionPattern)) {
        const start = match.index!;
        if (marks.some((m) => start < m.end && start + match[0].length > m.start)) continue;
        marks.push({ start, end: start + match[0].length, kind: 'mention' });
      }
    }
    marks.sort((a, b) => a.start - b.start);

    const out: ReactNode[] = [];
    let at = 0;
    marks.forEach((mark, i) => {
      if (mark.start > at) out.push(...words(line.slice(at, mark.start), `${key}-t${i}`));
      const text = line.slice(mark.start, mark.end);
      out.push(
        mark.kind === 'url' ? (
          <a href={text} key={`${key}-u${i}`} rel="noopener noreferrer" target="_blank">
            {breakable(text, `${key}-u${i}`)}
          </a>
        ) : (
          <strong key={`${key}-m${i}`}>{text}</strong>
        ),
      );
      at = mark.end;
    });
    if (at < line.length) out.push(...words(line.slice(at), `${key}-e`));
    return (
      <Fragment key={key}>
        {lineIndex > 0 ? <br /> : null}
        {out}
      </Fragment>
    );
  });
}
