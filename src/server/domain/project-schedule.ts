/**
 * The Project System's schedule and earned value — REQ-PM-001 §5 (activities
 * and milestones), §10 (earned value), Stage PM-4. No database: the working
 * calendar, the critical-path pass over the dependencies, and the EVM
 * arithmetic in scaled bigints.
 *
 * D-PM-4 asks for forward-pass scheduling with float and the critical path.
 * Total float needs the latest dates, so the backward pass is computed too —
 * for float only: no resource levelling, no constraint other than an
 * activity's own "not before" date (recorded as a refinement of D-PM-4).
 */
import { divideHalfUp } from './money';
import { ProjectSystemError } from './project-system';

// ---------------------------------------------------------------------------
// The working calendar
// ---------------------------------------------------------------------------

const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface WorkCalendar {
  /** "sun,mon,tue,wed,thu" */
  readonly workingDays: readonly string[];
  readonly holidays: ReadonlySet<string>;
}

/** Iraq's working week, for a project whose branch names no calendar. */
export const DEFAULT_CALENDAR: WorkCalendar = { workingDays: ['sun', 'mon', 'tue', 'wed', 'thu'], holidays: new Set() };

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const fromDate = (d: Date) => d.toISOString().slice(0, 10);

export function isWorkingDay(day: string, calendar: WorkCalendar): boolean {
  const key = WEEKDAY_KEYS[toDate(day).getUTCDay()]!;
  return calendar.workingDays.includes(key) && !calendar.holidays.has(day);
}

