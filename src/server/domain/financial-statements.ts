/**
 * Financial statement lines — Phase 1 requirement 5, opened to Finance by
 * direction 2026-09-03.
 *
 * "Accounts can be assigned to the correct financial statement lines."
 *
 * A trial balance lists accounts; a financial statement lists *lines*, and
 * the two are not the same thing. Half a dozen receivable accounts appear on
 * one line called Trade receivables, and which line an account belongs on is
 * a decision Finance makes about that account — not something a report can
 * work out from the account's name.
 *
 * The lines used to be a closed list in this file. They are now rows of
 * `financial_statement_line`, edited on the Statement Mapping screens:
 * Finance creates the headers and lines of its own reports, and this module
 * holds what is still the code's to say — the vocabulary (roles, sides,
 * categories), the derivations from it, and the catalogue the services build
 * from the table's rows. A statement assembled from free text would differ
 * between two runs; a statement assembled from the mapping table is the same
 * statement every time, because the table is the single answer.
 *
 * The Income Statement and Balance Sheet are separate account mappings. A
 * revenue or expense account therefore has two useful answers: where it
 * explains the period result on the Income Statement, and where that result
 * is presented inside Balance Sheet equity. The Cash Flow Statement still
 * classifies the account's primary line, while Changes in Equity reads its
 * Balance Sheet mapping.
 *
 * Every account still lands somewhere without anybody assigning it: an
 * unassigned account falls to its type's default line — one of the seeded
 * system lines, which is why those cannot be deleted.
 */
import type { AccountType } from './accounts';

export const STATEMENT_SECTIONS = ['financial_position', 'profit_or_loss'] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

export const STATEMENT_FACES = ['income_statement', 'balance_sheet'] as const;
export type StatementFace = (typeof STATEMENT_FACES)[number];

/**
 * The six classical roles an income-statement line can play. The layout is
 * Finance's; the arithmetic is not — gross profit is revenue less cost of
 * sales whatever the page looks like, so every line names the role it plays
 * and the subtotals are computed from the roles.
 */
export const INCOME_ROLES = [
  'revenue',
  'cost_of_sales',
  'other_income',
  'operating_expenses',
  'finance_costs',
  'tax_expense',
] as const;
export type IncomeRole = (typeof INCOME_ROLES)[number];

export const BALANCE_SIDES = ['asset', 'equity', 'liability'] as const;
export type BalanceSide = (typeof BALANCE_SIDES)[number];

export const CASH_FLOW_CATEGORIES = ['operating', 'investing', 'financing'] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];

/** Roles whose figures are taken away on the face of the statement. */
const DEDUCTING_ROLES: ReadonlySet<IncomeRole> = new Set([
  'cost_of_sales',
  'operating_expenses',
  'finance_costs',
  'tax_expense',
]);

/** The account types a role's accounts must be. */
const ROLE_ACCOUNT_TYPES: Readonly<Record<IncomeRole, readonly AccountType[]>> = Object.freeze({
  revenue: ['revenue'],
  other_income: ['revenue'],
  cost_of_sales: ['expense'],
  operating_expenses: ['expense'],
  finance_costs: ['expense'],
  tax_expense: ['expense'],
});

export interface StatementLine {
  readonly id: string;
  readonly code: string;
  /** What the statement prints; seeded lines prefer their translated name. */
  readonly name: string;
  readonly statement: StatementFace;
  readonly parentId: string | null;
  readonly isHeader: boolean;
  /** Where it sits among its siblings, top to bottom. */
  readonly ordinal: number;
  readonly role: IncomeRole | null;
  readonly side: BalanceSide | null;
  readonly cashFlowCategory: CashFlowCategory | null;
  readonly isCash: boolean;
  readonly isSystem: boolean;

  // ── Derived, so the statements ask one object one question ───────────────
  readonly section: StatementSection;
  /** Subtracted rather than added on the face of the statement. */
  readonly deduction: boolean;
  /** The account types that may be assigned to it. Empty for a header. */
  readonly accountTypes: readonly AccountType[];
}

