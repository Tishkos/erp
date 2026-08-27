/**
 * Financial statement lines — Phase 1 requirement 5.
 *
 * "Accounts can be assigned to the correct financial statement lines."
 *
 * A trial balance lists accounts; a financial statement lists *lines*, and the
 * two are not the same thing. Half a dozen receivable accounts appear on one
 * line called Trade receivables, and which line an account belongs on is a
 * decision Finance makes about that account — not something a report can work
 * out from the account's name.
 *
 * So the lines are a closed list. A statement assembled from free text would
 * differ between two runs of the same report, and a statement that can differ
 * from itself is not a statement.
 *
 * Every account still lands somewhere without anybody assigning it: an
 * unassigned account falls to its type's default line, so the statements are
 * right from the first day and get more precise as Finance works through the
 * chart.
 */
import type { AccountType } from './accounts';

export const STATEMENT_SECTIONS = ['financial_position', 'profit_or_loss'] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

export interface StatementLine {
  readonly code: string;
  readonly section: StatementSection;
  /** Where it sits on the face of the statement, top to bottom. */
  readonly ordinal: number;
  /** The account types that may be assigned to it. */
  readonly accountTypes: readonly AccountType[];
  /**
   * Subtracted rather than added on the face of the statement.
   *
   * Cost of sales is a positive number that reads as a deduction; expressing
   * that here keeps the sign convention in one place instead of in each
   * report that renders it.
   */
  readonly deduction?: boolean;
}

/**
 * The standard lines.
 *
 * Deliberately the ones a small statement actually has. Phase 1 is the
 * accounting foundation; the detailed master data that would justify a longer
 * list is explicitly out of scope.
 */
export const STATEMENT_LINES: readonly StatementLine[] = Object.freeze([
  // Statement of Financial Position
  { code: 'non_current_assets', section: 'financial_position', ordinal: 10, accountTypes: ['asset'] },
  { code: 'current_assets', section: 'financial_position', ordinal: 20, accountTypes: ['asset'] },
  { code: 'cash_and_equivalents', section: 'financial_position', ordinal: 30, accountTypes: ['asset'] },
  { code: 'equity', section: 'financial_position', ordinal: 40, accountTypes: ['equity'] },
  { code: 'non_current_liabilities', section: 'financial_position', ordinal: 50, accountTypes: ['liability'] },
  { code: 'current_liabilities', section: 'financial_position', ordinal: 60, accountTypes: ['liability'] },

  // Statement of Profit or Loss
  { code: 'revenue', section: 'profit_or_loss', ordinal: 10, accountTypes: ['revenue'] },
  { code: 'cost_of_sales', section: 'profit_or_loss', ordinal: 20, accountTypes: ['expense'], deduction: true },
  { code: 'other_income', section: 'profit_or_loss', ordinal: 30, accountTypes: ['revenue'] },
  { code: 'operating_expenses', section: 'profit_or_loss', ordinal: 40, accountTypes: ['expense'], deduction: true },
  { code: 'finance_costs', section: 'profit_or_loss', ordinal: 50, accountTypes: ['expense'], deduction: true },
  { code: 'tax_expense', section: 'profit_or_loss', ordinal: 60, accountTypes: ['expense'], deduction: true },
]);

export const STATEMENT_LINE_CODES: readonly string[] = STATEMENT_LINES.map((l) => l.code);

const BY_CODE = new Map(STATEMENT_LINES.map((line) => [line.code, line]));

export function statementLine(code: string): StatementLine | undefined {
  return BY_CODE.get(code);
}

/**
 * Where an account goes when nobody has said.
 *
 * Current rather than non-current, and operating rather than anything more
 * specific: the safe assumption is the ordinary one, and an account that has
 * been put on the wrong line is easier to notice than one that has vanished
 * from the statement altogether.
 */
export const DEFAULT_LINE: Readonly<Record<AccountType, string>> = Object.freeze({
  asset: 'current_assets',
  liability: 'current_liabilities',
  equity: 'equity',
  revenue: 'revenue',
  expense: 'operating_expenses',
});

/** The line an account reports on: the one assigned, or its type's default. */
export function lineFor(accountType: AccountType, assigned?: string | null): StatementLine {
  const chosen = assigned ? BY_CODE.get(assigned) : undefined;
  if (chosen && chosen.accountTypes.includes(accountType)) return chosen;
  return BY_CODE.get(DEFAULT_LINE[accountType])!;
}

/** The lines a given account type may be assigned to, for a picker. */
export function linesForType(accountType: AccountType): readonly StatementLine[] {
  return STATEMENT_LINES.filter((line) => line.accountTypes.includes(accountType));
}

export class StatementLineError extends Error {
  readonly code = 'STATEMENT_LINE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'StatementLineError';
  }
}

/** Refuses a line that does not exist, or one this account type cannot sit on. */
export function assertLineAllowed(accountType: AccountType, code: string): StatementLine {
  const line = BY_CODE.get(code);
  if (!line) {
    throw new StatementLineError(`'${code}' is not a financial statement line.`);
  }
  if (!line.accountTypes.includes(accountType)) {
    throw new StatementLineError(
      `A ${accountType} account cannot report on '${code}' — that line carries ${line.accountTypes.join(' and ')} accounts.`,
    );
  }
  return line;
}
