/**
 * Journal Entry — Phase 02.5.
 *
 * The first document in the system that actually posts. Everything built so far
 * meets here: a number from 01.5, a date checked against 02.2, a rate from
 * 02.3, dimensions from 02.4, an account from 02.1, and an approval route from
 * 01.7.
 *
 * §14.3 gives three rules that are short enough to state and strict enough to
 * matter:
 *
 *   "One Journal Entry can contain one branch only."
 *   "The only manual journal type is Standard Journal."
 *   "Manual Journal corrections use Full Reversal only."   (02.8)
 *
 * And §14 gives a fourth: "Journal Entries belong exclusively to the Finance
 * Department."
 *
 * ── On balancing ────────────────────────────────────────────────────────────
 * A journal balances **in IQD** and only in IQD. §14.3: "IQD is the primary
 * balancing currency. USD is a historical-rate reporting equivalent and does
 * not replace IQD ledger values." A multi-currency journal will not balance in
 * its transaction currencies and is not expected to; the USD column is a
 * reporting derivative and balancing it is not a requirement, it is a
 * coincidence.
 */
import type { SuppliedDimensions } from './dimensions';

/** §14.3 — "The only manual journal type is Standard Journal." */
export const JOURNAL_TYPES = ['standard'] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

/** How a journal came to exist. */
export const JOURNAL_SOURCES = ['manual', 'system'] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

/**
 * One line, with money already resolved into the four-part tuple §24 requires.
 *
 * Debit and credit are separate fields because §14.2 names them separately and
 * because that is how an accountant reads a journal. Exactly one of them
 * carries a value; the invariant is checked here and again by the database.
 */
export interface JournalLineDraft {
  readonly lineNo: number;
  readonly accountId: string;
  /** For error messages — the code is what a user recognises. */
  readonly accountCode: string;

  /** Amounts in the transaction currency, scaled by MONEY_SCALE. Never negative. */
  readonly debitTxn: bigint;
  readonly creditTxn: bigint;
  readonly currency: string;

  /** The balancing amounts. §14.3 — IQD is the primary balancing currency. */
  readonly debitIqd: bigint;
  readonly creditIqd: bigint;

  /** Reporting equivalents at the historical rate (§1.1). Not balanced against. */
  readonly debitUsd: bigint;
  readonly creditUsd: bigint;

  readonly dimensions: SuppliedDimensions;
  readonly description?: string | null;
}

export interface JournalHeaderDraft {
  /** §14.3 — one branch per entry, on the header, so it cannot vary by line. */
  readonly branchCode: string;
  readonly documentDate: string;
  readonly postingDate: string;
  readonly journalType: JournalType;
  readonly description?: string | null;
}

export class JournalValidationError extends Error {
  readonly code = 'JOURNAL_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'JournalValidationError';
  }
}

export class JournalUnbalancedError extends Error {
  readonly code = 'JOURNAL_UNBALANCED';

  constructor(
    readonly totalDebitIqd: bigint,
    readonly totalCreditIqd: bigint,
  ) {
    const difference = totalDebitIqd - totalCreditIqd;
    super(
      `The journal does not balance in IQD. Debits total ${format(totalDebitIqd)} and credits ${format(totalCreditIqd)}, ` +
        `a difference of ${format(difference < 0n ? -difference : difference)}. ` +
        'Every journal must balance in IQD (§14.3).',
    );
    this.name = 'JournalUnbalancedError';
  }
}

export class JournalBranchError extends Error {
  readonly code = 'JOURNAL_MULTIPLE_BRANCHES';

  constructor(
    readonly headerBranch: string,
    readonly lineBranch: string,
    readonly lineNo: number,
  ) {
    super(
      `Line ${lineNo} is in branch ${lineBranch} but the journal is in ${headerBranch}. ` +
        'One Journal Entry can contain one branch only (§14.3) — raise a separate journal for the other branch.',
    );
    this.name = 'JournalBranchError';
  }
}

export class NotFinanceDepartmentError extends Error {
  readonly code = 'NOT_FINANCE_DEPARTMENT';

  constructor(readonly userId: string) {
    super(
      'Journal Entries belong exclusively to the Finance Department (§14). ' +
        'This user is not assigned to a Finance department.',
    );
    this.name = 'NotFinanceDepartmentError';
  }
}

