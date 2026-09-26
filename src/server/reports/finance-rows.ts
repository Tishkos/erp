import type {
  CashFlow,
  ChangesInEquity,
  FinancialPosition,
  IncomeStatement,
  StatementLineResult,
} from '../services/financial-statements';

/**
 * The rows of each financial statement, as the screen lays them out.
 *
 * Built once here and read twice: by the statement's screen, which formats
 * each figure into a cell, and by its printed and exported copies, which keep
 * the figure as a number. Written twice, they would be two layouts that
 * drift, and a printed Balance Sheet that disagreed with the screen about
 * which lines it has.
 */
export interface LayoutRow {
  readonly key: string;
  readonly label: string;
  /** Steps into the layout; a top-level heading is 0. */
  readonly depth: number;
  readonly tone: 'header' | 'line' | 'account' | 'subtotal';
  /** The service's signed figure. */
  readonly amount: string;
  readonly rule?: 'none' | 'single' | 'double';
}

/** Statement of Profit or Loss, down to `level`; the subtotals always show. */
export function incomeStatementRows(pl: IncomeStatement, level: number): LayoutRow[] {
  return pl.rows
    .filter((row) => row.kind === 'subtotal' || row.depth < level)
    .map((row) => ({
      key: row.key,
      label: row.kind === 'account' ? `${row.code} · ${row.name}` : (row.name ?? ''),
      depth: row.depth,
      tone:
        row.kind === 'subtotal'
          ? 'subtotal'
          : row.kind === 'account'
            ? 'account'
            : row.kind === 'section' || row.isHeader
              ? 'header'
              : 'line',
      amount: row.amount,
      rule: row.rule,
    }));
}

/** The deepest level the Balance Sheet offers: sides, lines, accounts. */
export const BALANCE_SHEET_LEVELS = 3;

/**
 * Statement of Financial Position — each side a heading of its own, then the
 * mapping's headers and lines beneath it, then (at level 3) the accounts on
 * each line; under Equity, the result no year-end close has carried away yet.
 */
export function balanceSheetRows(
  sfp: FinancialPosition,
  level: number,
  words: {
    readonly assets: string;
    readonly equity: string;
    readonly liabilities: string;
    readonly resultForThePeriod: string;
  },
): LayoutRow[] {
  const side = (
    title: string,
    total: string,
    lines: readonly StatementLineResult[],
    extra?: {
      readonly label: string;
      readonly amount: string;
      readonly accounts: readonly { readonly accountCode: string; readonly accountName: string; readonly amount: string }[];
    },
  ): LayoutRow[] => [
    { key: `side:${title}`, label: title, depth: 0, tone: 'header', amount: total },
    ...lines.flatMap((entry): LayoutRow[] => [
      {
        key: `line:${entry.line.code}`,
        label: entry.line.name,
        depth: entry.depth + 1,
        tone: entry.line.isHeader ? 'header' : 'line',
        amount: entry.amount,
      },
      ...(level >= 3
        ? entry.accounts.map(
            (account): LayoutRow => ({
              key: `account:${entry.line.code}:${account.accountCode}`,
              label: `${account.accountCode} · ${account.accountName}`,
              depth: entry.depth + 2,
              tone: 'account',
              amount: account.amount,
            }),
          )
        : []),
    ]),
    ...(extra
      ? [
          { key: `extra:${title}`, label: extra.label, depth: 1, tone: 'line' as const, amount: extra.amount },
          ...(level >= 3
            ? extra.accounts.map(
                (account): LayoutRow => ({
                  key: `extra:${title}:${account.accountCode}`,
                  label: `${account.accountCode} · ${account.accountName}`,
                  depth: 2,
                  tone: 'account',
                  amount: account.amount,
                }),
              )
            : []),
        ]
      : []),
  ];

  return [
    ...side(words.assets, sfp.totalAssets, sfp.assets),
    ...side(words.equity, sfp.totalEquity, sfp.equity, {
      label: words.resultForThePeriod,
      amount: sfp.unmappedResult,
      accounts: sfp.resultAccounts,
    }),
    ...side(words.liabilities, sfp.totalLiabilities, sfp.liabilities),
  ];
}

export function changesInEquityRows(equity: ChangesInEquity): LayoutRow[] {
  return equity.rows.map((row) => ({
    key: `row:${row.code}`,
    label: row.name,
    depth: row.depth,
    tone: row.kind === 'header' ? 'header' : 'line',
    amount: row.amount,
    rule: row.rule,
  }));
}

/** Each line, and under it the accounts behind the figure where it names them. */
export function cashFlowRows(flow: CashFlow): LayoutRow[] {
  return flow.rows.flatMap((row): LayoutRow[] => [
    {
      key: `row:${row.code}`,
      label: row.name,
      depth: row.depth,
      tone: row.kind === 'header' ? 'header' : 'line',
      amount: row.amount,
      rule: row.rule,
    },
    ...row.accounts.map(
      (account): LayoutRow => ({
        key: `account:${row.code}:${account.accountCode}`,
        label: `${account.accountCode} · ${account.accountName}`,
        depth: row.depth + 1,
        tone: 'account',
        amount: account.amount,
      }),
    ),
  ]);
}
