/**
 * The Project System — REQ-PM-001 Stage PM-4: activities and milestones
 * under the elements, the critical-path pass over their dependencies, the
 * milestone trend, progress (measured by one person, approved by another —
 * a progress milestone's approval is such a measurement), and earned value
 * per element from the current plan, the approved progress and the actuals.
 *
 * Over `services/projects.ts` (Phase 11): its `project_progress` rows are
 * the measurements; this module adds the element checks Phase 11 left to
 * the caller, the schedule, and the arithmetic of §10.
 */
import { and, asc, desc, eq, lte, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  project,
  projectActivity,
  projectActivityDependency,
  projectCost,
  projectMilestoneHistory,
  projectPlanLine,
  projectPlanVersion,
  projectProgress,
  projectWbs,
  workingCalendar,
  workingCalendarHoliday,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal, toDecimalString } from '../domain/money';
import { ProjectSystemError, admitsStructureChange, treeOrder, type ProjectStatus } from '../domain/project-system';
import {
  DEFAULT_CALENDAR,
  earnedOf,
  earnedValue,
  plannedValueAt,
  ratioText,
  schedule as criticalPath,
  topologicalOrder,
  type DependencyKind,
  type WorkCalendar,
} from '../domain/project-schedule';
import { AdminNotFoundError, optionalText, permit, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';
import * as budget from './project-budget';
import * as billing from './project-billing';

/** A literal, as in `project-budget.ts`. */
export const PERMISSION_OBJECT = 'project';
export const ACTIVITY_DOCUMENT_TYPE = 'project_activity';

const MONEY = 4n;
const PERCENT = 4n;

async function load(tx: Tx, projectCode: string) {
  const [row] = await tx.select().from(project).where(eq(project.code, projectCode)).limit(1);
  if (!row) throw new AdminNotFoundError('project', projectCode);
  return row;
}

async function loadActivity(tx: Tx, projectCode: string, code: string) {
  const [row] = await tx.select().from(projectActivity).where(and(eq(projectActivity.projectCode, projectCode), eq(projectActivity.code, code))).limit(1);
  if (!row) throw new AdminNotFoundError('project_activity', `${projectCode}:${code}`);
  return row;
}

const day = (value: string | null | undefined, field: string): string | null => {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new ProjectSystemError(field, `'${text}' is not a date`);
  return text;
};

const percentOf = (value: string | number | null | undefined, field: string): bigint => {
  const text = String(value ?? '').trim();
  if (!text) throw new ProjectSystemError(field, 'is required');
  let parsed: bigint;
  try {
    parsed = parseDecimal(text, PERCENT);
  } catch {
    throw new ProjectSystemError(field, `'${text}' is not a percentage`);
  }
  if (parsed < 0n || parsed > 100_0000n) throw new ProjectSystemError(field, 'a percentage is between 0 and 100');
  return parsed;
};

const wholeDays = (value: string | number | null | undefined, field: string, fallback: number): number => {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n)) throw new ProjectSystemError(field, `'${text}' is not a whole number of days`);
  return n;
};

// ---------------------------------------------------------------------------
// The calendar the project counts in
// ---------------------------------------------------------------------------

export async function calendarOf(tx: Tx, projectCode: string): Promise<WorkCalendar & { code: string | null }> {
  const row = await load(tx, projectCode);
  if (!row.calendarCode) return { ...DEFAULT_CALENDAR, code: null };
  const [cal] = await tx.select().from(workingCalendar).where(eq(workingCalendar.code, row.calendarCode)).limit(1);
  if (!cal) return { ...DEFAULT_CALENDAR, code: null };
  const holidays = await tx.select({ day: workingCalendarHoliday.holidayDate }).from(workingCalendarHoliday).where(eq(workingCalendarHoliday.calendarCode, cal.code));
  return { code: cal.code, workingDays: cal.workingDays.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean), holidays: new Set(holidays.map((h) => h.day)) };
}

export async function setCalendar(tx: Tx, ctx: ActorContext, projectCode: string, calendarCode: string | null): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const code = (calendarCode ?? '').trim() || null;
  if (code) {
    const [cal] = await tx.select({ active: workingCalendar.active }).from(workingCalendar).where(eq(workingCalendar.code, code)).limit(1);
    if (!cal) throw new ProjectSystemError('calendar', `there is no working calendar '${code}'`);
    if (!cal.active) throw new ProjectSystemError('calendar', `working calendar ${code} is deactivated`);
  }
  await tx.update(project).set({ calendarCode: code, updatedAt: new Date() }).where(eq(project.code, projectCode));
  await recordChange(tx, ctx, { action: 'project.calendar_set', objectType: 'project', objectId: projectCode, branchCode: row.branchCode, before: { calendarCode: row.calendarCode }, after: { calendarCode: code } });
}