/** The first working day on or after `day`. */
export function nextWorkingDay(day: string, calendar: WorkCalendar): string {
  if (calendar.workingDays.length === 0) throw new ProjectSystemError('calendar', 'the calendar has no working day');
  const d = toDate(day);
  for (let i = 0; i < 3660; i += 1) {
    const s = fromDate(d);
    if (isWorkingDay(s, calendar)) return s;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new ProjectSystemError('calendar', 'no working day within ten years');
}

/**
 * Working day `index` counted from `origin` (itself day 0, moved to the
 * first working day). The schedule is computed in these indices and turned
 * back into dates at the end.
 */
export class WorkingDays {
  private readonly days: string[] = [];
  constructor(
    readonly origin: string,
    private readonly calendar: WorkCalendar,
  ) {
    this.days.push(nextWorkingDay(origin, calendar));
  }

  dateOf(index: number): string {
    if (index < 0) throw new ProjectSystemError('schedule', 'a date before the project start');
    while (this.days.length <= index) {
      const last = toDate(this.days[this.days.length - 1]!);
      last.setUTCDate(last.getUTCDate() + 1);
      this.days.push(nextWorkingDay(fromDate(last), this.calendar));
    }
    return this.days[index]!;
  }

  /** The index of the first working day on or after `day` (0 for a day before the origin). */
  indexOf(day: string): number {
    if (day <= this.days[0]!) return 0;
    let i = 0;
    while (this.dateOf(i) < day) i += 1;
    return i;
  }
}

// ---------------------------------------------------------------------------
// The critical-path pass (§5, D-PM-4)
// ---------------------------------------------------------------------------

export type DependencyKind = 'FS' | 'SS';

export interface ScheduleActivity {
  readonly code: string;
  /** Working days; 0 is a milestone. */
  readonly durationDays: number;
  /** "Not before": the earliest day the activity may start. */
  readonly notBefore?: string | null;
  /** Once work has started the actual start pins it. */
  readonly actualStart?: string | null;
  readonly actualFinish?: string | null;
}

export interface ScheduleDependency {
  readonly predecessor: string;
  readonly successor: string;
  readonly kind: DependencyKind;
  readonly lagDays: number;
}

export interface ScheduledActivity {
  readonly code: string;
  readonly earliestStart: string;
  readonly earliestFinish: string;
  readonly latestStart: string;
  readonly latestFinish: string;
  /** Working days the activity may slip without moving the project's finish. */
  readonly totalFloat: number;
  /** Working days it may slip without moving any successor. */
  readonly freeFloat: number;
  readonly critical: boolean;
}

export interface ScheduleResult {
  readonly activities: readonly ScheduledActivity[];
  readonly finish: string;
  /** The critical activities in the order they are worked. */
  readonly criticalPath: readonly string[];
}

/** Codes in dependency order; a cycle is refused with the activities on it. */
export function topologicalOrder(codes: readonly string[], dependencies: readonly ScheduleDependency[]): string[] {
  const known = new Set(codes);
  const incoming = new Map<string, number>(codes.map((c): [string, number] => [c, 0]));
  const outgoing = new Map<string, string[]>(codes.map((c) => [c, []]));
  for (const d of dependencies) {
    if (!known.has(d.predecessor) || !known.has(d.successor)) throw new ProjectSystemError('dependency', `${d.predecessor} → ${d.successor} names an activity that is not on the project`);
    if (d.predecessor === d.successor) throw new ProjectSystemError('dependency', `${d.predecessor} cannot depend on itself`);
    outgoing.get(d.predecessor)!.push(d.successor);
    incoming.set(d.successor, (incoming.get(d.successor) ?? 0) + 1);
  }
  const queue = codes.filter((c) => (incoming.get(c) ?? 0) === 0).sort();
  const out: string[] = [];
  while (queue.length) {
    const c = queue.shift()!;
    out.push(c);
    for (const s of outgoing.get(c) ?? []) {
      const n = (incoming.get(s) ?? 0) - 1;
      incoming.set(s, n);
      if (n === 0) {
        queue.push(s);
        queue.sort();
      }
    }
  }
  if (out.length !== codes.length) {
    const stuck = codes.filter((c) => !out.includes(c)).sort();
    throw new ProjectSystemError('dependency', `the dependencies make a loop through ${stuck.join(', ')}`);
  }
  return out;
}

/**
 * Forward pass for the earliest dates, backward pass for the latest and the
 * float. Computed on time points: point k is the start of working day k. An
 * activity of d days runs from point s to point s+d; a milestone is a single
 * point, shown as the working day that ends at it (a completion milestone
 * after a five-day activity falls on that activity's last day, and its
 * finish-to-start successor starts the next working day).
 */
export function schedule(origin: string, calendar: WorkCalendar, activities: readonly ScheduleActivity[], dependencies: readonly ScheduleDependency[]): ScheduleResult {
  if (activities.length === 0) return { activities: [], finish: nextWorkingDay(origin, calendar), criticalPath: [] };
  const days = new WorkingDays(origin, calendar);
  const byCode = new Map(activities.map((a) => [a.code, a] as const));
  for (const a of activities) {
    if (!Number.isInteger(a.durationDays) || a.durationDays < 0) throw new ProjectSystemError('duration', `${a.code}: a duration is a whole number of working days`);
  }
  for (const d of dependencies) if (!Number.isInteger(d.lagDays)) throw new ProjectSystemError('lag', `${d.predecessor} → ${d.successor}: a lag is a whole number of working days`);
  const order = topologicalOrder([...byCode.keys()], dependencies);
  const preds = new Map<string, ScheduleDependency[]>(order.map((c): [string, ScheduleDependency[]] => [c, []]));
  const succs = new Map<string, ScheduleDependency[]>(order.map((c): [string, ScheduleDependency[]] => [c, []]));
  for (const d of dependencies) {
    preds.get(d.successor)!.push(d);
    succs.get(d.predecessor)!.push(d);
  }
  const isMilestone = (a: ScheduleActivity) => a.durationDays === 0;
  /** A day as a point: an activity starts at the start of it, a milestone stands at the end of it. */
  const pointOf = (a: ScheduleActivity, day: string) => days.indexOf(day) + (isMilestone(a) ? 1 : 0);

  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const code of order) {
    const a = byCode.get(code)!;
    let start = a.notBefore ? pointOf(a, a.notBefore) : 0;
    for (const d of preds.get(code)!) start = Math.max(start, d.kind === 'FS' ? ef.get(d.predecessor)! + d.lagDays : es.get(d.predecessor)! + d.lagDays);
    if (a.actualStart) start = pointOf(a, a.actualStart);
    let finish = start + a.durationDays;
    if (a.actualFinish && !isMilestone(a)) finish = Math.max(start + 1, days.indexOf(a.actualFinish) + 1);
    es.set(code, start);
    ef.set(code, finish);
  }
  const end = Math.max(...order.map((c) => ef.get(c)!));
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  for (const code of [...order].reverse()) {
    const length = ef.get(code)! - es.get(code)!;
    let latestFinish = end;
    for (const d of succs.get(code)!) latestFinish = Math.min(latestFinish, d.kind === 'FS' ? ls.get(d.successor)! - d.lagDays : ls.get(d.successor)! - d.lagDays + length);
    lf.set(code, latestFinish);
    ls.set(code, latestFinish - length);
  }
  const startDay = (point: number) => days.dateOf(Math.max(0, point));
  const finishDay = (point: number) => days.dateOf(Math.max(0, point - 1));
  const scheduled = order.map((code): ScheduledActivity => {
    const a = byCode.get(code)!;
    const totalFloat = Math.max(0, ls.get(code)! - es.get(code)!);
    let freeFloat = end - ef.get(code)!;
    for (const d of succs.get(code)!) freeFloat = Math.min(freeFloat, d.kind === 'FS' ? es.get(d.successor)! - d.lagDays - ef.get(code)! : es.get(d.successor)! - d.lagDays - es.get(code)!);
    const milestone = isMilestone(a);
    return {
      code,
      earliestStart: milestone ? finishDay(es.get(code)!) : startDay(es.get(code)!),
      earliestFinish: finishDay(ef.get(code)!),
      latestStart: milestone ? finishDay(ls.get(code)!) : startDay(ls.get(code)!),
      latestFinish: finishDay(lf.get(code)!),
      totalFloat,
      freeFloat: Math.max(0, freeFloat),
      critical: totalFloat === 0,
    };
  });
  const criticalPath = order.filter((c) => scheduled.find((x) => x.code === c)!.critical).sort((x, y) => es.get(x)! - es.get(y)! || ef.get(x)! - ef.get(y)! || x.localeCompare(y));
  return { activities: scheduled, finish: finishDay(end), criticalPath };
}

