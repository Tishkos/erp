/**
 * Fiscal calendar service — Phase 02.2.
 *
 * §14.6 — soft close. The rule is short and the consequence is not: every
 * posting in the system, from a journal to a stock movement, asks this module
 * whether its date is usable before it does anything else.
 *
 * The authority to post into a soft-closed period is expressed as a permission
 * verb, not as a role name: `execute` on `fiscal_period`. §5.3 makes verbs the
 * unit of authorisation, and a hard-coded role name would put "who is a Finance
 * Manager?" in two places that could disagree.
 */
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  NoPeriodForDateError,
  assertPeriodsAreContiguous,
  assertPostingAllowed,
  generateMonthlyPeriods,
  type FiscalPeriod,
  type PeriodStatus,
  type PostingPermission,
} from '../domain/periods';
import { can } from '../domain/permissions';
import { fiscalPeriod, fiscalYear, periodOverride } from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';

/** The permission object the calendar is governed by. */
export const PERMISSION_OBJECT = 'fiscal_period';

/**
 * The verb that carries §14.6's "authorised Finance Manager" authority.
 *
 * `execute` rather than `configure`: configuring the calendar (opening and
 * closing periods) and overriding a lock to post an adjustment are different
 * authorities, and §5.3 requires them to be separately grantable.
 */
export const OVERRIDE_VERB = 'execute' as const;

export class PeriodStatusChangeError extends Error {
  readonly code = 'PERIOD_STATUS_CHANGE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'PeriodStatusChangeError';
  }
}

function toPeriod(
  row: typeof fiscalPeriod.$inferSelect,
  fiscalYearCode: string,
): FiscalPeriod {
  return {
    id: row.id,
    fiscalYearCode,
    periodNo: row.periodNo,
    name: row.name,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status,
  };
}

/**
 * Opens a fiscal year and lays out its periods.
 *
 * The periods are generated rather than typed, and checked for contiguity
 * before they are written — a calendar with a one-day hole in August is only
 * discovered in August, by someone who cannot post.
 */
export async function createFiscalYear(
  tx: Tx,
  ctx: ActorContext,
  input: { code: string; name?: string; startsOn: string; endsOn: string },
): Promise<{ fiscalYearId: string; periodCount: number }> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const generated = generateMonthlyPeriods(input);
  assertPeriodsAreContiguous(generated, input);

  const [year] = await tx
    .insert(fiscalYear)
    .values({
      code: input.code,
      name: input.name ?? input.code,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
    })
    .returning({ id: fiscalYear.id });

  await tx.insert(fiscalPeriod).values(
    generated.map((period) => ({
      fiscalYearId: year!.id,
      periodNo: period.periodNo,
      name: period.name,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
    })),
  );

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fiscal_year.created',
    objectType: 'fiscal_year',
    objectId: year!.id,
    branchCode: ctx.branchCode,
    after: { code: input.code, startsOn: input.startsOn, endsOn: input.endsOn, periods: generated.length },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { fiscalYearId: year!.id, periodCount: generated.length };
}

/** The period covering a date, or a clear refusal naming the date. */
export async function periodFor(tx: Tx, postingDate: string): Promise<FiscalPeriod> {
  const rows = await tx
    .select({ period: fiscalPeriod, yearCode: fiscalYear.code })
    .from(fiscalPeriod)
    .innerJoin(fiscalYear, eq(fiscalYear.id, fiscalPeriod.fiscalYearId))
    .where(
      and(lte(fiscalPeriod.startsOn, postingDate), gte(fiscalPeriod.endsOn, postingDate)),
    )
    .limit(1);

  if (rows.length === 0) throw new NoPeriodForDateError(postingDate);
  return toPeriod(rows[0]!.period, rows[0]!.yearCode);
}

export interface PostingRequest {
  readonly postingDate: string;
  /** What is being posted, for the override record. */
  readonly documentType: string;
  readonly documentId?: string | null;
  /** Required only when posting into a soft-closed period. */
  readonly overrideReason?: string | null;
  /**
   * Whether the actor's override authority applies at all. False for automatic
   * postings: §14.6 gives the override to "authorised Finance Manager users"
   * posting "approved adjustments" — a deliberate act. An operational document
   * flowing through the posting engine is not that, and must not breach a
   * closed period merely because the person who approved it happens to hold the
   * verb.
   */
  readonly allowOverride?: boolean;
}

/**
 * Authorises a posting date **and records the override if it is one**.
 *
 * Both in one call, deliberately. A separate `recordOverride` would be a step
 * someone eventually forgets, and §24's report is only as good as the rows in
 * it. This is the only sanctioned way to establish that a posting date is
 * usable.
 */
