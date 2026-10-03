/**
 * Payment applications — REQ-AP-001 §15.2–§15.5, the rules a database cannot
 * hold. Pure and framework-free, like the rest of the domain.
 *
 *   * **The instalment plan (§15.2).** Percent of the invoice amount or a
 *     fixed amount, unlimited rows, totalling exactly what is owed; the last
 *     row absorbs the rounding.
 *   * **The status machine (§15.3).** Draft → approved → sent → confirmed →
 *     debited; rejected or cancelled, with a reason, from approved or sent.
 *     The transitions are rows (seeded, editable); this checks a move against
 *     them.
 *   * **The checks on Send (§15.3, the diagram's dashed arrows).** Each check
 *     answers pass / fail / warning / not applicable with the cause in words;
 *     a failure is refused unless a manager overrides it with a reason.
 *   * **Applied / Paid / Remaining (§15.5).** Arithmetic over the rows, never
 *     stored, so it cannot drift.
 */

export class PaymentApplicationError extends Error {
  readonly code = 'PAYMENT_APPLICATION_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'PaymentApplicationError';
  }
}

// ---------------------------------------------------------------------------
// What confirms a payment
// ---------------------------------------------------------------------------

/** What proves the money left — a column of the payment method (migration 0232). */
export const CONFIRMATION_KINDS = ['swift', 'transfer', 'cash', 'cheque'] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

export function isConfirmationKind(value: string): value is ConfirmationKind {
  return (CONFIRMATION_KINDS as readonly string[]).includes(value);
}

/** §15.3 — SWIFT and transfers go to a bank account of the supplier's; cash and cheques do not. */
export function needsPayeeAccount(kind: ConfirmationKind): boolean {
  return kind === 'swift' || kind === 'transfer';
}

/** Cash is paid from a cash account; everything else from a bank account. */
export function accountTypeFor(kind: ConfirmationKind): 'bank' | 'cash' {
  return kind === 'cash' ? 'cash' : 'bank';
}

/** The event a confirmation writes, by what proved it. */
export function confirmationEvent(kind: ConfirmationKind): string {
  switch (kind) {
    case 'swift':
      return 'SWIFT_CONFIRMED';
    case 'transfer':
      return 'TRANSFER_CONFIRMED';
    case 'cash':
      return 'CASH_PAID';
    case 'cheque':
      return 'CHEQUE_PAID';
  }
}

/** Which time-limit check watches an application sent by this method (§15.4, D4). */
export function pendingCheckFor(kind: ConfirmationKind): 'swift_pending' | 'transfer_pending' {
  return kind === 'swift' ? 'swift_pending' : 'transfer_pending';
}

// ---------------------------------------------------------------------------
// §15.3 — the status machine
// ---------------------------------------------------------------------------

export const PAYMENT_APPLICATION_STATUSES = [
  'draft',
  'approved',
  'sent',
  'confirmed',
  'debited',
  'rejected',
  'cancelled',
] as const;
export type ApplicationStatus = (typeof PAYMENT_APPLICATION_STATUSES)[number];

/** Live: holds or has moved money. Rejected and cancelled are not. */
export function isLive(status: string): boolean {
  return status !== 'rejected' && status !== 'cancelled';
}

/** Reserved on the account: approved or sent, not yet confirmed (§15.6). */
export function isReserved(status: string): boolean {
  return status === 'approved' || status === 'sent';
}

/** Applied to the bank (§15.5): sent, confirmed or debited. */
export function isApplied(status: string): boolean {
  return status === 'sent' || status === 'confirmed' || status === 'debited';
}

/** Paid (§15.5): confirmed or debited. */
export function isPaid(status: string): boolean {
  return status === 'confirmed' || status === 'debited';
}

export interface TransitionRow {
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly active: boolean;
}