export async function calendars(tx: Tx) {
  return tx.select({ code: workingCalendar.code, nameEn: workingCalendar.nameEn, nameAr: workingCalendar.nameAr, year: workingCalendar.year }).from(workingCalendar).where(eq(workingCalendar.active, true)).orderBy(desc(workingCalendar.year), asc(workingCalendar.code));
}

// ---------------------------------------------------------------------------
// Activities and milestones (§5)
// ---------------------------------------------------------------------------

export interface ActivityInput {
  readonly wbsCode: string;
  /** Typed, or left blank for the next in steps of ten (A0010, A0020, …). */
  readonly code?: string | null;
  readonly name: string;
  readonly kind?: string | null;
  readonly milestoneUsage?: string | null;
  readonly progressPercent?: string | null;
  readonly durationDays?: string | number | null;
  readonly notBefore?: string | null;
  readonly responsibleUserId?: string | null;
}

function nextActivityCode(taken: readonly string[]): string {
  const numbers = taken.map((c) => /^A(\d{4})$/.exec(c)?.[1]).filter((n): n is string => Boolean(n)).map(Number);
  const next = numbers.length === 0 ? 10 : Math.ceil((Math.max(...numbers) + 1) / 10) * 10;
  return `A${String(next).padStart(4, '0')}`;
}

export async function addActivity(tx: Tx, ctx: ActorContext, projectCode: string, input: ActivityInput): Promise<{ id: string; code: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (!admitsStructureChange(row.status as ProjectStatus)) throw new ProjectSystemError('status', `${projectCode} is ${row.status}; its schedule is fixed`);
  const wbsCode = (input.wbsCode ?? '').trim();
  const [element] = await tx.select().from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, wbsCode))).limit(1);
  if (!element) throw new ProjectSystemError('wbs', `${projectCode} has no element '${wbsCode}'`);
  if (!element.active) throw new ProjectSystemError('wbs', `${wbsCode} is deactivated`);
  const kind = (input.kind ?? 'activity').trim();
  if (kind !== 'activity' && kind !== 'milestone') throw new ProjectSystemError('kind', `'${kind}' is neither an activity nor a milestone`);
  const usage = kind === 'milestone' ? (input.milestoneUsage ?? '').trim() : null;
  if (kind === 'milestone' && !['billing', 'progress', 'date'].includes(usage ?? '')) throw new ProjectSystemError('usage', 'a milestone names its usage: billing, progress or date');
  const progress = usage === 'progress' ? percentOf(input.progressPercent, 'progress_percent') : null;
  const duration = kind === 'milestone' ? 0 : wholeDays(input.durationDays, 'duration_days', 1);
  if (kind === 'activity' && (duration < 1 || duration > 3650)) throw new ProjectSystemError('duration_days', 'an activity lasts between 1 and 3,650 working days');
  const taken = (await tx.select({ code: projectActivity.code }).from(projectActivity).where(eq(projectActivity.projectCode, projectCode))).map((a) => a.code);
  const typed = (input.code ?? '').trim().toUpperCase();
  if (typed && !/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(typed)) throw new ProjectSystemError('code', 'use up to 16 letters, digits, hyphens or underscores');
  if (typed && taken.includes(typed)) throw new ProjectSystemError('code', `${projectCode} already has an activity ${typed}`);
  const code = typed || nextActivityCode(taken);
  const [created] = await tx
    .insert(projectActivity)
    .values({
      projectCode,
      wbsCode,
      code,
      name: requireText(input.name, 'name'),
      kind,
      milestoneUsage: usage,
      progressPercent: progress === null ? null : toDecimalString(progress, PERCENT),
      durationDays: duration,
      notBefore: day(input.notBefore, 'not_before'),
      responsibleUserId: (input.responsibleUserId ?? '').trim() || element.responsibleUserId || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectActivity.id });
  await recordChange(tx, ctx, {
    action: 'project_activity.created',
    objectType: ACTIVITY_DOCUMENT_TYPE,
    objectId: `${projectCode}:${code}`,
    branchCode: row.branchCode,
    after: { wbsCode, kind, usage, durationDays: duration, progressPercent: progress === null ? null : toDecimalString(progress, PERCENT) },
  });
  return { id: created!.id, code };
}

