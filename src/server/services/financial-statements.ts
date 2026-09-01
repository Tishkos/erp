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
  STATEMENT_LINES,
  lineFor,
  type StatementLine,
  type StatementSection,
} from '../domain/financial-statements';
import type { ChartRow } from '../domain/report-levels';
import { chartRows } from './trial-balance';

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
  /** `result` is not an equity account — it is what the P&L accounts come to. */
  readonly kind: 'line' | 'result';
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
  readonly statementLine: string | null;
  opening: bigint;
  movement: bigint;
}

/**
 * Two sets of movements — before the period and during it — laid side by side
 * per account. An account that appears in only one of them still gets a row,
 * with zero for the side it is missing from.
 */
function pairUp(before: readonly Movement[], during: readonly Movement[]): Map<string, Paired> {
  const byCode = new Map<string, Paired>();
  const put = (movement: Movement, column: 'opening' | 'movement', sign: bigint) => {
    const existing =
      byCode.get(movement.accountCode) ??
      {
        accountName: movement.accountName,
        accountType: movement.accountType,
        statementLine: movement.statementLine,
        opening: 0n,
        movement: 0n,
      };
    existing[column] += naturalAmount(movement) * sign;
    byCode.set(movement.accountCode, existing);
  };
  // Revenue and expense accounts are signed as they bear on the result: income
  // adds to it, a deduction takes away. Equity accounts keep their own sign.
  const signOf = (movement: Movement) =>
    lineFor(movement.accountType, movement.statementLine).deduction ? -1n : 1n;
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
  const [before, during] = await Promise.all([
    movements(tx, { ...filter, from: BEGINNING, to: dayBefore(filter.from) }),
    movements(tx, filter),
  ]);
  const paired = pairUp(before, during);

  // The equity accounts, grouped onto the lines they report on.
  const byLine = new Map<string, string[]>();
  for (const [code, entry] of paired) {
    if (entry.accountType !== 'equity') continue;
    if (entry.opening === 0n && entry.movement === 0n) continue;
    const line = lineFor(entry.accountType, entry.statementLine);
    byLine.set(line.code, [...(byLine.get(line.code) ?? []), code]);
  }

  const lineRows: EquityRow[] = STATEMENT_LINES.filter(
    (line) => line.section === 'financial_position' && byLine.has(line.code),
  )
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((line) => {
      const accounts = accountRows(paired, byLine.get(line.code)!);
      const opening = accounts.reduce((total, a) => total + parseDecimal(a.opening, MONEY_SCALE), 0n);
      const movement = accounts.reduce((total, a) => total + parseDecimal(a.movement, MONEY_SCALE), 0n);
      return {
        code: line.code,
        kind: 'line' as const,
        opening: decimal(opening),
        movement: decimal(movement),
        closing: decimal(opening + movement),
        accounts,
      };
    });

  // The result: the revenue and expense accounts, already signed by `pairUp`.
  const resultCodes = [...paired]
    .filter(([, entry]) => entry.accountType === 'revenue' || entry.accountType === 'expense')
    .filter(([, entry]) => entry.opening !== 0n || entry.movement !== 0n)
    .map(([code]) => code);
  const resultAccounts = accountRows(paired, resultCodes);
  const openingResult = resultAccounts.reduce((t, a) => t + parseDecimal(a.opening, MONEY_SCALE), 0n);
  const periodResult = resultAccounts.reduce((t, a) => t + parseDecimal(a.movement, MONEY_SCALE), 0n);

  const rows: EquityRow[] = [
    ...lineRows,
    ...(resultAccounts.length > 0
      ? [
          {
            code: 'result',
            kind: 'result' as const,
            opening: decimal(openingResult),
            movement: decimal(periodResult),
            closing: decimal(openingResult + periodResult),
            accounts: resultAccounts,
          },
        ]
      : []),
  ];

  const opening = rows.reduce((t, row) => t + parseDecimal(row.opening, MONEY_SCALE), 0n);
  const movement = rows.reduce((t, row) => t + parseDecimal(row.movement, MONEY_SCALE), 0n);

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

export const CASH_LINE = 'cash_and_equivalents';

export type CashFlowCategory = 'operating' | 'investing' | 'financing';

/**
 * Where a cash movement belongs, read from the account on the other side.
 *
 * Trading, and everything that settles it, is operating. What was spent on or
 * received for long-lived assets is investing. What the owners and the lenders
 * put in or took out is financing. `cash_and_equivalents` is absent on purpose:
 * cash moving between two cash accounts is not a cash flow.
 */
const CATEGORY_OF: Readonly<Record<string, CashFlowCategory>> = Object.freeze({
  non_current_assets: 'investing',
  current_assets: 'operating',
  equity: 'financing',
  non_current_liabilities: 'financing',
  current_liabilities: 'operating',
  revenue: 'operating',
  cost_of_sales: 'operating',
  other_income: 'operating',
  operating_expenses: 'operating',
  finance_costs: 'operating',
  tax_expense: 'operating',
});

export const CASH_FLOW_CATEGORIES: readonly CashFlowCategory[] = Object.freeze([
  'operating',
  'investing',
  'financing',
]);

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
  readonly statementLine: string | null;
  readonly debit: bigint;
  readonly credit: bigint;
}