export function assertTransition(
  applicationNo: string,
  rows: readonly TransitionRow[],
  from: string,
  to: string,
): void {
  const allowed = rows.some((row) => row.active && row.fromStatus === from && row.toStatus === to);
  if (!allowed) {
    throw new PaymentApplicationError(
      `${applicationNo} is '${from}' and cannot become '${to}'. ` +
        'A payment application moves draft → approved → sent → confirmed → debited; ' +
        'it is rejected or cancelled, with a reason, before it is confirmed.',
    );
  }
}

// ---------------------------------------------------------------------------
// §15.3 — the checks on Send
// ---------------------------------------------------------------------------

export const SEND_CHECKS = ['pd_validated', 'funds', 'payee_account', 'instalment_trigger'] as const;
export type SendCheckCode = (typeof SEND_CHECKS)[number];

export type CheckOutcome = 'pass' | 'fail' | 'warning' | 'not_applicable';

export interface SendCheck {
  readonly code: SendCheckCode;
  readonly outcome: CheckOutcome;
  /** The cause in words — what a person needs to fix it. */
  readonly detail: string;
}

/** The checks a Send would be refused on. Warnings and n/a never refuse. */
export function failing(checks: readonly SendCheck[]): SendCheck[] {
  return checks.filter((check) => check.outcome === 'fail');
}

export class SendRefusedError extends Error {
  readonly code = 'PAYMENT_SEND_REFUSED';
  constructor(
    applicationNo: string,
    readonly failed: readonly SendCheck[],
  ) {
    super(
      `${applicationNo} cannot go to the bank: ${failed.map((check) => check.detail).join(' ')} ` +
        'Fix the cause, or a manager may send it anyway with a reason, which is logged.',
    );
    this.name = 'SendRefusedError';
  }
}

/** §15.3 check 2 — Available (less this application's own reservation) ≥ amount. */
export function fundsCheck(input: {
  accountCode: string;
  availableIqd: bigint;
  ownReservationIqd: bigint;
  amountIqd: bigint;
}): SendCheck {
  const available = input.availableIqd + input.ownReservationIqd;
  if (available >= input.amountIqd) {
    return { code: 'funds', outcome: 'pass', detail: `${input.accountCode} has the funds.` };
  }
  return {
    code: 'funds',
    outcome: 'fail',
    detail:
      `${input.accountCode} has ${formatMinor(available)} IQD available against ${formatMinor(input.amountIqd)} IQD — ` +
      'deposit or draw the money first.',
  };
}

/** §15.3 — the payee's bank account must be verified for SWIFT and transfers. */
export function payeeCheck(input: {
  kind: ConfirmationKind;
  account: { approvalStatus: string; isActive: boolean; bankName: string; accountNumber: string } | null;
  belongsToSupplier: boolean;
}): SendCheck {
  if (!needsPayeeAccount(input.kind)) {
    return { code: 'payee_account', outcome: 'not_applicable', detail: 'No supplier bank account is needed for this method.' };
  }
  if (!input.account) {
    return {
      code: 'payee_account',
      outcome: 'fail',
      detail: 'Name the supplier bank account the money goes to.',
    };
  }
  if (!input.belongsToSupplier) {
    return {
      code: 'payee_account',
      outcome: 'fail',
      detail: 'The bank account named belongs to a different partner.',
    };
  }
  if (input.account.approvalStatus !== 'approved' || !input.account.isActive) {
    return {
      code: 'payee_account',
      outcome: 'fail',
      detail: `${input.account.bankName} ${input.account.accountNumber} is not verified — approve it on the supplier first.`,
    };
  }
  return {
    code: 'payee_account',
    outcome: 'pass',
    detail: `${input.account.bankName} ${input.account.accountNumber} is verified.`,
  };
}

// ---------------------------------------------------------------------------
// §15.2 — the instalment plan
// ---------------------------------------------------------------------------

export interface InstalmentDraft {
  readonly label: string;
  readonly basis: 'percent' | 'amount';
  /** Percent of the invoice amount, as typed ("10", "33.3333"). */
  readonly percent?: string | null;
  /** A fixed amount in the payable's currency, at the money scale. */
  readonly amountTxn?: bigint | null;
  readonly triggerCode: string;
  readonly triggerDays?: number | null;
  readonly expectedDate?: string | null;
}

