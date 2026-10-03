/**
 * Employee advances and loans — REQ-HR-001 Stage HR-4 (§10): the arithmetic,
 * with no database.
 *
 * An advance is lent in whole dinars and recovered in instalments, one a
 * month from its first recovery month: every instalment but the last is the
 * amount ÷ the instalments rounded down to the dinar, the last takes what is
 * left, so the instalments add up to the amount exactly. What a month's pay
 * recovers is what the schedule says is due by that month less what has
 * already come back — so a month whose payroll recovered nothing is caught
 * up the next — and never more than is still owed (H6).
 */
import { MONEY_SCALE } from './money';

export const ADVANCE_KINDS = ['advance', 'loan'] as const;
export type AdvanceKind = (typeof ADVANCE_KINDS)[number];

export const ADVANCE_STATUSES = ['draft', 'submitted', 'endorsed', 'approved', 'paid', 'settled', 'refused', 'cancelled'] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

export const ADVANCE_TRANSITIONS: Readonly<Record<AdvanceStatus, readonly AdvanceStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['endorsed', 'refused', 'cancelled'],
  endorsed: ['approved', 'refused', 'cancelled'],
  approved: ['paid', 'cancelled'],
  paid: ['settled'],
  settled: ['paid'],
  refused: [],
  cancelled: [],
};

export class AdvanceError extends Error {
  readonly code = 'EMPLOYEE_ADVANCE';
  constructor(message: string) {
    super(message);
    this.name = 'AdvanceError';
  }
}

export function assertAdvanceTransition(advanceNo: string, from: string, to: AdvanceStatus): void {
  const allowed = ADVANCE_TRANSITIONS[from as AdvanceStatus] ?? [];
  if (!allowed.includes(to)) throw new AdvanceError(`${advanceNo} is ${from}; it cannot become ${to}.`);
}

const DINAR = 10n ** MONEY_SCALE;

/** Whole dinars only: an advance is handed over in notes, not fils. */
export function assertWholeDinars(amount: bigint, field: string): void {
  if (amount <= 0n) throw new AdvanceError(`${field} must be more than nothing.`);
  if (amount % DINAR !== 0n) throw new AdvanceError(`${field} is lent in whole dinars.`);
}

/** The instalments, each scaled by 10⁴: equal to the dinar, the last takes the rest. */
export function instalmentPlan(amount: bigint, instalments: number): bigint[] {
  if (!Number.isInteger(instalments) || instalments < 1 || instalments > 60) throw new AdvanceError('An advance is recovered in 1 to 60 monthly instalments.');
  const n = BigInt(instalments);
  const each = (amount / n / DINAR) * DINAR;
  return Array.from({ length: instalments }, (_, i) => (i < instalments - 1 ? each : amount - each * (n - 1n)));
}

/** "YYYY-MM-01" → months between two firsts of the month (b − a). */
export function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return (yb - ya) * 12 + (mb - ma);
}

/** The first day of the month after the one a day falls in. */
export function nextMonth(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export interface Schedule {
  readonly amount: bigint;
  readonly instalments: number;
  /** First day of the month the first instalment is recovered in. */
  readonly firstRecoveryMonth: string;
}

/** What the schedule says has come back by the end of a month (first day given). */
export function dueBy(schedule: Schedule, month: string): bigint {
  const count = monthsBetween(schedule.firstRecoveryMonth, month) + 1;
  if (count <= 0) return 0n;
  return instalmentPlan(schedule.amount, schedule.instalments)
    .slice(0, Math.min(count, schedule.instalments))
    .reduce((sum, value) => sum + value, 0n);
}

/** What a month's pay recovers on one advance: due by the month less what is back, never more than is owed. */
export function recoveryFor(schedule: Schedule, recovered: bigint, month: string): bigint {
  const owed = schedule.amount - recovered;
  if (owed <= 0n) return 0n;
  const due = dueBy(schedule, month) - recovered;
  if (due <= 0n) return 0n;
  return due > owed ? owed : due;
}

/** The month whose instalment is the oldest not yet recovered, or null when nothing is behind by `month`. */
export function behindSince(schedule: Schedule, recovered: bigint, month: string): string | null {
  if (dueBy(schedule, month) <= recovered) return null;
  const plan = instalmentPlan(schedule.amount, schedule.instalments);
  let cumulative = 0n;
  for (let i = 0; i < plan.length; i += 1) {
    cumulative += plan[i]!;
    if (cumulative > recovered) {
      const [y, m] = schedule.firstRecoveryMonth.split('-').map(Number) as [number, number];
      return new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * A recovery split over a person's advances, the oldest first: each takes
 * what its schedule has due, until the recovery is spent.
 */
export function allocateRecovery<T extends { readonly id: string; readonly schedule: Schedule; readonly recovered: bigint }>(
  advances: readonly T[],
  amount: bigint,
  month: string,
): { id: string; amount: bigint }[] {
  let left = amount;
  const out: { id: string; amount: bigint }[] = [];
  for (const advance of advances) {
    if (left <= 0n) break;
    const due = recoveryFor(advance.schedule, advance.recovered, month);
    if (due <= 0n) continue;
    const take = due < left ? due : left;
    out.push({ id: advance.id, amount: take });
    left -= take;
  }
  return out;
}
