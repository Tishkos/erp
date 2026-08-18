/**
 * Stock counts and reconciliation — Phase 04.8, §9.6.
 *
 * *"Stock Count Plan → Physical Count → Recount where required → Variance
 * Approval → Inventory Adjustment"*, with scope by warehouse, item, category or
 * filter, and Inventory Loss requiring Warehouse Manager approval.
 *
 * Two decisions shape the tables.
 *
 * **The system quantity is snapshotted onto the line when the count is planned.**
 * §9.6 says *"the system quantity remains visible during counting"* — which is a
 * deliberate choice, and not the obvious one: many systems hide it to stop
 * counters writing down what the system already thinks. The blueprint's position
 * is that a counter who can see the book figure queries a difference on the
 * spot, while a blind count produces variances nobody can explain a week later.
 * Taking the snapshot at planning time is what makes the variance meaningful:
 * it is the difference between what was counted and what the books said *at the
 * moment the count started*, not at the moment somebody got round to approving
 * it.
 *
 * **A variance is not an adjustment.** Counting produces a difference; a
 * Warehouse Manager decides whether to believe it. The adjustment is a separate,
 * approved act, because §9.6 makes writing stock off a decision with a name
 * against it rather than an arithmetic consequence.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { warehouse } from './organisation';
import { item } from './item';

/**
 * Appendix B, Stock Reconciliation: *"Planned, Counted, Recount, Pending
 * Approval, Adjusted, Closed"* — verbatim.
 */
export const STOCK_COUNT_STATUSES = [
  'planned',
  'counted',
  'recount',
  'pending_approval',
  'adjusted',
  'closed',
  'cancelled',
] as const;

export const stockCountStatus = pgEnum('stock_count_status', STOCK_COUNT_STATUSES);

/** §9.6 — "full, by warehouse, item, category or filter". */
export const COUNT_SCOPES = ['full', 'warehouse', 'item', 'category'] as const;
export const countScope = pgEnum('stock_count_scope', COUNT_SCOPES);

export const stockCount = pgTable(
  'stock_count',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countNo: text('count_no').notNull(),
    status: stockCountStatus('status').notNull().default('planned'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),

    scope: countScope('scope').notNull(),
    /** The category or item filter the scope was built from, for the record. */
    scopeFilter: text('scope_filter'),

    plannedOn: date('planned_on').notNull(),
    countedOn: date('counted_on'),
    adjustedOn: date('adjusted_on'),

    plannedBy: uuid('planned_by')
      .notNull()
      .references(() => appUser.id),
    countedBy: uuid('counted_by').references(() => appUser.id),
    /** §9.6 — the Warehouse Manager who approved the variance. */
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvalReason: text('approval_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('stock_count_no_uniq').on(t.countNo),
    index('stock_count_status_idx').on(t.status, t.branchCode),
    // §5.4 — an approval without a reason is a record that something happened,
    // not a record of a decision.
    check(
      'stock_count_approval_has_reason',
      sql`(${t.approvedBy} is null and ${t.approvedAt} is null)
          or (${t.approvedBy} is not null and ${t.approvedAt} is not null
              and coalesce(btrim(${t.approvalReason}), '') <> '')`,
    ),
  ],
);

export const stockCountLine = pgTable(
  'stock_count_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stockCountId: uuid('stock_count_id')
      .notNull()
      .references(() => stockCount.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),

    /**
     * §9.6 — the book quantity, snapshotted when the count was planned and
     * visible to the counter. Frozen at that moment on purpose: a variance
     * against a figure that moved while the count was in progress is a variance
     * against nothing.
     */
    systemQuantity: numeric('system_quantity', { precision: 24, scale: 6 }).notNull(),
    /** What was physically found. Null until the count is recorded. */
    countedQuantity: numeric('counted_quantity', { precision: 24, scale: 6 }),
    /** §9.6's recount, where the first count was doubted. */
    recountQuantity: numeric('recount_quantity', { precision: 24, scale: 6 }),

    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    note: text('note'),

    /** The adjustment movement, once approved. */
    movementId: uuid('movement_id'),
  },
  (t) => [
    uniqueIndex('stock_count_line_no_uniq').on(t.stockCountId, t.lineNo),
    // A count of a negative quantity is a counting error, not a finding.
    check(
      'stock_count_line_counted_not_negative',
      sql`${t.countedQuantity} is null or ${t.countedQuantity} >= 0`,
    ),
    check(
      'stock_count_line_recount_not_negative',
      sql`${t.recountQuantity} is null or ${t.recountQuantity} >= 0`,
    ),
  ],
);
