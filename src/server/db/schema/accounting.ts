/**
 * Chart of Accounts — Phase 02.1.
 *
 * §1.2: "The Chart of Accounts shall remain hierarchical and configurable."
 *
 * One self-referencing table, because a chart of accounts is one tree. A group
 * holds children and accepts no postings; a posting account is a leaf and takes
 * the entries. An account converts between the two as the chart grows, and
 * conversion must not change its identity — which is why they are one table and
 * one flag, not two tables.
 *
 * Approval is not modelled here. A new account is a `chart_of_account` document
 * in the shared workflow engine (Phase 01.7): the Accounting Officer raises it,
 * the Accounting Manager approves it, and `approval_status` mirrors the status
 * machine. §24 forbids a module carrying its own approval mechanism.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ACCOUNT_TYPES } from '../../domain/accounts';
import { CONTROL_ACCOUNT_KINDS, DIMENSION_TYPES, MAX_ACCOUNT_DEPTH } from '../../domain/chart-of-accounts';
import { appUser } from './platform';
import { documentStatus } from './workflow';

/** The five types. Normal balance is derived from this, never stored. */
export const accountType = pgEnum('account_type', ACCOUNT_TYPES);

/** Which subledger an account controls, when it controls one (§1.2, §14.3). */
export const controlAccountKind = pgEnum('control_account_kind', CONTROL_ACCOUNT_KINDS);

/** The seven dimensions of §4.2. The framework itself is Phase 02.4. */
export const dimensionType = pgEnum('dimension_type', DIMENSION_TYPES);

export const chartOfAccount = pgTable(
  'chart_of_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Allocated automatically through the Phase 01.5 numbering service. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    accountType: accountType('account_type').notNull(),
    /** Null for the five roots. Every other account answers to a group. */
    parentId: uuid('parent_id').references((): AnyPgColumn => chartOfAccount.id),

    /** A folder: holds children, accepts no postings (§02.1 gate). */
    isGroup: boolean('is_group').notNull().default(false),

    /**
     * Accepts postings. Set true on approval; set false to retire the account.
     * §02.1: "Active/inactive; deactivation rather than deletion when referenced."
     */
    isActive: boolean('is_active').notNull().default(false),

    /** Mirrors the shared status machine — draft → submitted → approved. */
    approvalStatus: documentStatus('approval_status').notNull().default('draft'),

    /**
     * Superseded 2026-09-03 by the four columns below, and no longer read or
     * written. It keeps its rows for one release so the version being replaced
     * goes on working while the new one builds; a later migration drops it.
     */
    statementLine: text('statement_line'),

    /**
     * Phase 1 §5, opened to Finance by direction (2026-09-03) — where this
     * account reports on each of the four statements, one independent answer
     * per report.
     *
     * Independent is the point. A revenue account explains the period on the
     * Income Statement *and* is presented inside Equity on the Balance Sheet;
     * one column could only hold one of those, and deriving the second from
     * the first is what made the reports argue with each other.
     *
     * Null is not "missing" — it means the account reports where its type
     * says it does, so every statement is complete from the first day and
     * grows more precise as Finance works through the chart.
     */
    incomeStatementLine: text('income_statement_line'),
    balanceSheetLine: text('balance_sheet_line'),
    cashFlowLine: text('cash_flow_line'),
    changesInEquityLine: text('changes_in_equity_line'),

    /**
     * §14.3 — direct manual posting to a control account requires Finance
     * Manager approval, because a manual journal into it breaks the
     * subledger-to-G/L reconciliation the account exists to provide.
     */
    controlAccount: controlAccountKind('control_account'),

    /**
     * The one currency this account holds — D7, decided 2026-08-17:
     * *"Each Chart of Accounts account is limited to one currency only … the
     * currency should not be assumed automatically."*
     *
     * Required on every posting account and forbidden on a group, which holds
     * no balance. Nullable in the column only because groups exist; the CHECK
     * below is what makes it required where it matters. Cash in three
     * currencies is three accounts, not one account with three balances.
     */
    currencyRestriction: char('currency_restriction', { length: 3 }),

    /**
     * D7, decided 2026-08-17: dimension rules are configured at the group and
     * inherited by everything below.
     *
     * True when this account states its own rules. False means inherit from the
     * nearest ancestor that declares. An account that declares with no rows
     * requires nothing — an explicit override of the group, which is a
     * different fact from having said nothing at all.
     */
    declaresDimensions: boolean('declares_dimensions').notNull().default(false),

    /** The five roots. Renameable, never deletable. */
    isSystem: boolean('is_system').notNull().default(false),

    /** Depth from the root. A root is 0. Maintained by trigger. */
    level: integer('level').notNull().default(0),

    description: text('description'),

    createdBy: uuid('created_by').references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('chart_of_account_code_uniq').on(t.code),
    index('chart_of_account_parent_idx').on(t.parentId, t.code),
    index('chart_of_account_type_idx').on(t.accountType, t.code),

    check('chart_of_account_code_shape', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9._-]*$'`),
    check(
      'chart_of_account_currency_shape',
      sql`${t.currencyRestriction} is null or ${t.currencyRestriction} ~ '^[A-Z]{3}$'`,
    ),

    // A group summarises its children; it has no balance of its own to control.
    check(
      'chart_of_account_group_not_control',
      sql`not (${t.isGroup} and ${t.controlAccount} is not null)`,
    ),

    // D7 (2026-08-17) — one currency per posting account, none on a group.
    // Written as a constraint rather than a service check because "unrestricted"
    // is precisely the state the decision rules out, and a nullable column with
    // an obvious fallback is a default by another name.
    check(
      'chart_of_account_posting_needs_currency',
      sql`(${t.isGroup} and ${t.currencyRestriction} is null)
          or (not ${t.isGroup} and ${t.currencyRestriction} is not null)`,
    ),

    // Nothing posts to an account that has not been approved. This is the
    // maker-checker rule expressed as a constraint rather than as a hope.
    check(
      'chart_of_account_active_requires_approval',
      sql`not (${t.isActive} and ${t.approvalStatus} <> 'approved')`,
    ),

    check(
      'chart_of_account_level_range',
      sql`${t.level} >= 0 and ${t.level} < ${sql.raw(String(MAX_ACCOUNT_DEPTH))}`,
    ),

    // A root is one of the five types and answers to nothing; anything else
    // must sit under a parent. Prevents a second, accidental root appearing.
    check(
      'chart_of_account_root_is_system',
      sql`(${t.parentId} is null) = (${t.level} = 0)`,
    ),
  ],
);

/**
 * Dimensions a posting to this account must supply — §4.2: "Dimensions shall be
 * mandatory or optional by account and document type."
 *
 * A table rather than seven boolean columns, because §4.2's list grows by
 * configuration and because "which accounts require a cost centre?" should be a
 * query, not a scan.
 */
export const accountRequiredDimension = pgTable(
  'account_required_dimension',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccount.id, { onDelete: 'cascade' }),
    dimension: dimensionType('dimension').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.dimension] })],
);
