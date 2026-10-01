/**
 * The payables sweep — REQ-AP-001 §19.3, §19.4.
 *
 * "Over its time limit" is not an event anybody fires; it becomes true while
 * nobody is looking. So the state is read once a day: for every active check
 * whose named query this build implements, every payable over the limit in
 * force gets one `OVER_LIMIT_DETECTED` event and one automatic
 * `PENDING_REASON` hold — and never a second while the first stands, which
 * the partial unique index on (payable, check, open) guarantees even against
 * a sweep run twice.
 *
 * A check is a row of `sweep_check` plus a named query here. The rows for
 * SWIFT, PD and container clocks are seeded already and sit inert until
 * their build stages implement the queries — a new check is a new row and a
 * new query, never a schema change (§23).
 *
 * The sweep also keeps the event log's partitions a year ahead (§22.2) and
 * escalates holds that have waited past their escalation days with no owner
 * (§19.4).
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { payable, payableHold, stageTimeLimit, sweepCheck } from '../db/schema';
import { limitInForce, type LimitScope, type TimeLimitRow } from '../domain/payables';
import * as events from './payable-events';
import * as holds from './payable-holds';
import * as contracts from './recurring-contracts';
import * as notifications from './notifications';

export interface SweepResult {
  readonly asOf: string;
  readonly checked: number;
  readonly opened: number;
  readonly escalated: number;
  /** §10.4 — contract periods the generator raised in this run. */
  readonly periodsGenerated: number;
  /** Checks whose query this build does not implement yet — seeded, inert. */
  readonly skipped: string[];
}

/** One offender: a payable over a check's clock. */
interface Offender {
  readonly payableId: string;
  readonly laneCode: string;
  /** When the clock started — the limit counts from here. */
  readonly since: string;
  readonly scope: LimitScope;
  readonly summary: (limitDays: number, days: number) => string;
}

type CheckQuery = (tx: Tx, asOf: string) => Promise<Offender[]>;

const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * The named queries this build implements. Stage 1 can only read the payable
 * row itself; the later lanes' clocks arrive with their documents.
 */
