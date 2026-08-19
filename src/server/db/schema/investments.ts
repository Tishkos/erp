/**
 * Investment Management — Phase 13 schema, §13 and Appendix E (IFRS 9).
 *
 * ── The two tables that ship empty, and why that is the design ──────────────
 * §13: *"The legal and accounting treatment of investments differs by
 * instrument. The IT team must implement configurable types and posting rules
 * **only after Finance defines the required categories**."* And separately:
 * *"Valuation methods and frequency require Finance approval."*
 *
 * `investment_type` and `investment_valuation_method` are therefore catalogues
 * Finance fills, and both are **empty on delivery**. That is not an omission:
 *
 *   · Without a type, no investment can be created — the foreign key has nothing
 *     to point at.
 *   · Without a method, no valuation can be recorded — same.
 *
 * Emptiness **refuses**. That is the test every open item in the decision
 * register is held to, and it is the only arrangement under which shipping ahead
 * of D2 is safe. A plausible-looking seed list would be worse than no list: an
 * investment posted under an invented category is a misstatement, and no test in
 * this phase would catch it because the test would be written against the same
 * invented rule.
 *
 * ── Units are scale 6 ───────────────────────────────────────────────────────
 * Money is scale 4 as everywhere; units are scale 6 like quantities. A holding
 * of 1,000 shares and a holding of 0.000001 of a fund are the same kind of
 * number, and rounding units at four places loses fractional holdings that exist
 * in real portfolios.
 *
 * ── Carrying value is not a column ──────────────────────────────────────────
 * §13 requires historical valuations to be preserved and never overwritten. A
 * `carrying_value` column would be a second opinion about the same fact — the
 * latest valuation — and the two would part company the first time a valuation
 * was corrected. Cost is stored because it happened; carrying value is read from
 * the valuation history.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner } from './organisation';
import { bankCashAccount } from './item';
import { currency } from './fiscal';
import { journalEntry } from './journal';
import { attachment } from './attachments';
import { documentStatus } from './workflow';

// ---------------------------------------------------------------------------
// 13.1 — the type catalogue. Ships empty (D2).
// ---------------------------------------------------------------------------

/**
 * §13 — *"Investment type determines required fields and account mappings."*
 *
 * `required_fields` is a list of column names the type demands, held as data so
 * that adding a type or changing what it demands is configuration. The 13.1 gate
 * — *"adding a new investment type requires no code change"* — is true because
 * nothing in TypeScript enumerates these rows.
 *
 * The account columns are **roles**, resolved through §3.3's Accounting Mapping,
 * for the same reason every other module names roles: which G/L account a role
 * becomes is Finance's to configure, and D2 covers it.
 */
export const investmentType = pgTable(
  'investment_type',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),

    /** Column names this type demands before an investment may be saved. */
    requiredFields: text('required_fields').array().notNull().default(sql`'{}'::text[]`),

    /** §3.3 roles, never account ids. */
    costAccountRole: text('cost_account_role').notNull().default('investment_cost'),
    incomeAccountRole: text('income_account_role').notNull().default('investment_income'),
    valuationAccountRole: text('valuation_account_role').notNull().default('investment_valuation'),
    impairmentAccountRole: text('impairment_account_role')
      .notNull()
      .default('investment_impairment'),
    disposalGainRole: text('disposal_gain_role').notNull().default('investment_disposal_gain'),
    disposalLossRole: text('disposal_loss_role').notNull().default('investment_disposal_loss'),

    /**
     * §13 — *"Related-party status and approval are captured where the approved
     * process requires it."* Per type, because "where required" is a business
     * rule and this is where the business states it.
     */
    relatedPartyApprovalRequired: boolean('related_party_approval_required')
      .notNull()
      .default(false),

    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('investment_type_code_not_blank', sql`btrim(${t.code}) <> ''`)],
);

/**
 * The valuation methods Finance has approved — §13, D2.
 *
 * Empty on delivery. A valuation names a method, the method must be here, and
 * nothing in this codebase knows what belongs here.
 */
