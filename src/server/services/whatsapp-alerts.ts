/**
 * The ERP's own alerts in the WhatsApp group — who is told, and of what.
 *
 * By direction (2026-10-05): "I want the AI aware a notification went to
 * Tishko, so it lets Tishko know in the WhatsApp group and tags them …
 * automatically … task due, task alert … when what a user requested is
 * approved, let them know too … it is so important, tag the person."
 * What an alert says is `domain/whatsapp-alerts.ts`; this file reads what is
 * new and keeps the marks of how far it has told.
 *
 * Three things are read, each for the person it concerns and nobody else:
 *
 *   NOTIFICATIONS   the rows the bell shows (`pending`). Not through the
 *                   notification rules or the delivery runner: most of what
 *                   the platform raises (a task assigned, a chat message, a
 *                   finding) has no rule and so no WhatsApp delivery row.
 *                   Read as a system sweep (`markSystemSweep`: the one way a
 *                   process may read another person's notifications, as the
 *                   delivery runner does).
 *   DECISIONS       what somebody else decided about a thing a person raised
 *                   (`pendingDecisions`): the audit trail records every
 *                   `<document>.approved / .rejected / .returned / .posted`
 *                   with who did it, and the same trail says who submitted or
 *                   created the document. Most documents tell nobody when
 *                   they are approved; this is how their maker hears. A
 *                   decision the application already notified them of is not
 *                   said twice, a person is not told of their own decision,
 *                   and HR's documents are nobody's business in a group.
 *   THE DAY         each morning, what each person has due, overdue, to
 *                   review and to approve (`dayOf`) — counted AS that person,
 *                   under their own permissions, as their own screens count.
 *
 * In every case only people with an active WhatsApp contact that allows
 * notifications, who are active users.
 *
 * The marks ("told up to notification N", "decisions up to audit row M", "the
 * morning note of this day is said") are a file beside the rest of what the
 * bridge keeps for itself (`var/noah/alerts.json`): the bridge owns no table
 * of its own, and `var/` outlives a deploy. With no mark, each is set to the
 * newest and nothing is said — switching alerts on never floods the group
 * with what happened before.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sql } from 'drizzle-orm';
import en from '../../../messages/en.json';
import ar from '../../../messages/ar.json';
import { markSystemSweep, withScope, type RequestScope } from '../db/client';
import { can } from '../domain/permissions';
import { isPrivateObject, referenceOf, type AlertRow, type DayCounts, type DecisionRow, type KindWords } from '../domain/whatsapp-alerts';
import * as authz from './authorization';

export interface PendingAlert extends AlertRow {
  readonly recipientUserId: string;
  readonly e164: string;
  readonly displayName: string;
}

export interface PendingDecision extends DecisionRow {
  readonly recipientUserId: string;
  readonly e164: string;
  readonly displayName: string;
}

/** What the bell calls each kind of notification, in one language (`notifications.kind` of the catalogue). */
export function kindWords(locale: 'en' | 'ar'): KindWords {
  return ((locale === 'ar' ? ar : en) as unknown as { notifications: { kind: KindWords } }).notifications.kind;
}

/** No sweep reads more than this; what is left is read on the next one. */
export const ALERT_BATCH = 200;

// ---------------------------------------------------------------------------
// The marks
// ---------------------------------------------------------------------------

export interface Marks {
  /** The last notification already told in the group; null when alerts have never run here. */
  readonly toldUpTo: bigint | null;
  /** The last audit row whose decisions have been told. */
  readonly decidedUpTo: bigint | null;
  /** The business day whose morning note has been said. */
  readonly briefDay: string | null;
}

function markFile(): string {
  return process.env.NOAH_ALERTS_FILE?.trim() || join(process.env.NOAH_NOTES_DIR?.trim() || join(process.cwd(), 'var', 'noah'), 'alerts.json');
}

const idOf = (value: unknown): bigint | null => (typeof value === 'string' && /^\d{1,19}$/.test(value) ? BigInt(value) : null);

/** A file that is missing or damaged is "never run": each mark starts again at the newest, which tells nothing old. */
export function readMarks(): Marks {
  try {
    const file = markFile();
    if (!existsSync(file)) return { toldUpTo: null, decidedUpTo: null, briefDay: null };
    const kept = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return {
      toldUpTo: idOf(kept.toldUpTo),
      decidedUpTo: idOf(kept.decidedUpTo),
      briefDay: typeof kept.briefDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(kept.briefDay) ? kept.briefDay : null,
    };
  } catch {
    return { toldUpTo: null, decidedUpTo: null, briefDay: null };
  }
}

