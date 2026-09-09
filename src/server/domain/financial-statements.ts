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
 * work out from the account's name, or from its type.
 *
 * The lines used to be a closed list in this file. They are now rows of
 * `financial_statement_line`, edited on the Statement Mapping screens: one
 * hierarchy per report, built by the people who read the reports. This module
 * holds what is still the code's to say — the vocabulary each report needs
 * (roles, sides, cash-flow activities), and the catalogue that answers, for
 * one account and one report, "where does this print?".
 *
 * ── Four reports, four independent answers ─────────────────────────────────
 * An account is mapped once per statement, and no mapping is derived from
 * another. A revenue account explains the period on the Income Statement,
 * is presented inside Equity on the Balance Sheet, lands in an operating line
 * of the Cash Flow Statement, and belongs to the result on Changes in Equity.
 * One field could hold only the first of those, and guessing the rest from it
 * is what made the four reports argue with each other.
 *
 * ── Mapping is a mapping ───────────────────────────────────────────────────
 * Any posting account may be mapped to any posting line of any report. The
 * code does not refuse a mapping because the account type looks wrong to it:
 * the person building the chart knows what the line is for, and the whole
 * purpose of a mapping screen is that they decide. What the code still says
 * is what a *line* means for the arithmetic — a cost-of-sales line deducts, an
 * asset line prints on the asset side — so the subtotals and the two halves of
 * the Balance Sheet keep meaning what they say whatever layout is built.
 *
 * ── Nothing has to be mapped ───────────────────────────────────────────────
 * An unmapped account falls to its type's default line for that report, so
 * every statement is complete on the first day and grows more precise as
 * Finance works through the chart. Revenue and expense accounts have no
 * default on the Balance Sheet or on Changes in Equity: until they are mapped
 * they are carried by those statements' computed result row, which is what
 * makes the two agree.
 */
import type { AccountType } from './accounts';

export const STATEMENT_SECTIONS = ['financial_position', 'profit_or_loss'] as const;
export type StatementSection = (typeof STATEMENT_SECTIONS)[number];

/** The four reports, each with a layout and an account mapping of its own. */
export const STATEMENT_FACES = [
  'income_statement',
  'balance_sheet',
  'cash_flow',
  'changes_in_equity',
] as const;
export type StatementFace = (typeof STATEMENT_FACES)[number];

export const BALANCE_SIDES = ['asset', 'equity', 'liability'] as const;
export type BalanceSide = (typeof BALANCE_SIDES)[number];

export const CASH_FLOW_CATEGORIES = ['operating', 'investing', 'financing'] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];

export interface StatementLine {
  readonly id: string;
  readonly code: string;
  /** What the statement prints. Seeded lines prefer their translated name. */
  readonly name: string;
  readonly statement: StatementFace;
  readonly parentId: string | null;
  readonly isHeader: boolean;
  /** Where it sits among its siblings, top to bottom. */
  readonly ordinal: number;
  readonly side: BalanceSide | null;
  readonly cashFlowCategory: CashFlowCategory | null;
  /** On the Cash Flow Statement: the accounts here ARE the cash it explains. */
  readonly isCash: boolean;
  /**
   * A computed total — the running sum of everything above it on its report.
   *
   * "Gross Profit" and "Net Income (Loss)" are lines Finance places, names and
   * moves like any other; the only difference is that their figure is worked
   * out rather than mapped. Nothing reports on one.
   */
  readonly isSubtotal: boolean;
  readonly isSystem: boolean;

  // ── Derived, so the statements ask one object one question ───────────────
  readonly section: StatementSection | null;
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
  readonly side: string | null;
  readonly cashFlowCategory: string | null;
  readonly isCash: boolean;
  readonly isSubtotal: boolean;
  readonly isSystem: boolean;
}

/**
 * An account's four mappings, as the chart stores them.
 *
 * Every report has a key, and null is a real answer — "wherever this type
 * reports by default" — so a form that clears one can say so.
 */
export type AccountMapping = Readonly<Record<StatementFace, string | null>>;

