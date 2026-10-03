/**
 * Payables — REQ-AP-001 Stage 1, the payables core.
 *
 * One record per thing the company has to pay — an import of panels, the
 * office rent, a forwarder's bill — and every one of them on the same spine:
 * a typed `payable` with a derived stage, an append-only status log, and
 * holds that answer "where is it stopped, and why?".
 *
 * Three decisions shape these tables:
 *
 * **The stage is derived, never typed (R2).** `payable.stage_code` is a cache
 * of a computation over the lanes, recomputed inside the transaction of every
 * event that could change it. No service sets it directly; the rule names
 * live in `payable_stage.rule_name` and the predicates in
 * `domain/payables.ts`, so a type's rail is configuration (R4) while what
 * makes a stage *true* stays code.
 *
 * **Everything under a payable appends (R3).** `payable_event` (its own
 * hand-authored, partitioned migration — Drizzle cannot declare partitions;
 * the table here describes the parent for queries only) and
 * `payable_hold_update` reuse the `audit_event` reject-mutation trigger.
 * Nothing in this module grants DELETE to the application role.
 *
 * **Lists are master data (R4).** Types, lanes, stages, event codes, reason
 * codes, expense categories, sweep checks and time limits are rows with an
 * `active` flag. Seed rows carry `created_by NULL`; rows added later record
 * who added them — which is also how the test reset tells them apart.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';
import { businessPartner } from './organisation';
import { chartOfAccount } from './accounting';
import { item, unitOfMeasure } from './item';
import { purchaseOrder } from './purchase-order';

// ---------------------------------------------------------------------------
// Masters (R4)
// ---------------------------------------------------------------------------

/** The tracks of the workflow diagram, plus the payable's own. */
export const payableLane = pgTable('payable_lane', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  sortOrder: smallint('sort_order').notNull(),
});

/**
 * What kind of payable — §5.3. Seed: import, service, recurring, local_goods,
 * advance. A new kind of fee is a row here, not a change to the system.
 */
