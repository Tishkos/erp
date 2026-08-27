import { getLocale, getTranslations } from 'next-intl/server';
import { formatTimestamp, type Locale } from '@/i18n/config';
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
 * newest first. Actor names are resolved here rather than stored, so a renamed
 * person is still recognisable in old events.
 *
 * Events are named in the catalogue where a name exists and shown raw where
 * one does not — the trail is written by every service in the system and no
 * catalogue will ever be complete, so an unknown action must still be legible
 * rather than blank.
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
  // missing message instead of throwing, so the catch never fired and an
  // unnamed action rendered as 'audit_action.journal_entry.created'.
  const label = (code: string): string => (action.has(code) ? action(code) : code);

  const entries = await withCurrentUser(async (tx) => {
    const rows = await audit.timelineFor(tx, objectType, objectId);
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
        when: formatTimestamp(String(row.occurred_at), locale as Locale),
        action: label(String(row.action)),
        actor: row.actor_user_id ? (names.get(String(row.actor_user_id)) ?? null) : null,
        outcome: String(row.outcome),
        reason: row.reason ? String(row.reason) : null,
        detail: changedFields(row.after_value),
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

/**
 * What changed, in a line.
 *
 * The stored value is the whole after-image, which is the right thing to keep
 * and the wrong thing to show: a person scanning a history wants the fields
 * that moved, not a JSON document. The full value stays in the trail for
 * anyone who queries it.
 */
function changedFields(after: unknown): string | null {
  if (!after || typeof after !== 'object' || Array.isArray(after)) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(after as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    parts.push(`${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${String(value)}`);
    if (parts.length === 4) break;
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
