import { boolean, index, integer, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The financial statement lines — owned by Finance, not by the code.
 *
 * By direction (2026-09-03): the fixed catalogue of twelve lines was half a
 * mapping. Finance defines the shape of its own reports — the headers, the
 * lines, their order — and the accounts are connected to those lines when
 * they are opened. This table *is* the report layout, one hierarchy for each
 * of the four statements, and every statement is drawn from it.
 *
 * All four mappings are independent, because an account has a different
 * answer on each report and no answer can be worked out from another. A
 * revenue account explains the period on the Income Statement, is presented
 * inside Equity on the Balance Sheet, carries an operating line of the Cash
 * Flow Statement, and belongs to the result on Changes in Equity. Deriving
 * any of those from the first is what made the reports disagree.
 *
 * The seeded lines carry `is_system`: the type defaults name them, so they
 * may be renamed, moved and reordered but never deleted. Everything else is
 * Finance's to create and remove — removal only while no account reports on
 * the line, which the foreign keys from `chart_of_account` enforce from
 * below.
 */
export const financialStatementLine = pgTable(
  'financial_statement_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable handle the chart references; never edited once issued. */
    code: text('code').notNull(),
    /** What the statement prints. Seeded lines fall back to the translated name. */
    name: text('name').notNull(),
    /** Which of the four reports this line belongs to. */
    statement: text('statement', {
      enum: ['income_statement', 'balance_sheet', 'cash_flow', 'changes_in_equity'],
    }).notNull(),
    /** A header within the same statement; null at the top level. */
    parentId: uuid('parent_id').references((): AnyPgColumn => financialStatementLine.id),
    /** A header groups lines and takes no accounts. */
    isHeader: boolean('is_header').notNull().default(false),
    /** Order among siblings, top to bottom. */
    ordinal: integer('ordinal').notNull(),
    /**
     * A computed total: the running sum of every line above it on its report.
     *
     * "Gross Profit" and "Net Income (Loss)" are lines like any other — they
     * are placed, named, moved and removed by Finance — and what makes them
     * different is only that their figure is worked out rather than mapped.
     * Which way each account pushes that figure is known from the account
     * itself: revenue is credit-normal and adds, expense is debit-normal and
     * takes away, so no line has to be told.
     */
    isSubtotal: boolean('is_subtotal').notNull().default(false),
    /**
     * Changes in Equity only: a line whose figure is worked out rather than
     * mapped.
     *
     *   `opening`  the equity the period began with — every balance as at
     *              the day before it, including profit of earlier periods
     *              that no year-end close has moved into retained earnings.
     *   `result`   the profit or loss of the period itself, from the revenue
     *              and expense accounts not mapped to a line of this
     *              statement. Mr Issa's "Total Income".
     *
     * No account reports on one.
     */
    computes: text('computes', {
      enum: ['opening', 'result', 'net_income', 'opening_cash', 'unclassified'],
    }),
    /** Balance-sheet lines only: which side of the statement. */
    side: text('side', { enum: ['asset', 'equity', 'liability'] }),
    /** The accounts on this line ARE the cash the Cash Flow Statement tracks. */
    isCash: boolean('is_cash').notNull().default(false),
    /** The seeded lines: renameable, movable, never deletable. */
    isSystem: boolean('is_system').notNull().default(false),
  },
  (t) => [
    uniqueIndex('financial_statement_line_code_key').on(t.code),
    index('financial_statement_line_parent_idx').on(t.parentId),
    index('financial_statement_line_statement_idx').on(t.statement),
  ],
);