export async function updateActivity(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  code: string,
  input: { name?: string | null; durationDays?: string | number | null; notBefore?: string | null; responsibleUserId?: string | null; progressPercent?: string | null },
): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const before = await loadActivity(tx, projectCode, code);
  if (before.status !== 'open') throw new ProjectSystemError('status', `${code} is ${before.status}; it is not changed`);
  const values = {
    name: input.name === undefined || input.name === null ? before.name : requireText(input.name, 'name'),
    durationDays: before.kind === 'milestone' ? 0 : wholeDays(input.durationDays, 'duration_days', before.durationDays),
    notBefore: input.notBefore === undefined ? before.notBefore : day(input.notBefore, 'not_before'),
    responsibleUserId: input.responsibleUserId === undefined ? before.responsibleUserId : (input.responsibleUserId ?? '').trim() || null,
    progressPercent: before.milestoneUsage === 'progress' && input.progressPercent ? toDecimalString(percentOf(input.progressPercent, 'progress_percent'), PERCENT) : before.progressPercent,
  };
  if (before.kind === 'activity' && (values.durationDays < 1 || values.durationDays > 3650)) throw new ProjectSystemError('duration_days', 'an activity lasts between 1 and 3,650 working days');
  await tx.update(projectActivity).set({ ...values, updatedAt: new Date() }).where(eq(projectActivity.id, before.id));
  await recordChange(tx, ctx, {
    action: 'project_activity.updated',
    objectType: ACTIVITY_DOCUMENT_TYPE,
    objectId: `${projectCode}:${code}`,
    branchCode: row.branchCode,
    before: { name: before.name, durationDays: before.durationDays, notBefore: before.notBefore, progressPercent: before.progressPercent },
    after: values,
  });
}

/** A cancelled activity or milestone stays on the record and leaves the schedule; its links stop counting. */
export async function cancelActivity(tx: Tx, ctx: ActorContext, projectCode: string, code: string, reason: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const before = await loadActivity(tx, projectCode, code);
  if (before.status !== 'open') throw new ProjectSystemError('status', `${code} is ${before.status}`);
  if (before.reachedOn) throw new ProjectSystemError('status', `${code} was reported reached; approve it or leave it`);
  // PM-5 — a billing milestone with a plan line waiting on it: the line is cancelled (or moved to a date) first.
  const [waiting] = (await tx.execute(sql`select line_no from project_billing_plan_line where activity_id = ${before.id}::uuid and status in ('planned', 'due') limit 1`)).rows as { line_no: number }[];
  if (waiting) throw new ProjectSystemError('status', `billing-plan line ${waiting.line_no} falls due on ${code}; cancel the line first`);
  const why = requireText(reason, 'reason');
  await tx.update(projectActivity).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: new Date(), cancelReason: why, isCritical: false, updatedAt: new Date() }).where(eq(projectActivity.id, before.id));
  await recordChange(tx, ctx, { action: 'project_activity.cancelled', objectType: ACTIVITY_DOCUMENT_TYPE, objectId: `${projectCode}:${code}`, branchCode: row.branchCode, before: { status: 'open' }, after: { status: 'cancelled' }, reason: why });
}

export async function addDependency(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: { predecessorCode: string; successorCode: string; kind?: string | null; lagDays?: string | number | null },
): Promise<{ id: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (!admitsStructureChange(row.status as ProjectStatus)) throw new ProjectSystemError('status', `${projectCode} is ${row.status}; its schedule is fixed`);
  const pred = await loadActivity(tx, projectCode, (input.predecessorCode ?? '').trim().toUpperCase());
  const succ = await loadActivity(tx, projectCode, (input.successorCode ?? '').trim().toUpperCase());
  if (pred.status === 'cancelled' || succ.status === 'cancelled') throw new ProjectSystemError('dependency', 'a cancelled activity is not linked');
  const kind = ((input.kind ?? 'FS').trim().toUpperCase() || 'FS') as DependencyKind;
  if (kind !== 'FS' && kind !== 'SS') throw new ProjectSystemError('kind', 'a link is finish-to-start (FS) or start-to-start (SS)');
  const lag = wholeDays(input.lagDays, 'lag_days', 0);
  if (lag < -365 || lag > 365) throw new ProjectSystemError('lag_days', 'a lag is within a year either way');
  const links = await activeLinks(tx, projectCode);
  if (links.some((l) => l.predecessor === pred.code && l.successor === succ.code)) throw new ProjectSystemError('dependency', `${pred.code} → ${succ.code} is already linked`);
  const codes = (await tx.select({ code: projectActivity.code }).from(projectActivity).where(and(eq(projectActivity.projectCode, projectCode), ne(projectActivity.status, 'cancelled')))).map((a) => a.code);
  topologicalOrder(codes, [...links, { predecessor: pred.code, successor: succ.code, kind, lagDays: lag }]);
  const [created] = await tx
    .insert(projectActivityDependency)
    .values({ projectCode, predecessorId: pred.id, successorId: succ.id, kind, lagDays: lag, createdBy: ctx.principal.userId })
    .returning({ id: projectActivityDependency.id });
  await recordChange(tx, ctx, { action: 'project_activity.linked', objectType: ACTIVITY_DOCUMENT_TYPE, objectId: `${projectCode}:${succ.code}`, branchCode: row.branchCode, after: { predecessor: pred.code, successor: succ.code, kind, lagDays: lag } });
  return { id: created!.id };
}