/** Renders a scaled amount for a message. Four places, as stored. */
function format(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 10_000n;
  const fraction = (abs % 10_000n).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * One line's own invariants.
 *
 * A line carrying both a debit and a credit is not a line an accountant would
 * recognise, and a line carrying neither is a row that changes nothing while
 * looking like it might.
 */
export function assertLineWellFormed(line: JournalLineDraft): void {
  const amounts: Array<[string, bigint]> = [
    ['debit', line.debitTxn],
    ['credit', line.creditTxn],
    ['debit IQD', line.debitIqd],
    ['credit IQD', line.creditIqd],
    ['debit USD', line.debitUsd],
    ['credit USD', line.creditUsd],
  ];

  for (const [label, amount] of amounts) {
    if (amount < 0n) {
      throw new JournalValidationError(
        `Line ${line.lineNo} has a negative ${label} amount. A negative debit is a credit — post it as one.`,
      );
    }
  }

  const hasDebit = line.debitTxn > 0n;
  const hasCredit = line.creditTxn > 0n;

  if (hasDebit && hasCredit) {
    throw new JournalValidationError(
      `Line ${line.lineNo} carries both a debit and a credit. Split it into two lines.`,
    );
  }

  if (!hasDebit && !hasCredit) {
    throw new JournalValidationError(
      `Line ${line.lineNo} has no amount. Remove it, or give it a debit or a credit.`,
    );
  }

  // The IQD side must follow the transaction side: a debit in USD is a debit in
  // IQD. If they disagree the conversion went in on the wrong side, and the
  // journal would balance while meaning the opposite of what was entered.
  if (hasDebit && (line.debitIqd <= 0n || line.creditIqd !== 0n)) {
    throw new JournalValidationError(
      `Line ${line.lineNo} is a debit in ${line.currency} but not in IQD. The conversion is on the wrong side.`,
    );
  }
  if (hasCredit && (line.creditIqd <= 0n || line.debitIqd !== 0n)) {
    throw new JournalValidationError(
      `Line ${line.lineNo} is a credit in ${line.currency} but not in IQD. The conversion is on the wrong side.`,
    );
  }
}

export function totalDebitIqd(lines: readonly JournalLineDraft[]): bigint {
  return lines.reduce((sum, line) => sum + line.debitIqd, 0n);
}

export function totalCreditIqd(lines: readonly JournalLineDraft[]): bigint {
  return lines.reduce((sum, line) => sum + line.creditIqd, 0n);
}

/** §14.3 — the balancing rule, in IQD. */
export function assertBalanced(lines: readonly JournalLineDraft[]): void {
  const debit = totalDebitIqd(lines);
  const credit = totalCreditIqd(lines);
  if (debit !== credit) {
    throw new JournalUnbalancedError(debit, credit);
  }
}

/** §14.3 — "One Journal Entry can contain one branch only." */
export function assertSingleBranch(
  header: JournalHeaderDraft,
  lines: readonly JournalLineDraft[],
): void {
  for (const line of lines) {
    const lineBranch = line.dimensions.branch;
    if (lineBranch && lineBranch !== header.branchCode) {
      throw new JournalBranchError(header.branchCode, lineBranch, line.lineNo);
    }
  }
}

/**
 * Everything a journal must satisfy before it can be submitted.
 *
 * Account-level rules (active, postable, control-account protection, required
 * dimensions) are checked by the service, which has the accounts loaded. What
 * is here is what can be decided from the journal alone.
 */
export function assertJournalValid(
  header: JournalHeaderDraft,
  lines: readonly JournalLineDraft[],
): void {
  if (lines.length < 2) {
    throw new JournalValidationError(
      'A journal needs at least two lines: one debit and one credit. A single-sided entry cannot balance.',
    );
  }

  for (const line of lines) assertLineWellFormed(line);

  if (totalDebitIqd(lines) === 0n) {
    throw new JournalValidationError(
      'The journal totals zero. An entry that moves nothing has no accounting effect — cancel it instead.',
    );
  }

  assertSingleBranch(header, lines);
  assertBalanced(lines);

  if (header.postingDate < header.documentDate) {
    // Posting before the document exists is a data-entry slip, not a policy.
    // Back-dating the *posting* date relative to today is legitimate (§14.6);
    // posting it before its own document date is not.
    throw new JournalValidationError(
      `The posting date ${header.postingDate} is before the document date ${header.documentDate}.`,
    );
  }
}

/**
 * §14 — "Journal Entries belong exclusively to the Finance Department."
 *
 * Read from the user's department assignments rather than from a role name, so
 * that "who is in Finance?" has one answer, held in one place (§5.1).
 */
export function assertFinanceDepartment(
  userId: string,
  departments: readonly { code: string; isFinance: boolean }[],
): void {
  if (!departments.some((d) => d.isFinance)) {
    throw new NotFinanceDepartmentError(userId);
  }
}