const PERCENT_SCALE = 10_000n; // four decimals

function parsePercent(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(trimmed)) {
    throw new PaymentApplicationError(`"${value}" is not a percentage — type it as 10 or 33.3333.`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole!) * PERCENT_SCALE + BigInt(fraction.padEnd(4, '0'));
}

/**
 * The amounts of a plan, at the money scale, totalling exactly `totalTxn`
 * less what earlier, kept instalments already account for.
 *
 * Percent rows are a share of the whole amount owed (§15.2); amount rows are
 * as typed. The last row absorbs the rounding of the percent rows — never
 * more than one minor unit per row — and anything else that does not add up
 * is refused with the difference named.
 */
export function planAmounts(
  totalTxn: bigint,
  drafts: readonly InstalmentDraft[],
  keptTxn = 0n,
): bigint[] {
  if (drafts.length === 0) {
    throw new PaymentApplicationError('A plan has at least one instalment.');
  }
  if (totalTxn <= 0n) {
    throw new PaymentApplicationError(
      'The import has no amount yet, so there is nothing to divide into instalments. Enter its invoice lines first.',
    );
  }

  const amounts = drafts.map((draft, index) => {
    if (!draft.label.trim()) {
      throw new PaymentApplicationError(`Instalment ${index + 1} needs a label — Deposit, Balance, 2nd payment.`);
    }
    if (draft.basis === 'percent') {
      const percent = parsePercent(draft.percent ?? '');
      if (percent <= 0n || percent > 100n * PERCENT_SCALE) {
        throw new PaymentApplicationError(`Instalment ${index + 1}: a percentage is above 0 and at most 100.`);
      }
      return (totalTxn * percent) / (100n * PERCENT_SCALE);
    }
    const amount = draft.amountTxn ?? 0n;
    if (amount <= 0n) {
      throw new PaymentApplicationError(`Instalment ${index + 1}: state the amount.`);
    }
    return amount;
  });

  const target = totalTxn - keptTxn;
  const sum = amounts.reduce((a, b) => a + b, 0n);
  const difference = target - sum;
  const percentRows = BigInt(drafts.filter((d) => d.basis === 'percent').length);
  const tolerance = percentRows * 100n; // one minor unit (0.01) per percent row, at scale 4

  if (difference !== 0n) {
    const absolute = difference < 0n ? -difference : difference;
    if (percentRows === 0n || absolute > tolerance) {
      throw new PaymentApplicationError(
        `The plan comes to ${formatMinor(sum + keptTxn)} of ${formatMinor(totalTxn)} — ` +
          `${difference > 0n ? 'short' : 'over'} by ${formatMinor(absolute)}. Instalments total what is owed (§15.2).`,
      );
    }
    amounts[amounts.length - 1] = amounts[amounts.length - 1]! + difference;
  }

  if (amounts.some((amount) => amount <= 0n)) {
    throw new PaymentApplicationError('Every instalment pays something.');
  }
  return amounts;
}

/** §15.2 — an instalment's status, derived from its applications. */
export function instalmentStatus(applicationStatuses: readonly string[]): 'planned' | 'applied' | 'paid' {
  const live = applicationStatuses.filter(isLive);
  if (live.some(isPaid)) return 'paid';
  if (live.length > 0) return 'applied';
  return 'planned';
}

// ---------------------------------------------------------------------------
// §15.5 — Applied / Paid / Remaining
// ---------------------------------------------------------------------------

export interface ApplicationAmount {
  readonly status: string;
  readonly amountTxn: bigint;
  readonly amountIqd: bigint;
}

export interface PaymentTotals {
  readonly appliedTxn: bigint;
  readonly paidTxn: bigint;
  readonly remainingTxn: bigint;
  readonly appliedIqd: bigint;
  readonly paidIqd: bigint;
  /** Approved or sent — held on the accounts. */
  readonly reservedTxn: bigint;
  readonly fullyPaid: boolean;
}