/** One node of a statement's layout: a line, with its children beneath it. */
export interface StatementLineNode {
  readonly line: StatementLine;
  readonly children: readonly StatementLineNode[];
}

/** The raw row, as the table holds it. */
export interface StatementLineRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly statement: string;
  readonly parentId: string | null;
  readonly isHeader: boolean;
  readonly ordinal: number;
  readonly role: string | null;
  readonly side: string | null;
  readonly cashFlowCategory: string | null;
  readonly isCash: boolean;
  readonly isSystem: boolean;
}

/**
 * Where an account goes when nobody has said.
 *
 * Current rather than non-current, and operating rather than anything more
 * specific: the safe assumption is the ordinary one, and an account that has
 * been put on the wrong line is easier to notice than one that has vanished
 * from the statement altogether. These name seeded system lines, which is
 * why the system lines cannot be deleted.
 */
export const DEFAULT_LINE: Readonly<Record<AccountType, string>> = Object.freeze({
  asset: 'current_assets',
  liability: 'current_liabilities',
  equity: 'equity',
  revenue: 'revenue',
  expense: 'operating_expenses',
});

/** The statement on which an account type has its ordinary, default line. */
export const PRIMARY_STATEMENT: Readonly<Record<AccountType, StatementFace>> = Object.freeze({
  asset: 'balance_sheet',
  liability: 'balance_sheet',
  equity: 'balance_sheet',
  revenue: 'income_statement',
  expense: 'income_statement',
});

export class StatementLineError extends Error {
  readonly code = 'STATEMENT_LINE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'StatementLineError';
  }
}

function toLine(row: StatementLineRow): StatementLine {
  const statement = row.statement as StatementFace;
  const role = (row.role as IncomeRole | null) ?? null;
  const side = (row.side as BalanceSide | null) ?? null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    statement,
    parentId: row.parentId,
    isHeader: row.isHeader,
    ordinal: row.ordinal,
    role,
    side,
    cashFlowCategory: (row.cashFlowCategory as CashFlowCategory | null) ?? null,
    isCash: row.isCash,
    isSystem: row.isSystem,
    section: statement === 'income_statement' ? 'profit_or_loss' : 'financial_position',
    deduction: role !== null && DEDUCTING_ROLES.has(role),
    accountTypes: row.isHeader
      ? []
      : role !== null
        ? ROLE_ACCOUNT_TYPES[role]
        : side === 'equity'
          // Profit and loss accounts may also be presented on a configured
          // Balance Sheet equity line. Their Income Statement mapping remains
          // separate and continues to determine the P&L subtotals.
          ? ['equity', 'revenue', 'expense']
          : side !== null
            ? [side]
            : [],
  };
}

/**
 * The mapping, loaded once per request and asked everything after that.
 *
 * Built from the table's rows; every question the statements, the pickers and
 * the validators had for the old closed list is answered here instead.
 */
export class LineCatalogue {
  private readonly byCodeMap = new Map<string, StatementLine>();
  private readonly byIdMap = new Map<string, StatementLine>();
  readonly lines: readonly StatementLine[];

  constructor(rows: readonly StatementLineRow[]) {
    this.lines = rows.map(toLine);
    for (const line of this.lines) {
      this.byCodeMap.set(line.code, line);
      this.byIdMap.set(line.id, line);
    }
  }

  byCode(code: string): StatementLine | undefined {
    return this.byCodeMap.get(code);
  }

  byId(id: string): StatementLine | undefined {
    return this.byIdMap.get(id);
  }

  /** The posting lines (never headers) an account of this type may report on. */
  linesForType(accountType: AccountType): readonly StatementLine[] {
    return this.ordered().filter((line) => line.accountTypes.includes(accountType));
  }

