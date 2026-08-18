/**
 * A/R collections and write-off — Phase 06.11, §16.
 *
 * > §16: *"Collections Worklist, Promise to Pay, Follow-up Notes."*
 * > §16: *"Write-off requires defined threshold, approval and reason code."*
 * > §16 acceptance 5: *"Write-offs, refunds and credit notes require controlled
 * > approval."*
 *
 * Three small tables and one configuration row, and the interesting decisions
 * are about what each one refuses to be.
 *
 * **A promise to pay is a row, not a note.** *"They said they would pay on the
 * 15th"* is a fact somebody should be held to on the 16th, and a free-text note
 * cannot be reported on, chased, or counted when Finance asks how many promises
 * are kept. So it has a date, an amount and an outcome.
 *
 * **A write-off is a document, not a status.** Forgiving a debt is a decision
 * with an owner, a reason and a journal — Dr Bad Debt Expense / Cr Customer A/R
 * — and §16 asks for a *threshold* on top, so that small write-offs are routine
 * and large ones are not. Marking an invoice "written off" with a flag would
 * make the decision invisible in the ledger and unattributable afterwards.
 *
 * **The threshold is configuration with a safe default.** Zero, so that *every*
 * write-off needs the higher approval until Finance sets a figure. The same
 * treatment §8.4's receipt tolerance got, and for the same reason: a default that
 * lets things through silently is a control that was never turned on.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner } from './organisation';
import { journalEntry } from './journal';
import { arInvoice } from './ar-invoice';
import { documentStatus } from './workflow';

/** How a promise ended. `open` until the date passes or the money arrives. */
export const promiseStatus = pgEnum('promise_status', ['open', 'kept', 'broken', 'cancelled']);

export const promiseToPay = pgTable(
  'promise_to_pay',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The item promised against. Null for a promise about the account overall. */
    arInvoiceId: uuid('ar_invoice_id').references(() => arInvoice.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** When the customer said they would pay. */
    promisedOn: date('promised_on').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    status: promiseStatus('status').notNull().default('open'),
    /** Who the clerk spoke to — the promise is only as good as its source. */
    promisedBy: text('promised_by'),
    note: text('note'),

    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the promise is resolved, with how it went. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
  },
  (t) => [
    index('promise_to_pay_customer_idx').on(t.customerId, t.status),
    index('promise_to_pay_invoice_idx').on(t.arInvoiceId),
    index('promise_to_pay_due_idx').on(t.promisedOn, t.status),

    check('promise_to_pay_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'promise_to_pay_resolution_complete',
      sql`(${t.status} = 'open') = (${t.resolvedAt} is null)`,
    ),
  ],
);

/**
 * §16's *"follow-up notes"* — what was done, when, by whom.
 *
 * Append-only (§5.4). A collections history that could be edited is one where
 * *"we called three times"* becomes unverifiable, and the whole value of the
 * record is that somebody else can check it.
 */
export const collectionActivity = pgTable(
  'collection_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    arInvoiceId: uuid('ar_invoice_id').references(() => arInvoice.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    occurredOn: date('occurred_on').notNull(),
    /** call · email · visit · letter · other — free text, deliberately. */
    activityKind: text('activity_kind').notNull(),
    note: text('note').notNull(),

    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('collection_activity_customer_idx').on(t.customerId, t.occurredOn),
    index('collection_activity_invoice_idx').on(t.arInvoiceId),

    check('collection_activity_note_present', sql`btrim(${t.note}) <> ''`),
    check('collection_activity_kind_present', sql`btrim(${t.activityKind}) <> ''`),
  ],
);

/**
 * §16 — *"write-off requires defined threshold, approval and reason code."*
 *
 * The threshold decides *who* may approve, not whether approval is needed: every
 * write-off is approved by somebody. Below it, the ordinary approver; above it,
 * a higher one. Zero — the default — puts everything above the line, which is
 * the safe direction until Finance sets a figure.
 */
export const arWriteOffPolicy = pgTable(
  'ar_write_off_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null is the company-wide default. */
    branchCode: text('branch_code').references(() => branch.code),

    /** Below this, the ordinary approver suffices. Zero means nothing is. */
    thresholdIqd: numeric('threshold_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    note: text('note'),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per branch and exactly one default, so "the threshold" cannot
    // depend on which row was read first.
    uniqueIndex('ar_write_off_policy_branch_uniq')
      .on(t.branchCode)
      .where(sql`branch_code is not null`),
    uniqueIndex('ar_write_off_policy_default_uniq')
      .on(sql`(true)`)
      .where(sql`branch_code is null`),

    check('ar_write_off_policy_threshold_not_negative', sql`${t.thresholdIqd} >= 0`),
  ],
);

/** §16 — the reason codes a write-off may cite. Configuration, not free text. */
export const arWriteOffReason = pgTable(
  'ar_write_off_reason',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [check('ar_write_off_reason_name_present', sql`btrim(${t.name}) <> ''`)],
);

/**
 * Forgiving a debt — Dr Bad Debt Expense / Cr Customer A/R.
 *
 * A document rather than a flag on the invoice, because it is a decision with an
 * owner, a reason and an accounting effect. §16 acceptance 5 puts it alongside
 * refunds and credit notes as requiring *"controlled approval"*, which is only
 * meaningful if there is something to approve.
 */
export const arWriteOff = pgTable(
  'ar_write_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    writeOffNo: text('write_off_no').notNull(),

    /** draft · approved · posted · reversed. */
    status: documentStatus('status').notNull().default('draft'),

    arInvoiceId: uuid('ar_invoice_id')
      .notNull()
      .references(() => arInvoice.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    writeOffDate: date('write_off_date').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /** §16 — the reason code, from the configured list. */
    reasonCode: text('reason_code')
      .notNull()
      .references(() => arWriteOffReason.code),
    note: text('note'),

    /**
     * The threshold in force when this was raised, copied here.
     *
     * Recorded rather than looked up later, for the same reason the warranty
     * duration is: the policy may change, and the question a year later is
     * *"what rule was this approved under?"*
     */
    thresholdAtApprovalIqd: numeric('threshold_at_approval_iqd', { precision: 19, scale: 4 }),
    /** True when the amount exceeded the threshold and needed the higher hand. */
    aboveThreshold: boolean('above_threshold'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ar_write_off_no_uniq').on(t.writeOffNo),
    index('ar_write_off_invoice_idx').on(t.arInvoiceId),
    index('ar_write_off_customer_idx').on(t.customerId, t.status),

    check('ar_write_off_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'ar_write_off_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
    check(
      'ar_write_off_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
    check(
      'ar_write_off_stamps_in_order',
      sql`(${t.postedAt} is null or ${t.approvedAt} is not null)
          and (${t.postedAt} is null or ${t.approvedAt} <= ${t.postedAt})`,
    ),
  ],
);