/** The same, as a form or a caller may supply it: any subset, any of them null. */
export type AccountMappingInput = Readonly<Partial<Record<StatementFace, string | null>>>;

/**
 * Where an account goes on each report when nobody has said.
 *
 * Current rather than non-current, and operating rather than anything more
 * specific: the safe assumption is the ordinary one, and an account on the
 * wrong line is easier to notice than one that has vanished from the
 * statement altogether.
 *
 * These are *preferences*, not requirements. Every line belongs to Finance,
 * including the seeded ones, so any of them may be renamed, moved under a
 * header, or removed. When the preferred line is gone the fallback below
 * finds another of the same kind, and only when a report has no line of that
 * kind at all does an unmapped account stop printing on it — which by then is
 * plainly what was meant.
 *
 * The gaps are deliberate. A revenue account has no default on the Balance
 * Sheet or on Changes in Equity: unmapped, it is carried by those statements'
 * computed result row instead, and that is what keeps them agreeing with each
 * other. An asset account has no default on the Income Statement because it
 * has no business on one.
 */
export const DEFAULT_LINES: Readonly<
  Record<StatementFace, Readonly<Partial<Record<AccountType, string>>>>
> = Object.freeze({
  income_statement: Object.freeze({
    revenue: 'revenue',
    expense: 'operating_expenses',
  }),
  balance_sheet: Object.freeze({
    asset: 'current_assets',
    liability: 'current_liabilities',
    equity: 'equity',
  }),
  cash_flow: Object.freeze({
    asset: 'cash_flow_operating',
    liability: 'cash_flow_operating',
    equity: 'cash_flow_financing',
    revenue: 'cash_flow_operating',
    expense: 'cash_flow_operating',
  }),
  changes_in_equity: Object.freeze({
    equity: 'equity_movements',
  }),
});

/**
 * Failing the preferred line, the kind of line an account type may fall to.
 *
 * Read in the report's own print order, so "the first one that fits" is the
 * one nearest the top of the statement — which is where a reader looks for
 * anything that was not filed more precisely. A misplaced account is still
 * signed correctly, because the sign comes from the account and not from the
 * line it landed on.
 */
const FALLBACK_KIND: Readonly<
  Record<StatementFace, Readonly<Partial<Record<AccountType, (line: StatementLine) => boolean>>>>
> = Object.freeze({
  income_statement: Object.freeze({
    revenue: () => true,
    expense: () => true,
  }),
  balance_sheet: Object.freeze({
    asset: (line: StatementLine) => line.side === 'asset',
    liability: (line: StatementLine) => line.side === 'liability',
    equity: (line: StatementLine) => line.side === 'equity',
  }),
  cash_flow: Object.freeze({
    // Anything but the cash itself: an account is not its own explanation.
    asset: (line: StatementLine) => !line.isCash,
    liability: (line: StatementLine) => !line.isCash,
    equity: (line: StatementLine) => !line.isCash,
    revenue: (line: StatementLine) => !line.isCash,
    expense: (line: StatementLine) => !line.isCash,
  }),
  changes_in_equity: Object.freeze({
    equity: () => true,
  }),
});

/** The report an account type has its ordinary home on. */
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
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    statement,
    parentId: row.parentId,
    isHeader: row.isHeader,
    ordinal: row.ordinal,
    side: (row.side as BalanceSide | null) ?? null,
    cashFlowCategory: (row.cashFlowCategory as CashFlowCategory | null) ?? null,
    isCash: row.isCash,
    isSubtotal: row.isSubtotal,
    isSystem: row.isSystem,
    section:
      statement === 'income_statement'
        ? 'profit_or_loss'
        : statement === 'balance_sheet'
          ? 'financial_position'
          : null,
  };
}

/**
 * Which way one account pushes a figure it is mapped onto.
 *
 * Nobody has to say. A revenue account is credit-normal, so what it holds
 * adds; an expense account is debit-normal, so what it holds takes away. That
 * is the whole of the sign convention, and it is why a line needs no `role`:
 * the accounts on it already answer the only question the arithmetic asks.
 */