export async function removeDependency(tx: Tx, ctx: ActorContext, projectCode: string, dependencyId: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const [link] = await tx.select().from(projectActivityDependency).where(and(eq(projectActivityDependency.id, dependencyId), eq(projectActivityDependency.projectCode, projectCode))).limit(1);
  if (!link || !link.active) throw new AdminNotFoundError('project_activity_dependency', dependencyId);
  await tx.update(projectActivityDependency).set({ active: false, deactivatedBy: ctx.principal.userId, deactivatedAt: new Date() }).where(eq(projectActivityDependency.id, link.id));
  await recordChange(tx, ctx, { action: 'project_activity.unlinked', objectType: ACTIVITY_DOCUMENT_TYPE, objectId: `${projectCode}:${dependencyId}`, branchCode: row.branchCode, before: { kind: link.kind, lagDays: link.lagDays }, after: { active: false } });
}

async function activeLinks(tx: Tx, projectCode: string) {
  const rows = (
    await tx.execute(sql`
      select d.id, p.code as predecessor, s.code as successor, d.kind, d.lag_days
        from project_activity_dependency d
        join project_activity p on p.id = d.predecessor_id
        join project_activity s on s.id = d.successor_id
       where d.project_code = ${projectCode} and d.active and p.status <> 'cancelled' and s.status <> 'cancelled'
       order by p.code, s.code`)
  ).rows as { id: string; predecessor: string; successor: string; kind: DependencyKind; lag_days: number }[];
  return rows.map((r) => ({ id: r.id, predecessor: r.predecessor, successor: r.successor, kind: r.kind, lagDays: Number(r.lag_days) }));
}

/**
 * The critical-path pass: earliest and latest dates, float and the critical
 * mark written on every open or done activity; the project's scheduled
 * finish; and each milestone's date as a trend row for this run.
 */
