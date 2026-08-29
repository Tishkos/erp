/**
 * The financial statements — Phase 1 requirement 5.
 *
 * "The system can produce the main accounting reports from the posted
 *  accounting records: General Ledger Report, Trial Balance, Statement of
 *  Profit or Loss and Statement of Financial Position."
 *
 * The General Ledger Report and the Trial Balance live in `trial-balance.ts`,
 * which is where the posted-lines query already is. This file adds the two
 * statements, and it adds them by *reading the same rows* — a statement that
 * came from anywhere but the posted journal lines would be a second set of
 * books, which is the failure mode double-entry exists to prevent.
 *
 * ── The one real difference between the two statements ─────────────────────
 * A Statement of Profit or Loss is about a *period*: what was earned and spent
 * between two dates. A Statement of Financial Position is about a *moment*:
 * what is owned and owed on one date, which is every posting from the
 * beginning up to it. Getting that wrong is the classic error — a balance
 * sheet filtered to one month shows a company that came into existence on the
 * first of it.
 *
 * ── Where the revenue goes on the balance sheet ─────────────────────────────
 * Revenue and expense accounts are not balance-sheet lines, and a reader who
 * looks for "Sales" among the liabilities is right not to find it. What they
 * *do* find, under Equity, is the result those accounts add up to — every
 * profit or loss since the beginning that a year-end close has not yet moved
 * into retained earnings — and beneath it, at the deepest level, the revenue
 * and expense accounts that make it. That is how the two sides agree, and how
 * a person can see why.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { NORMAL_BALANCE, type AccountType } from '../domain/accounts';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import {
  STATEMENT_LINES,
  lineFor,
  type StatementLine,
  type StatementSection,
} from '../domain/financial-statements';

export interface StatementFilter {
  readonly from: string;
  readonly to: string;
  readonly branchCode?: string | null;
  readonly allPermittedBranches?: boolean;
  readonly currency?: 'IQD' | 'USD';
}

/** One account, as it contributes to a statement line. */
export interface StatementAccount {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  /** Positive in the account's own normal direction. */
  readonly amount: string;
}

export interface StatementLineResult {
  readonly line: StatementLine;
  readonly amount: string;
  readonly accounts: readonly StatementAccount[];
}

export interface ProfitOrLoss {
  readonly from: string;
  readonly to: string;
  readonly lines: readonly StatementLineResult[];
  /** Revenue and other income added together. */
  readonly totalIncome: string;
  /** Every deduction added together. */
  readonly totalExpenses: string;
  /** Revenue less every deduction. Negative is a loss. */
  readonly result: string;
}

export interface FinancialPosition {
  readonly asAt: string;
  readonly assets: readonly StatementLineResult[];
  readonly equity: readonly StatementLineResult[];
  readonly liabilities: readonly StatementLineResult[];
  readonly totalAssets: string;
  readonly totalEquity: string;
  readonly totalLiabilities: string;
  readonly totalEquityAndLiabilities: string;
  /**
   * The accumulated result — every profit or loss up to `asAt` that no
   * year-end close has yet carried into retained earnings. Shown under Equity,
   * and it is what makes the two sides agree.
   */
  readonly resultForThePeriod: string;
  /** The revenue and expense accounts behind that result, positive in their own direction. */
  readonly resultAccounts: readonly StatementAccount[];
  readonly balances: boolean;
}

interface Movement {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  statementLine: string | null;
  debit: bigint;
  credit: bigint;
}

/**
 * Posted movement per account, between two dates.
 *
 * Posted **and reversed**: a reversed journal's own lines are still in the
 * ledger, and so are its reversal's — leaving either out would make the two
 * fail to cancel. The rule is that everything with an accounting effect is
 * included, and a draft has none.
 */
async function movements(tx: Tx, filter: StatementFilter): Promise<Movement[]> {
  const usd = (filter.currency ?? 'IQD') === 'USD';
  const debitColumn = usd ? sql`l.debit_usd` : sql`l.debit_iqd`;
  const creditColumn = usd ? sql`l.credit_usd` : sql`l.credit_iqd`;
  const branch = filter.branchCode
    ? sql`e.branch_code = ${filter.branchCode}`
    : filter.allPermittedBranches
      ? sql`true`
      : sql`(app_is_super_user() OR e.branch_code = current_setting('app.branch_code', true))`;

  const result = await tx.execute(sql`
    select a.code                                  as "accountCode",
           a.name                                  as "accountName",
           a.account_type::text                    as "accountType",
           a.statement_line                        as "statementLine",
           coalesce(sum(${debitColumn}), 0)::text  as "debit",
           coalesce(sum(${creditColumn}), 0)::text as "credit"
      from journal_line l
      join journal_entry e    on e.id = l.journal_entry_id
      join chart_of_account a on a.id = l.account_id
     where e.status in ('posted', 'reversed')
       and e.posting_date between ${filter.from}::date and ${filter.to}::date
       and ${branch}
     group by a.code, a.name, a.account_type, a.statement_line
    having coalesce(sum(${debitColumn}), 0) <> 0 or coalesce(sum(${creditColumn}), 0) <> 0
     order by a.code
  `);

  return (result.rows as unknown as Array<Record<string, string>>).map((row) => ({
    accountCode: row.accountCode!,
    accountName: row.accountName!,
    accountType: row.accountType as AccountType,
    statementLine: row.statementLine ?? null,
    debit: parseDecimal(String(row.debit), MONEY_SCALE),
    credit: parseDecimal(String(row.credit), MONEY_SCALE),
  }));
}

