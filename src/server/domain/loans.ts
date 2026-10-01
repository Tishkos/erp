/**
 * Loans — REQ-AP-001 §15.7, decidable without a database.
 *
 * Amounts are bigints at the money scale (4 decimals, `MONEY_SCALE`); a
 * percentage is a decimal string ("2", "2.5"). Every split rounds its parts to
 * the cent and gives the remainder to the last part — "the last instalment
 * absorbs rounding", and so does the last share of an equal split.
 */
import { MONEY_SCALE, parseDecimal } from './money';
import { addDays, formatAmount } from './payment-applications';

export class LoanError extends Error {
  readonly code = 'LOAN_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'LoanError';
  }
}

export const LOAN_STATUSES = ['draft', 'approved', 'active', 'fully_repaid', 'cancelled'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const FREQUENCIES = ['monthly', 'quarterly', 'custom'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const ALLOCATION_METHODS = ['by_amount_used', 'equal', 'manual'] as const;
export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export const INSTALMENT_STATES = ['upcoming', 'due', 'paid', 'overdue'] as const;
export type InstalmentState = (typeof INSTALMENT_STATES)[number];

/** One cent at the money scale. */
const CENT = 100n;
const ONE = 10n ** MONEY_SCALE;

// ---------------------------------------------------------------------------
// The status machine
// ---------------------------------------------------------------------------

const MOVES: Readonly<Record<LoanStatus, readonly LoanStatus[]>> = {
  draft: ['approved', 'cancelled'],
  approved: ['active', 'cancelled'],
  active: ['fully_repaid'],
  fully_repaid: [],
  cancelled: [],
};

export function assertMove(loanNo: string, from: string, to: LoanStatus): void {
  const allowed = MOVES[from as LoanStatus] ?? [];
  if (!allowed.includes(to)) {
    const why: Record<string, string> = {
      cancelled: 'it is cancelled',
      fully_repaid: 'it is fully repaid',
      active: 'its money has arrived — a disbursed loan is repaid, not cancelled',
    };
    throw new LoanError(
      `${loanNo} cannot become ${to.replace('_', ' ')}: ${why[from] ?? `it is ${from.replace('_', ' ')}`}.`,
    );
  }
}

/** A schedule may be rewritten only before the loan is approved. */
export function scheduleEditable(status: string): boolean {
  return status === 'draft';
}

// ---------------------------------------------------------------------------
// Commission and proceeds
// ---------------------------------------------------------------------------

/** A percentage as typed — "2", "2.5", "0.75" — at 4 decimals, 0 ≤ p < 100. */
export function percentOf(value: string | null | undefined, label: string): bigint {
  const text = (value ?? '').trim();
  if (!text) return 0n;
  if (!/^\d+(\.\d{1,4})?$/.test(text)) throw new LoanError(`${label} "${text}" is not a percentage.`);
  const parsed = parseDecimal(text, 4n);
  if (parsed >= 100n * ONE) throw new LoanError(`${label} of ${text}% is not a loan's.`);
  return parsed;
}

/** principal × pct / 100, to the cent, half up. */
export function commissionOf(principal: bigint, pct: bigint): bigint {
  return roundToCent((principal * pct) / (100n * ONE));
}

/** To the cent, half up (amounts here are never negative). */
function roundToCent(value: bigint): bigint {
  const rest = value % CENT;
  return rest * 2n >= CENT ? value - rest + CENT : value - rest;
}

/** What lands in the account: the principal less a commission taken out of it. */
export function netProceeds(principal: bigint, commission: bigint, deducted: boolean): bigint {
  return deducted ? principal - commission : principal;
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------

/** Adds whole months; a day past the month's end lands on its last day. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Equal parts to the cent; the last takes what rounding left. */
export function splitEvenly(total: bigint, count: number): bigint[] {
  if (count <= 0) return [];
  const part = (total / BigInt(count) / CENT) * CENT;
  const parts = Array.from({ length: count }, () => part);
  parts[count - 1] = total - part * BigInt(count - 1);
  return parts;
}

export function dueDates(first: string, count: number, frequency: Frequency, custom?: readonly string[]): string[] {
  if (frequency === 'custom') {
    const dates = (custom ?? []).filter(Boolean);
    if (dates.length !== count) {
      throw new LoanError(`A custom schedule names each of its ${count} due dates; ${dates.length} given.`);
    }
    for (let i = 1; i < dates.length; i += 1) {
      if (dates[i]! <= dates[i - 1]!) throw new LoanError(`Due dates run forward: ${dates[i]} is not after ${dates[i - 1]}.`);
    }
    return [...dates];
  }
  const step = frequency === 'monthly' ? 1 : 3;
  return Array.from({ length: count }, (_, i) => addMonths(first, i * step));
}

export interface ScheduleInput {
  readonly principal: bigint;
  readonly commission: bigint;
  /** The commission is paid with the instalments, in equal shares. */
  readonly spreadCommission: boolean;
  readonly interestPctPa: bigint | null;
  readonly count: number;
  readonly frequency: Frequency;
  readonly firstDueDate: string;
  readonly customDates?: readonly string[];
  /** Interest runs from here to the first due date (the disbursement, or the loan's date). */
  readonly startDate: string;
}

export interface ScheduleRow {
  readonly sequence: number;
  readonly dueDate: string;
  readonly principal: bigint;
  readonly commission: bigint;
  readonly interest: bigint;
  readonly total: bigint;
}

/**
 * §15.7 — equal principal, the last absorbing rounding; a spread commission in
 * equal shares; interest on the outstanding principal for the days of each
 * period (actual/365), none when the loan carries no rate.
 */
export function buildSchedule(input: ScheduleInput): ScheduleRow[] {
  if (input.count <= 0) throw new LoanError('A loan is repaid in at least one instalment.');
  if (input.principal <= 0n) throw new LoanError('A loan has a principal.');
  const dates = dueDates(input.firstDueDate, input.count, input.frequency, input.customDates);
  if (dates[0]! < input.startDate) {
    throw new LoanError(`The first instalment (${dates[0]}) falls before the loan starts (${input.startDate}).`);
  }
  const principals = splitEvenly(input.principal, input.count);
  const commissions = input.spreadCommission ? splitEvenly(input.commission, input.count) : principals.map(() => 0n);
  let outstanding = input.principal;
  let from = input.startDate;
  return dates.map((dueDate, index) => {
    const days = BigInt(Math.max(0, Math.round((Date.parse(dueDate) - Date.parse(from)) / 86_400_000)));
    const interest = input.interestPctPa
      ? roundToCent((outstanding * input.interestPctPa * days) / (100n * ONE * 365n))
      : 0n;
    const principal = principals[index]!;
    const commission = commissions[index]!;
    outstanding -= principal;
    from = dueDate;
    return {
      sequence: index + 1,
      dueDate,
      principal,
      commission,
      interest,
      total: principal + commission + interest,
    };
  });
}

/** A schedule typed by hand (before approval) must still repay the principal exactly. */
export function assertScheduleRepays(
  loanNo: string,
  rows: readonly Pick<ScheduleRow, 'dueDate' | 'principal' | 'commission' | 'interest'>[],
  principal: bigint,
  spreadCommission: bigint,
): void {
  if (rows.length === 0) throw new LoanError(`${loanNo}: a schedule has at least one instalment.`);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!row.dueDate) throw new LoanError(`${loanNo}: instalment ${i + 1} has no due date.`);
    if (row.principal < 0n || row.commission < 0n || row.interest < 0n) {
      throw new LoanError(`${loanNo}: instalment ${i + 1} has a negative amount.`);
    }
    if (row.principal + row.commission + row.interest <= 0n) {
      throw new LoanError(`${loanNo}: instalment ${i + 1} repays nothing.`);
    }
    if (i > 0 && row.dueDate <= rows[i - 1]!.dueDate) {
      throw new LoanError(`${loanNo}: due dates run forward; instalment ${i + 1} is not after ${i}.`);
    }
  }
  const repaid = rows.reduce((sum, row) => sum + row.principal, 0n);
  if (repaid !== principal) {
    const gap = principal - repaid;
    throw new LoanError(
      `${loanNo}: the instalments repay ${formatAmount(repaid)} of a ${formatAmount(principal)} principal — ` +
        `${gap > 0n ? 'short' : 'over'} by ${formatAmount(gap > 0n ? gap : -gap)}.`,
    );
  }
  const commission = rows.reduce((sum, row) => sum + row.commission, 0n);
  if (commission !== spreadCommission) {
    throw new LoanError(
      `${loanNo}: the instalments carry ${formatAmount(commission)} of commission; the loan spreads ${formatAmount(spreadCommission)}.`,
    );
  }
}

/** Where an unpaid instalment stands on a day: due inside the warning window, overdue after it. */
export function instalmentState(
  row: { readonly status: string; readonly dueDate: string },
  today: string,
  warningDays: number,
): InstalmentState {
  if (row.status === 'paid') return 'paid';
  if (row.dueDate < today) return 'overdue';
  if (row.dueDate <= addDays(today, warningDays)) return 'due';
  return 'upcoming';
}

// ---------------------------------------------------------------------------
// Allocations and the commission share
// ---------------------------------------------------------------------------

export interface AllocationShareInput {
  readonly id: string;
  readonly amount: bigint;
  /** A share typed by the manager — `manual` only. */
  readonly manualShare?: bigint | null;
}

/**
 * §15.7 — each funded application's part of the commission.
 *   by_amount_used  commission × allocated / principal, to the cent
 *   equal           the commission split evenly over the live allocations
 *   manual          what the manager typed (never more than the commission in all)
 */
export function commissionShares(
  method: AllocationMethod,
  commission: bigint,
  principal: bigint,
  allocations: readonly AllocationShareInput[],
): Map<string, bigint> {
  const shares = new Map<string, bigint>();
  if (allocations.length === 0) return shares;
  if (method === 'equal') {
    const parts = splitEvenly(commission, allocations.length);
    allocations.forEach((allocation, index) => shares.set(allocation.id, parts[index]!));
    return shares;
  }
  if (method === 'manual') {
    let total = 0n;
    for (const allocation of allocations) {
      const share = allocation.manualShare ?? 0n;
      if (share < 0n) throw new LoanError('A commission share is never negative.');
      total += share;
      shares.set(allocation.id, share);
    }
    if (total > commission) {
      throw new LoanError(`The shares total ${formatAmount(total)}, more than the ${formatAmount(commission)} commission.`);
    }
    return shares;
  }
  for (const allocation of allocations) {
    const exact = (commission * allocation.amount) / principal;
    shares.set(allocation.id, roundToCent(exact));
  }
  return shares;
}

/** What the loan may still fund: the principal less what is allocated. */
export function unallocated(principal: bigint, allocated: bigint): bigint {
  return principal - allocated;
}

/** Outstanding principal: the principal less the principal of paid instalments. */
export function outstanding(principal: bigint, rows: readonly { status: string; principal: bigint }[]): bigint {
  return principal - rows.filter((row) => row.status === 'paid').reduce((sum, row) => sum + row.principal, 0n);
}