export async function scheduleProject(tx: Tx, ctx: ActorContext, projectCode: string, reason?: string | null): Promise<{ finish: string; criticalPath: string[]; run: number }> {
  const [row] = await tx.select().from(project).where(eq(project.code, projectCode)).for('update');
  if (!row) throw new AdminNotFoundError('project', projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (row.status === 'closed') throw new ProjectSystemError('status', `${projectCode} is closed`);
  const activities = await tx.select().from(projectActivity).where(and(eq(projectActivity.projectCode, projectCode), ne(projectActivity.status, 'cancelled')));
  if (activities.length === 0) throw new ProjectSystemError('schedule', `${projectCode} has no activity to schedule`);
  const links = await activeLinks(tx, projectCode);
  const calendar = await calendarOf(tx, projectCode);
  const origin = row.forecastStartsOn ?? row.baselineStartsOn ?? businessToday();
  const result = criticalPath(
    origin,
    calendar,
    activities.map((a) => ({ code: a.code, durationDays: a.durationDays, notBefore: a.notBefore, actualStart: a.actualStart, actualFinish: a.actualFinish })),
    links,
  );
  const run = row.scheduleRun + 1;
  for (const s of result.activities) {
    const a = activities.find((x) => x.code === s.code)!;
    await tx
      .update(projectActivity)
      .set({ earliestStart: s.earliestStart, earliestFinish: s.earliestFinish, latestStart: s.latestStart, latestFinish: s.latestFinish, totalFloat: s.totalFloat, freeFloat: s.freeFloat, isCritical: s.critical, updatedAt: new Date() })
      .where(eq(projectActivity.id, a.id));
    if (a.kind === 'milestone') {
      await tx.insert(projectMilestoneHistory).values({ projectCode, activityId: a.id, scheduleRun: run, scheduledOn: a.reachedOn ?? s.earliestFinish, reason: optionalText(reason), recordedBy: ctx.principal.userId });
    }
  }
  await tx.update(project).set({ scheduleRun: run, scheduledAt: new Date(), scheduledFinishOn: result.finish, updatedAt: new Date() }).where(eq(project.code, projectCode));
  await recordChange(tx, ctx, {
    action: 'project.scheduled',
    objectType: 'project',
    objectId: projectCode,
    branchCode: row.branchCode,
    before: { scheduledFinishOn: row.scheduledFinishOn, run: row.scheduleRun },
    after: { scheduledFinishOn: result.finish, run, criticalPath: result.criticalPath.join(' → '), calendar: calendar.code ?? 'Sun–Thu' },
    reason: optionalText(reason),
  });
  return { finish: result.finish, criticalPath: [...result.criticalPath], run };
}

/** Actual dates and percent of an activity; finishing it closes it. */
export async function recordActual(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  code: string,
  input: { actualStart?: string | null; actualFinish?: string | null; percentComplete?: string | null },
): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'submit', PERMISSION_OBJECT, projectCode);
  if (row.status !== 'active') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; work is recorded on an active project`);
  const before = await loadActivity(tx, projectCode, code);
  if (before.kind !== 'activity') throw new ProjectSystemError('kind', `${code} is a milestone; it is reached, not progressed`);
  if (before.status !== 'open') throw new ProjectSystemError('status', `${code} is ${before.status}`);
  const actualStart = day(input.actualStart, 'actual_start') ?? before.actualStart;
  const actualFinish = day(input.actualFinish, 'actual_finish');
  const typed = (input.percentComplete ?? '').trim();
  let percent = typed ? percentOf(typed, 'percent_complete') : parseDecimal(before.percentComplete, PERCENT);
  if (actualFinish) percent = 100_0000n;
  if ((percent > 0n || actualFinish) && !actualStart) throw new ProjectSystemError('actual_start', 'work that has begun names the day it started');
  if (actualStart && actualFinish && actualFinish < actualStart) throw new ProjectSystemError('actual_finish', 'it finishes on or after it starts');
  if (actualStart && actualStart > businessToday()) throw new ProjectSystemError('actual_start', 'an actual date is not in the future');
  if (actualFinish && actualFinish > businessToday()) throw new ProjectSystemError('actual_finish', 'an actual date is not in the future');
  if (!actualFinish && percent === 100_0000n) throw new ProjectSystemError('actual_finish', 'work at 100 % names the day it finished');
  const status = actualFinish ? 'done' : 'open';
  await tx.update(projectActivity).set({ actualStart, actualFinish, percentComplete: toDecimalString(percent, PERCENT), status, updatedAt: new Date() }).where(eq(projectActivity.id, before.id));
  await recordChange(tx, ctx, {
    action: actualFinish ? 'project_activity.finished' : 'project_activity.progressed',
    objectType: ACTIVITY_DOCUMENT_TYPE,
    objectId: `${projectCode}:${code}`,
    branchCode: row.branchCode,
    before: { actualStart: before.actualStart, percentComplete: before.percentComplete },
    after: { actualStart, actualFinish, percentComplete: toDecimalString(percent, PERCENT) },
  });
}

/** One person reports a milestone reached on a day. */
export async function reachMilestone(tx: Tx, ctx: ActorContext, projectCode: string, code: string, reachedOn: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'submit', PERMISSION_OBJECT, projectCode);
  if (row.status !== 'active') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; milestones are reached on an active project`);
  const before = await loadActivity(tx, projectCode, code);
  if (before.kind !== 'milestone') throw new ProjectSystemError('kind', `${code} is an activity, not a milestone`);
  if (before.status !== 'open' || before.reachedOn) throw new ProjectSystemError('status', `${code} is already reported reached or closed`);
  const on = day(reachedOn, 'reached_on');
  if (!on) throw new ProjectSystemError('reached_on', 'is required');
  if (on > businessToday()) throw new ProjectSystemError('reached_on', 'a milestone is reached on a day that has come');
  await tx.update(projectActivity).set({ reachedOn: on, reachedBy: ctx.principal.userId, updatedAt: new Date() }).where(eq(projectActivity.id, before.id));
  await recordChange(tx, ctx, { action: 'project_activity.reached', objectType: ACTIVITY_DOCUMENT_TYPE, objectId: `${projectCode}:${code}`, branchCode: row.branchCode, after: { reachedOn: on } });
}

/**
 * Another person approves it. A `progress` milestone is a measurement: the
 * element's percent at the day it was reached, measured by the reporter and
 * approved by the approver (§10).
 */