export function totals(owedTxn: bigint, rows: readonly ApplicationAmount[]): PaymentTotals {
  let appliedTxn = 0n;
  let paidTxn = 0n;
  let appliedIqd = 0n;
  let paidIqd = 0n;
  let reservedTxn = 0n;
  for (const row of rows) {
    if (isApplied(row.status)) {
      appliedTxn += row.amountTxn;
      appliedIqd += row.amountIqd;
    }
    if (isPaid(row.status)) {
      paidTxn += row.amountTxn;
      paidIqd += row.amountIqd;
    }
    if (isReserved(row.status)) reservedTxn += row.amountTxn;
  }
  const remainingTxn = owedTxn - paidTxn;
  return {
    appliedTxn,
    paidTxn,
    remainingTxn,
    appliedIqd,
    paidIqd,
    reservedTxn,
    // To the currency's minor unit (§15.5): within half a cent at scale 4.
    fullyPaid: owedTxn > 0n && remainingTxn < 50n,
  };
}

/** Whole days between two ISO dates (b − a), for "days waiting". */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Adds days to an ISO date. */
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** 1,234,567.89 — an amount at the money scale, for a sentence. */
export function formatAmount(value: bigint): string {
  return formatMinor(value);
}

function formatMinor(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10_000n;
  const cents = (absolute % 10_000n) / 100n;
  return `${negative ? '-' : ''}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents.toString().padStart(2, '0')}`;
}

/**
 * The advance a percentage asks for, out of an invoice's total.
 *
 * By direction (2026-10-03): "if accountant writes 20 percentage of advances
 * it automatically takes 20 percent of the whole invoice".
 *
 * On bigints throughout and rounded half-up at the money scale. A percentage
 * that does not divide — a third of the goods — lands on the nearest dinar
 * rather than drifting, and the figure the screen shows beside the percentage
 * is the figure the bank is asked for, because both come from here.
 *
 * Null when there is nothing to ask for: no percentage, nought per cent, or an
 * invoice that totals nothing. Null is "raise nothing", which is different
 * from zero and is why it is not zero.
 */
export function advanceOf(totalIqd: bigint, percent: string | null | undefined): bigint | null {
  const text = (percent ?? '').trim();
  if (text === '') return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;

  /*
   * The percentage at four places, as a bigint: "20.5" → 205000.
   *
   * Scaled here rather than through `parseDecimal` because this module has no
   * imports at all and is the better for it — every rule in it is decidable
   * from its arguments, which is what lets the tests run without a database or
   * a money library. Four places is the money scale, and a percentage written
   * to more than four is truncated rather than rounded: nobody means the fifth
   * decimal of a percent, and refusing it would be worse than ignoring it.
   */
  const [whole = '0', fraction = ''] = text.split('.');
  const places = (fraction + '0000').slice(0, 4);
  const parsed = BigInt(whole) * 10000n + BigInt(places);
  if (parsed <= 0n) return null;
  if (totalIqd <= 0n) return null;
  /*
   * Never more than the whole invoice (2026-10-03). 0270's CHECK says the same
   * of the stored column and the box on the screen will not take the
   * keystroke; this is what the arithmetic itself will not do, so a caller
   * that reached here another way is refused rather than obeyed.
   */
  if (parsed > 100n * 10000n) {
    throw new Error('an advance cannot be more than 100% of the invoice');
  }

  // total × percent / 100, half-up on the last place.
  const scale = 10n ** 4n;
  const numerator = totalIqd * parsed;
  const denominator = 100n * scale;
  const share = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? share + 1n : share;

  /*
   * A share that rounds away to nothing is nothing to ask for.
   *
   * A hundredth of a per cent of a small invoice is less than a fils, and
   * without this the caller would raise a payment application for zero — a
   * request to the bank to send no money, needing approval and a signature.
   * Null is already this function's word for "raise nothing" (2026-10-03).
   */
  return rounded <= 0n ? null : rounded;
}