const isCash = (line: { accountType: AccountType; statementLine: string | null }) =>
  lineFor(line.accountType, line.statementLine).code === CASH_LINE;

/** Has anybody said which accounts are cash? */
async function cashLineAssigned(tx: Tx): Promise<boolean> {
  const result = await tx.execute(sql`
    select 1 from chart_of_account where statement_line = ${CASH_LINE} limit 1
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
async function entryMovements(tx: Tx, filter: StatementFilter): Promise<EntryLine[]> {
  const debitColumn = debitOf(filter);
  const creditColumn = creditOf(filter);
  const branch = branchOf(filter);

  const result = await tx.execute(sql`
    select l.journal_entry_id::text                as "entryId",
           a.code                                  as "accountCode",
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
       and exists (
         select 1
           from journal_line cash
           join chart_of_account ca on ca.id = cash.account_id
          where cash.journal_entry_id = l.journal_entry_id
            and ca.statement_line = ${CASH_LINE}
       )
     group by l.journal_entry_id, a.code, a.name, a.account_type, a.statement_line
     order by l.journal_entry_id, a.code
  `);

  return (result.rows as unknown as Array<Record<string, string>>).map((row) => ({
    entryId: row.entryId!,
    accountCode: row.accountCode!,
    accountName: row.accountName!,
    accountType: row.accountType as AccountType,
    statementLine: row.statementLine ?? null,
    debit: parseDecimal(String(row.debit), MONEY_SCALE),
    credit: parseDecimal(String(row.credit), MONEY_SCALE),
  }));
}

const abs = (value: bigint) => (value < 0n ? -value : value);

/** The cash held, and by which account, in a set of movements. */
function cashHeld(rows: readonly Movement[]): { total: bigint; accounts: StatementAccount[] } {
  let total = 0n;
  const accounts: StatementAccount[] = [];
  for (const movement of rows) {
    if (!isCash(movement)) continue;
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
  const [configured, before, upToTheEnd, entries] = await Promise.all([
    cashLineAssigned(tx),
    movements(tx, { ...filter, from: BEGINNING, to: dayBefore(filter.from) }),
    movements(tx, { ...filter, from: BEGINNING }),
    entryMovements(tx, filter),
  ]);

  const opening = cashHeld(before);
  const closing = cashHeld(upToTheEnd);

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
    const cash = lines.filter(isCash);
    const others = lines.filter((line) => !isCash(line));
    // Positive when the entry brought cash in.
    const delta = cash.reduce((total, line) => total + line.debit - line.credit, 0n);
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
      const line = lineFor(account.accountType, account.statementLine);
      const category = CATEGORY_OF[line.code];
      if (category && share !== 0n) attribute(category, line, account, share);
    });
    const rest = delta - assigned;
    const line = lineFor(others[largest]!.accountType, others[largest]!.statementLine);
    const category = CATEGORY_OF[line.code];
    if (category && rest !== 0n) attribute(category, line, others[largest]!, rest);
  }

  const sections: CashFlowSection[] = CASH_FLOW_CATEGORIES.map((category) => {
    const mine = [...buckets.values()].filter((bucket) => bucket.category === category);
    const byLine = new Map<
      string,
      { line: StatementLine; amount: bigint; accounts: StatementAccount[] }
    >();
    for (const bucket of mine) {
      const existing = byLine.get(bucket.line.code) ?? { line: bucket.line, amount: 0n, accounts: [] };
      existing.amount += bucket.amount;
      existing.accounts.push({
        accountCode: bucket.account.accountCode,
        accountName: bucket.account.accountName,
        accountType: bucket.account.accountType,
        amount: decimal(bucket.amount),
      });
      byLine.set(bucket.line.code, existing);
    }
    const lines = [...byLine.values()]
      .sort((a, b) => a.line.ordinal - b.line.ordinal)
      .map((entry) => ({
        line: entry.line,
        amount: decimal(entry.amount),
        accounts: entry.accounts.sort((a, b) => a.accountCode.localeCompare(b.accountCode, 'en')),
      }));
    return {
      category,
      lines,
      total: decimal(
        lines.reduce((total, line) => total + parseDecimal(line.amount, MONEY_SCALE), 0n),
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
// By direction (2026-09-01), with a template: the statement is not a list of
// sections each ending in a total. It is a *running* document — revenue, what
// it cost, then the margin; expenses, then what was left; then the things
// below the operating line, then the result — and the subtotals in between are
// the reason anyone reads it.
//
//   Revenue                       ← the section's total, on its heading
//     Product Revenue             ← a header in the chart, its children summed
//       Solar Revenue             ← a posting account
//       Batteries Revenue
//     Logistics Revenue
//   Cost of Sales
//     Solar COGS
//                        ─────────
//   Gross profit                  ← computed, ruled
//
//   Operating expenses
//     Administrative expenses
//       Rent
//                        ─────────
//   Operating income              ← computed, ruled
//   ...
//                        ═════════
//   Net profit                    ← computed, double-ruled
//
// ── Where the shape comes from ─────────────────────────────────────────────
// Two different things decide where an account appears, and keeping them apart
// is what makes this configurable without a second tree to maintain:
//
//   *Which section* it falls in is the account's statement line — the field
//   set when the account is created. Revenue, cost of sales, operating
//   expenses, other income, finance costs, tax.
//
//   *Where inside that section* is the account's place in the chart. "Solar
//   Revenue" sits under "Product Revenue" because that is its parent, and the
//   statement reads the same hierarchy the Chart of Accounts screen shows.
//
// So a company gets the statement it wants by building its chart and mapping
// the leaves — no separate report layout to keep in step with the accounts.
//
// ── Rolled up within the section, never across it ──────────────────────────
// A header's figure is the sum of its descendants *that belong to the section
// being drawn*. That matters: the "Expense" root holds both cost of sales and
// operating expenses, and rolling it up blindly would print one number under
// two headings, each time wrong. An ancestor appears only where it has
// children in that section, carrying only what those children hold.
//
// The type roots themselves are skipped. The section heading already says
// "Revenue"; the root account named Revenue directly beneath it would be the
// same word twice with the same figure.
// ───────────────────────────────────────────────────────────────────────────

/** A line of the statement, in the order it is printed. */
export interface IncomeRow {
  /**
   * `section`  — a statement line and its total.
   * `group`    — a header account within a section.
   * `account`  — a posting account.
   * `subtotal` — a computed figure: the margin, the result.
   */
  readonly kind: 'section' | 'group' | 'account' | 'subtotal';
  /** Unique within the statement. */
  readonly key: string;
  /** For `section` and `subtotal`: the message key naming it. */
  readonly labelKey: string | null;
  /** For `group` and `account`: what the chart calls it. */
  readonly code: string | null;
  readonly name: string | null;
  /** 0 for a section or a subtotal; each step down the chart adds one. */
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
  /** The deepest the chart goes in this statement — the level picker's ceiling. */
  readonly depth: number;
}

/**
 * The sections, in the order the statement prints them, and how each one bears
 * on the result.
 *
 * This is the whole layout, as data. A section is drawn where it has anything
 * in it, and the subtotals that follow it are computed from what came before.
 */
const SECTIONS: readonly {
  readonly line: string;
  readonly deducted: boolean;
}[] = [
  { line: 'revenue', deducted: false },
  { line: 'cost_of_sales', deducted: true },
  { line: 'operating_expenses', deducted: true },
  { line: 'other_income', deducted: false },
  { line: 'finance_costs', deducted: true },
  { line: 'tax_expense', deducted: true },
];

interface SectionAccount {
  readonly code: string;
  readonly name: string;
  readonly amount: bigint;
}

/**
 * The rows for one section: its accounts arranged as the chart arranges them,
 * with every header carrying the sum of what is beneath it *in this section*.
 */
function sectionRows(
  chart: readonly ChartRow[],
  accounts: readonly SectionAccount[],
  line: string,
): { rows: IncomeRow[]; total: bigint; depth: number } {
  const byId = new Map(chart.map((row) => [row.id, row]));
  const byCode = new Map(chart.map((row) => [row.code, row]));
  const children = new Map<string | null, ChartRow[]>();
  for (const row of chart) {
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }

  // Every account's figure lands on itself and on each of its ancestors, so a
  // header knows what it holds without anybody adding it up by hand.
  const totals = new Map<string, bigint>();
  const held = new Set<string>();
  let total = 0n;
  for (const account of accounts) {
    const node = byCode.get(account.code);
    if (!node) continue;
    total += account.amount;
    let cursor: ChartRow | undefined = node;
    while (cursor) {
      totals.set(cursor.id, (totals.get(cursor.id) ?? 0n) + account.amount);
      held.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  const rows: IncomeRow[] = [];
  let deepest = 0;

  // The type roots are skipped: the section heading above already names them.
  const walk = (parentId: string | null, depth: number) => {
    const siblings = [...(children.get(parentId) ?? [])]
      .filter((row) => held.has(row.id))
      .sort((a, b) => a.code.localeCompare(b.code, 'en'));

    for (const row of siblings) {
      const amount = totals.get(row.id) ?? 0n;
      const kids = (children.get(row.id) ?? []).filter((kid) => held.has(kid.id));
      // A header with nothing beneath it *in this section* reads as an
      // account, because here that is all it is.
      const isGroup = row.isGroup && kids.length > 0;
      rows.push({
        kind: isGroup ? 'group' : 'account',
        key: `${line}:${row.code}`,
        labelKey: null,
        code: row.code,
        name: row.name,
        depth,
        amount: decimal(amount),
        rule: 'none',
        deducted: false,
      });
      deepest = Math.max(deepest, depth);
      if (isGroup) walk(row.id, depth + 1);
    }
  };

  // Start below the roots — an account whose parent is null is a type root.
  for (const root of chart.filter((row) => row.parentId === null)) {
    if (held.has(root.id)) walk(root.id, 1);
  }

  return { rows, total, depth: deepest };
}

/**
 * Statement of Profit or Loss, in the form it is presented.
 *
 * Read from the posted journal lines, like everything else here. The figures
 * are the same ones `profitOrLoss` returns — this arranges them.
 */
export async function incomeStatement(
  tx: Tx,
  filter: StatementFilter,
): Promise<IncomeStatement> {
  const [rows, chart] = await Promise.all([movements(tx, filter), chartRows(tx)]);

  // Each account, positive in its own normal direction, filed under the
  // statement line it reports on.
  const bySection = new Map<string, SectionAccount[]>();
  for (const movement of rows) {
    const line = lineFor(movement.accountType, movement.statementLine);
    if (line.section !== 'profit_or_loss') continue;
    const amount = naturalAmount(movement);
    // An account that moved and came back has nothing to say on a statement
    // of results; it stays in the Trial Balance, which is about movement.
    if (amount === 0n) continue;
    bySection.set(line.code, [
      ...(bySection.get(line.code) ?? []),
      { code: movement.accountCode, name: movement.accountName, amount },
    ]);
  }

  const out: IncomeRow[] = [];
  const totals = new Map<string, bigint>();
  let depth = 0;

  const draw = (line: string, deducted: boolean) => {
    const accounts = bySection.get(line) ?? [];
    if (accounts.length === 0) {
      totals.set(line, 0n);
      return;
    }
    const built = sectionRows(chart, accounts, line);
    totals.set(line, built.total);
    depth = Math.max(depth, built.depth);
    out.push({
      kind: 'section',
      key: `section:${line}`,
      labelKey: line,
      code: null,
      name: null,
      depth: 0,
      amount: decimal(built.total),
      rule: 'none',
      deducted,
    });
    out.push(...built.rows);
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

  const at = (line: string) => totals.get(line) ?? 0n;

  // Trading: what was sold, what it cost, and the margin between them.
  draw('revenue', false);
  draw('cost_of_sales', true);
  const grossProfit = at('revenue') - at('cost_of_sales');
  subtotal('gross_profit', grossProfit, 'single');

  // Running the business, and what trading left after it.
  draw('operating_expenses', true);
  const operatingIncome = grossProfit - at('operating_expenses');

  // ── Two subtotals that earn their place only sometimes ───────────────────
  // Operating income and income before tax separate trading from everything
  // that is not trading. Where a company has nothing below the operating line
  // — no other income, no finance costs, no tax — there is nothing to
  // separate: both figures equal the result, and printing them would be the
  // same number three times under three headings.
  //
  // So they appear where they say something and stay silent where they do
  // not. A simple statement then reads exactly as it was specified — revenue,
  // cost, gross profit, expenses, result — and a company with borrowings and
  // tax still gets the full form.
  //
  // Asked of the sections rather than of the totals, because the totals are
  // only known once a section has been drawn, and these lines have to be
  // written *before* the sections they introduce.
  const has = (line: string) => (bySection.get(line)?.length ?? 0) > 0;
  if (has('other_income') || has('finance_costs') || has('tax_expense')) {
    subtotal('operating_income', operatingIncome, 'single');
  }

  // Below the operating line: income and costs that are not trading.
  draw('other_income', false);
  draw('finance_costs', true);
  const incomeBeforeTax = operatingIncome + at('other_income') - at('finance_costs');

  // Before the tax line, not after it: this is the figure tax is charged on.
  if (has('tax_expense')) subtotal('income_before_tax', incomeBeforeTax, 'single');

  draw('tax_expense', true);
  const result = incomeBeforeTax - at('tax_expense');
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