export async function approveMilestone(tx: Tx, ctx: ActorContext, projectCode: string, code: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, projectCode);
  const before = await loadActivity(tx, projectCode, code);
  if (before.kind !== 'milestone' || !before.reachedOn || before.reachedApprovedAt) throw new ProjectSystemError('status', `${code} is not waiting for approval`);
  if (before.reachedBy === ctx.principal.userId) throw new ProjectSystemError('approver', `${code} was reported reached by you; somebody else approves it`);
  const now = new Date();
  await tx.update(projectActivity).set({ reachedApprovedBy: ctx.principal.userId, reachedApprovedAt: now, status: 'done', percentComplete: '100', updatedAt: now }).where(eq(projectActivity.id, before.id));
  if (before.milestoneUsage === 'progress' && before.progressPercent !== null) {
    await tx.execute(sql`
      insert into project_progress (project_code, wbs_code, measured_on, percent_complete, measured_by, approved_by, approved_at, note, activity_id)
      values (${projectCode}, ${before.wbsCode}, ${before.reachedOn}::date, ${before.progressPercent}, ${before.reachedBy}::uuid, ${ctx.principal.userId}::uuid, now(), ${`Milestone ${code} — ${before.name}`}, ${before.id}::uuid)
      on conflict (project_code, wbs_code, measured_on)
      do update set percent_complete = excluded.percent_complete, measured_by = excluded.measured_by, approved_by = excluded.approved_by,
                    approved_at = excluded.approved_at, note = excluded.note, activity_id = excluded.activity_id`);
  }
  await recordChange(tx, ctx, {
    action: 'project_activity.reach_approved',
    objectType: ACTIVITY_DOCUMENT_TYPE,
    objectId: `${projectCode}:${code}`,
    branchCode: row.branchCode,
    after: { reachedOn: before.reachedOn, usage: before.milestoneUsage, progressPercent: before.progressPercent, wbsCode: before.wbsCode },
  });
  // PM-5 §11 — a billing milestone's approval makes its plan line due.
  if (before.milestoneUsage === 'billing') await billing.refreshDue(tx, projectCode);
}

/** PM3 — technical completion waits for every activity done and every milestone reached or cancelled. */
export async function openActivities(tx: Tx, projectCode: string): Promise<string[]> {
  const rows = await tx.select({ code: projectActivity.code }).from(projectActivity).where(and(eq(projectActivity.projectCode, projectCode), eq(projectActivity.status, 'open'))).orderBy(asc(projectActivity.code));
  return rows.map((r) => r.code);
}

export async function activities(tx: Tx, projectCode: string) {
  const rows = await tx
    .select({ activity: projectActivity, responsibleName: appUser.displayName, elementName: projectWbs.name })
    .from(projectActivity)
    .leftJoin(appUser, eq(appUser.id, projectActivity.responsibleUserId))
    .leftJoin(projectWbs, and(eq(projectWbs.projectCode, projectActivity.projectCode), eq(projectWbs.code, projectActivity.wbsCode)))
    .where(eq(projectActivity.projectCode, projectCode))
    .orderBy(asc(projectActivity.code));
  const links = (
    await tx.execute(sql`
      select d.id, p.code as predecessor, s.code as successor, d.kind, d.lag_days, d.active
        from project_activity_dependency d
        join project_activity p on p.id = d.predecessor_id
        join project_activity s on s.id = d.successor_id
       where d.project_code = ${projectCode} and d.active
       order by s.code, p.code`)
  ).rows as { id: string; predecessor: string; successor: string; kind: string; lag_days: number }[];
  return {
    activities: rows.map((r) => ({ ...r.activity, responsibleName: r.responsibleName, elementName: r.elementName })),
    links: links.map((l) => ({ id: l.id, predecessor: l.predecessor, successor: l.successor, kind: l.kind, lagDays: Number(l.lag_days) })),
  };
}

export async function milestoneTrend(tx: Tx, projectCode: string) {
  const rows = await tx
    .select({ activityId: projectMilestoneHistory.activityId, run: projectMilestoneHistory.scheduleRun, on: projectMilestoneHistory.scheduledOn })
    .from(projectMilestoneHistory)
    .where(eq(projectMilestoneHistory.projectCode, projectCode))
    .orderBy(asc(projectMilestoneHistory.scheduleRun));
  const milestones = await tx.select().from(projectActivity).where(and(eq(projectActivity.projectCode, projectCode), eq(projectActivity.kind, 'milestone'))).orderBy(asc(projectActivity.code));
  const runs = [...new Set(rows.map((r) => r.run))].sort((a, b) => a - b);
  return {
    runs,
    milestones: milestones.map((m) => {
      const history = new Map(rows.filter((r) => r.activityId === m.id).map((r) => [r.run, r.on] as const));
      const dates = runs.map((run) => history.get(run) ?? null);
      const known = dates.filter((d): d is string => d !== null);
      const slipDays = known.length >= 2 ? Math.round((Date.parse(known[known.length - 1]!) - Date.parse(known[0]!)) / 86_400_000) : 0;
      return { code: m.code, name: m.name, usage: m.milestoneUsage, status: m.status, reachedOn: m.reachedOn, dates, slipDays };
    }),
  };
}