// ---------------------------------------------------------------------------
// Earned value (§10)
// ---------------------------------------------------------------------------

const RATIO = 10_000n; // ratios carried to four decimals

export interface EarnedValueInput {
  /** The element's current budget (own plus descendants). */
  readonly budgetIqd: bigint;
  /** BCWS — the plan to the date. */
  readonly plannedIqd: bigint;
  /** BCWP — earned. */
  readonly earnedIqd: bigint;
  /** ACWP — actual to the date. */
  readonly actualIqd: bigint;
}

export interface EarnedValue extends EarnedValueInput {
  /** Earned ÷ budget, in percent to two decimals; null without a budget. */
  readonly percentComplete: number | null;
  /** BCWP ÷ ACWP, scaled by 10,000; null without an actual. */
  readonly cpi: bigint | null;
  /** BCWP ÷ BCWS, scaled by 10,000; null without a plan to date. */
  readonly spi: bigint | null;
  readonly eacIqd: bigint;
  readonly vacIqd: bigint;
  /** BCWP − ACWP, BCWP − BCWS. */
  readonly costVarianceIqd: bigint;
  readonly scheduleVarianceIqd: bigint;
}

/** BCWP of one element: its approved percent (scaled by 10,000 as 100.0000 % = 1,000,000) × its own budget. */
export function earnedOf(budgetIqd: bigint, percentScaled: bigint): bigint {
  return divideHalfUp(budgetIqd * percentScaled, 1_000_000n);
}

/**
 * §10 — CPI and SPI as ratios; EAC = ACWP + (budget − BCWP) ÷ CPI, which is
 * budget ÷ CPI when work has been done. With nothing spent yet the
 * remaining work is taken at budget (CPI undefined is not CPI infinite).
 */
export function earnedValue(input: EarnedValueInput): EarnedValue {
  const { budgetIqd, plannedIqd, earnedIqd, actualIqd } = input;
  const cpi = actualIqd > 0n ? divideHalfUp(earnedIqd * RATIO, actualIqd) : null;
  const spi = plannedIqd > 0n ? divideHalfUp(earnedIqd * RATIO, plannedIqd) : null;
  const remaining = budgetIqd - earnedIqd;
  const eacIqd = cpi !== null && cpi > 0n ? actualIqd + divideHalfUp(remaining * RATIO, cpi) : actualIqd + remaining;
  return {
    ...input,
    percentComplete: budgetIqd > 0n ? Number(divideHalfUp(earnedIqd * 10_000n, budgetIqd)) / 100 : null,
    cpi,
    spi,
    eacIqd,
    vacIqd: budgetIqd - eacIqd,
    costVarianceIqd: earnedIqd - actualIqd,
    scheduleVarianceIqd: earnedIqd - plannedIqd,
  };
}

/**
 * BCWS to a day from a monthly spread: whole months before the day's month,
 * and the day's month in proportion to the calendar days elapsed.
 */
export function plannedValueAt(lines: readonly { readonly period: string; readonly amountIqd: bigint }[], asOf: string): bigint {
  const month = asOf.slice(0, 7);
  const day = Number(asOf.slice(8, 10));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let total = 0n;
  for (const line of lines) {
    const p = line.period.slice(0, 7);
    if (p < month) total += line.amountIqd;
    else if (p === month) total += divideHalfUp(line.amountIqd * BigInt(day), BigInt(daysInMonth));
  }
  return total;
}

/** A ratio scaled by 10,000 as text to two decimals, half up: 9,500 → "0.95", 8,000 → "0.80". */
export function ratioText(value: bigint | null): string | null {
  if (value === null) return null;
  const hundredths = divideHalfUp(value, 100n);
  const sign = hundredths < 0n ? '-' : '';
  const abs = hundredths < 0n ? -hundredths : hundredths;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}