const CHECK_QUERIES: Readonly<Record<string, CheckQuery>> = {
  /** D4 — a service payable nobody has confirmed (still at its first stage). */
  service_unconfirmed: async (tx) => {
    const rows = await tx
      .select({
        id: payable.id,
        since: sql<string>`${payable.stageSince}::date::text`,
        typeCode: payable.payableTypeCode,
        supplierId: payable.supplierId,
      })
      .from(payable)
      .where(
        and(
          eq(payable.payableTypeCode, 'service'),
          eq(payable.stageCode, 'requested'),
          isNull(payable.cancelledAt),
          isNull(payable.closedAt),
        ),
      );
    return rows.map((row) => ({
      payableId: row.id,
      laneCode: 'service',
      since: row.since,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: unconfirmed for ${days} days (limit ${limit}) — the benefiting department has not confirmed it`,
    }));
  },

  /** D4 — a recurring payable past its due date and not yet paid. */
  recurring_overdue: async (tx, asOf) => {
    const rows = await tx
      .select({
        id: payable.id,
        due: sql<string>`${payable.dueDate}::text`,
        typeCode: payable.payableTypeCode,
        supplierId: payable.supplierId,
        stageCode: payable.stageCode,
      })
      .from(payable)
      .where(
        and(
          eq(payable.payableTypeCode, 'recurring'),
          lt(payable.dueDate, asOf),
          isNull(payable.cancelledAt),
          isNull(payable.closedAt),
          sql`${payable.stageCode} not in ('paid','closed')`,
        ),
      );
    return rows.map((row) => ({
      payableId: row.id,
      laneCode: 'payment',
      since: row.due!,
      scope: { typeCode: row.typeCode, supplierId: row.supplierId },
      summary: (limit, days) =>
        `Over time limit: due ${row.due}, unpaid for ${days} days (limit ${limit})`,
    }));
  },
};

async function limitsFor(tx: Tx, checkCode: string): Promise<TimeLimitRow[]> {
  const rows = await tx
    .select({
      scope: stageTimeLimit.scope,
      limitDays: stageTimeLimit.limitDays,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
      active: stageTimeLimit.active,
      validFrom: sql<string>`${stageTimeLimit.validFrom}::text`,
    })
    .from(stageTimeLimit)
    .where(eq(stageTimeLimit.checkCode, checkCode));
  return rows;
}

/**
 * One day's sweep, idempotent. Call inside a super-scoped transaction — the
 * sweep reads every branch, like the due-notice sweep does, because a clock
 * nobody's branch can see is a clock nobody answers for.
 */
export async function runSweep(tx: Tx, asOf: string): Promise<SweepResult> {
  // §22.2 — the log's partitions stay a year ahead of the calendar.
  const nextYear = Number(asOf.slice(0, 4)) + 1;
  await tx.execute(sql`select payable_event_ensure_partition(${nextYear})`);

  // §10.4 — the contract generator runs in the same sweep, before the
  // checks, so a period born due today is also checked today. Idempotent, as
  // the generator itself is.
  const generated = await contracts.generateDue(tx, asOf, null);

  const checks = await tx.select().from(sweepCheck).where(eq(sweepCheck.active, true));

  let checked = 0;
  let opened = 0;
  const skipped: string[] = [];

  for (const check of checks) {
    const query = CHECK_QUERIES[check.code];
    if (!query) {
      skipped.push(check.code);
      continue;
    }
    checked += 1;

    const limits = await limitsFor(tx, check.code);
    for (const offender of await query(tx, asOf)) {
      const limit = limitInForce(limits, offender.scope, asOf);
      if (!limit) continue;

      const days = daysBetween(offender.since, asOf);
      if (days <= limit.limitDays) continue;

      const breachedOn = new Date(
        Date.parse(offender.since) + (limit.limitDays + 1) * 86_400_000,
      );
      const created = await holds.openAutomatic(tx, {
        payableId: offender.payableId,
        laneCode: offender.laneCode,
        checkCode: check.code,
        startedAt: breachedOn,
        summary: offender.summary(limit.limitDays, days),
      });
      if (created) opened += 1;
    }
  }

  // §19.4 — a hold with no owner past its escalation days is told upward,
  // once: `escalated_at` is the idempotency mark.
  const limits = await tx
    .select({
      checkCode: stageTimeLimit.checkCode,
      escalateAfterDays: stageTimeLimit.escalateAfterDays,
      escalateToRole: stageTimeLimit.escalateToRole,
    })
    .from(stageTimeLimit)
    .where(and(eq(stageTimeLimit.active, true), sql`${stageTimeLimit.escalateAfterDays} is not null`));
  const escalateDays = new Map(limits.map((l) => [l.checkCode, l]));

  let escalated = 0;
  const openHolds = await tx
    .select()
    .from(payableHold)
    .where(
      and(
        eq(payableHold.status, 'open'),
        isNull(payableHold.ownerUserId),
        isNull(payableHold.escalatedAt),
        sql`${payableHold.checkCode} is not null`,
      ),
    );

  for (const hold of openHolds) {
    const rule = escalateDays.get(hold.checkCode!);
    if (!rule?.escalateAfterDays) continue;
    // From when the hold was OPENED, not from the backdated breach: the
    // escalation is about nobody answering, and nobody could answer before
    // the question existed.
    const waited = daysBetween(hold.createdAt.toISOString().slice(0, 10), asOf);
    if (waited <= rule.escalateAfterDays) continue;

    const toRole = rule.escalateToRole ?? 'accounting_manager';
    await tx
      .update(payableHold)
      .set({ escalatedAt: new Date(), escalatedToRole: toRole, updatedAt: new Date() })
      .where(eq(payableHold.id, hold.id));

    await events.record(tx, {
      payableId: hold.payableId,
      eventCode: 'ESCALATED',
      summary: `Escalated to ${toRole}: stopped ${waited} days with nobody following up`,
      holdId: hold.id,
      actorUserId: null,
    });

    const [parent] = await tx
      .select({ payableNo: payable.payableNo, branchCode: payable.branchCode })
      .from(payable)
      .where(eq(payable.id, hold.payableId))
      .limit(1);

    await notifications.raise(
      tx,
      {
        eventType: 'payable.hold.escalated',
        objectType: 'payable',
        objectId: hold.payableId,
        occurrence: asOf,
      },
      { payableNo: parent?.payableNo ?? hold.payableId, days: waited },
      { branchCode: parent?.branchCode ?? null },
    );

    escalated += 1;
  }

  return { asOf, checked, opened, escalated, periodsGenerated: generated.periodsCreated, skipped };
}
