/**
 * The Project System's planning and budget rules — REQ-PM-001 §7, Stage
 * PM-2: what a budget document of each kind may carry, where an assignment
 * stands against the tolerance profile, and how a plan spreads over months.
 * No database.
 */
import { ProjectSystemError } from './project-system';

export type BudgetDocumentKind = 'original' | 'supplement' | 'return' | 'transfer';

export const BUDGET_DOCUMENT_KINDS: readonly BudgetDocumentKind[] = ['original', 'supplement', 'return', 'transfer'];

export interface BudgetLineInput {
  readonly wbsCode: string;
  readonly costCode: string;
  /** Signed: positive adds budget to the element, negative takes it. */
  readonly amountIqd: bigint;
  readonly description?: string | null;
}

/**
 * The sign rule of each kind, and the document's total. An original and a
 * supplement add; a return takes; a transfer moves — its lines sum to zero
 * with at least one giver and one receiver.
 */
export function budgetDocumentTotal(kind: BudgetDocumentKind, lines: readonly BudgetLineInput[]): bigint {
  if (lines.length === 0) throw new ProjectSystemError('lines', 'a budget document carries at least one line');
  const seen = new Set<string>();
  let total = 0n;
  let positive = 0;
  let negative = 0;
  for (const line of lines) {
    if (line.amountIqd === 0n) throw new ProjectSystemError('lines', `${line.wbsCode} / ${line.costCode}: an amount of zero moves nothing`);
    const key = `${line.wbsCode}|${line.costCode}`;
    if (seen.has(key)) throw new ProjectSystemError('lines', `${line.wbsCode} / ${line.costCode} appears twice; one line per element and cost code`);
    seen.add(key);
    if (line.amountIqd > 0n) positive += 1;
    else negative += 1;
    total += line.amountIqd;
  }
  switch (kind) {
    case 'original':
    case 'supplement':
      if (negative > 0) throw new ProjectSystemError('lines', `${kind === 'original' ? 'an original budget' : 'a supplement'} adds budget; a line that takes it is a return`);
      return total;
    case 'return':
      if (positive > 0) throw new ProjectSystemError('lines', 'a return takes budget; a line that adds it is a supplement');
      return total;
    case 'transfer':
      if (total !== 0n) throw new ProjectSystemError('lines', 'a transfer moves budget between elements; its lines sum to zero');
      if (positive === 0 || negative === 0) throw new ProjectSystemError('lines', 'a transfer names the element that gives and the element that receives');
      return 0n;
  }
}

// ---------------------------------------------------------------------------
// Availability control (§7, D-PM-5)
// ---------------------------------------------------------------------------

export interface ToleranceLines {
  readonly warnPercent: number;
  readonly stopPercent: number;
}

export interface AvailabilityDecision {
  /** Where the element stands once the amount is assigned. */
  readonly state: 'ok' | 'warn' | 'stop';
  /** The warning line was crossed by this assignment (it was below before). */
  readonly crossedWarn: boolean;
  /** Assigned ÷ budget after, in percent with two decimals; null without a budget. */
  readonly percentAfter: number | null;
  readonly availableBeforeIqd: bigint;
  readonly availableAfterIqd: bigint;
  /** The stop line that applied: the profile's, or the one raised for the element. */
  readonly stopPercent: number;
}

function percentOf(assignedIqd: bigint, budgetIqd: bigint): number {
  return Number((assignedIqd * 10000n) / budgetIqd) / 100;
}

/** `assigned ÷ budget` against a line in percent, exactly — no rounding decides a refusal. */
function reaches(assignedIqd: bigint, budgetIqd: bigint, linePercent: number): boolean {
  return assignedIqd * 1_000_000n >= budgetIqd * BigInt(Math.round(linePercent * 10000));
}

function exceeds(assignedIqd: bigint, budgetIqd: bigint, linePercent: number): boolean {
  return assignedIqd * 1_000_000n > budgetIqd * BigInt(Math.round(linePercent * 10000));
}

/**
 * Where an assignment of `requestedIqd` leaves an element that has
 * `budgetIqd` and already carries `assignedIqd` (commitments + actuals).
 * Above the stop line it is refused; at or above the warning line the
 * responsible people are told, once, as it is crossed. A raised stop line
 * replaces the profile's for that element.
 */
