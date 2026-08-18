/**
 * Payment proposal, payment batch and the maker-checker record — Phase 07.2 and
 * 07.3, §15 and §17.
 *
 * > §15: *"Include due items in payment proposal based on due date, priority,
 * > discount and available cash."*
 * > §17: *"Generate payment batch and bank instruction/reference."*
 * > §17: *"Creator, approver and executor shall be different users for
 * > high-risk payments."*
 *
 * **Why a proposal is a document and not a query.** Phase 05.10 already answers
 * *"what could be paid today?"* as a report. What §15 asks for is different: a
 * list somebody **approved**, that money then moved against. The difference only
 * shows up when they disagree — an invoice that was in the proposal and is not
 * in the payment, or the reverse — and a query cannot be disagreed with because
 * it has no past tense.
 *
 * **Why excluded items are rows.** The proposal stores every candidate it
 * considered, including the ones it refused and why. A run that recorded only
 * what it paid could never answer the question Finance actually asks, which is
 * why something was *not* paid.
 *
 * **Why the batch line carries a revision number.** §15 requires supplier bank
 * detail changes to be *"independently verified and approved before payment"*.
 * The approver approved a payment to an account number; if that number moves
 * between approval and execution, the approval no longer covers where the money
 * is going. Storing the revision seen at approval is what makes that detectable
 * rather than merely forbidden.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner, partnerBankAccount } from './organisation';
import { bankCashAccount } from './item';
import { documentStatus } from './workflow';
import { apInvoice } from './ap-invoice';
import { supplierAdvance } from './supplier-advance';
import { supplierPayment } from './supplier-payment';

export const INCLUSIONS = [
  'selected',
  'deferred_funds',
  'excluded_not_due',
  'excluded_unapproved',
  'excluded_settled',
  'excluded_blocked',
  'excluded_no_bank_details',
  'excluded_currency',
] as const;

export const proposalInclusion = pgEnum('proposal_inclusion', INCLUSIONS);

export const BATCH_LINE_STATES = ['pending', 'executed', 'failed', 'returned'] as const;

export const batchLineStatus = pgEnum('batch_line_status', BATCH_LINE_STATES);

// ---------------------------------------------------------------------------
// §17 — what counts as a high-risk payment
// ---------------------------------------------------------------------------

/**
 * §17 — *"…for high-risk payments."*
 *
 * §17 never defines high-risk, so this holds the definition as configuration
 * rather than letting the implementation invent one. The threshold is the
 * **lowest amount that is high-risk**, and it defaults to zero: everything is
 * high-risk until Finance says otherwise. The same shape and the same safe
 * direction as §16's write-off threshold. Registered as D13.
 */
