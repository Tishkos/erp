/**
 * The financial statements — Phase 1 requirement 5.
 *
 * "The system can produce the main accounting reports from the posted
 *  accounting records: General Ledger Report, Trial Balance, Statement of
 *  Profit or Loss and Statement of Financial Position."
 *
 * The General Ledger Report and the Trial Balance live in `trial-balance.ts`,
 * which is where the posted-lines query already is. This file adds the four
 * statements — Income Statement, Balance Sheet, Changes in Equity and Cash
 * Flow Statement, each on a screen of its own (by direction, 2026-08-31) — and
 * it adds them by *reading the same rows*. A statement that came from anywhere
 * but the posted journal lines would be a second set of books, which is the
 * failure mode double-entry exists to prevent.
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
  CASH_FLOW_CATEGORIES,
  type CashFlowCategory,
  type IncomeRole,
  LineCatalogue,
  type StatementFace,
  type StatementLine,
  type StatementLineNode,
  type StatementSection,
} from '../domain/financial-statements';
import * as statementLines from './statement-lines';

export { CASH_FLOW_CATEGORIES, type CashFlowCategory };

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
  /** Signed as this account contributes to the statement line. */
  readonly amount: string;
}

export interface StatementLineResult {
  readonly line: StatementLine;
  /** Steps below the side heading — headers and their lines indent by it. */
  readonly depth: number;
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
  /** The part of the result not presented on a configured Balance Sheet line. */
  readonly unmappedResult: string;
  /** The revenue and expense accounts behind that result, positive in their own direction. */
  readonly resultAccounts: readonly StatementAccount[];
  readonly balances: boolean;
}