/** Moves the marks named, and keeps the others. */
export function writeMarks(patch: Partial<Marks>, at: Date = new Date()): void {
  const now = { ...readMarks(), ...patch };
  const file = markFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ toldUpTo: now.toldUpTo === null ? null : now.toldUpTo.toString(), decidedUpTo: now.decidedUpTo === null ? null : now.decidedUpTo.toString(), briefDay: now.briefDay, at: at.toISOString() }, null, 1)}\n`,
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * What is new since the mark, for the people who are told in the group — and
 * `head`, the newest notification there is, which is where the mark goes once
 * these are told (a notification for somebody with no WhatsApp contact is
 * passed over, not waited for).
 *
 * `full` says the batch was cut at `ALERT_BATCH`: the mark then goes only as
 * far as the last row read.
 */
export async function pending(scope: RequestScope, input: { readonly after: bigint; readonly limit?: number }): Promise<{ readonly rows: PendingAlert[]; readonly head: bigint; readonly full: boolean }> {
  const limit = Math.max(1, Math.min(ALERT_BATCH, input.limit ?? ALERT_BATCH));
  return withScope(scope, async (tx) => {
    await markSystemSweep(tx);
    const newest = await tx.execute(sql`select coalesce(max(id), 0)::text as head from notification`);
    const head = BigInt((newest.rows[0] as { head: string }).head);
    const found = await tx.execute(sql`
      select n.id::text            as id,
             n.event_type           as kind,
             n.subject,
             n.body,
             n.object_id            as object_id,
             n.context,
             n.created_at           as created_at,
             n.recipient_user_id::text as recipient_user_id,
             c.e164,
             u.display_name
        from notification n
        join whatsapp_contact c on c.user_id = n.recipient_user_id and c.active and c.allow_notifications
        join app_user u on u.id = n.recipient_user_id and u.is_active
       where n.id > ${input.after.toString()}::bigint
         and n.id <= ${head.toString()}::bigint
         and n.read_at is null
       order by n.id
       limit ${limit}
    `);
    const rows = (found.rows as Array<Record<string, unknown>>).map(
      (row): PendingAlert => ({
        id: String(row.id),
        kind: String(row.kind),
        subject: String(row.subject ?? ''),
        body: String(row.body ?? ''),
        objectId: String(row.object_id ?? ''),
        context: (row.context ?? null) as Record<string, unknown> | null,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
        recipientUserId: String(row.recipient_user_id),
        e164: String(row.e164),
        displayName: String(row.display_name ?? ''),
      }),
    );
    return { rows, head, full: rows.length >= limit };
  });
}

/** Where a mark goes after a batch: the newest there is, or — when the batch was cut — the last row read. */
export function markAfter(batch: { readonly rows: ReadonlyArray<{ readonly id: string }>; readonly head: bigint; readonly full: boolean; readonly last?: bigint }): bigint {
  if (!batch.full) return batch.head;
  if (batch.last !== undefined) return batch.last;
  const last = batch.rows[batch.rows.length - 1];
  return last ? BigInt(last.id) : batch.head;
}

// ---------------------------------------------------------------------------
// Decisions on what a person raised
// ---------------------------------------------------------------------------

/**
 * The decisions recorded since the mark, each for the person who raised the
 * document: the last one to SUBMIT it before the decision, else the one who
 * created it.
 *
 * Left out: a decision by the maker themselves; one the application already
 * told them of (a notification about the same record within ten minutes —
 * the approval workflow's "Approved: …"); and anything of HR's.
 *
 * `last` is the last audit row examined, which is where the mark goes when
 * the batch was cut — whether or not that row made an alert.
 */
export async function pendingDecisions(
  scope: RequestScope,
  input: { readonly after: bigint; readonly limit?: number },
): Promise<{ readonly rows: PendingDecision[]; readonly head: bigint; readonly full: boolean; readonly last: bigint }> {
  const limit = Math.max(1, Math.min(ALERT_BATCH, input.limit ?? ALERT_BATCH));
  return withScope(scope, async (tx) => {
    await markSystemSweep(tx);
    const newest = await tx.execute(sql`select coalesce(max(id), 0)::text as head from audit_event`);
    const head = BigInt((newest.rows[0] as { head: string }).head);
    const scanned = await tx.execute(sql`
      select count(*)::int as n, coalesce(max(id), 0)::text as last
        from (
          select e.id
            from audit_event e
           where e.id > ${input.after.toString()}::bigint
             and e.id <= ${head.toString()}::bigint
             and e.outcome = 'success'
             and e.object_id is not null
             and e.actor_user_id is not null
             and e.action ~ '^[a-z_]+\\.(approved|rejected|returned|posted)$'
           order by e.id
           limit ${limit}
        ) s
    `);
    const scan = scanned.rows[0] as { n: number; last: string };
    const full = Number(scan.n) >= limit;
    const last = full ? BigInt(scan.last) : head;
    if (Number(scan.n) === 0) return { rows: [], head, full: false, last: head };

    const found = await tx.execute(sql`
      select d.id::text                 as id,
             d.action,
             d.object_type,
             d.object_id,
             d.after_value,
             d.before_value,
             d.reason,
             d.occurred_at,
             maker.actor_user_id::text  as recipient_user_id,
             c.e164,
             u.display_name,
             coalesce(a.display_name, '') as actor_name
        from audit_event d
        join lateral (
          select m.actor_user_id
            from audit_event m
           where m.object_type = d.object_type
             and m.object_id = d.object_id
             and m.outcome = 'success'
             and m.actor_user_id is not null
             and m.id < d.id
             and m.action ~ '\\.(submitted|created)$'
           order by (m.action ~ '\\.submitted$') desc, m.id desc
           limit 1
        ) maker on true
        join whatsapp_contact c on c.user_id = maker.actor_user_id and c.active and c.allow_notifications
        join app_user u on u.id = maker.actor_user_id and u.is_active
        left join app_user a on a.id = d.actor_user_id
       where d.id > ${input.after.toString()}::bigint
         and d.id <= ${last.toString()}::bigint
         and d.outcome = 'success'
         and d.object_id is not null
         and d.actor_user_id is not null
         and d.action ~ '^[a-z_]+\\.(approved|rejected|returned|posted)$'
         and maker.actor_user_id <> d.actor_user_id
         and not exists (
           select 1
             from notification n
            where n.recipient_user_id = maker.actor_user_id
              and n.object_id = d.object_id
              and n.created_at between d.occurred_at - interval '10 minutes' and d.occurred_at + interval '10 minutes'
         )
       order by d.id
    `);
    const rows = (found.rows as Array<Record<string, unknown>>)
      .filter((row) => !isPrivateObject(String(row.object_type)))
      .map(
        (row): PendingDecision => ({
          id: String(row.id),
          action: String(row.action),
          objectType: String(row.object_type),
          reference: referenceOf(row.after_value, row.before_value, row.object_id === null ? null : String(row.object_id)),
          actorName: String(row.actor_name ?? ''),
          reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
          occurredAt: row.occurred_at instanceof Date ? row.occurred_at : new Date(String(row.occurred_at)),
          recipientUserId: String(row.recipient_user_id),
          e164: String(row.e164),
          displayName: String(row.display_name ?? ''),
        }),
      );
    return { rows, head, full, last };
  });
}

// ---------------------------------------------------------------------------
// The day, as one person has it
// ---------------------------------------------------------------------------

/** Who may be named in the morning note: active contacts that allow notifications, of active users. */
export async function alertContacts(scope: RequestScope): Promise<Array<{ readonly userId: string; readonly e164: string; readonly displayName: string }>> {
  return withScope(scope, async (tx) => {
    const found = await tx.execute(sql`
      select c.user_id::text as user_id, c.e164, u.display_name
        from whatsapp_contact c
        join app_user u on u.id = c.user_id and u.is_active
       where c.active and c.allow_notifications
       order by u.display_name
    `);
    return (found.rows as Array<Record<string, unknown>>).map((row) => ({ userId: String(row.user_id), e164: String(row.e164), displayName: String(row.display_name ?? '') }));
  });
}

/**
 * What one person has on their plate today — counted AS them, in their own
 * scope, by the services their own screens use. Each count is its own
 * transaction, and one that cannot be read is nothing: a morning note is not
 * worth an error.
 */
export async function dayOf(userId: string, today: string): Promise<DayCounts | null> {
  const principal = await withScope({ userId, branchCode: '' }, (tx) => authz.loadPrincipal(tx, userId)).catch(() => null);
  if (!principal || !principal.isActive) return null;
  const mine = { userId, branchCode: principal.defaultBranchCode ?? '', isSuperUser: principal.isSuperUser };
  const quietly = async <T>(read: () => Promise<T>, otherwise: T): Promise<T> => {
    try {
      return await read();
    } catch {
      return otherwise;
    }
  };
  const nothing = { today: 0, overdue: 0, review: 0 };
  const [given, gave, approvals] = await Promise.all([
    can(principal, 'view', 'task')
      ? quietly(async () => {
          const tasks = await import('./tasks');
          return withScope(mine, (tx) => tasks.countsFor(tx, { principal }, 'mine', today));
        }, nothing)
      : Promise.resolve(nothing),
    can(principal, 'view', 'task')
      ? quietly(async () => {
          const tasks = await import('./tasks');
          return withScope(mine, (tx) => tasks.countsFor(tx, { principal }, 'assigned', today));
        }, nothing)
      : Promise.resolve(nothing),
    quietly(async () => {
      const dashboard = await import('./dashboard');
      return withScope(mine, async (tx) => (await dashboard.waitingFor(tx, principal)).approvals.length);
    }, 0),
  ]);
  return { dueToday: Number(given.today ?? 0), overdue: Number(given.overdue ?? 0), toReview: Number(gave.review ?? 0), approvals };
}