/**
 * The account's figure, positive in its own normal direction.
 *
 * An expense of 100 is a debit of 100 and reads as 100 on the statement; a
 * revenue of 100 is a credit of 100 and reads as 100 too. Signing by normal
 * balance is what lets both sit on the same page without a minus sign that
 * means "this is the other kind of account".
 */
function naturalAmount(movement: Movement): bigint {
  return NORMAL_BALANCE[movement.accountType] === 'debit'
    ? movement.debit - movement.credit
    : movement.credit - movement.debit;
}

/** Four decimal places, the scale the money columns keep. */
const decimal = (value: bigint): string => toDecimalString(value, MONEY_SCALE);

const sum = (lines: readonly StatementLineResult[]) =>
  lines.reduce((total, line) => total + parseDecimal(line.amount, MONEY_SCALE), 0n);

/** Groups movements onto the lines of one statement section. */
function assemble(movements: Movement[], section: StatementSection): StatementLineResult[] {
  const byLine = new Map<string, { total: bigint; accounts: StatementAccount[] }>();

  for (const movement of movements) {
    const line = lineFor(movement.accountType, movement.statementLine);
    if (line.section !== section) continue;
    const amount = naturalAmount(movement);
    // An account that moved and came back — a posting and its reversal — has
    // nothing to say on a statement of balances, so it is not listed. It stays
    // in the Trial Balance and the General Ledger, which are about movement.
    if (amount === 0n) continue;
    const bucket = byLine.get(line.code) ?? { total: 0n, accounts: [] };
    bucket.total += amount;
    bucket.accounts.push({
      accountCode: movement.accountCode,
      accountName: movement.accountName,
      accountType: movement.accountType,
      amount: decimal(amount),
    });
    byLine.set(line.code, bucket);
  }

  return STATEMENT_LINES.filter((line) => line.section === section && byLine.has(line.code))
    .map((line) => {
      const bucket = byLine.get(line.code)!;
      return { line, amount: decimal(bucket.total), accounts: bucket.accounts };
    })
    .sort((a, b) => a.line.ordinal - b.line.ordinal);
}

/** The P&L lines, and the result they come to — shared by both statements. */
function resultOf(lines: readonly StatementLineResult[]) {
  let income = 0n;
  let expenses = 0n;
  for (const entry of lines) {
    const amount = parseDecimal(entry.amount, MONEY_SCALE);
    if (entry.line.deduction) expenses += amount;
    else income += amount;
  }
  return { income, expenses, result: income - expenses };
}

/**
 * Statement of Profit or Loss, for the period between two dates.
 *
 * Revenue and other income add; cost of sales, operating expenses, finance
 * costs and tax subtract. Which of those a line does is a property of the
 * line, not of this function — see `domain/financial-statements.ts`.
 */
export async function profitOrLoss(tx: Tx, filter: StatementFilter): Promise<ProfitOrLoss> {
  const rows = await movements(tx, filter);
  const lines = assemble(rows, 'profit_or_loss');
  const { income, expenses, result } = resultOf(lines);

  return {
    from: filter.from,
    to: filter.to,
    lines,
    totalIncome: decimal(income),
    totalExpenses: decimal(expenses),
    result: decimal(result),
  };
}

/**
 * Statement of Financial Position, as at one date.
 *
 * Everything posted from the beginning up to `asAt` — see the note at the top
 * about why this is not a period report. The accumulated result is shown as a
 * line of its own under Equity: until a year-end close moves it into retained
 * earnings, that figure is what makes the two sides agree, and hiding it would
 * leave a statement that silently does not balance.
 *
 * `yearStart` is accepted for callers that still pass it and ignored: the
 * result that balances a sheet drawn from the beginning is the result since
 * the beginning, and no year-end close exists yet to have moved any of it.
 */
export async function financialPosition(
  tx: Tx,
  asAt: string,
  filter: Omit<StatementFilter, 'from' | 'to'> & { readonly yearStart?: string } = {},
): Promise<FinancialPosition> {
  const { yearStart: _ignored, ...rest } = filter;
  const fromTheBeginning: StatementFilter = { ...rest, from: '0001-01-01', to: asAt };
  const rows = await movements(tx, fromTheBeginning);

  const position = assemble(rows, 'financial_position');
  const assets = position.filter((l) => l.line.accountTypes.includes('asset'));
  const equity = position.filter((l) => l.line.accountTypes.includes('equity'));
  const liabilities = position.filter((l) => l.line.accountTypes.includes('liability'));

  // The result since the beginning, from the same rows — one query, one truth.
  const plLines = assemble(rows, 'profit_or_loss');
  const { result } = resultOf(plLines);
  const resultAccounts = plLines.flatMap((line) =>
    line.accounts.map((account) => ({
      ...account,
      // Signed as it bears on the result: income adds, a deduction takes away.
      amount: line.line.deduction
        ? decimal(-parseDecimal(account.amount, MONEY_SCALE))
        : account.amount,
    })),
  );

  const totalAssets = sum(assets);
  const totalEquity = sum(equity) + result;
  const totalLiabilities = sum(liabilities);
  const totalEquityAndLiabilities = totalEquity + totalLiabilities;

  return {
    asAt,
    assets,
    equity,
    liabilities,
    totalAssets: decimal(totalAssets),
    totalEquity: decimal(totalEquity),
    totalLiabilities: decimal(totalLiabilities),
    totalEquityAndLiabilities: decimal(totalEquityAndLiabilities),
    resultForThePeriod: decimal(result),
    resultAccounts,
    balances: totalAssets === totalEquityAndLiabilities,
  };
}