interface Movement {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  income_statement: string | null;
  balance_sheet: string | null;
  cash_flow: string | null;
  changes_in_equity: string | null;
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
const debitOf = (filter: StatementFilter) =>
  (filter.currency ?? 'IQD') === 'USD' ? sql`l.debit_usd` : sql`l.debit_iqd`;
const creditOf = (filter: StatementFilter) =>
  (filter.currency ?? 'IQD') === 'USD' ? sql`l.credit_usd` : sql`l.credit_iqd`;

/** Which branches the reader may see — the same rule for every statement. */
const branchOf = (filter: StatementFilter) =>
  filter.branchCode
    ? sql`e.branch_code = ${filter.branchCode}`
    : filter.allPermittedBranches
      ? sql`true`
      : sql`(app_is_super_user() OR e.branch_code = current_setting('app.branch_code', true))`;

async function movements(tx: Tx, filter: StatementFilter): Promise<Movement[]> {
  const debitColumn = debitOf(filter);
  const creditColumn = creditOf(filter);
  const branch = branchOf(filter);

  const result = await tx.execute(sql`
    select a.code                                  as "accountCode",
           a.name                                  as "accountName",
           a.account_type::text                    as "accountType",
           a.income_statement_line                 as "incomeStatementLine",
           a.balance_sheet_line                    as "balanceSheetLine",
           a.cash_flow_line                        as "cashFlowLine",
           a.changes_in_equity_line                as "changesInEquityLine",
           coalesce(sum(${debitColumn}), 0)::text  as "debit",
           coalesce(sum(${creditColumn}), 0)::text as "credit"
      from journal_line l
      join journal_entry e    on e.id = l.journal_entry_id
      join chart_of_account a on a.id = l.account_id
     where e.status in ('posted', 'reversed')
       and e.posting_date between ${filter.from}::date and ${filter.to}::date
       and ${branch}
     group by a.code, a.name, a.account_type,
              a.income_statement_line, a.balance_sheet_line,
              a.cash_flow_line, a.changes_in_equity_line
    having coalesce(sum(${debitColumn}), 0) <> 0 or coalesce(sum(${creditColumn}), 0) <> 0
     order by a.code
  `);

  return (result.rows as unknown as Array<Record<string, string>>).map((row) => ({
    accountCode: row.accountCode!,
    accountName: row.accountName!,
    accountType: row.accountType as AccountType,
    income_statement: row.incomeStatementLine ?? null,
    balance_sheet: row.balanceSheetLine ?? null,
    cash_flow: row.cashFlowLine ?? null,
    changes_in_equity: row.changesInEquityLine ?? null,
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

/**
 * Where one account prints on one report.
 *
 * Every statement below asks this and nothing else. The account carries four
 * independent answers and this picks the one the report in hand is asking
 * about — or its type's default there, or nothing, when the account does not
 * belong on that report at all.
 */
const lineOf = (
  catalogue: LineCatalogue,
  account: {
    readonly accountType: AccountType;
    readonly income_statement: string | null;
    readonly balance_sheet: string | null;
    readonly cash_flow: string | null;
    readonly changes_in_equity: string | null;
  },
  statement: StatementFace,
): StatementLine | undefined => catalogue.lineFor(account.accountType, statement, account[statement]);

/** Four decimal places, the scale the money columns keep. */
const decimal = (value: bigint): string => toDecimalString(value, MONEY_SCALE);

/** Headers repeat what their lines hold, so a total counts the lines alone. */
const sum = (lines: readonly StatementLineResult[]) =>
  lines
    .filter((entry) => !entry.line.isHeader)
    .reduce((total, line) => total + parseDecimal(line.amount, MONEY_SCALE), 0n);

/** The accounts of one report, grouped onto the line each of them maps to. */
function bucket(
  catalogue: LineCatalogue,
  movements: Movement[],
  statement: StatementFace,
): Map<string, { total: bigint; accounts: StatementAccount[] }> {
  const byLine = new Map<string, { total: bigint; accounts: StatementAccount[] }>();

  for (const movement of movements) {
    const line = lineOf(catalogue, movement, statement);
    if (!line) continue;

    let amount = naturalAmount(movement);
    const profitOrLossAccount =
      movement.accountType === 'revenue' || movement.accountType === 'expense';
    if (statement !== 'income_statement' && profitOrLossAccount) {
      // Away from the Income Statement, a revenue balance adds to equity and
      // an expense balance reduces it. Which way round is a property of the
      // account's *income* line, because that is where its bearing on the
      // result is stated.
      if (lineOf(catalogue, movement, 'income_statement')?.deduction) amount = -amount;
    }

    // An account that moved and came back — a posting and its reversal — has
    // nothing to say on a statement of balances, so it is not listed. It stays
    // in the Trial Balance and the General Ledger, which are about movement.
    if (amount === 0n) continue;
    const entry = byLine.get(line.code) ?? { total: 0n, accounts: [] };
    entry.total += amount;
    entry.accounts.push({
      accountCode: movement.accountCode,
      accountName: movement.accountName,
      accountType: movement.accountType,
      amount: decimal(amount),
    });
    byLine.set(line.code, entry);
  }

  return byLine;
}

/** Groups movements onto one report's lines, flat, in the mapping's own order. */
function assemble(
  catalogue: LineCatalogue,
  movements: Movement[],
  statement: StatementFace,
): StatementLineResult[] {
  const byLine = bucket(catalogue, movements, statement);
  return catalogue
    .linesOf(statement)
    .filter((line) => !line.isHeader && byLine.has(line.code))
    .map((line) => {
      const entry = byLine.get(line.code)!;
      return { line, depth: 0, amount: decimal(entry.total), accounts: entry.accounts };
    });
}

/**
 * The branches of one report's layout that have something to print, in the
 * mapping's own order, each with its depth.
 *
 * The rule is the same on all four statements: a header is a grouping title,
 * so it appears exactly where something beneath it does, and it carries the
 * sum of what is beneath it *in the part being drawn*. That last part
 * matters — a header may hold lines on both sides of the Balance Sheet, or in
 * two sections of the Cash Flow Statement, and printing its whole total under
 * each heading would be the same money counted twice.
 */
function heldBranches(
  nodes: readonly StatementLineNode[],
  holds: (code: string) => boolean,
  depth = 0,
): { node: StatementLineNode; depth: number }[] {
  const out: { node: StatementLineNode; depth: number }[] = [];
  for (const node of nodes) {
    const children = heldBranches(node.children, holds, depth + 1);
    if (children.length === 0 && !(!node.line.isHeader && holds(node.line.code))) continue;
    out.push({ node, depth });
    out.push(...children);
  }
  return out;
}

/** Every line code in one branch, the branch's own line included. */
function branchCodes(node: StatementLineNode): string[] {
  return [node.line.code, ...node.children.flatMap(branchCodes)];
}

/**
 * One side of the Balance Sheet, drawn as the mapping draws it: the side's
 * headers and lines in Finance's own order and nesting, each header carrying
 * the sum of the lines beneath it. A branch with nothing in it is not drawn.
 */
function sideRows(
  catalogue: LineCatalogue,
  byLine: ReadonlyMap<string, { total: bigint; accounts: StatementAccount[] }>,
  side: 'asset' | 'equity' | 'liability',
): StatementLineResult[] {
  return heldBranches(catalogue.sideTree(side), (code) => byLine.has(code)).map(
    ({ node, depth }) => ({
      line: node.line,
      depth,
      amount: decimal(
        branchCodes(node).reduce((total, code) => total + (byLine.get(code)?.total ?? 0n), 0n),
      ),
      accounts: node.line.isHeader ? [] : (byLine.get(node.line.code)?.accounts ?? []),
    }),
  );
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
  const [rows, catalogue] = await Promise.all([movements(tx, filter), statementLines.catalogue(tx)]);
  const lines = assemble(catalogue, rows, 'income_statement');
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
  const [rows, catalogue] = await Promise.all([
    movements(tx, fromTheBeginning),
    statementLines.catalogue(tx),
  ]);

  const position = bucket(catalogue, rows, 'balance_sheet');
  const assets = sideRows(catalogue, position, 'asset');
  const equity = sideRows(catalogue, position, 'equity');
  const liabilities = sideRows(catalogue, position, 'liability');

  // The complete result still comes from the Income Statement mapping. Any
  // P&L account with its own Balance Sheet mapping is already inside `equity`,
  // so only the remainder is shown in the computed result row.
  const plLines = assemble(catalogue, rows, 'income_statement');
  const { result } = resultOf(plLines);
  const residualRows = rows.filter(
    (movement) =>
      (movement.accountType === 'revenue' || movement.accountType === 'expense') &&
      !lineOf(catalogue, movement, 'balance_sheet'),
  );
  const residualLines = assemble(catalogue, residualRows, 'income_statement');
  const { result: unmappedResult } = resultOf(residualLines);
  const resultAccounts = residualLines.flatMap((line) =>
    line.accounts.map((account) => ({
      ...account,
      // Signed as it bears on the result: income adds, a deduction takes away.
      amount: line.line.deduction
        ? decimal(-parseDecimal(account.amount, MONEY_SCALE))
        : account.amount,
    })),
  );

  const totalAssets = sum(assets);
  const totalEquity = sum(equity) + unmappedResult;
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
    unmappedResult: decimal(unmappedResult),
    resultAccounts,
    balances: totalAssets === totalEquityAndLiabilities,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Statement of Changes in Equity
//
// The third statement, on a page of its own (by direction, 2026-08-31). It
// answers one question the other two cannot: equity was this at the start of
// the period and that at the end — what happened in between.
//
// Read the same way everything else here is read, from the posted lines: the
// opening column is every posting from the beginning up to the day before the
// period, the movement column is the period itself, and the closing column is
// the two added. The closing column is therefore the Equity section of a
// Balance Sheet drawn at `to`, which is the check a reader will make.
// ───────────────────────────────────────────────────────────────────────────

const BEGINNING = '0001-01-01';

/** The day before a date — an opening balance is everything up to it. */
function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** One account, with what it stood at and what it did. */
export interface MovementAccount {
  readonly accountCode: string;
  readonly accountName: string;
  readonly opening: string;
  readonly movement: string;
  readonly closing: string;
}

export interface EquityRow {
  /** A statement line's code, or `result` for the accumulated profit or loss. */
  readonly code: string;
  /** What the mapping calls the line; pages fall back to it when no translation exists. */
  readonly name: string;
  /**
   * `header` is a grouping title carrying the sum of the lines beneath it;
   * `result` is not an equity account at all — it is what the revenue and
   * expense accounts nobody mapped here come to.
   */
  readonly kind: 'line' | 'header' | 'result';
  /** Steps into the mapping — a header and its lines indent by it. */
  readonly depth: number;
  readonly opening: string;
  readonly movement: string;
  readonly closing: string;
  readonly accounts: readonly MovementAccount[];
}

export interface ChangesInEquity {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly EquityRow[];
  readonly opening: string;
  readonly movement: string;
  readonly closing: string;
  /** The profit or loss of the period alone — the reason most of the movement exists. */
  readonly resultForThePeriod: string;
}

interface Paired {
  readonly accountName: string;
  readonly accountType: AccountType;
  readonly income_statement: string | null;
  readonly balance_sheet: string | null;
  readonly cash_flow: string | null;
  readonly changes_in_equity: string | null;
  opening: bigint;
  movement: bigint;
}

/**
 * Two sets of movements — before the period and during it — laid side by side
 * per account. An account that appears in only one of them still gets a row,
 * with zero for the side it is missing from.
 */
function pairUp(
  catalogue: LineCatalogue,
  before: readonly Movement[],
  during: readonly Movement[],
): Map<string, Paired> {
  const byCode = new Map<string, Paired>();
  const put = (movement: Movement, column: 'opening' | 'movement', sign: bigint) => {
    const existing =
      byCode.get(movement.accountCode) ??
      {
        accountName: movement.accountName,
        accountType: movement.accountType,
        income_statement: movement.income_statement,
        balance_sheet: movement.balance_sheet,
        cash_flow: movement.cash_flow,
        changes_in_equity: movement.changes_in_equity,
        opening: 0n,
        movement: 0n,
      };
    existing[column] += naturalAmount(movement) * sign;
    byCode.set(movement.accountCode, existing);
  };
  // Revenue and expense accounts are signed as they bear on the result: income
  // adds to it, a deduction takes away. Equity accounts keep their own sign.
  const signOf = (movement: Movement) =>
    lineOf(catalogue, movement, 'income_statement')?.deduction ? -1n : 1n;
  for (const movement of before) put(movement, 'opening', signOf(movement));
  for (const movement of during) put(movement, 'movement', signOf(movement));
  return byCode;
}

const accountRows = (paired: Map<string, Paired>, codes: readonly string[]): MovementAccount[] =>
  codes
    .map((code) => {
      const entry = paired.get(code)!;
      return {
        accountCode: code,
        accountName: entry.accountName,
        opening: decimal(entry.opening),
        movement: decimal(entry.movement),
        closing: decimal(entry.opening + entry.movement),
      };
    })
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode, 'en'));

/**
 * Statement of Changes in Equity, for the period between two dates.
 *
 * Every equity line, plus the accumulated result that no year-end close has
 * carried into retained earnings — the same figure the Balance Sheet shows
 * under Equity, which is what makes the two statements agree.
 */
export async function changesInEquity(tx: Tx, filter: StatementFilter): Promise<ChangesInEquity> {
  const [before, during, catalogue] = await Promise.all([
    movements(tx, { ...filter, from: BEGINNING, to: dayBefore(filter.from) }),
    movements(tx, filter),
    statementLines.catalogue(tx),
  ]);
  const paired = pairUp(catalogue, before, during);

  // This statement has a mapping of its own: the rows are the lines Finance
  // built for it, carrying the accounts mapped to them. An equity account
  // that nobody has moved falls to the seeded line, so the statement is never
  // silently missing a piece of equity the Balance Sheet is showing.
  const byLine = new Map<string, string[]>();
  for (const [code, entry] of paired) {
    if (entry.opening === 0n && entry.movement === 0n) continue;
    const line = lineOf(catalogue, entry, 'changes_in_equity');
    if (!line) continue;
    byLine.set(line.code, [...(byLine.get(line.code) ?? []), code]);
  }

  // The statement's own layout, headers and all: a title appears wherever
  // something beneath it does, carrying the sum of what its lines hold.
  const lineRows: EquityRow[] = heldBranches(
    catalogue.treeFor('changes_in_equity'),
    (code) => byLine.has(code),
  ).map(({ node, depth }) => {
    const accounts = node.line.isHeader ? [] : accountRows(paired, byLine.get(node.line.code) ?? []);
    const codes = branchCodes(node);
    const sumOf = (column: 'opening' | 'movement') =>
      codes
        .flatMap((code) => byLine.get(code) ?? [])
        .reduce((total, account) => total + (paired.get(account)?.[column] ?? 0n), 0n);
    const opening = sumOf('opening');
    const movement = sumOf('movement');
    return {
      code: node.line.code,
      name: node.line.name,
      kind: node.line.isHeader ? ('header' as const) : ('line' as const),
      depth,
      opening: decimal(opening),
      movement: decimal(movement),
      closing: decimal(opening + movement),
      accounts,
    };
  });

  // A revenue or expense account nobody has mapped here stays inside the
  // computed result, which is what keeps this statement's closing equity
  // equal to the Balance Sheet's.
  const resultCodes = [...paired]
    .filter(([, entry]) => entry.accountType === 'revenue' || entry.accountType === 'expense')
    .filter(([, entry]) => !lineOf(catalogue, entry, 'changes_in_equity'))
    .filter(([, entry]) => entry.opening !== 0n || entry.movement !== 0n)
    .map(([code]) => code);
  const resultAccounts = accountRows(paired, resultCodes);
  const openingResult = resultAccounts.reduce((t, a) => t + parseDecimal(a.opening, MONEY_SCALE), 0n);
  const residualPeriodResult = resultAccounts.reduce(
    (t, a) => t + parseDecimal(a.movement, MONEY_SCALE),
    0n,
  );
  const periodResult = [...paired]
    .filter(([, entry]) => entry.accountType === 'revenue' || entry.accountType === 'expense')
    .reduce((total, [, entry]) => total + entry.movement, 0n);

  const rows: EquityRow[] = [
    ...lineRows,
    ...(resultAccounts.length > 0
      ? [
          {
            code: 'result',
            name: 'Result',
            kind: 'result' as const,
            depth: 0,
            opening: decimal(openingResult),
            movement: decimal(residualPeriodResult),
            closing: decimal(openingResult + residualPeriodResult),
            accounts: resultAccounts,
          },
        ]
      : []),
  ];

  const counted = rows.filter((row) => row.kind !== 'header');
  const opening = counted.reduce((t, row) => t + parseDecimal(row.opening, MONEY_SCALE), 0n);
  const movement = counted.reduce((t, row) => t + parseDecimal(row.movement, MONEY_SCALE), 0n);

  return {
    from: filter.from,
    to: filter.to,
    rows,
    opening: decimal(opening),
    movement: decimal(movement),
    closing: decimal(opening + movement),
    resultForThePeriod: decimal(periodResult),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Statement of Cash Flows
//
// The fourth statement, on a page of its own (by direction, 2026-08-31), and
// the only one that cannot be read off account balances alone. Cash went up or
// down by a figure the Balance Sheet already shows; what this statement adds
// is *why*, and the why is not a property of the cash account — it is a
// property of the other side of each journal that touched cash.
//
// So it is built the direct way, from the journals themselves: take every
// entry that moved a cash account, and attribute the cash it moved to the
// accounts on the other side of it. A sale settled in cash is attributed to
// Revenue and is operating; an equipment purchase to Non-current assets and is
// investing; capital introduced to Equity and is financing. Nothing is
// classified by a mapping table somebody has to maintain, and nothing is
// guessed from an account's name.
//
// Which accounts *are* cash is the one thing that must be said out loud, and
// it is said in the Chart of Accounts: an account reports on the "Cash and
// cash equivalents" statement line, or it is not cash. Until Finance has
// assigned at least one, this statement says so plainly rather than showing an
// empty page that reads as a fault.
//
// The arithmetic ties by construction. Every entry that touched cash is
// attributed in full, so the three sections add to the movement between the
// opening and closing cash balances — and the page says whether they do.
// ───────────────────────────────────────────────────────────────────────────

// Where a cash movement belongs is read from the account on the other side of
// the entry: the *category* of the statement line that account reports on.
// The categories live on the mapping — Finance sets them on the Cash Flow
// Mapping screen — and a cash line itself carries none, because cash moving
// between two cash accounts is not a cash flow.

/** The codes of the lines whose accounts ARE cash, per the mapping. */
const cashCodes = (catalogue: LineCatalogue): string[] =>
  catalogue.lines.filter((line) => line.isCash).map((line) => line.code);

export interface CashFlowSection {
  readonly category: CashFlowCategory;
  /** Amounts are signed as the cash moved: positive in, negative out. */
  readonly lines: readonly StatementLineResult[];
  readonly total: string;
}

export interface CashFlow {
  readonly from: string;
  readonly to: string;
  readonly sections: readonly CashFlowSection[];
  readonly netMovement: string;
  readonly openingCash: string;
  readonly closingCash: string;
  /** False when no account has been assigned to the cash line yet. */
  readonly configured: boolean;
  /** The cash accounts and what each of them closed at. */
  readonly cashAccounts: readonly StatementAccount[];
  readonly reconciles: boolean;
}

interface EntryLine {
  readonly entryId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountType;
  readonly cash_flow: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
}

/**
 * Which accounts are the cash this statement explains.
 *
 * Said out loud on the Cash Flow mapping, and nowhere else: an account is
 * mapped to a line marked as cash, or it is not cash. Nothing is guessed from
 * an account's name or from where it sits on another report.
 */
const isCash = (
  catalogue: LineCatalogue,
  account: { accountType: AccountType; cash_flow: string | null },
) => catalogue.lineFor(account.accountType, 'cash_flow', account.cash_flow)?.isCash ?? false;

/** The line an account's cash movements are attributed to. */
const cashFlowLineOf = (
  catalogue: LineCatalogue,
  account: { accountType: AccountType; cash_flow: string | null },
) => catalogue.lineFor(account.accountType, 'cash_flow', account.cash_flow);

/** Has anybody said which accounts are cash? */
async function cashLineAssigned(tx: Tx, codes: readonly string[]): Promise<boolean> {
  if (codes.length === 0) return false;
  const list = sql.join(codes.map((code) => sql`${code}`), sql`, `);
  const result = await tx.execute(sql`
    select 1 from chart_of_account where cash_flow_line in (${list}) limit 1
  `);
  return result.rows.length > 0;
}

/**
 * Every line of every entry that moved a cash account, in the period.
 *
 * Per entry, not per account: the attribution is a question about one journal
 * — which accounts sat opposite the cash — and summing across journals first
 * would destroy exactly the information it needs.
 */
async function entryMovements(
  tx: Tx,
  filter: StatementFilter,
  codes: readonly string[],
): Promise<EntryLine[]> {
  if (codes.length === 0) return [];
  const cashList = sql.join(codes.map((code) => sql`${code}`), sql`, `);
  const debitColumn = debitOf(filter);
  const creditColumn = creditOf(filter);
  const branch = branchOf(filter);

  const result = await tx.execute(sql`
    select l.journal_entry_id::text                as "entryId",
           a.code                                  as "accountCode",
           a.name                                  as "accountName",
           a.account_type::text                    as "accountType",
           a.cash_flow_line                        as "cashFlowLine",
           coalesce(sum(${debitColumn}), 0)::text  as "debit",
           coalesce(sum(${creditColumn}), 0)::text as "credit"
      from journal_line l
      join journal_entry e    on e.id = l.journal_entry_id
      join chart_of_account a on a.id = l.account_id
     where e.status in ('posted', 'reversed')
       and e.posting_date between ${filter.from}::date and ${filter.to}::date
       and ${branch}
       and exists (
         select 1
           from journal_line cash
           join chart_of_account ca on ca.id = cash.account_id
          where cash.journal_entry_id = l.journal_entry_id
            and ca.cash_flow_line in (${cashList})
       )
     group by l.journal_entry_id, a.code, a.name, a.account_type, a.cash_flow_line
     order by l.journal_entry_id, a.code
  `);

  return (result.rows as unknown as Array<Record<string, string>>).map((row) => ({
    entryId: row.entryId!,
    accountCode: row.accountCode!,
    accountName: row.accountName!,
    accountType: row.accountType as AccountType,
    cash_flow: row.cashFlowLine ?? null,
    debit: parseDecimal(String(row.debit), MONEY_SCALE),
    credit: parseDecimal(String(row.credit), MONEY_SCALE),
  }));
}

const abs = (value: bigint) => (value < 0n ? -value : value);

/** The cash held, and by which account, in a set of movements. */
function cashHeld(
  catalogue: LineCatalogue,
  rows: readonly Movement[],
): { total: bigint; accounts: StatementAccount[] } {
  let total = 0n;
  const accounts: StatementAccount[] = [];
  for (const movement of rows) {
    if (!isCash(catalogue, movement)) continue;
    const amount = naturalAmount(movement);
    total += amount;
    accounts.push({
      accountCode: movement.accountCode,
      accountName: movement.accountName,
      accountType: movement.accountType,
      amount: decimal(amount),
    });
  }
  return { total, accounts };
}

/**
 * Statement of Cash Flows, for the period between two dates.
 *
 * Each entry's cash movement is shared out across the accounts opposite it, in
 * proportion to what each of them moved. For the ordinary two-line journal
 * that is the whole amount to the one account facing the cash; for a longer
 * journal it is the only division that does not invent a fact the entry does
 * not contain. The rounding remainder goes to the largest share, so the
 * sections still add to the movement exactly.
 */
export async function cashFlow(tx: Tx, filter: StatementFilter): Promise<CashFlow> {
  const catalogue = await statementLines.catalogue(tx);
  const cash = cashCodes(catalogue);
  const [configured, before, upToTheEnd, entries] = await Promise.all([
    cashLineAssigned(tx, cash),
    movements(tx, { ...filter, from: BEGINNING, to: dayBefore(filter.from) }),
    movements(tx, { ...filter, from: BEGINNING }),
    entryMovements(tx, filter, cash),
  ]);

  const opening = cashHeld(catalogue, before);
  const closing = cashHeld(catalogue, upToTheEnd);

  // entryId → its lines.
  const byEntry = new Map<string, EntryLine[]>();
  for (const line of entries) {
    byEntry.set(line.entryId, [...(byEntry.get(line.entryId) ?? []), line]);
  }

  // (category, statement line, account) → the cash attributed to it.
  const buckets = new Map<
    string,
    { category: CashFlowCategory; line: StatementLine; account: EntryLine; amount: bigint }
  >();
  const attribute = (
    category: CashFlowCategory,
    line: StatementLine,
    account: EntryLine,
    amount: bigint,
  ) => {
    const key = `${category}|${line.code}|${account.accountCode}`;
    const existing = buckets.get(key);
    if (existing) existing.amount += amount;
    else buckets.set(key, { category, line, account, amount });
  };

  for (const lines of byEntry.values()) {
    const cashSide = lines.filter((line) => isCash(catalogue, line));
    const others = lines.filter((line) => !isCash(catalogue, line));
    // Positive when the entry brought cash in.
    const delta = cashSide.reduce((total, line) => total + line.debit - line.credit, 0n);
    if (delta === 0n || others.length === 0) continue;

    const weights = others.map((line) => abs(line.debit - line.credit));
    const weight = weights.reduce((total, w) => total + w, 0n);
    if (weight === 0n) continue;

    // The largest share absorbs the rounding remainder, so the parts add up.
    let largest = 0;
    for (let i = 1; i < weights.length; i += 1) if (weights[i]! > weights[largest]!) largest = i;

    let assigned = 0n;
    others.forEach((account, index) => {
      if (index === largest) return;
      const share = (delta * weights[index]!) / weight;
      assigned += share;
      const line = cashFlowLineOf(catalogue, account);
      const category = line?.cashFlowCategory;
      if (line && category && share !== 0n) attribute(category, line, account, share);
    });
    const rest = delta - assigned;
    const line = cashFlowLineOf(catalogue, others[largest]!);
    const category = line?.cashFlowCategory;
    if (line && category && rest !== 0n) attribute(category, line, others[largest]!, rest);
  }

  const sections: CashFlowSection[] = CASH_FLOW_CATEGORIES.map((category) => {
    const byLine = new Map<string, { total: bigint; accounts: StatementAccount[] }>();
    for (const bucket of buckets.values()) {
      if (bucket.category !== category) continue;
      const entry = byLine.get(bucket.line.code) ?? { total: 0n, accounts: [] };
      entry.total += bucket.amount;
      entry.accounts.push({
        accountCode: bucket.account.accountCode,
        accountName: bucket.account.accountName,
        accountType: bucket.account.accountType,
        amount: decimal(bucket.amount),
      });
      byLine.set(bucket.line.code, entry);
    }

    // The activity's own branch of the layout — headers included, each
    // carrying the sum of what this activity holds beneath it.
    const lines = heldBranches(catalogue.treeFor('cash_flow'), (code) => byLine.has(code)).map(
      ({ node, depth }) => ({
        line: node.line,
        depth,
        amount: decimal(
          branchCodes(node).reduce((total, code) => total + (byLine.get(code)?.total ?? 0n), 0n),
        ),
        accounts: node.line.isHeader
          ? []
          : [...(byLine.get(node.line.code)?.accounts ?? [])].sort((a, b) =>
              a.accountCode.localeCompare(b.accountCode, 'en'),
            ),
      }),
    );

    return {
      category,
      lines,
      // Headers repeat what their lines hold, so only the lines are added up.
      total: decimal(
        lines
          .filter((entry) => !entry.line.isHeader)
          .reduce((total, entry) => total + parseDecimal(entry.amount, MONEY_SCALE), 0n),
      ),
    };
  });

  const netMovement = sections.reduce(
    (total, section) => total + parseDecimal(section.total, MONEY_SCALE),
    0n,
  );

  return {
    from: filter.from,
    to: filter.to,
    sections,
    netMovement: decimal(netMovement),
    openingCash: decimal(opening.total),
    closingCash: decimal(closing.total),
    configured,
    cashAccounts: closing.accounts,
    reconciles: opening.total + netMovement === closing.total,
  };
}


// ───────────────────────────────────────────────────────────────────────────
// The Income Statement, as it is presented
//
// By direction (2026-09-03): the layout belongs to Finance. The Income
// Statement Mapping screen holds the headers and lines in the order they
// print, and this function draws exactly that — each top-level branch as a
// section carrying its total, the lines beneath it indented as the mapping
// nests them, and the accounts connected to each line listed under it.
//
//   Revenue                       ← a mapping line (or header), its total
//     R000006 · Solar Revenue     ← an account connected to the line
//     R000012 · Logistics Revenue
//   Cost of Sales
//     X000005 · Solar COGS
//                        ─────────
//   Gross profit                  ← computed, ruled
//   ...
//                        ═════════
//   Net profit                    ← computed, double-ruled
//
// ── The layout is Finance's; the arithmetic is not ─────────────────────────
// Every line names the role it plays — revenue, cost of sales, other income,
// operating expenses, finance costs, tax — and the running subtotals are
// computed from the roles, wherever the lines sit on the page. Gross profit
// is revenue less cost of sales however the statement is arranged; a layout
// that could redefine it would make two companies' statements incomparable.
//
// Each subtotal is ruled in after the last section that feeds it: gross
// profit after the last branch holding revenue or cost-of-sales content, the
// operating result after the operating expenses, and the result — double-
// ruled — at the end. A subtotal that would repeat the figure above it under
// another name stays silent, exactly as before.
// ───────────────────────────────────────────────────────────────────────────

/** A line of the statement, in the order it is printed. */
export interface IncomeRow {
  /**
   * `section`  — a top-level branch of the mapping and its total.
   * `group`    — a nested header or line of the mapping.
   * `account`  — a posting account connected to the line above it.
   * `subtotal` — a computed figure: the margin, the result.
   */
  readonly kind: 'section' | 'group' | 'account' | 'subtotal';
  /** Unique within the statement. */
  readonly key: string;
  /** For `subtotal`: the message key naming it. */
  readonly labelKey: string | null;
  /** The mapping line's code, or the account's. */
  readonly code: string | null;
  /** The mapping line's name, or the account's. */
  readonly name: string | null;
  /** 0 for a section or a subtotal; each step into the mapping adds one. */
  readonly depth: number;
  readonly amount: string;
  /** Subtotals are ruled above; the result is ruled twice. */
  readonly rule: 'none' | 'single' | 'double';
  /** True where the figure is taken away from what is above it. */
  readonly deducted: boolean;
}

export interface IncomeStatement {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly IncomeRow[];
  readonly revenue: string;
  readonly costOfSales: string;
  readonly grossProfit: string;
  readonly operatingExpenses: string;
  readonly operatingIncome: string;
  readonly otherIncome: string;
  readonly financeCosts: string;
  readonly incomeBeforeTax: string;
  readonly tax: string;
  readonly result: string;
  /** The deepest the mapping goes in this statement — the level picker's ceiling. */
  readonly depth: number;
}

/**
 * Statement of Profit or Loss, in the form Finance mapped it.
 *
 * Read from the posted journal lines, like everything else here. The figures
 * are the same ones `profitOrLoss` returns — this arranges them.
 */
export async function incomeStatement(
  tx: Tx,
  filter: StatementFilter,
): Promise<IncomeStatement> {
  const [rows, catalogue] = await Promise.all([movements(tx, filter), statementLines.catalogue(tx)]);

  // Each line's accounts and total, and each role's total for the subtotals.
  const byLine = bucket(catalogue, rows, 'income_statement');
  const roleTotals = new Map<IncomeRole, bigint>();
  for (const line of catalogue.lines) {
    if (line.statement !== 'income_statement' || line.isHeader) continue;
    const entry = byLine.get(line.code);
    if (!entry || !line.role) continue;
    roleTotals.set(line.role, (roleTotals.get(line.role) ?? 0n) + entry.total);
  }
  const at = (role: IncomeRole) => roleTotals.get(role) ?? 0n;
  const has = (role: IncomeRole) => roleTotals.has(role);

  // What a branch of the mapping holds, and how its figure reads. A branch of
  // one bearing prints positive with its "deducted" mark; a branch that mixes
  // income and deductions prints the net, because any other single number
  // about it would be wrong.
  const holds = (node: StatementLineNode): boolean =>
    (!node.line.isHeader && byLine.has(node.line.code)) || node.children.some(holds);
  const bearings = (node: StatementLineNode): { added: bigint; deducted: bigint } => {
    const own = !node.line.isHeader ? (byLine.get(node.line.code)?.total ?? 0n) : 0n;
    let added = node.line.deduction ? 0n : own;
    let taken = node.line.deduction ? own : 0n;
    for (const child of node.children) {
      const inner = bearings(child);
      added += inner.added;
      taken += inner.deducted;
    }
    return { added, deducted: taken };
  };
  const figureOf = (node: StatementLineNode): { amount: bigint; deducted: boolean } => {
    const { added, deducted: taken } = bearings(node);
    if (added !== 0n && taken !== 0n) return { amount: added - taken, deducted: false };
    if (taken !== 0n || (added === 0n && node.line.deduction)) return { amount: taken, deducted: true };
    return { amount: added, deducted: false };
  };
  const rolesOf = (node: StatementLineNode, into = new Set<IncomeRole>()): Set<IncomeRole> => {
    if (!node.line.isHeader && node.line.role && byLine.has(node.line.code)) into.add(node.line.role);
    for (const child of node.children) rolesOf(child, into);
    return into;
  };

  const out: IncomeRow[] = [];
  let depth = 0;

  const emit = (node: StatementLineNode, level: number) => {
    if (!holds(node)) return;
    const figure = figureOf(node);
    out.push({
      kind: level === 0 ? 'section' : 'group',
      key: `line:${node.line.code}`,
      labelKey: null,
      code: node.line.code,
      name: node.line.name,
      depth: level,
      amount: decimal(figure.amount),
      rule: 'none',
      deducted: figure.deducted,
    });
    depth = Math.max(depth, level);
    if (!node.line.isHeader) {
      const accounts = [...(byLine.get(node.line.code)?.accounts ?? [])].sort((a, b) =>
        a.accountCode.localeCompare(b.accountCode, 'en'),
      );
      for (const account of accounts) {
        out.push({
          kind: 'account',
          key: `account:${node.line.code}:${account.accountCode}`,
          labelKey: null,
          code: account.accountCode,
          name: account.accountName,
          depth: level + 1,
          amount: account.amount,
          rule: 'none',
          deducted: false,
        });
        depth = Math.max(depth, level + 1);
      }
    }
    for (const child of node.children) emit(child, level + 1);
  };

  const subtotal = (labelKey: string, amount: bigint, rule: 'single' | 'double') => {
    out.push({
      kind: 'subtotal',
      key: `subtotal:${labelKey}`,
      labelKey,
      code: null,
      name: null,
      depth: 0,
      amount: decimal(amount),
      rule,
      deducted: false,
    });
  };

  const grossProfit = at('revenue') - at('cost_of_sales');
  const operatingIncome = grossProfit - at('operating_expenses');
  const incomeBeforeTax = operatingIncome + at('other_income') - at('finance_costs');
  const result = incomeBeforeTax - at('tax_expense');

  // Each subtotal lands after the last branch that feeds it — and never
  // before an earlier subtotal, so the running story stays in order.
  const top = catalogue.treeFor('income_statement').filter(holds);
  const topRoles = top.map((node) => rolesOf(node));
  const lastWith = (...roles: IncomeRole[]): number => {
    let index = -1;
    topRoles.forEach((present, i) => {
      if (roles.some((role) => present.has(role))) index = i;
    });
    return index;
  };
  const grossAfter = lastWith('revenue', 'cost_of_sales');
  const belowTheLine = has('other_income') || has('finance_costs') || has('tax_expense');
  const operatingAfter = Math.max(grossAfter, lastWith('operating_expenses'));
  const beforeTaxAfter = Math.max(operatingAfter, lastWith('other_income', 'finance_costs'));

  // The two optional subtotals appear only where they separate something —
  // see 6c5f175: the same number three times under three headings is worse
  // than not printing it.
  const place = (index: number) => {
    if (index === grossAfter) subtotal('gross_profit', grossProfit, 'single');
    if (index === operatingAfter && belowTheLine) subtotal('operating_income', operatingIncome, 'single');
    if (index === beforeTaxAfter && has('tax_expense')) subtotal('income_before_tax', incomeBeforeTax, 'single');
  };

  place(-1); // Where a figure has nothing feeding it, it still opens the page.
  top.forEach((node, index) => {
    emit(node, 0);
    place(index);
  });
  subtotal('result', result, 'double');

  return {
    from: filter.from,
    to: filter.to,
    rows: out,
    revenue: decimal(at('revenue')),
    costOfSales: decimal(at('cost_of_sales')),
    grossProfit: decimal(grossProfit),
    operatingExpenses: decimal(at('operating_expenses')),
    operatingIncome: decimal(operatingIncome),
    otherIncome: decimal(at('other_income')),
    financeCosts: decimal(at('finance_costs')),
    incomeBeforeTax: decimal(incomeBeforeTax),
    tax: decimal(at('tax_expense')),
    result: decimal(result),
    depth: Math.max(1, depth),
  };
}