// ---------------------------------------------------------------------------
// Progress measurements (§10) — Phase 11's rows, with the checks
// ---------------------------------------------------------------------------

export async function measure(tx: Tx, ctx: ActorContext, projectCode: string, input: { wbsCode: string; measuredOn: string; percentComplete: string; note?: string | null }): Promise<{ id: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (row.status !== 'active' && row.status !== 'on_hold' && row.status !== 'closing') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; progress is measured once it is released`);
  const [element] = await tx.select({ active: projectWbs.active }).from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, input.wbsCode))).limit(1);
  if (!element) throw new ProjectSystemError('wbs', `${projectCode} has no element '${input.wbsCode}'`);
  const on = day(input.measuredOn, 'measured_on');
  if (!on) throw new ProjectSystemError('measured_on', 'is required');
  if (on > businessToday()) throw new ProjectSystemError('measured_on', 'progress is measured on a day that has come');
  const percent = percentOf(input.percentComplete, 'percent_complete');
  const [existing] = await tx.select({ id: projectProgress.id }).from(projectProgress).where(and(eq(projectProgress.projectCode, projectCode), eq(projectProgress.wbsCode, input.wbsCode), eq(projectProgress.measuredOn, on))).limit(1);
  if (existing) throw new ProjectSystemError('measured_on', `${input.wbsCode} was already measured on ${on}`);
  const [created] = await tx
    .insert(projectProgress)
    .values({ projectCode, wbsCode: input.wbsCode, measuredOn: on, percentComplete: toDecimalString(percent, PERCENT), measuredBy: ctx.principal.userId, note: optionalText(input.note) })
    .returning({ id: projectProgress.id });
  await recordChange(tx, ctx, { action: 'project.progress_measured', objectType: 'project', objectId: projectCode, branchCode: row.branchCode, after: { wbsCode: input.wbsCode, measuredOn: on, percentComplete: toDecimalString(percent, PERCENT) } });
  return { id: created!.id };
}

export async function measurements(tx: Tx, projectCode: string) {
  const rows = (
    await tx.execute(sql`
      select p.id, p.wbs_code, w.name as element_name, p.measured_on::text, p.percent_complete::text, p.note, p.activity_id,
             m.display_name as measured_by_name, p.measured_by, a.display_name as approved_by_name, p.approved_at
        from project_progress p
        left join project_wbs w on w.project_code = p.project_code and w.code = p.wbs_code
        left join app_user m on m.id = p.measured_by
        left join app_user a on a.id = p.approved_by
       where p.project_code = ${projectCode}
       order by p.measured_on desc, p.wbs_code`)
  ).rows as {
    id: string;
    wbs_code: string;
    element_name: string | null;
    measured_on: string;
    percent_complete: string;
    note: string | null;
    activity_id: string | null;
    measured_by_name: string | null;
    measured_by: string;
    approved_by_name: string | null;
    approved_at: Date | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    wbsCode: r.wbs_code,
    elementName: r.element_name,
    measuredOn: r.measured_on,
    percentComplete: r.percent_complete,
    note: r.note,
    fromMilestone: r.activity_id !== null,
    measuredBy: r.measured_by,
    measuredByName: r.measured_by_name,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
  }));
}

// ---------------------------------------------------------------------------
// Earned value by element (§10, PM9)
// ---------------------------------------------------------------------------

export interface EarnedValueRow {
  readonly code: string;
  readonly parentCode: string | null;
  readonly level: number;
  readonly name: string;
  /** The latest approved measurement of this element itself, to the day; null when none. */
  readonly measuredPercent: string | null;
  readonly budgetIqd: string;
  readonly plannedIqd: string;
  readonly earnedIqd: string;
  readonly actualIqd: string;
  readonly percentComplete: number | null;
  readonly cpi: string | null;
  readonly spi: string | null;
  readonly eacIqd: string;
  readonly vacIqd: string;
}

/**
 * BCWS from the current plan's spread, BCWP from each element's latest
 * approved percent × its own budget, ACWP from the cost rows — all to
 * `asOf`, each element's own figures summed up its subtree before the
 * ratios are taken, so a parent's CPI is its children's money, not an
 * average of their ratios.
 */
export interface OwnFigures {
  budget: bigint;
  planned: bigint;
  earned: bigint;
  actual: bigint;
}

/** Each element's own budget, plan to the day, earned and actual — before any roll-up. */
export async function ownFigures(tx: Tx, projectCode: string, asOf: string) {
  const { elements, own, measured } = await ownFiguresInner(tx, projectCode, asOf);
  return { elements, own, measured };
}

export async function earnedValueTree(tx: Tx, projectCode: string, asOf: string = businessToday()): Promise<EarnedValueRow[]> {
  const { elements, own, measured } = await ownFiguresInner(tx, projectCode, asOf);
  return rollEarnedValue(elements, own, measured);
}

async function ownFiguresInner(tx: Tx, projectCode: string, asOf: string) {
  await load(tx, projectCode);
  const elements = await tx.select({ code: projectWbs.code, parentCode: projectWbs.parentCode, level: projectWbs.level, name: projectWbs.name }).from(projectWbs).where(eq(projectWbs.projectCode, projectCode));
  const { own: ownBudget } = await budget.ownBudgetByElement(tx, projectCode);
  const [version] = await tx.select({ id: projectPlanVersion.id }).from(projectPlanVersion).where(and(eq(projectPlanVersion.projectCode, projectCode), eq(projectPlanVersion.isCurrent, true))).limit(1);
  const plan = version ? await tx.select({ wbsCode: projectPlanLine.wbsCode, period: projectPlanLine.period, amountIqd: projectPlanLine.amountIqd }).from(projectPlanLine).where(eq(projectPlanLine.versionId, version.id)) : [];
  const progress = (
    await tx.execute(sql`
      select distinct on (wbs_code) wbs_code, percent_complete::text as percent
        from project_progress
       where project_code = ${projectCode} and approved_at is not null and measured_on <= ${asOf}::date
       order by wbs_code, measured_on desc, approved_at desc`)
  ).rows as { wbs_code: string; percent: string }[];
  const costs = await tx.select({ wbsCode: projectCost.wbsCode, amountIqd: projectCost.amountIqd }).from(projectCost).where(and(eq(projectCost.projectCode, projectCode), lte(projectCost.incurredOn, asOf)));
  const root = elements.find((e) => e.level === 1)?.code ?? null;

  const own = new Map<string, OwnFigures>(elements.map((e) => [e.code, { budget: 0n, planned: 0n, earned: 0n, actual: 0n }] as const));
  for (const e of elements) own.get(e.code)!.budget = ownBudget.get(e.code) ?? 0n;
  for (const e of elements) {
    const lines = plan.filter((l) => l.wbsCode === e.code).map((l) => ({ period: l.period, amountIqd: parseDecimal(l.amountIqd, MONEY) }));
    own.get(e.code)!.planned = plannedValueAt(lines, asOf);
  }
  const measured = new Map(progress.map((p) => [p.wbs_code, p.percent] as const));
  for (const e of elements) {
    const pct = measured.get(e.code);
    if (pct) own.get(e.code)!.earned = earnedOf(own.get(e.code)!.budget, parseDecimal(pct, PERCENT));
  }
  for (const k of costs) {
    const key = k.wbsCode ?? root;
    if (key && own.has(key)) own.get(key)!.actual += parseDecimal(k.amountIqd, MONEY);
  }
  return { elements, own, measured };
}

function rollEarnedValue(
  elements: readonly { code: string; parentCode: string | null; level: number; name: string }[],
  own: ReadonlyMap<string, OwnFigures>,
  measured: ReadonlyMap<string, string>,
): EarnedValueRow[] {
  type Sums = OwnFigures;
  // Sum each element's own figures over its subtree, deepest first.
  const totals = new Map<string, Sums>([...own].map(([code, s]) => [code, { ...s }] as const));
  for (const e of [...elements].sort((a, b) => b.level - a.level)) {
    if (!e.parentCode) continue;
    const parent = totals.get(e.parentCode);
    const child = totals.get(e.code)!;
    if (!parent) continue;
    parent.budget += child.budget;
    parent.planned += child.planned;
    parent.earned += child.earned;
    parent.actual += child.actual;
  }
  const rows = elements.map((e): EarnedValueRow => {
    const t = totals.get(e.code)!;
    const ev = earnedValue({ budgetIqd: t.budget, plannedIqd: t.planned, earnedIqd: t.earned, actualIqd: t.actual });
    return {
      code: e.code,
      parentCode: e.parentCode,
      level: e.level,
      name: e.name,
      measuredPercent: measured.get(e.code) ?? null,
      budgetIqd: toDecimalString(t.budget, MONEY),
      plannedIqd: toDecimalString(t.planned, MONEY),
      earnedIqd: toDecimalString(t.earned, MONEY),
      actualIqd: toDecimalString(t.actual, MONEY),
      percentComplete: ev.percentComplete,
      cpi: ratioText(ev.cpi),
      spi: ratioText(ev.spi),
      eacIqd: toDecimalString(ev.eacIqd, MONEY),
      vacIqd: toDecimalString(ev.vacIqd, MONEY),
    };
  });
  return treeOrder(rows);
}

export type { DependencyKind };
