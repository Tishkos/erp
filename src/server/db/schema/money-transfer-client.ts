/**
 * Money Transfer client accounts and KYC — Phase 09.1, §12 and §21.
 *
 * ── The client account holds no client details ──────────────────────────────
 * §6: *"one record serves CRM, Sales, Finance, Projects, Logistics and Money
 * Transfer"*, and §3.1 requires *"one authoritative record and a unique system
 * identifier"*. So this table has no name, no address, no phone and no tax
 * identifier: every one of them lives on `business_partner`, and a column here
 * would be a second answer to a question that must have one. The 09.1 gate —
 * *"a client account uses the central Business Partner record, not a
 * module-local copy"* — is met by the columns that are absent, which is a
 * stronger guarantee than a rule saying not to fill them in.
 *
 * ── What a client account is ────────────────────────────────────────────────
 * §12.3: *"The client account remains open until the client confirms that
 * funding is complete and specifies the amount to transfer."* It is therefore
 * one funding cycle — the case a client opens, pays into over days, and then
 * closes by naming the amount to send. A partner has as many over time as they
 * have transfers.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner } from './organisation';
import { documentStatus } from './workflow';
import { attachment } from './attachments';

// ---------------------------------------------------------------------------
// 09.1 — the client account
// ---------------------------------------------------------------------------

export const moneyTransferClientAccount = pgTable(
  'money_transfer_client_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountNo: text('account_no').notNull(),

    /**
     * §12.2 — *"Client Business Partner and client account."* The partner is the
     * client; this row is their funding cycle. Not nullable and not duplicated.
     */
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartner.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * Mapped onto §3.2's shared vocabulary:
     *
     *   draft      Open — deposits may be made, rates and details are editable
     *   approved   Funding confirmed — the client has said the amount to transfer
     *   closed     Closed — the cycle is finished and the balance is settled
     *   cancelled  Opened in error; nothing was ever deposited
     */
    status: documentStatus('status').notNull().default('draft'),

    openedOn: date('opened_on').notNull(),

    /**
     * §12.3 — the two halves of "funding is complete" are one act: the client
     * confirms, and in confirming names the amount. The CHECK below keeps them
     * together, so an account can never be confirmed without an amount or carry
     * an amount nobody confirmed.
     */
    fundingConfirmedAt: timestamp('funding_confirmed_at', { withTimezone: true }),
    fundingConfirmedBy: uuid('funding_confirmed_by').references(() => appUser.id),
    confirmedTransferAmountIqd: numeric('confirmed_transfer_amount_iqd', {
      precision: 19,
      scale: 4,
    }),

    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => appUser.id),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('money_transfer_client_account_no_uniq').on(t.accountNo),
    index('money_transfer_client_account_partner_idx').on(t.partnerId, t.status),
    index('money_transfer_client_account_branch_idx').on(t.branchCode, t.openedOn),

    // §12.3 — confirmation and the amount arrive together or not at all.
    check(
      'money_transfer_client_account_confirmation_complete',
      sql`(${t.fundingConfirmedAt} is null and ${t.fundingConfirmedBy} is null
           and ${t.confirmedTransferAmountIqd} is null)
          or (${t.fundingConfirmedAt} is not null and ${t.fundingConfirmedBy} is not null
              and ${t.confirmedTransferAmountIqd} is not null
              and ${t.confirmedTransferAmountIqd} > 0)`,
    ),

    // 09.2 gate — "the account cannot be closed while the client has not
    // confirmed funding complete". Expressed here rather than in a service
    // because a service check can be bypassed and a CHECK cannot.
    check(
      'money_transfer_client_account_close_needs_confirmation',
      sql`${t.status} <> 'closed' or ${t.fundingConfirmedAt} is not null`,
    ),

    check(
      'money_transfer_client_account_closed_complete',
      sql`(${t.closedAt} is null and ${t.closedBy} is null)
          or (${t.closedAt} is not null and ${t.closedBy} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 09.1 — KYC
// ---------------------------------------------------------------------------

/**
 * Appendix E cites the FATF MVTS guidance; §26 gate 5 makes legal/compliance
 * sign-off a go-live condition, and the register carries it as **D9**.
 *
 * The bands themselves — what "high risk" means, and what it obliges — are
 * Compliance's to define (§28.1). This table is the mechanism and is seeded
 * **empty**, exactly as `partner_role_required_field` is: building the catalogue
 * is engineering, filling it is a compliance decision, and an implementation
 * team that pre-filled it would have chosen a control regime nobody approved.
 */
export const kycRiskRating = pgTable(
  'kyc_risk_rating',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** Ordering for reports; higher is riskier. Compliance sets the scale. */
    severity: numeric('severity', { precision: 5, scale: 0 }).notNull().default('0'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [check('kyc_risk_rating_code_present', sql`btrim(${t.code}) <> ''`)],
);

/**
 * Which documents a client must produce — the risk-based part of Appendix E.
 *
 * Seeded empty for the same reason as the ratings above. `risk_rating_code` null
 * means "every client, whatever their rating"; a rating narrows the requirement
 * to that band. Compliance can therefore express both a baseline and an
 * escalation without a code change, which is what "risk-based" means.
 */
export const kycRequiredDocument = pgTable(
  'kyc_required_document',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    riskRatingCode: text('risk_rating_code').references(() => kycRiskRating.code),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    index('kyc_required_document_rating_idx').on(t.riskRatingCode),
    check('kyc_required_document_code_present', sql`btrim(${t.code}) <> ''`),
  ],
);

/**
 * §21 — *"KYC/compliance records are linked to the business partner and relevant
 * Money Transfer cases."*
 *
 * Linked to the **partner**, not to the account: a client who has been
 * identified once has been identified for every case they open. The 09.1 gate
 * asks for it to be visible from both, which is a join rather than a second row.
 *
 * Renewal supersedes rather than overwrites — the same shape `exchange_rate`
 * uses — because the question "was this client identified when that transfer
 * went out?" has to stay answerable after the record is renewed.
 */
export const clientKycRecord = pgTable(
  'client_kyc_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartner.id),

    /** draft → submitted → approved | rejected. §3.2's vocabulary. */
    status: documentStatus('status').notNull().default('draft'),

    riskRatingCode: text('risk_rating_code').references(() => kycRiskRating.code),

    /** Inclusive. Null means Compliance set no expiry on this record. */
    expiresOn: date('expires_on'),

    reviewedBy: uuid('reviewed_by').references(() => appUser.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    /** Set when a renewal replaces this record. Never deleted (§1.1). */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references((): any => clientKycRecord.id),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live approved record per partner. Superseded and rejected rows stay,
    // so resolution is unambiguous without losing the history.
    uniqueIndex('client_kyc_record_current_uniq')
      .on(t.partnerId)
      .where(sql`status = 'approved' and superseded_at is null`),
    index('client_kyc_record_partner_idx').on(t.partnerId, t.status),
    index('client_kyc_record_expiry_idx').on(t.expiresOn).where(sql`status = 'approved'`),

    check(
      'client_kyc_record_approval_complete',
      sql`(${t.approvedAt} is null and ${t.approvedBy} is null)
          or (${t.approvedAt} is not null and ${t.approvedBy} is not null)`,
    ),
    // §5.4 — a refusal that does not say why cannot be answered or appealed.
    check(
      'client_kyc_record_rejection_has_reason',
      sql`${t.status} <> 'rejected' or coalesce(btrim(${t.rejectionReason}), '') <> ''`,
    ),
    check(
      'client_kyc_record_approved_not_rejected',
      sql`${t.status} <> 'approved' or ${t.rejectionReason} is null`,
    ),
  ],
);

/**
 * One produced document against one requirement — the 09.1 gate's *"attach
 * through the Phase 01 attachment service with correct classification"*.
 *
 * The file itself is an `attachment` row uploaded through the Phase 01 service,
 * so scanning, versioning, retention and the access log all apply without a
 * second implementation (§24). The classification is this row: it says which
 * requirement the file answers. A file with no requirement is not a KYC
 * document, and `required_document_code` being NOT NULL is what says so.
 */
export const clientKycDocument = pgTable(
  'client_kyc_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kycRecordId: uuid('kyc_record_id')
      .notNull()
      .references(() => clientKycRecord.id, { onDelete: 'cascade' }),
    requiredDocumentCode: text('required_document_code')
      .notNull()
      .references(() => kycRequiredDocument.code),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachment.id),

    providedOn: date('provided_on').notNull(),
    /** Passports expire; so does the evidence they gave. */
    expiresOn: date('expires_on'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live file per requirement per record: two passports on one record
    // means nobody can say which was checked.
    uniqueIndex('client_kyc_document_requirement_uniq').on(t.kycRecordId, t.requiredDocumentCode),
    index('client_kyc_document_attachment_idx').on(t.attachmentId),
    check(
      'client_kyc_document_expiry_after_provision',
      sql`${t.expiresOn} is null or ${t.expiresOn} >= ${t.providedOn}`,
    ),
  ],
);