export const investmentValuationMethod = pgTable(
  'investment_valuation_method',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    /** How often a holding valued this way is reviewed. Finance's number (D2). */
    reviewFrequencyMonths: smallint('review_frequency_months'),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('investment_valuation_method_code_not_blank', sql`btrim(${t.code}) <> ''`),
    check(
      'investment_valuation_method_frequency_positive',
      sql`${t.reviewFrequencyMonths} is null or ${t.reviewFrequencyMonths} > 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 13.2 — proposal and approval
// ---------------------------------------------------------------------------

/**
 * §13 workflow steps 1 and 2. Five fields, then two approvals — three where the
 * type asks for a related-party one.
 *
 * The three approvers are three columns rather than one `approved_by`, because
 * they are three different decisions and §5.2 is about who made which. One
 * column would let a single signature stand for all of them.
 */
export const investmentProposal = pgTable(
  'investment_proposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalNo: text('proposal_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    typeCode: text('type_code')
      .notNull()
      .references(() => investmentType.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** §13 workflow step 1 — the five things a proposal states. */
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currency.code),
    expectedReturn: text('expected_return').notNull(),
    riskAssessment: text('risk_assessment').notNull(),

    counterpartyPartnerId: uuid('counterparty_partner_id').references(() => businessPartner.id),

    /** §13 — related-party status, captured whether or not it gates anything. */
    isRelatedParty: boolean('is_related_party').notNull().default(false),
    relatedPartyNote: text('related_party_note'),

    proposedOn: date('proposed_on').notNull(),

    managementApprovedBy: uuid('management_approved_by').references(() => appUser.id),
    managementApprovedAt: timestamp('management_approved_at', { withTimezone: true }),
    fundingApprovedBy: uuid('funding_approved_by').references(() => appUser.id),
    fundingApprovedAt: timestamp('funding_approved_at', { withTimezone: true }),
    relatedPartyApprovedBy: uuid('related_party_approved_by').references(() => appUser.id),
    relatedPartyApprovedAt: timestamp('related_party_approved_at', { withTimezone: true }),

    rejectedBy: uuid('rejected_by').references(() => appUser.id),
    rejectionReason: text('rejection_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('investment_proposal_no_uniq').on(t.proposalNo),
    index('investment_proposal_type_idx').on(t.typeCode, t.status),
    index('investment_proposal_branch_idx').on(t.branchCode, t.proposedOn),

    check('investment_proposal_amount_positive', sql`${t.amountIqd} > 0`),
    check('investment_proposal_return_stated', sql`btrim(${t.expectedReturn}) <> ''`),
    check('investment_proposal_risk_stated', sql`btrim(${t.riskAssessment}) <> ''`),

    // An approval is a person and a time, or it is neither. Half of one is a
    // record that cannot be audited.
    check(
      'investment_proposal_management_approval_complete',
      sql`(${t.managementApprovedBy} is null) = (${t.managementApprovedAt} is null)`,
    ),
    check(
      'investment_proposal_funding_approval_complete',
      sql`(${t.fundingApprovedBy} is null) = (${t.fundingApprovedAt} is null)`,
    ),
    check(
      'investment_proposal_related_party_approval_complete',
      sql`(${t.relatedPartyApprovedBy} is null) = (${t.relatedPartyApprovedAt} is null)`,
    ),
    check(
      'investment_proposal_rejection_has_reason',
      sql`${t.rejectedBy} is null or coalesce(btrim(${t.rejectionReason}), '') <> ''`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 13.1 / 13.3 — the register entry
// ---------------------------------------------------------------------------

export const investment = pgTable(
  'investment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentNo: text('investment_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    typeCode: text('type_code')
      .notNull()
      .references(() => investmentType.code),

    /** §13 acceptance 1 — an acquisition traces to the proposal that approved it. */
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => investmentProposal.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    description: text('description').notNull(),
    counterpartyPartnerId: uuid('counterparty_partner_id').references(() => businessPartner.id),

    /** §13 — custody information. */
    custodian: text('custodian'),
    custodyAccount: text('custody_account'),

    /** §13 — ownership percentage, where the instrument has one. */
    ownershipPercent: numeric('ownership_percent', { precision: 9, scale: 4 }),

    /** Units held, scale 6. Maintained from acquisitions and disposals. */
    unitsHeld: numeric('units_held', { precision: 24, scale: 6 }).notNull().default('0'),

    /**
     * §13 — *"Foreign-currency investments store transaction currency and
     * base-currency equivalents"* (TECHSTACK A4). Both are stored: the
     * equivalent is what it was worth when it happened, and recomputing it later
     * at a newer rate would restate a transaction that already occurred.
     */
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currency.code),
    costTxn: numeric('cost_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    acquiredOn: date('acquired_on'),
    /** §13.7 — the calendar. All four event kinds live on the register entry. */
    maturityDate: date('maturity_date'),
    nextReviewOn: date('next_review_on'),

    disposedOn: date('disposed_on'),
    closedBy: uuid('closed_by').references(() => appUser.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('investment_no_uniq').on(t.investmentNo),
    // One proposal buys one investment. §13 acceptance 1 makes the proposal the
    // control, and a proposal that could be spent twice is not a control.
    uniqueIndex('investment_proposal_uniq').on(t.proposalId),
    index('investment_type_idx').on(t.typeCode, t.status),
    index('investment_counterparty_idx').on(t.counterpartyPartnerId),
    index('investment_maturity_idx').on(t.maturityDate),
    index('investment_review_idx').on(t.nextReviewOn),

    check('investment_units_not_negative', sql`${t.unitsHeld} >= 0`),
    check('investment_cost_not_negative', sql`${t.costTxn} >= 0 and ${t.costIqd} >= 0`),
    check(
      'investment_ownership_percent_range',
      sql`${t.ownershipPercent} is null or (${t.ownershipPercent} > 0 and ${t.ownershipPercent} <= 100)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 13.3 — acquisition and additional funding
// ---------------------------------------------------------------------------

/**
 * §13 — *"Treasury provides funding and receives proceeds."*
 *
 * Every movement of money into a holding is a row here, so "what did this cost"
 * is a sum of events rather than a figure somebody maintained. A capital call is
 * the same shape as the first acquisition, which is why there is one table and
 * not two.
 */
export const investmentFunding = pgTable(
  'investment_funding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentId: uuid('investment_id')
      .notNull()
      .references(() => investment.id),
    fundingNo: text('funding_no').notNull(),

    kind: text('kind').notNull(),
    fundedOn: date('funded_on').notNull(),

    unitsAcquired: numeric('units_acquired', { precision: 24, scale: 6 }).notNull().default('0'),
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /** §13 — funding flows through Treasury, not a direct journal. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    postedBy: uuid('posted_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('investment_funding_no_uniq').on(t.fundingNo),
    index('investment_funding_investment_idx').on(t.investmentId, t.fundedOn),

    check('investment_funding_amount_positive', sql`${t.amountTxn} > 0 and ${t.amountIqd} > 0`),
    check('investment_funding_units_not_negative', sql`${t.unitsAcquired} >= 0`),
    check('investment_funding_kind', sql`${t.kind} in ('acquisition', 'capital_call')`),
  ],
);

// ---------------------------------------------------------------------------
// 13.4 — income
// ---------------------------------------------------------------------------

/**
 * §13 acceptance 3 — *"Income and disposal trace to bank transactions and
 * supporting documents."*
 *
 * Both halves are NOT NULL. Evidence that is optional is evidence that is
 * missing on the one occasion somebody asks for it, and §13 says *"income and
 * disposal records require source evidence"* without qualification.
 */
export const investmentIncome = pgTable(
  'investment_income',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentId: uuid('investment_id')
      .notNull()
      .references(() => investment.id),
    incomeNo: text('income_no').notNull(),

    /** Free text, not an enum: §13 lists examples, not a closed set. */
    kind: text('kind').notNull(),
    receivedOn: date('received_on').notNull(),

    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /** The bank transaction it traces to. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    /** The supporting document it traces to. */
    evidenceAttachmentId: uuid('evidence_attachment_id')
      .notNull()
      .references(() => attachment.id),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    postedBy: uuid('posted_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('investment_income_no_uniq').on(t.incomeNo),
    index('investment_income_investment_idx').on(t.investmentId, t.receivedOn),

    check('investment_income_amount_positive', sql`${t.amountTxn} > 0 and ${t.amountIqd} > 0`),
    check('investment_income_kind_not_blank', sql`btrim(${t.kind}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 13.5 — valuation and impairment
// ---------------------------------------------------------------------------

/**
 * §13 — *"The system preserves historical valuations; it does not overwrite
 * prior values."*
 *
 * Append-only by construction: there is no `superseded` flag and no update path.
 * The current carrying value is the latest row, which is why `investment` has no
 * carrying-value column to disagree with it.
 *
 * `method_code` points at Finance's catalogue, which is empty until D2. So a
 * valuation cannot be recorded before Finance has said what a valuation is —
 * which is exactly the state §13 describes.
 */
export const investmentValuation = pgTable(
  'investment_valuation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentId: uuid('investment_id')
      .notNull()
      .references(() => investment.id),

    valuedOn: date('valued_on').notNull(),
    methodCode: text('method_code')
      .notNull()
      .references(() => investmentValuationMethod.code),

    valueTxn: numeric('value_txn', { precision: 19, scale: 4 }).notNull(),
    valueIqd: numeric('value_iqd', { precision: 19, scale: 4 }).notNull(),

    /** §13 acceptance 2 — attributable to its approver. */
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),

    basis: text('basis'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
  },
  (t) => [
    // One valuation per holding per date. A second would make "the value on that
    // date" have two answers, and §13's history could not be read.
    uniqueIndex('investment_valuation_date_uniq').on(t.investmentId, t.valuedOn),
    index('investment_valuation_investment_idx').on(t.investmentId, t.valuedOn),

    check('investment_valuation_not_negative', sql`${t.valueTxn} >= 0 and ${t.valueIqd} >= 0`),
  ],
);

/**
 * Impairment, kept apart from valuation for the same reason Phase 12 keeps it
 * apart from depreciation: they reconcile to different accounts and answer
 * different questions.
 *
 * The **trigger and measurement basis are D2's**, so nothing here computes one.
 * A row records that Finance decided an impairment, what it was, and on what
 * basis they say it rests.
 */
export const investmentImpairment = pgTable(
  'investment_impairment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentId: uuid('investment_id')
      .notNull()
      .references(() => investment.id),

    impairedOn: date('impaired_on').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** Why, in Finance's words. Not optional: an impairment without a basis is a write-down nobody can defend. */
    basis: text('basis').notNull(),

    carryingValueBeforeIqd: numeric('carrying_value_before_iqd', {
      precision: 19,
      scale: 4,
    }).notNull(),

    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
  },
  (t) => [
    index('investment_impairment_investment_idx').on(t.investmentId, t.impairedOn),
    check('investment_impairment_amount_positive', sql`${t.amountIqd} > 0`),
    check('investment_impairment_basis_stated', sql`btrim(${t.basis}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 13.6 — disposal
// ---------------------------------------------------------------------------

export const investmentDisposal = pgTable(
  'investment_disposal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentId: uuid('investment_id')
      .notNull()
      .references(() => investment.id),
    disposalNo: text('disposal_no').notNull(),

    disposedOn: date('disposed_on').notNull(),

    unitsDisposed: numeric('units_disposed', { precision: 24, scale: 6 }).notNull(),
    proceedsTxn: numeric('proceeds_txn', { precision: 19, scale: 4 }).notNull(),
    proceedsIqd: numeric('proceeds_iqd', { precision: 19, scale: 4 }).notNull(),

    /** What left with the units, computed at the time and kept. */
    carryingValueDisposedIqd: numeric('carrying_value_disposed_iqd', {
      precision: 19,
      scale: 4,
    }).notNull(),
    /** Positive is a gain. Stored because it is what was posted. */
    realisedResultIqd: numeric('realised_result_iqd', { precision: 19, scale: 4 }).notNull(),

    isFullDisposal: boolean('is_full_disposal').notNull(),

    /** §13 acceptance 3 — traces to the bank and to a document. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    evidenceAttachmentId: uuid('evidence_attachment_id')
      .notNull()
      .references(() => attachment.id),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    postedBy: uuid('posted_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('investment_disposal_no_uniq').on(t.disposalNo),
    index('investment_disposal_investment_idx').on(t.investmentId, t.disposedOn),

    check('investment_disposal_units_positive', sql`${t.unitsDisposed} > 0`),
    check(
      'investment_disposal_proceeds_not_negative',
      sql`${t.proceedsTxn} >= 0 and ${t.proceedsIqd} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 13.7 — the calendar
// ---------------------------------------------------------------------------

/**
 * §13.7's fourth event kind. Maturity, review and document expiry are already
 * dates on the register entry or on the attachment; a capital call is a
 * commitment with its own date and amount, so it needs a row.
 */
export const investmentCapitalCall = pgTable(
  'investment_capital_call',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    investmentId: uuid('investment_id')
      .notNull()
      .references(() => investment.id),

    dueOn: date('due_on').notNull(),
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    /**
     * §A4 — both amounts, like every other money row in this phase. A call is
     * the one place the figure is read by another module (§13.8 feeds the
     * Phase 07.8 forecast), so storing only the transaction amount put a
     * foreign-currency commitment into a dinar forecast at one to one.
     */
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    note: text('note'),

    /** Set when the call is met, by the funding row that met it. */
    fundedById: uuid('funded_by_id').references(() => investmentFunding.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('investment_capital_call_due_idx').on(t.dueOn),
    index('investment_capital_call_investment_idx').on(t.investmentId, t.dueOn),
    check('investment_capital_call_amount_positive', sql`${t.amountTxn} > 0`),
  ],
);