export const ADDS_TO_RESULT: Readonly<Record<AccountType, boolean>> = Object.freeze({
  revenue: true,
  expense: false,
  asset: true,
  liability: true,
  equity: true,
});

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

  /** Every line a report can print, headers included, in print order. */
  linesOf(statement: StatementFace): readonly StatementLine[] {
    return this.flattened(statement).map((entry) => entry.line);
  }

  /**
   * Where one account prints on one report — the line it was mapped to, or
   * its type's default there, or nowhere.
   *
   * "Nowhere" is a real answer and not a failure: an asset account is not on
   * the Income Statement, and an unmapped revenue account is not on a Balance
   * Sheet line either — it is inside the computed result instead.
   */
  lineFor(
    accountType: AccountType,
    statement: StatementFace,
    mapped?: string | null,
  ): StatementLine | undefined {
    const chosen = mapped ? this.byCodeMap.get(mapped) : undefined;
    if (chosen && chosen.statement === statement && !chosen.isHeader && !chosen.isSubtotal) {
      return chosen;
    }

    // The line this type prefers, while it is still there…
    const preferred = DEFAULT_LINES[statement][accountType];
    if (preferred) {
      const line = this.byCodeMap.get(preferred);
      if (line && !line.isHeader && !line.isSubtotal) return line;
    }

    // …and, once Finance has removed it, the first line of the same kind.
    const fits = FALLBACK_KIND[statement][accountType];
    if (!fits) return undefined;
    return this.linesOf(statement).find(
      (line) => !line.isHeader && !line.isSubtotal && fits(line),
    );
  }

  /**
   * Refuses a mapping that cannot mean anything: a line that is not there, a
   * line belonging to another report, or a header — which prints the sum of
   * the lines beneath it and takes no accounts of its own.
   *
   * It does *not* refuse a mapping because the account type looks wrong. That
   * is Finance's judgement, and the reason this screen exists.
   */
  assertLineAllowed(code: string, statement: StatementFace): StatementLine {
    const line = this.byCodeMap.get(code);
    if (!line) {
      throw new StatementLineError(`'${code}' is not a financial statement line.`);
    }
    if (line.statement !== statement) {
      throw new StatementLineError(
        `'${line.name}' belongs to another report, so it cannot be this account's ${TITLES[statement]} line.`,
      );
    }
    if (line.isHeader) {
      throw new StatementLineError(
        `'${line.name}' is a header — accounts map to the lines beneath it, not to the header itself.`,
      );
    }
    if (line.isSubtotal) {
      throw new StatementLineError(
        `'${line.name}' is a computed total — it adds up the lines above it, so nothing reports on it.`,
      );
    }
    return line;
  }

  /**
   * Every line beneath this one, however deep.
   *
   * A line cannot be moved under its own descendant — that makes a branch
   * that contains itself, which no walk of the tree ever leaves.
   */
  descendantIds(id: string): ReadonlySet<string> {
    const out = new Set<string>();
    const walk = (parentId: string) => {
      for (const line of this.lines) {
        if (line.parentId !== parentId || out.has(line.id)) continue;
        out.add(line.id);
        walk(line.id);
      }
    };
    walk(id);
    return out;
  }

  /** How many levels sit beneath this line — a leaf is 0. */
  heightOf(id: string): number {
    const children = this.lines.filter((line) => line.parentId === id);
    return children.length === 0 ? 0 : 1 + Math.max(...children.map((child) => this.heightOf(child.id)));
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

  /** Every line and header of every report, in print order, depth-first. */
  ordered(): readonly StatementLine[] {
    return STATEMENT_FACES.flatMap((statement) => this.linesOf(statement));
  }
}

/** What each report is called when a message has to name one. */
export const TITLES: Readonly<Record<StatementFace, string>> = Object.freeze({
  income_statement: 'Income Statement',
  balance_sheet: 'Balance Sheet',
  cash_flow: 'Cash Flow Statement',
  changes_in_equity: 'Changes in Equity',
});
