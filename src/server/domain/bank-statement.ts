/**
 * Bank statement lines — Phase 07.6, §17, §23 and Appendix B.
 *
 * > Appendix B, Bank Statement Line: *"**Unique import key**; match status;
 * > book-to-bank reconciliation."*
 * > §17: *"Import or manual entry of bank statements."*
 *
 * A statement is the bank's account of what happened, and the system's job is
 * to hold it **exactly as given** — not to interpret it. Everything here is
 * therefore about identity and arithmetic: which line is which, and whether the
 * statement adds up. What a line *means* is the reconciliation workspace's
 * question (07.7).
 *
 * Pure. Money is scaled at 10^4.
 */
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// Identity — Appendix B's "unique import key"
// ---------------------------------------------------------------------------

export interface LineIdentity {
  readonly accountCode: string;
  readonly bookingDate: string;
  /** Signed: positive is money into the account. */
  readonly amountIqd: bigint;
  readonly reference: string | null;
  /**
   * Which occurrence this is among otherwise identical lines — the line's
   * position in the statement, which is the only stable marker a file supplies.
   */
  readonly ordinal: number;
}

/**
 * The key that makes importing the same statement twice a no-op.
 *
 * **Date, amount and reference are facts about the payment**, and they do the
 * work: a line is recognised by what it is rather than by anything the file
 * decided.
 *
 * **The ordinal exists for one case, and it cannot be avoided.** Two genuinely
 * different transactions can be identical on every visible field — the same
 * amount to the same reference on the same day happens — and a key without an
 * ordinal would silently collapse them into one line, losing a real movement.
 * Distinguishing "the second copy of one transaction" from "a second, identical
 * transaction" needs information the two lines do not contain, so the ordinal is
 * taken from the line's position in the statement. Re-importing the same file
 * gives the same positions, so the same keys, so no duplicates.
 *
 * The cost is stated rather than hidden: a file that listed the same period's
 * lines in a **different order** would give its identical-looking lines
 * different ordinals. That is why the bank's own identifier wins whenever there
 * is one — it is the only key that is authoritative rather than inferred, and it
 * is immune to how the file was ordered. Most Iraqi bank exports do not carry
 * one, which is why the fallback exists at all.
 */
export function importKeyFor(identity: LineIdentity, bankReference?: string | null): string {
  if (bankReference && bankReference.trim()) {
    return `bank:${identity.accountCode}:${bankReference.trim()}`;
  }

  const reference = (identity.reference ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  return [
    'fp',
    identity.accountCode,
    identity.bookingDate,
    toDecimalString(identity.amountIqd, 4n),
    reference,
    String(identity.ordinal),
  ].join(':');
}

// ---------------------------------------------------------------------------
// Arithmetic — the statement has to add up
// ---------------------------------------------------------------------------

export class StatementDoesNotBalanceError extends Error {
  readonly code = 'STATEMENT_DOES_NOT_BALANCE';

  constructor(
    readonly openingIqd: bigint,
    readonly closingIqd: bigint,
    readonly movementIqd: bigint,
  ) {
    super(
      `The statement opens at ${toDecimalString(openingIqd, 4n)}, closes at ` +
        `${toDecimalString(closingIqd, 4n)}, and its lines move ` +
        `${toDecimalString(movementIqd, 4n)} — which is ` +
        `${toDecimalString(closingIqd - openingIqd - movementIqd, 4n)} out. ` +
        'A statement that does not add up is a statement with a line missing, and reconciling ' +
        'against it would prove the wrong thing (§17).',
    );
    this.name = 'StatementDoesNotBalanceError';
  }
}

/**
 * §17 — opening + movement = closing, or the import is refused.
 *
 * This is the cheapest possible check on a file that will be trusted to prove
 * the bank balance, and it catches the failure that matters most: a truncated
 * download. A statement missing its last three lines still looks like a
 * statement, and reconciling to it would agree the G/L to a number the bank
 * never said.
 */
export function assertStatementBalances(input: {
  readonly openingIqd: bigint;
  readonly closingIqd: bigint;
  readonly lines: readonly { amountIqd: bigint }[];
}): void {
  const movement = input.lines.reduce((total, line) => total + line.amountIqd, 0n);

  if (input.openingIqd + movement !== input.closingIqd) {
    throw new StatementDoesNotBalanceError(input.openingIqd, input.closingIqd, movement);
  }
}

// ---------------------------------------------------------------------------
// Line shape
// ---------------------------------------------------------------------------

export const MATCH_STATES = ['unmatched', 'suggested', 'matched', 'ignored'] as const;
export type MatchStatus = (typeof MATCH_STATES)[number];

export class StatementLineInvalidError extends Error {
  readonly code = 'STATEMENT_LINE_INVALID';
  constructor(
    readonly lineNo: number,
    detail: string,
  ) {
    super(`Statement line ${lineNo}: ${detail}`);
    this.name = 'StatementLineInvalidError';
  }
}

export interface StatementLineInput {
  readonly lineNo: number;
  readonly bookingDate: string;
  /** §17 — when the money is actually available, which is not always the same day. */
  readonly valueDate: string;
  readonly amountIqd: bigint;
  readonly reference: string | null;
  readonly counterparty: string | null;
  readonly description: string | null;
  readonly bankReference?: string | null;
}

/**
 * The 07.6 gate: *"statement lines carry date, value date, amount, reference and
 * counterparty."*
 *
 * The value date is checked against the booking date rather than merely
 * required, because the pair is what 07.7 will reconcile against: a value date
 * *before* the booking date is either a bank error or a parsing error, and both
 * are worth stopping at the door.
 */
export function assertLineUsable(line: StatementLineInput): void {
  if (line.amountIqd === 0n) {
    throw new StatementLineInvalidError(
      line.lineNo,
      'the amount is zero. A movement of nothing is not a movement, and a line that means ' +
        'something else — a balance marker, a heading — is not a transaction.',
    );
  }

  if (line.valueDate < line.bookingDate) {
    throw new StatementLineInvalidError(
      line.lineNo,
      `the value date (${line.valueDate}) is before the booking date (${line.bookingDate}). ` +
        'Money cannot clear before it moves; this is a parsing error or a bank error, and either ' +
        'way it should not be reconciled against.',
    );
  }
}

/** Which way the money went — the word a person uses, from the sign. */
export function directionOf(amountIqd: bigint): 'in' | 'out' {
  return amountIqd > 0n ? 'in' : 'out';
}
