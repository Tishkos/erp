import { boolean, index, integer, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * The financial statement lines — owned by Finance, not by the code.
 *
 * By direction (2026-09-03): the fixed catalogue of twelve lines was half a
 * mapping. Finance defines the shape of its own reports — the headers, the
 * lines, their order — and the accounts are connected to those lines when
 * they are opened. This table *is* the report layout: the Income Statement
 * and Balance Sheet mapping screens edit it, and the statements are drawn
 * from it.
 *
 * The Income Statement and Balance Sheet have independent account mappings.
 * Revenue and expense accounts may explain the period result on the first and
 * also be presented within equity on the second. Cash Flow classifies primary
 * lines, while Changes in Equity reads the Balance Sheet equity mapping.
 *
 * The twelve original lines are seeded with `is_system` set: they carry the
 * type defaults and the running subtotals (gross profit needs to know what
 * "cost of sales" is), so they may be renamed, moved and reordered but never
 * deleted. Everything else is Finance's to create and remove — removal only
 * while no account reports on the line, which the foreign key from
 * `chart_of_account.statement_line` also enforces from below.
 */
export const financialStatementLine = pgTable(
  'financial_statement_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable handle the chart references; never edited once issued. */
    code: text('code').notNull(),
    /** What the statement prints. Seeded lines fall back to the translated name. */
    name: text('name').notNull(),
    /** Which statement face this line belongs to. */
    statement: text('statement', { enum: ['income_statement', 'balance_sheet'] }).notNull(),
    /** A header within the same statement; null at the top level. */
    parentId: uuid('parent_id').references((): AnyPgColumn => financialStatementLine.id),
    /** A header groups lines and takes no accounts. */
    isHeader: boolean('is_header').notNull().default(false),
    /** Order among siblings, top to bottom. */
    ordinal: integer('ordinal').notNull(),
    /**
     * Income-statement lines only: how the line bears on the result and on
     * the running subtotals. Gross profit is revenue less cost of sales
     * *whatever* the layout looks like, so every line says which of the six
     * classical roles it plays.
     */
    role: text('role', {
      enum: ['revenue', 'cost_of_sales', 'other_income', 'operating_expenses', 'finance_costs', 'tax_expense'],
    }),
    /** Balance-sheet lines only: which side of the statement. */
    side: text('side', { enum: ['asset', 'equity', 'liability'] }),
    /**
     * Where the line's movements land on the Cash Flow Statement. Null for
     * cash itself — cash moving between cash accounts is not a cash flow.
     */
    cashFlowCategory: text('cash_flow_category', { enum: ['operating', 'investing', 'financing'] }),
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