export function availabilityDecision(
  budgetIqd: bigint,
  assignedIqd: bigint,
  requestedIqd: bigint,
  profile: ToleranceLines,
  raisedStopPercent: number | null = null,
): AvailabilityDecision {
  const stopPercent = raisedStopPercent ?? profile.stopPercent;
  const after = assignedIqd + requestedIqd;
  const availableBeforeIqd = budgetIqd - assignedIqd;
  const availableAfterIqd = budgetIqd - after;
  if (budgetIqd <= 0n) {
    return {
      state: after > 0n ? 'stop' : 'ok',
      crossedWarn: false,
      percentAfter: null,
      availableBeforeIqd,
      availableAfterIqd,
      stopPercent,
    };
  }
  const percentAfter = percentOf(after, budgetIqd);
  const state: AvailabilityDecision['state'] = exceeds(after, budgetIqd, stopPercent) ? 'stop' : reaches(after, budgetIqd, profile.warnPercent) ? 'warn' : 'ok';
  return {
    state,
    crossedWarn: state === 'warn' && !reaches(assignedIqd, budgetIqd, profile.warnPercent),
    percentAfter,
    availableBeforeIqd,
    availableAfterIqd,
    stopPercent,
  };
}

/** D-PM-5 — the stop line a project manager may raise to; beyond it the accounting manager. */
export const RAISED_STOP_WITHOUT_ACCOUNTING = 110;
export const RAISED_STOP_CEILING = 200;

export function assertRaisedStopLine(percent: number, profile: ToleranceLines, mayExceed: boolean): void {
  if (!Number.isFinite(percent) || percent <= profile.stopPercent) {
    throw new ProjectSystemError('stop_percent', `a raised stop line is above the profile's ${profile.stopPercent} %`);
  }
  if (percent > RAISED_STOP_CEILING) throw new ProjectSystemError('stop_percent', `a stop line is ${RAISED_STOP_CEILING} % at most`);
  if (percent > RAISED_STOP_WITHOUT_ACCOUNTING && !mayExceed) {
    throw new ProjectSystemError('stop_percent', `above ${RAISED_STOP_WITHOUT_ACCOUNTING} % the accounting manager raises the line (D-PM-5)`);
  }
}

// ---------------------------------------------------------------------------
// The cost plan's spread over months (§7, §10)
// ---------------------------------------------------------------------------

/** The first day of each month from `from` to `to` inclusive (both `YYYY-MM-DD`). */
export function monthsBetween(from: string, to: string): string[] {
  const start = /^(\d{4})-(\d{2})/.exec(from);
  const end = /^(\d{4})-(\d{2})/.exec(to);
  if (!start || !end) throw new ProjectSystemError('period', 'a plan period is a date');
  let year = Number(start[1]);
  let month = Number(start[2]);
  const endYear = Number(end[1]);
  const endMonth = Number(end[2]);
  if (year * 12 + month > endYear * 12 + endMonth) throw new ProjectSystemError('period', 'the plan ends before it starts');
  const out: string[] = [];
  while (year * 12 + month <= endYear * 12 + endMonth) {
    out.push(`${year}-${String(month).padStart(2, '0')}-01`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/** `total` over `months`, evenly; the remainder on the last month so the sum is exact. */
export function spreadEvenly(totalIqd: bigint, months: readonly string[]): Map<string, bigint> {
  if (months.length === 0) throw new ProjectSystemError('period', 'a plan spreads over at least one month');
  if (totalIqd < 0n) throw new ProjectSystemError('amount', 'a plan amount is not negative');
  const n = BigInt(months.length);
  const share = totalIqd / n;
  const out = new Map<string, bigint>();
  let placed = 0n;
  months.forEach((month, i) => {
    const amount = i === months.length - 1 ? totalIqd - placed : share;
    out.set(month, amount);
    placed += amount;
  });
  return out;
}

/** The planned value up to and including a month — BCWS's cumulative input. */
export function plannedThrough(lines: readonly { readonly period: string; readonly amountIqd: bigint }[], month: string): bigint {
  const cutoff = month.slice(0, 7);
  let total = 0n;
  for (const line of lines) if (line.period.slice(0, 7) <= cutoff) total += line.amountIqd;
  return total;
}
