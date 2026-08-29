import { getLocale, getTranslations } from 'next-intl/server';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { inArray } from 'drizzle-orm';
import { appUser } from '@/server/db/schema';
import { withCurrentUser } from '@/server/session';
import * as audit from '@/server/services/audit';
import { Timeline, type TimelineEntry } from './index';

/**
 * Record history — Phase 0 requirement 10.
 *
 * "Each record shows who created it, when it was created, its current status
 * and its approval/cancellation history." The audit trail is the source; this
 * reads the events for one record under the caller's own scope and draws them
 * newest first, with the paperwork's own events folded in.
 *
 * Written for a person (by direction, 2026-08-29): the event is a sentence
 * from the catalogue, the person is named, the moment is given to the second,
 * and what changed is spelled out field by field — *posting date: 2026-08-01
 * → 2026-08-29* — rather than dumped as a document. Ids are never shown; the
 * things they point at are named instead.
 */
export async function RecordHistory({
  objectType,
  objectId,
}: {
  readonly objectType: string;
  readonly objectId: string;
}) {
  const [t, action, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('audit_action'),
    getLocale(),
  ]);

  // `has` rather than a try/catch: next-intl returns the key path for a
  // missing message instead of throwing.
  const label = (code: string): string => {
    if (action.has(code)) return action(code);
    const [, ...rest] = code.split('.');
    return (rest.length > 0 ? rest.join('.') : code).replace(/_/g, ' ');
  };
  const field = (key: string): string =>
    t.has(`audit.fields.${key}`)
      ? t(`audit.fields.${key}`)
      : key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

  const entries = await withCurrentUser(async (tx) => {
    const rows = await audit.timelineWithAttachments(tx, objectType, objectId);
    const actorIds = [...new Set(rows.map((r) => r.actor_user_id).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const people = await tx
        .select({ id: appUser.id, displayName: appUser.displayName })
        .from(appUser)
        .where(inArray(appUser.id, actorIds));
      for (const person of people) names.set(person.id, person.displayName);
    }
    return rows.map(
      (row): TimelineEntry => ({
        id: String(row.id),
        when: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(String(row.occurred_at)),
        ),
        action: label(String(row.action)),
        actor: row.actor_user_id ? (names.get(String(row.actor_user_id)) ?? t('audit.former_user')) : null,
        outcome: String(row.outcome),
        reason: row.reason ? String(row.reason) : null,
        detail: describeChange(row.before_value, row.after_value, field, locale as Locale),
      }),
    );
  });

  return (
    <Timeline
      emptyLabel={t('history_empty')}
      entries={entries}
      labelledBy={`record-history-${objectType}-${objectId}`}
      title={t('history')}
    />
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d+\.\d{4}$/;
/** Bookkeeping the trail keeps for itself; nothing a reader needs. */
const HIDDEN = new Set(['parent', 'sha256', 'requestId', 'id']);

/**
 * What changed, in words.
 *
 * Every scalar in the after-image that differs from the before-image is one
 * clause — *field: old → new* — and a field with no before is stated on its
 * own. Ids are left out (the record they point at is named elsewhere), dates
 * and money are formatted, and booleans read as yes and no.
 */
function describeChange(
  before: unknown,
  after: unknown,
  field: (key: string) => string,
  locale: Locale,
): string | null {
  const b = asRecord(before);
  const a = asRecord(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !HIDDEN.has(k));
  const parts: string[] = [];
  for (const key of keys) {
    const was = a[key] === undefined && b[key] !== undefined ? b[key] : undefined;
    const now = a[key];
    const shown = (v: unknown) => readable(v, locale);
    if (now !== undefined && b[key] !== undefined && key in a && String(b[key]) !== String(now)) {
      if (skip(b[key]) && skip(now)) continue;
      parts.push(`${field(key)}: ${shown(b[key])} → ${shown(now)}`);
    } else if (now !== undefined && !skip(now)) {
      parts.push(`${field(key)}: ${shown(now)}`);
    } else if (was !== undefined && !skip(was) && Object.keys(a).length === 0) {
      // A removal: the before-image is all there is.
      parts.push(`${field(key)}: ${shown(was)}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Nothing to say: empty, an id, or a nested document. */
function skip(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value === 'object') return true;
  if (typeof value === 'string' && UUID.test(value)) return true;
  return false;
}

function readable(value: unknown, locale: Locale): string {
  if (value === true) return '✓';
  if (value === false) return '✗';
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return formatBusinessDate(value, locale);
    if (DECIMAL.test(value)) return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Number(value));
  }
  return String(value);
}