  /** The line an account reports on its primary statement. */
  lineFor(accountType: AccountType, assigned?: string | null): StatementLine {
    const line = this.lineForStatement(accountType, PRIMARY_STATEMENT[accountType], assigned);
    if (line) return line;
    throw new StatementLineError(`A ${accountType} account has no primary financial statement line.`);
  }

  /**
   * The account's line on one statement.
   *
   * Revenue and expense accounts have no automatic Balance Sheet line. Until
   * Finance maps one, their net amount remains in the computed result row under
   * equity. Once mapped, the account is presented on that equity line instead.
   */
  lineForStatement(
    accountType: AccountType,
    statement: StatementFace,
    assigned?: string | null,
  ): StatementLine | undefined {
    const chosen = assigned ? this.byCodeMap.get(assigned) : undefined;
    if (
      chosen &&
      chosen.statement === statement &&
      chosen.accountTypes.includes(accountType)
    ) {
      return chosen;
    }
    if (PRIMARY_STATEMENT[accountType] !== statement) return undefined;
    const fallback = this.byCodeMap.get(DEFAULT_LINE[accountType]);
    if (!fallback) {
      throw new StatementLineError(
        `The default line '${DEFAULT_LINE[accountType]}' is missing from the mapping — the seeded lines must not be deleted.`,
      );
    }
    return fallback;
  }

  /** Refuses a line that does not exist, is on the wrong statement, or cannot take this type. */
  assertLineAllowed(
    accountType: AccountType,
    code: string,
    statement: StatementFace = PRIMARY_STATEMENT[accountType],
  ): StatementLine {
    const line = this.byCodeMap.get(code);
    if (!line) {
      throw new StatementLineError(`'${code}' is not a financial statement line.`);
    }
    if (line.isHeader) {
      throw new StatementLineError(
        `'${line.name}' is a header — accounts report on its lines, not on the header itself.`,
      );
    }
    if (line.statement !== statement) {
      throw new StatementLineError(
        `'${line.name}' belongs to the ${line.statement === 'income_statement' ? 'Income Statement' : 'Balance Sheet'}, not the ${statement === 'income_statement' ? 'Income Statement' : 'Balance Sheet'}.`,
      );
    }
    if (!line.accountTypes.includes(accountType)) {
      throw new StatementLineError(
        `A ${accountType} account cannot report on '${line.name}' — that line carries ${line.accountTypes.join(' and ')} accounts.`,
      );
    }
    return line;
  }

  /** One statement's layout, as a tree in print order. */
  treeFor(statement: StatementFace): readonly StatementLineNode[] {
    const mine = this.lines.filter((line) => line.statement === statement);
    const build = (parentId: string | null): StatementLineNode[] =>
      mine
        .filter((line) => line.parentId === parentId)
        .sort((a, b) => a.ordinal - b.ordinal || a.code.localeCompare(b.code, 'en'))
        .map((line) => ({ line, children: build(line.id) }));
    return build(null);
  }

  /** The balance-sheet branches of one side, as trees in print order. */
  sideTree(side: BalanceSide): readonly StatementLineNode[] {
    return this.treeFor('balance_sheet').filter((node) => node.line.side === side);
  }

  /** One statement's lines in print order, each with its depth — for pickers. */
  flattened(statement: StatementFace): readonly { line: StatementLine; depth: number }[] {
    const out: { line: StatementLine; depth: number }[] = [];
    const walk = (nodes: readonly StatementLineNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ line: node.line, depth });
        walk(node.children, depth + 1);
      }
    };
    walk(this.treeFor(statement), 0);
    return out;
  }

  /** Every line and header in print order, statement by statement, depth-first. */
  ordered(): readonly StatementLine[] {
    const out: StatementLine[] = [];
    const walk = (nodes: readonly StatementLineNode[]) => {
      for (const node of nodes) {
        out.push(node.line);
        walk(node.children);
      }
    };
    walk(this.treeFor('balance_sheet'));
    walk(this.treeFor('income_statement'));
    return out;
  }
}
