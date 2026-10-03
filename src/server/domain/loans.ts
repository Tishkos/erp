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

export const LOAN_STATUSES = [
  'draft',
  // Sent for approval: the offer and the schedule are as the bank wrote them
  // and somebody else is asked to agree (2026-10-03). Before this they may be
  // retyped freely; after approval an amendment is a decision with a trail.
  'submitted',
  'approved',
  'active',
  'fully_repaid',
  'cancelled',
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const FREQUENCIES = ['monthly', 'quarterly', 'semiannual', 'annual', 'custom'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** How the principal comes back — the thing "four instalments" does not say. */
export const PRINCIPAL_METHODS = ['equal_principal', 'equal_instalments', 'bullet', 'custom'] as const;
export type PrincipalMethod = (typeof PRINCIPAL_METHODS)[number];

/** How the bank works its interest out. Quoted alike, these are not alike. */
export const INTEREST_BASES = ['reducing', 'flat'] as const;
export type InterestBasis = (typeof INTEREST_BASES)[number];

/** A rate that stands, or one that follows a published one plus a spread. */
export const INTEREST_TYPES = ['fixed', 'variable'] as const;
export type InterestType = (typeof INTEREST_TYPES)[number];

/** How the letter states the commission. */
export const COMMISSION_BASES = ['percentage', 'fixed', 'none'] as const;
export type CommissionBasis = (typeof COMMISSION_BASES)[number];

/** What a grace period holds off, and until when. */
export const GRACE_KINDS = ['none', 'principal', 'interest', 'both'] as const;
export type GraceKind = (typeof GRACE_KINDS)[number];

/** What the money is for — the facility's purpose, not its accounting. */
export const LOAN_PURPOSES = [
  'working_capital',
  'import_finance',
  'equipment',
  'project',
  'construction',
  'general',
  'other',
] as const;
export type LoanPurpose = (typeof LOAN_PURPOSES)[number];

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
  /*
   * Draft → submitted → approved → active (2026-10-03). The offer and its
   * schedule are retyped freely while the loan is a draft or waiting; once
   * approved they are a decision somebody made, and changing them is an
   * amendment with a trail rather than an edit.
   *
   * A draft may still be approved outright: a bank offer entered by whoever
   * will approve it has nobody to send it to.
   */
  draft: ['submitted', 'approved', 'cancelled'],
  submitted: ['approved', 'draft', 'cancelled'],
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

/** How many months a frequency steps by. `custom` names its own dates. */
const STEP_MONTHS: Partial<Record<Frequency, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

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
  const step = STEP_MONTHS[frequency] ?? 3;
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
  /**
   * How the principal comes back (2026-10-03). Left out it is equal principal,
   * which is what every schedule built before this was.
   */
  readonly principalMethod?: PrincipalMethod;
  /** On the reducing balance (the default) or flat on the original principal. */
  readonly interestBasis?: InterestBasis;
  /** What a grace period holds off, and the date it runs to. */
  readonly grace?: GraceKind;
  readonly graceUntil?: string | null;
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
 * §15.7, and the bank's own terms (2026-10-03).
 *
 * The principal comes back by the method the letter states; interest is on the
 * reducing balance for the days of each period (actual/365) or flat on the
 * original principal; a grace period defers principal and accrues interest to
 * the first instalment after it; a spread commission rides along in equal
 * shares. No rate at all and there is no interest to charge.
 *
 * Whatever the method, the principal comes back exactly once —
 * `assertScheduleRepays` holds the typed version to the same rule.
 */
export function buildSchedule(input: ScheduleInput): ScheduleRow[] {
  if (input.count <= 0) throw new LoanError('A loan is repaid in at least one instalment.');
  if (input.principal <= 0n) throw new LoanError('A loan has a principal.');
  const dates = dueDates(input.firstDueDate, input.count, input.frequency, input.customDates);
  if (dates[0]! < input.startDate) {
    throw new LoanError(`The first instalment (${dates[0]}) falls before the loan starts (${input.startDate}).`);
  }

  const grace = input.grace ?? 'none';
  const graceUntil = grace === 'none' ? null : (input.graceUntil ?? null);
  if (grace !== 'none' && !graceUntil) {
    throw new LoanError('A grace period runs to a date. Say when it ends.');
  }
  if (graceUntil && graceUntil < input.startDate) {
    throw new LoanError(`The grace period (${graceUntil}) ends before the loan starts (${input.startDate}).`);
  }
  /** Instalments due on or before the grace date are inside it. */
  const inGrace = (dueDate: string) => Boolean(graceUntil && dueDate <= graceUntil);
  const holdsPrincipal = grace === 'principal' || grace === 'both';
  const holdsInterest = grace === 'interest' || grace === 'both';

  // Which instalments carry principal at all: the ones outside a principal grace.
  const paying = dates.map((dueDate) => !(holdsPrincipal && inGrace(dueDate)));
  if (!paying.some(Boolean)) {
    throw new LoanError('The grace period covers every instalment: nothing would repay the principal.');
  }

  const days = (from: string, to: string) =>
    BigInt(Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)));

  /** Interest on an outstanding balance for a stretch of days, actual/365. */
  const interestOn = (balance: bigint, from: string, to: string) =>
    input.interestPctPa ? roundToCent((balance * input.interestPctPa * days(from, to)) / (100n * ONE * 365n)) : 0n;

  const method = input.principalMethod ?? 'equal_principal';
  const basis = input.interestBasis ?? 'reducing';

  /*
   * Flat interest is on the original principal for the whole term, divided
   * equally — a different and larger figure than the same rate on the reducing
   * balance, and the one banks here quote. Worked out once, up front.
   */
  const flatEach =
    basis === 'flat' && input.interestPctPa
      ? splitEvenly(
          roundToCent(
            (input.principal * input.interestPctPa * days(input.startDate, dates[dates.length - 1]!)) /
              (100n * ONE * 365n),
          ),
          input.count,
        )
      : null;

  const principals = principalsBy(method, input.principal, paying, (balance, index) =>
    basis === 'flat'
      ? (flatEach?.[index] ?? 0n)
      : interestOn(balance, index === 0 ? input.startDate : dates[index - 1]!, dates[index]!),
  );

  const commissions = input.spreadCommission ? splitEvenly(input.commission, input.count) : dates.map(() => 0n);

  let outstanding = input.principal;
  let from = input.startDate;
  // Interest a grace held off, waiting for the first instalment that charges.
  let deferred = 0n;

  return dates.map((dueDate, index) => {
    const earned =
      basis === 'flat' ? (flatEach?.[index] ?? 0n) : interestOn(outstanding, from, dueDate);
    let interest: bigint;
    if (holdsInterest && inGrace(dueDate)) {
      // Not forgiven — carried to the first instalment after the grace.
      deferred += earned;
      interest = 0n;
    } else {
      interest = earned + deferred;
      deferred = 0n;
    }

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

/**
 * The principal of each instalment, by the method the bank's letter states.
 *
 * `paying` says which instalments carry principal at all — a principal grace
 * excuses the early ones, and the whole principal comes back over the rest.
 */
function principalsBy(
  method: PrincipalMethod,
  principal: bigint,
  paying: readonly boolean[],
  interestAt: (balance: bigint, index: number) => bigint,
): bigint[] {
  const count = paying.length;
  const live = paying.filter(Boolean).length;

  if (method === 'bullet') {
    // Nothing until the end, then all of it.
    const rows = Array.from({ length: count }, () => 0n);
    rows[count - 1] = principal;
    return rows;
  }

  if (method === 'equal_instalments') {
    /*
     * The level payment: the same total every time. Found by halving the
     * interval between "the principal split evenly" (too little, because it
     * carries no interest) and "the whole principal at once" (plenty), because
     * the annuity formula needs a power and a division this arithmetic does
     * not do in whole cents. Thirty halvings settle it to the cent on any
     * figure a bank would write.
     */
    let low = principal / BigInt(Math.max(1, live));
    let high = principal + principal; // principal and then some, for the interest
    for (let step = 0; step < 48; step += 1) {
      const payment = (low + high) / 2n;
      let balance = principal;
      for (let index = 0; index < count; index += 1) {
        const interest = interestAt(balance, index);
        if (!paying[index]) continue;
        const towards = payment - interest;
        balance -= towards > balance ? balance : towards > 0n ? towards : 0n;
      }
      if (balance > 0n) low = payment;
      else high = payment;
    }

    // Lay it out at the settled payment; the last paying row takes the rest.
    const payment = high;
    const rows = Array.from({ length: count }, () => 0n);
    let balance = principal;
    let lastPaying = -1;
    for (let index = 0; index < count; index += 1) {
      if (!paying[index]) continue;
      lastPaying = index;
      const interest = interestAt(balance, index);
      const towards = payment - interest;
      const taken = towards <= 0n ? 0n : towards > balance ? balance : (towards / CENT) * CENT;
      rows[index] = taken;
      balance -= taken;
    }
    if (lastPaying >= 0) rows[lastPaying] = rows[lastPaying]! + balance;
    return rows;
  }

  // Equal principal, and the starting point a custom schedule is retyped from.
  const shares = splitEvenly(principal, live);
  const rows: bigint[] = [];
  let next = 0;
  for (let index = 0; index < count; index += 1) {
    rows.push(paying[index] ? shares[next++]! : 0n);
  }
  return rows;
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
