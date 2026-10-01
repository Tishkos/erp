/**
 * The payable status log — REQ-AP-001 §7.
 *
 * One writer for every lane. A service that changes anything under a payable
 * calls `record` in the same transaction as its change; the coverage test
 * (`ap01-event-coverage`) fails any service that writes a payable table and
 * does not. The summary is rendered once, here, and stored — the log is the
 * company's story of the payable, and a story whose old lines re-render when
 * a template changes is not a record (§7.1).
 *
 * This module never recomputes the stage — `payables.recomputeStage` does,
 * and calls back into here for the `STAGE_CHANGED` line. Keeping the two
 * apart is what lets a lane write several events in one transaction with one
 * stage recomputation at the end.
 */
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, payableEvent, payableEventCode } from '../db/schema';

export interface PayableEventInput {
  readonly payableId: string;
  readonly eventCode: string;
  /** One line for the log. Stored verbatim, never re-rendered. */
  readonly summary: string;
  /** The business moment; defaults to now (the server clock also stamps `recorded_at`). */
  readonly occurredAt?: Date;
  readonly sourceType?: string | null;
  readonly sourceId?: string | null;
  readonly sourceNo?: string | null;
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  /** Null when the sweep writes — shown as "system". */
  readonly actorUserId?: string | null;
  readonly holdId?: string | null;
  readonly attachmentId?: string | null;
  readonly correctionOfId?: string | null;
}

export class UnknownEventCodeError extends Error {
  readonly code = 'UNKNOWN_PAYABLE_EVENT_CODE';
  constructor(eventCode: string) {
    super(
      `'${eventCode}' is not in the event catalogue. New kinds of event are added in ` +
        'Payables Settings → Event codes, never invented at the call site (R4).',
    );
    this.name = 'UnknownEventCodeError';
  }
}

/**
 * Writes one line of the story, in the caller's transaction.
 *
 * The lane comes from the catalogue row, not the caller — one place decides
 * which lane an event belongs to, so the log's lane filter cannot disagree
 * with itself.
 */
export async function record(tx: Tx, input: PayableEventInput): Promise<{ id: string }> {
  const [code] = await tx
    .select({ code: payableEventCode.code, laneCode: payableEventCode.laneCode })
    .from(payableEventCode)
    .where(eq(payableEventCode.code, input.eventCode))
    .limit(1);

  if (!code) throw new UnknownEventCodeError(input.eventCode);

  const [row] = await tx
    .insert(payableEvent)
    .values({
      payableId: input.payableId,
      occurredAt: input.occurredAt ?? new Date(),
      laneCode: code.laneCode,
      eventCode: code.code,
      summary: input.summary,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      sourceNo: input.sourceNo ?? null,
      before: (input.before ?? null) as Record<string, unknown> | null,
      after: (input.after ?? null) as Record<string, unknown> | null,
      actorUserId: input.actorUserId ?? null,
      holdId: input.holdId ?? null,
      attachmentId: input.attachmentId ?? null,
      correctionOfId: input.correctionOfId ?? null,
    })
    .returning({ id: payableEvent.id });

  return { id: row!.id };
}

export interface LogFilter {
  readonly laneCode?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

/** §7.3 — newest first on screen; the print route reverses. */
export async function logFor(tx: Tx, payableId: string, filter: LogFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 50));

  const where = and(
    eq(payableEvent.payableId, payableId),
    filter.laneCode ? eq(payableEvent.laneCode, filter.laneCode) : undefined,
    filter.search
      ? or(
          ilike(payableEvent.summary, `%${filter.search}%`),
          ilike(payableEvent.sourceNo, `%${filter.search}%`),
        )
      : undefined,
  );

  const found = await tx
    .select()
    .from(payableEvent)
    .where(where)
    .orderBy(desc(payableEvent.recordedAt), desc(payableEvent.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // §6.3 — "date · lane · summary · who": the person, by name. The row keeps
  // the id (evidence); the name is looked up, so a renamed user reads right.
  const actorIds = [...new Set(found.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))];
  const names = actorIds.length
    ? new Map(
        (
          await tx
            .select({ id: appUser.id, displayName: appUser.displayName })
            .from(appUser)
            .where(inArray(appUser.id, actorIds))
        ).map((user) => [user.id, user.displayName]),
      )
    : new Map<string, string>();
  const rows = found.map((row) => ({
    ...row,
    actorName: row.actorUserId ? (names.get(row.actorUserId) ?? null) : null,
  }));

  const [{ total }] = (await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(payableEvent)
    .where(where)) as [{ total: number }];

  return { rows, total, page, pageSize };
}