export async function authorisePosting(
  tx: Tx,
  ctx: ActorContext,
  request: PostingRequest,
): Promise<PostingPermission> {
  const period = await periodFor(tx, request.postingDate);

  const permission = assertPostingAllowed(period, {
    isFinanceManager:
      request.allowOverride === false
        ? false
        : can(ctx.principal, OVERRIDE_VERB, PERMISSION_OBJECT),
    overrideReason: request.overrideReason ?? null,
  });

  if (permission.isOverride) {
    await tx.insert(periodOverride).values({
      fiscalPeriodId: period.id,
      actorUserId: ctx.principal.userId,
      documentType: request.documentType,
      documentId: request.documentId ?? null,
      postingDate: request.postingDate,
      reason: permission.overrideReason!,
      branchCode: ctx.branchCode,
    });

    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'fiscal_period.overridden',
      objectType: PERMISSION_OBJECT,
      objectId: period.id,
      branchCode: ctx.branchCode,
      after: {
        period: period.name,
        postingDate: request.postingDate,
        documentType: request.documentType,
        documentId: request.documentId ?? null,
      },
      reason: permission.overrideReason,
      outcome: 'success',
      requestId: ctx.requestId ?? null,
    });
  }

  return permission;
}

/**
 * Opens, soft-closes or closes a period.
 *
 * A hard close is one-way: §14.6's model is soft close precisely so that the
 * routine month-end does not need an irreversible act. Reopening a closed
 * period is a year-end matter and belongs to Phase 16.
 */
export async function setPeriodStatus(
  tx: Tx,
  ctx: ActorContext,
  periodId: string,
  status: PeriodStatus,
  reason: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: periodId,
    requestId: ctx.requestId ?? null,
  });

  const [row] = await tx
    .select()
    .from(fiscalPeriod)
    .where(eq(fiscalPeriod.id, periodId))
    .limit(1);

  if (!row) throw new PeriodStatusChangeError(`No fiscal period with id '${periodId}'.`);

  if (row.status === 'closed' && status !== 'closed') {
    throw new PeriodStatusChangeError(
      `${row.name} is closed. Reopening a closed period is a year-end action and is not available here (§14.6, Phase 16).`,
    );
  }

  if (!reason.trim()) {
    throw new PeriodStatusChangeError(
      `Changing the status of ${row.name} requires a reason, which is recorded (§5.4).`,
    );
  }

  await tx
    .update(fiscalPeriod)
    .set({ status, statusChangedBy: ctx.principal.userId })
    .where(eq(fiscalPeriod.id, periodId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: status === 'open' ? 'fiscal_period.reopened' : 'fiscal_period.closed',
    objectType: PERMISSION_OBJECT,
    objectId: periodId,
    branchCode: ctx.branchCode,
    before: { status: row.status },
    after: { status },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * §24 — "Period-lock override and back-dated posting report."
 *
 * Two things in one report because they are the two ways a posting date can be
 * other than today, and a reviewer wants both on one page.
 */
export async function overrideReport(
  tx: Tx,
  from: string,
  to: string,
): Promise<
  Array<{
    periodName: string;
    postingDate: string;
    documentType: string;
    documentId: string | null;
    actorUserId: string;
    reason: string;
    occurredAt: Date;
  }>
> {
  return tx
    .select({
      periodName: fiscalPeriod.name,
      postingDate: periodOverride.postingDate,
      documentType: periodOverride.documentType,
      documentId: periodOverride.documentId,
      actorUserId: periodOverride.actorUserId,
      reason: periodOverride.reason,
      occurredAt: periodOverride.occurredAt,
    })
    .from(periodOverride)
    .innerJoin(fiscalPeriod, eq(fiscalPeriod.id, periodOverride.fiscalPeriodId))
    .where(and(gte(periodOverride.postingDate, from), lte(periodOverride.postingDate, to)))
    .orderBy(desc(periodOverride.occurredAt));
}

/** The calendar, for a screen. */
export async function calendar(tx: Tx, fiscalYearCode?: string): Promise<FiscalPeriod[]> {
  const rows = await tx
    .select({ period: fiscalPeriod, yearCode: fiscalYear.code })
    .from(fiscalPeriod)
    .innerJoin(fiscalYear, eq(fiscalYear.id, fiscalPeriod.fiscalYearId))
    .where(fiscalYearCode ? eq(fiscalYear.code, fiscalYearCode) : sql`true`)
    .orderBy(asc(fiscalPeriod.startsOn));

  return rows.map((r) => toPeriod(r.period, r.yearCode));
}