export const paymentRiskPolicy = pgTable(
  'payment_risk_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null is the company-wide default. */
    branchCode: text('branch_code').references(() => branch.code),

    /** At or above this, maker-checker applies. Zero means every payment. */
    highRiskThresholdIqd: numeric('high_risk_threshold_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    note: text('note'),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_risk_policy_branch_uniq')
      .on(t.branchCode)
      .where(sql`branch_code is not null`),
    uniqueIndex('payment_risk_policy_default_uniq')
      .on(sql`(true)`)
      .where(sql`branch_code is null`),

    check('payment_risk_policy_threshold_not_negative', sql`${t.highRiskThresholdIqd} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 07.2 — the proposal
// ---------------------------------------------------------------------------

export const paymentProposal = pgTable(
  'payment_proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalNo: text('proposal_no').notNull(),

    status: documentStatus('status').notNull().default('draft'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** §15 — *"available cash"* is available cash **on the paying account**. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    /** When the run was built, and the date it proposes to pay on. */
    proposalDate: date('proposal_date').notNull(),
    payDate: date('pay_date').notNull(),
    currency: text('currency').notNull().default('IQD'),

    /**
     * The funds the account had when the run was built.
     *
     * A snapshot, and deliberately so: money moves, and a proposal approved on
     * Tuesday was approved against Tuesday's balance. Execution re-checks the
     * live figure — this one is the evidence of what was in front of the
     * approver, which is a different question.
     */
    availableFundsIqd: numeric('available_funds_iqd', { precision: 19, scale: 4 }).notNull(),
    selectedTotalIqd: numeric('selected_total_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    deferredTotalIqd: numeric('deferred_total_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_proposal_no_uniq').on(t.proposalNo),
    index('payment_proposal_account_idx').on(t.bankCashAccountId, t.payDate),

    check('payment_proposal_funds_not_negative', sql`${t.availableFundsIqd} >= 0`),
    // §15 — the selected total can never be more than the cash there was.
    check(
      'payment_proposal_within_available_cash',
      sql`${t.selectedTotalIqd} <= ${t.availableFundsIqd}`,
    ),
    check('payment_proposal_pay_date_not_before_built', sql`${t.payDate} >= ${t.proposalDate}`),
  ],
);

/**
 * Every candidate the run considered, with what became of it.
 *
 * Exactly one of the two source columns is set. Two nullable foreign keys with a
 * check beats one polymorphic `(type, id)` pair, because the database still
 * knows what the row points at: a deleted invoice cannot leave an orphaned
 * proposal line behind, and *"which proposals referenced this advance?"* stays a
 * join rather than a text comparison.
 */
export const paymentProposalItem = pgTable(
  'payment_proposal_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => paymentProposal.id, { onDelete: 'cascade' }),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    apInvoiceId: uuid('ap_invoice_id').references(() => apInvoice.id),
    supplierAdvanceId: uuid('supplier_advance_id').references(() => supplierAdvance.id),

    /** The beneficiary details as they stood when the run was built. */
    partnerBankAccountId: uuid('partner_bank_account_id').references(() => partnerBankAccount.id),
    beneficiaryRevision: integer('beneficiary_revision'),

    reference: text('reference').notNull(),
    dueDate: date('due_date').notNull(),
    currency: text('currency').notNull(),
    outstandingIqd: numeric('outstanding_iqd', { precision: 19, scale: 4 }).notNull(),

    /** §15's *"priority"*. Copied from the supplier so the run is reproducible. */
    priority: smallint('priority').notNull().default(5),

    /**
     * Appendix D — *"discount opportunities"*. What an early settlement would
     * have been worth, **reported and never deducted**: paying less than the
     * invoice says needs an accounting treatment nobody has chosen (D14).
     */
    discountIqd: numeric('discount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    discountDeadline: date('discount_deadline'),

    inclusion: proposalInclusion('inclusion').notNull(),
    /** Null only when the item was selected — everything else says why not. */
    reason: text('reason'),
  },
  (t) => [
    index('payment_proposal_item_proposal_idx').on(t.proposalId, t.inclusion),
    index('payment_proposal_item_invoice_idx').on(t.apInvoiceId),
    index('payment_proposal_item_advance_idx').on(t.supplierAdvanceId),

    check(
      'payment_proposal_item_one_source',
      sql`(${t.apInvoiceId} is not null and ${t.supplierAdvanceId} is null)
          or (${t.apInvoiceId} is null and ${t.supplierAdvanceId} is not null)`,
    ),
    // A selected item is money about to move, so it is positive. An excluded
    // one may legitimately be zero — an invoice nobody has posted yet has no
    // total, and "there is nothing owed" is one of the reasons it is excluded.
    check(
      'payment_proposal_item_outstanding_positive',
      sql`case when ${t.inclusion} = 'selected' then ${t.outstandingIqd} > 0
               else ${t.outstandingIqd} >= 0 end`,
    ),
    check('payment_proposal_item_discount_not_negative', sql`${t.discountIqd} >= 0`),
    check('payment_proposal_item_priority_range', sql`${t.priority} between 1 and 9`),
    // An exclusion with no reason records that something was refused without
    // recording why, which is the one thing this table exists to prevent.
    check(
      'payment_proposal_item_reason_present',
      sql`(${t.inclusion} = 'selected' and ${t.reason} is null)
          or (${t.inclusion} <> 'selected' and coalesce(btrim(${t.reason}), '') <> '')`,
    ),
    // §17 — a selected item must have somewhere to pay to.
    check(
      'payment_proposal_item_selected_has_beneficiary',
      sql`${t.inclusion} <> 'selected' or ${t.partnerBankAccountId} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 07.2 and 07.3 — the batch
// ---------------------------------------------------------------------------

/**
 * §17 — *"Generate payment batch and bank instruction/reference."*
 *
 * The batch is the instruction to the bank and the record of what came back. It
 * carries three actors rather than the usual two, because §17 asks for three:
 * the person who raised it, the person who approved it, and the person who sent
 * it. They are separate columns rather than a status history so that the
 * constraint *"these three are different people"* can be written down here,
 * where the database will keep it.
 */
export const paymentBatch = pgTable(
  'payment_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchNo: text('batch_no').notNull(),

    status: documentStatus('status').notNull().default('draft'),

    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => paymentProposal.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    paymentDate: date('payment_date').notNull(),
    currency: text('currency').notNull().default('IQD'),
    totalIqd: numeric('total_iqd', { precision: 19, scale: 4 }).notNull(),
    lineCount: integer('line_count').notNull(),

    /** §17 — the reference the bank knows this instruction by. */
    bankInstructionRef: text('bank_instruction_ref'),

    /**
     * Whether §17's segregation applied. Stored rather than recomputed: the
     * threshold is configuration and configuration changes, and an audit two
     * years from now needs to know what the rule was **then**.
     */
    highRisk: boolean('high_risk').notNull(),
    riskThresholdIqd: numeric('risk_threshold_iqd', { precision: 19, scale: 4 }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    executedBy: uuid('executed_by').references(() => appUser.id),
    executedAt: timestamp('executed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_batch_no_uniq').on(t.batchNo),
    index('payment_batch_proposal_idx').on(t.proposalId),
    index('payment_batch_account_idx').on(t.bankCashAccountId, t.paymentDate),
    // §17 — the bank's own reference is unique where it is given.
    uniqueIndex('payment_batch_instruction_uniq')
      .on(t.bankInstructionRef)
      .where(sql`bank_instruction_ref is not null`),

    check('payment_batch_total_positive', sql`${t.totalIqd} > 0`),
    check('payment_batch_line_count_positive', sql`${t.lineCount} > 0`),

    // §17 — the three actors of a high-risk payment are three people. Written
    // here as well as in the service because a control that lives only in
    // application code is a control that a future migration can quietly drop.
    check(
      'payment_batch_maker_checker',
      sql`not ${t.highRisk}
          or (${t.approvedBy} is null or ${t.approvedBy} <> ${t.createdBy})
             and (${t.executedBy} is null or ${t.executedBy} <> ${t.createdBy})
             and (${t.executedBy} is null or ${t.approvedBy} is null
                  or ${t.executedBy} <> ${t.approvedBy})`,
    ),
    // Executed without an approval is the same breach by another route.
    check(
      'payment_batch_executed_after_approval',
      sql`${t.executedBy} is null or ${t.approvedBy} is not null`,
    ),
    check(
      'payment_batch_execution_complete',
      sql`(${t.executedBy} is null and ${t.executedAt} is null)
          or (${t.executedBy} is not null and ${t.executedAt} is not null)`,
    ),
  ],
);

export const paymentBatchLine = pgTable(
  'payment_batch_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => paymentBatch.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),
    apInvoiceId: uuid('ap_invoice_id').references(() => apInvoice.id),
    supplierAdvanceId: uuid('supplier_advance_id').references(() => supplierAdvance.id),

    /** §17 — where the money is going, and the version of it that was approved. */
    partnerBankAccountId: uuid('partner_bank_account_id')
      .notNull()
      .references(() => partnerBankAccount.id),
    approvedBeneficiaryRevision: integer('approved_beneficiary_revision'),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    status: batchLineStatus('status').notNull().default('pending'),

    /** Written at execution — the Phase 05 payment this line became. */
    supplierPaymentId: uuid('supplier_payment_id').references(() => supplierPayment.id),

    /** §17 — a payment the bank refused, or sent back. */
    failureReason: text('failure_reason'),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnedBy: uuid('returned_by').references(() => appUser.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_batch_line_no_uniq').on(t.batchId, t.lineNo),
    index('payment_batch_line_supplier_idx').on(t.supplierId),
    index('payment_batch_line_invoice_idx').on(t.apInvoiceId),
    index('payment_batch_line_advance_idx').on(t.supplierAdvanceId),
    // The same debt cannot sit in two live batches at once.
    uniqueIndex('payment_batch_line_invoice_live_uniq')
      .on(t.apInvoiceId)
      .where(sql`ap_invoice_id is not null and status in ('pending', 'executed')`),
    uniqueIndex('payment_batch_line_advance_live_uniq')
      .on(t.supplierAdvanceId)
      .where(sql`supplier_advance_id is not null and status in ('pending', 'executed')`),

    check(
      'payment_batch_line_one_source',
      sql`(${t.apInvoiceId} is not null and ${t.supplierAdvanceId} is null)
          or (${t.apInvoiceId} is null and ${t.supplierAdvanceId} is not null)`,
    ),
    check('payment_batch_line_amount_positive', sql`${t.amountIqd} > 0`),
    // An invoice line that moved money points at the payment that moved it; one
    // that did not, does not. Both directions, so neither state can be faked.
    //
    // An advance line never has one: Appendix C makes an advance payment its own
    // entry (Dr Supplier Advance / Cr Bank) rather than a settlement of a debt,
    // so there is no `supplier_payment` in the middle to point at.
    check(
      'payment_batch_line_executed_has_payment',
      sql`(${t.apInvoiceId} is not null
           and (${t.status} in ('executed', 'returned')) = (${t.supplierPaymentId} is not null))
          or (${t.supplierAdvanceId} is not null and ${t.supplierPaymentId} is null)`,
    ),
    check(
      'payment_batch_line_failure_has_reason',
      sql`${t.status} not in ('failed', 'returned')
          or coalesce(btrim(${t.failureReason}), '') <> ''`,
    ),
    check(
      'payment_batch_line_return_complete',
      sql`(${t.returnedAt} is null and ${t.returnedBy} is null)
          or (${t.returnedAt} is not null and ${t.returnedBy} is not null
              and ${t.status} = 'returned')`,
    ),
  ],
);