export const payableType = pgTable('payable_type', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** §5.3 — no goods without an order. The PI creates a real PO in-transaction. */
  requiresPo: boolean('requires_po').notNull().default(false),
  /** §5.3 — no service without the benefiting department. */
  requiresDepartment: boolean('requires_department').notNull().default(false),
  /** §5.3 — no invoice approval without receipt evidence (Stage 2 enforces). */
  requiresReceipt: boolean('requires_receipt').notNull().default(false),
  /** The `doc_sequence` key this type numbers from. */
  numberSeriesKey: text('number_series_key').notNull(),
  active: boolean('active').notNull().default(true),
  sortOrder: smallint('sort_order').notNull().default(0),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/** Which lanes a type shows — §5.3. The pairing is a table, so a type is configuration. */
export const payableTypeLane = pgTable(
  'payable_type_lane',
  {
    payableTypeCode: text('payable_type_code')
      .notNull()
      .references(() => payableType.code),
    laneCode: text('lane_code')
      .notNull()
      .references(() => payableLane.code),
  },
  (t) => [uniqueIndex('payable_type_lane_uniq').on(t.payableTypeCode, t.laneCode)],
);

/**
 * A type's stage rail — §6. The sequence and names are editable (R4); the
 * `rule_name` names the derivation predicate, implemented once in
 * `domain/payables.ts`, because what makes a stage true is this requirement's
 * to fix, not a setting's.
 */
export const payableStage = pgTable(
  'payable_stage',
  {
    payableTypeCode: text('payable_type_code')
      .notNull()
      .references(() => payableType.code),
    code: text('code').notNull(),
    sequence: smallint('sequence').notNull(),
    name: text('name').notNull(),
    ruleName: text('rule_name').notNull(),
    /** ✓ on the rail — the diagram marks 7 and 8. */
    isTerminalMark: boolean('is_terminal_mark').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
  },
  (t) => [
    uniqueIndex('payable_stage_code_uniq').on(t.payableTypeCode, t.code),
    index('payable_stage_sequence_idx').on(t.payableTypeCode, t.sequence),
    check('payable_stage_sequence_positive', sql`${t.sequence} > 0`),
  ],
);

/** The event catalogue — §7.2. A code is never deleted; new codes are rows. */
export const payableEventCode = pgTable('payable_event_code', {
  code: text('code').primaryKey(),
  laneCode: text('lane_code')
    .notNull()
    .references(() => payableLane.code),
  name: text('name').notNull(),
  /** The one-line summary template; the rendered summary is stored per event. */
  summaryTemplate: text('summary_template'),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/** The twelve reason codes of the diagram's red band, plus `PENDING_REASON`. */
export const holdReasonCode = pgTable('hold_reason_code', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  laneHint: text('lane_hint').references(() => payableLane.code),
  /** D2 — who completes an automatic hold in this lane by default. */
  defaultOwnerRole: text('default_owner_role'),
  requiresDetail: boolean('requires_detail').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/**
 * Expense categories — §9.1. Rent, utilities, freight & forwarding, customs
 * brokerage… Each carries the default expense account its invoices post to
 * and the per-category receipt rule (D8: a lease is its own evidence).
 */
export const expenseCategory = pgTable('expense_category', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  defaultExpenseAccountId: uuid('default_expense_account_id').references(() => chartOfAccount.id),
  requiresPo: boolean('requires_po').notNull().default(false),
  requiresReceipt: boolean('requires_receipt').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/**
 * The sweep's check registry — §19.3. Each row names a query implemented in
 * `services/payables-sweep.ts`; a new check is a new row plus a named query,
 * never a schema change. A row whose query does not exist yet simply never
 * fires — which is how later stages' checks (SWIFT, PD, containers) sit here
 * from day one.
 */
export const sweepCheck = pgTable('sweep_check', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  laneCode: text('lane_code')
    .notNull()
    .references(() => payableLane.code),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/**
 * Time limits — §19.3. The most specific active row wins; a changed limit is
 * a new dated row, so "what was the limit in March?" keeps its answer.
 */
export const stageTimeLimit = pgTable(
  'stage_time_limit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkCode: text('check_code')
      .notNull()
      .references(() => sweepCheck.code),
    /** `all` · `type:<code>` · `bank:<code>` · `method:<code>` · `port:<code>` · `supplier:<id>`. */
    scope: text('scope').notNull().default('all'),
    limitDays: integer('limit_days').notNull(),
    escalateAfterDays: integer('escalate_after_days'),
    escalateToRole: text('escalate_to_role'),
    active: boolean('active').notNull().default(true),
    validFrom: date('valid_from').notNull(),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stage_time_limit_check_idx').on(t.checkCode, t.active),
    check('stage_time_limit_days_not_negative', sql`${t.limitDays} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// The payable (§5.1)
// ---------------------------------------------------------------------------

export const payable = pgTable(
  'payable',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableNo: text('payable_no').notNull(),
    payableTypeCode: text('payable_type_code')
      .notNull()
      .references(() => payableType.code),

    /** The supplier's PO / INV / contract number, verbatim (evidence). */
    supplierReference: text('supplier_reference').notNull(),
    /** Normalised `[A-Z0-9]` — the matching key. Unique per supplier and type. */
    supplierReferenceKey: text('supplier_reference_key').notNull(),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    /** Required for service and recurring — the benefiting department. */
    departmentCode: text('department_code').references(() => department.code),

    currency: char('currency', { length: 3 }).notNull(),
    /** Agreed / invoiced amount. Sum of linked posted invoices once they exist. */
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    /** Goods types only; the Cleared rule compares received against it. */
    quantity: numeric('quantity', { precision: 24, scale: 6 }),

    /** PI / invoice / contract date. */
    documentDate: date('document_date').notNull(),
    description: text('description').notNull(),
    paymentTermsText: text('payment_terms_text'),

    /** Required for import and local_goods (§5.1) — created from the PI lines
     *  by the existing PO service in the same transaction, or linked. */
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrder.id),
    /** Stage 2 — the generating contract. No FK until that table exists. */
    recurringContractId: uuid('recurring_contract_id'),
    expenseCategoryCode: text('expense_category_code').references(() => expenseCategory.code),
    /** A service payable whose cost belongs to an import (§20.2). */
    chargedToPayableId: uuid('charged_to_payable_id'),
    /** REQ-PM-001 §8 — the project, the element and the cost code the purchase is assigned to; the three together, or none. */
    projectCode: text('project_code'),
    wbsCode: text('wbs_code'),
    costCode: text('cost_code'),

    /** Stage 2 — recurring periods and due dates; nullable for other types. */
    dueDate: date('due_date'),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),

    /** Derived (§6). Stored for listing speed; recomputed on every event. */
    stageCode: text('stage_code').notNull(),
    stageSince: timestamp('stage_since', { withTimezone: true }).notNull().defaultNow(),
    /** Derived: an open hold exists (§19). */
    onHold: boolean('on_hold').notNull().default(false),

    /** End states. For the import type `closed_at` is *Cleared* (§20.1). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelReason: text('cancel_reason'),

    /** `erp` · `sheet_import` · `shipment_migration` · `contract` (R5). */
    source: text('source').notNull().default('erp'),
    sourceRow: text('source_row'),
    /** REQ-AP-001 §24.3 (0237) — the sheet's "Clear?", for the §20.1 comparison. */
    legacyCleared: boolean('legacy_cleared'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payable_no_uniq').on(t.payableNo),
    // R1 — one payable per supplier reference, per supplier and type.
    uniqueIndex('payable_reference_uniq').on(
      t.supplierId,
      t.payableTypeCode,
      t.supplierReferenceKey,
    ),
    index('payable_type_stage_idx').on(t.payableTypeCode, t.stageCode),
    index('payable_supplier_idx').on(t.supplierId),
    index('payable_branch_idx').on(t.branchCode),
    index('payable_hold_idx').on(t.onHold),
    foreignKey({
      columns: [t.payableTypeCode, t.stageCode],
      foreignColumns: [payableStage.payableTypeCode, payableStage.code],
      name: 'payable_stage_fk',
    }),
    check('payable_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('payable_reference_key_shape', sql`${t.supplierReferenceKey} ~ '^[A-Z0-9]+$'`),
    check(
      'payable_cancel_has_reason',
      sql`(${t.cancelledAt} is null and ${t.cancelledBy} is null)
          or (${t.cancelledAt} is not null and ${t.cancelledBy} is not null
              and coalesce(btrim(${t.cancelReason}), '') <> '')`,
    ),
  ],
);

/**
 * The PI / quote / contract lines — §5.1. Quantity is known before any
 * invoice — and a changed line supersedes the old one rather than replacing
 * it (D11): the PI is evidence, and evidence gains rows, never loses them.
 */
export const payableOrderLine = pgTable(
  'payable_order_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    /** The model, for goods; null for a pure expense line. */
    itemCode: text('item_code').references(() => item.code),
    expenseCategoryCode: text('expense_category_code').references(() => expenseCategory.code),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 6 }),
    uomCode: text('uom_code').references(() => unitOfMeasure.code),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }),
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }),
    /** D11 — set when a later edit replaced this line. The row stands. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references(() => appUser.id),
  },
  (t) => [
    uniqueIndex('payable_order_line_no_uniq')
      .on(t.payableId, t.lineNo)
      .where(sql`superseded_at is null`),
    check(
      'payable_order_line_quantity_positive',
      sql`${t.quantity} is null or ${t.quantity} > 0`,
    ),
    check(
      'payable_order_line_supersede_complete',
      sql`(${t.supersededAt} is null and ${t.supersededBy} is null)
          or (${t.supersededAt} is not null and ${t.supersededBy} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// The status log (§7) — the parent of a partitioned table
// ---------------------------------------------------------------------------

/**
 * One row per update, from every lane, in the same transaction as the change.
 *
 * The real table is created by a hand-authored migration, PARTITIONED BY
 * RANGE on `recorded_at` with yearly partitions — Drizzle cannot declare
 * that, so this definition describes the parent for the query builder only
 * and `drizzle-kit` is never run against it. The primary key includes the
 * partition column because PostgreSQL requires it.
 */
export const payableEvent = pgTable(
  'payable_event',
  {
    id: uuid('id').notNull().defaultRandom(),
    payableId: uuid('payable_id').notNull(),
    /** The business moment (the SWIFT date, the arrival) — typed or from the document. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** The server clock. Never typed. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    laneCode: text('lane_code').notNull(),
    eventCode: text('event_code').notNull(),
    /** Rendered once from the code's template and stored — it never changes. */
    summary: text('summary').notNull(),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    sourceNo: text('source_no'),
    before: jsonb('before'),
    after: jsonb('after'),
    /** Null for the sweep — shown as "system". */
    actorUserId: uuid('actor_user_id'),
    holdId: uuid('hold_id'),
    attachmentId: uuid('attachment_id'),
    correctionOfId: uuid('correction_of_id'),
  },
  (t) => [
    index('payable_event_payable_idx').on(t.payableId, t.recordedAt),
    index('payable_event_code_idx').on(t.eventCode, t.recordedAt),
    index('payable_event_source_idx').on(t.sourceType, t.sourceId),
  ],
);

// ---------------------------------------------------------------------------
// Holds (§19)
// ---------------------------------------------------------------------------

export const payableHold = pgTable(
  'payable_hold',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    laneCode: text('lane_code')
      .notNull()
      .references(() => payableLane.code),
    stageCode: text('stage_code'),
    /** The document that is stuck (payment application, container, PD). */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    reasonCode: text('reason_code')
      .notNull()
      .references(() => holdReasonCode.code),
    detail: text('detail'),
    /** Required to leave `PENDING_REASON` (§19.2). */
    ownerUserId: uuid('owner_user_id').references(() => appUser.id),
    /** When the stop began — the sweep uses the day the limit was passed. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    nextAction: text('next_action'),
    nextActionDue: date('next_action_due'),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => appUser.id),
    resolution: text('resolution'),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalatedToRole: text('escalated_to_role'),
    /** The sweep's idempotency key: one open hold per (payable, check). */
    checkCode: text('check_code').references(() => sweepCheck.code),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payable_hold_payable_idx').on(t.payableId, t.status),
    // §19.3 — the sweep never opens a second hold for the same condition.
    uniqueIndex('payable_hold_check_open_uniq')
      .on(t.payableId, t.checkCode)
      .where(sql`status = 'open' and check_code is not null`),
    check(
      'payable_hold_resolved_complete',
      sql`(${t.status} = 'open' and ${t.resolvedAt} is null)
          or (${t.status} = 'resolved' and ${t.resolvedAt} is not null
              and coalesce(btrim(${t.resolution}), '') <> '')`,
    ),
  ],
);

/**
 * The hold's thread — §19.2. Append-only; the hold's current values are a
 * projection of these rows, shown whole like `collection_activity` is.
 */
export const payableHoldUpdate = pgTable(
  'payable_hold_update',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdId: uuid('hold_id')
      .notNull()
      .references(() => payableHold.id),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    kind: text('kind', {
      enum: ['opened', 'completed', 'updated', 'reassigned', 'resolved', 'escalated'],
    }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    note: text('note'),
    /** Null for the sweep. */
    changedBy: uuid('changed_by'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payable_hold_update_hold_idx').on(t.holdId, t.changedAt)],
);

/**
 * REQ-AP-001 §24.3 (0237) — every dry run and apply of the sheet import, with
 * its report and the accountant's sign-off of the cleared comparison.
 */
export const payablesMigrationRun = pgTable('payables_migration_run', {
  id: uuid('id').primaryKey().defaultRandom(),
  mode: text('mode').notNull(),
  fileName: text('file_name').notNull(),
  fileSha256: text('file_sha256').notNull(),
  report: jsonb('report').notNull(),
  runBy: uuid('run_by')
    .notNull()
    .references(() => appUser.id),
  runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
  signedOffBy: uuid('signed_off_by').references(() => appUser.id),
  signedOffAt: timestamp('signed_off_at', { withTimezone: true }),
  signOffNote: text('sign_off_note'),
});

/**
 * REQ-FIX-001 FX8 (0253) — the dinars an import agreed in a foreign currency
 * closes on once it is fully paid in that currency: what an invoice still
 * owed (a gain) or what a payment or deposit was over them (a loss). One row
 * per document closed, append-only.
 */
export const payableExchangeDifference = pgTable(
  'payable_exchange_difference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    kind: text('kind', { enum: ['gain', 'loss'] }).notNull(),
    sourceType: text('source_type', { enum: ['ap_invoice', 'supplier_payment', 'supplier_advance'] }).notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceNo: text('source_no').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payable_exchange_difference_payable_idx').on(t.payableId),
    index('payable_exchange_difference_journal_idx').on(t.journalEntryId),
    check('payable_exchange_difference_kind', sql`${t.kind} in ('gain', 'loss')`),
    check('payable_exchange_difference_source', sql`${t.sourceType} in ('ap_invoice', 'supplier_payment', 'supplier_advance')`),
    check('payable_exchange_difference_positive', sql`${t.amountIqd} > 0`),
  ],
);
