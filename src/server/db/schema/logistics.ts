/**
 * Logistics Operations — Phase 10 schema, §11.
 *
 * Appendix A, menu 7: *"Client Import Files; Logistics Jobs; Routes; Carriers;
 * Shipping Documents; Client Charges; Direct Costs; Delivery Evidence; Claims;
 * Settlement; Margin Reports."*
 *
 * ── The one structural decision this file exists to make ────────────────────
 * §11: *"A logistics job can be linked to the same client import file as a Money
 * Transfer transaction **without combining their accounting results**."* §2.2,
 * §11.3 and §12.4 say the same thing three more times.
 *
 * A rule stated four times is one somebody expects to be broken. So it is not
 * expressed as a rule here at all — it is expressed as a missing column.
 * `logistics_client_import_file_reference` is the only place the two services meet, and it
 * has no amount, no currency, no debit and no credit. A report cannot net two
 * services across a table that holds no money, and no future developer can add
 * a subtotal to a row that has nothing to subtotal. That is the whole design:
 * the import file is a *reference*, and the schema makes it incapable of being
 * anything else.
 *
 * ── Why Logistics owns the import file ──────────────────────────────────────
 * Appendix A lists *Client Import Files* under menu 7, Logistics. Menu 8, Money
 * Transfer, does not list it; §12.2 refers to the *"Related Client Import File
 * and Logistics Job where the approved process requires it"* — the language of a
 * module pointing at something another module owns. So the table lives here and
 * Phase 09 registers against it, rather than the two phases each keeping half of
 * one identity.
 *
 * ── Why there is no item, quantity or warehouse column anywhere below ───────
 * §11.3: *"Goods imported for a client do not enter company warehouses"* and
 * *"No Sales Invoice is issued for the goods because the company is providing a
 * service rather than selling the goods."* A logistics job that cannot name an
 * item, a quantity or a warehouse cannot move stock however it is called, which
 * is a stronger guarantee than any service-layer check: a column that does not
 * exist beats a rule nobody can forget. `tests/unit/phase10-no-company-inventory
 * .test.ts` asserts the absence, so it stays absent.
 *
 * ── Small vocabularies are text + CHECK, not pgEnum ─────────────────────────
 * Leg status, claim type, carrier mode and the rest are `text` with a CHECK
 * rather than new PostgreSQL types. §3.2's shared `document_status` is a real
 * enum because every module depends on the same values; these are local to
 * Logistics, and a CHECK is altered in a migration without the type-dependency
 * dance an ALTER TYPE requires when a column is already using it.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';
import { businessPartner } from './organisation';
import { bankCashAccount } from './item';
import { currency } from './fiscal';
import { journalEntry } from './journal';
import { attachment } from './attachments';
import { documentStatus } from './workflow';

// ---------------------------------------------------------------------------
// 10.1 Client import files — the shared reference
// ---------------------------------------------------------------------------

/**
 * The client's import consignment, as one identity both services can point at.
 *
 * It is not a document in Appendix B's sense: it has no accounting effect, no
 * posting and no approval route. It is the answer to "which shipment are we
 * talking about?" — which is precisely why a logistics job and a money transfer
 * can both name it without either becoming the other.
 */
export const logisticsClientImportFile = pgTable(
  'logistics_client_import_file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileNo: text('file_no').notNull(),

    /** §11 — the client whose import this is. A customer, never a supplier. */
    clientId: uuid('client_id')
      .notNull()
      .references(() => businessPartner.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** When the file was opened — a business date, not an instant. */
    openedOn: date('opened_on').notNull(),

    /** Where the goods are coming from, for the Import File Status report. */
    originCountry: text('origin_country'),
    description: text('description'),

    /**
     * Open until every service touching the file has finished with it.
     * Deliberately not `document_status`: this is not a document and giving it
     * a document's vocabulary would invite somebody to post it.
     */
    status: text('status').notNull().default('open'),

    closedOn: date('closed_on'),
    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_client_import_file_no_uniq').on(t.fileNo),
    index('logistics_client_import_file_client_idx').on(t.clientId, t.status),
    index('logistics_client_import_file_branch_idx').on(t.branchCode, t.openedOn),

    check('logistics_client_import_file_status', sql`${t.status} in ('open', 'closed')`),
    check(
      'logistics_client_import_file_closed_has_date',
      sql`(${t.status} <> 'closed' and ${t.closedOn} is null)
          or (${t.status} = 'closed' and ${t.closedOn} is not null)`,
    ),
  ],
);

/**
 * A document in some module, declaring that it concerns this import file.
 *
 * **This table holds no money, and that is the point.** §11's *"without
 * combining their accounting results"* is enforced here by omission: there is no
 * amount, no currency, no debit, no credit and no margin column, so no query can
 * net a logistics job against a money transfer no matter how it is written. The
 * cross-reference report (§11.5) reads each service's own figures from that
 * service's own tables and presents them side by side; it has nowhere to add
 * them together even if somebody tried.
 *
 * `module` is free text rather than a check against a fixed list, because Phase
 * 09 has not been built yet and a CHECK naming `money_transfer` would be this
 * phase deciding what that phase calls itself.
 */
export const logisticsClientImportFileReference = pgTable(
  'logistics_client_import_file_reference',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    importFileId: uuid('import_file_id')
      .notNull()
      .references(() => logisticsClientImportFile.id),

    /** 'logistics', 'money_transfer', … — the module that owns the document. */
    module: text('module').notNull(),
    /** The Appendix B document type code, for drill-down (§3.3). */
    documentType: text('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    /** Denormalised so the report can name the document without a join per module. */
    documentNo: text('document_no').notNull(),

    note: text('note'),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => appUser.id),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One document belongs to at most one import file. Two files claiming the
    // same job would make "which shipment is this?" have two answers, and the
    // cross-reference report would double-count the job across both.
    uniqueIndex('logistics_client_import_file_reference_document_uniq').on(t.module, t.documentId),
    index('logistics_client_import_file_reference_file_idx').on(t.importFileId, t.module),

    check('logistics_client_import_file_reference_module', sql`btrim(${t.module}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 10.3 Masters — carriers and routes
// ---------------------------------------------------------------------------

/**
 * A carrier — §11.1's *"Carriers"*, Appendix A's *"Carriers"*.
 *
 * A carrier is paid, so it is a Business Partner in the supplier role rather
 * than a second party master. §4.4 keeps one identity per counterparty: two
 * masters would give the same haulier two ledgers and the A/P subledger would
 * reconcile to neither.
 */
export const logisticsCarrier = pgTable(
  'logistics_carrier',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),

    /** The supplier this carrier is billed as. Its A/P is the company's A/P. */
    businessPartnerId: uuid('business_partner_id')
      .notNull()
      .references(() => businessPartner.id),

    mode: text('mode').notNull(),
    /** Carrier's own reference — SCAC, IATA code, licence number. */
    carrierReference: text('carrier_reference'),

    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('logistics_carrier_partner_idx').on(t.businessPartnerId),
    check(
      'logistics_carrier_mode',
      sql`${t.mode} in ('road', 'rail', 'sea', 'air', 'courier', 'multimodal')`,
    ),
  ],
);

/** A named origin-to-destination corridor. Appendix D filters reports by it. */
export const logisticsRoute = pgTable(
  'logistics_route',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    origin: text('origin').notNull(),
    destination: text('destination').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('logistics_route_endpoints_idx').on(t.origin, t.destination),
    check('logistics_route_endpoints_differ', sql`${t.origin} <> ${t.destination}`),
  ],
);

// ---------------------------------------------------------------------------
// 10.7 Configuration — what each kind of job must prove before it settles
// ---------------------------------------------------------------------------

/**
 * The kind of service a job provides — import clearance, freight forwarding,
 * last-mile delivery.
 *
 * It exists because 10.7 requires that *"a job cannot settle without the
 * delivery evidence its type requires"*, and the blueprint nowhere says what an
 * air-freight job must prove as against a customs-clearance job. That is
 * configuration for the Logistics department, not a constant this phase may pick.
 */
export const logisticsServiceType = pgTable(
  'logistics_service_type',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('logistics_service_type_name', sql`btrim(${t.name}) <> ''`)],
);

/** One evidence type a service type must hold before its jobs may settle. */
export const logisticsServiceTypeEvidence = pgTable(
  'logistics_service_type_evidence',
  {
    serviceTypeCode: text('service_type_code')
      .notNull()
      .references(() => logisticsServiceType.code),
    evidenceType: text('evidence_type').notNull(),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('logistics_service_type_evidence_uniq').on(t.serviceTypeCode, t.evidenceType),
    check('logistics_service_type_evidence_type', sql`btrim(${t.evidenceType}) <> ''`),
  ],
);

/**
 * §11.4 — *"Client Logistics Clearing / Deferred Service Balance **according to
 * document stage**"*.
 *
 * The blueprint names two credit accounts and says the choice depends on the
 * stage the job is at, without saying which stage maps to which. That is an
 * accounting outcome, and §28.1 puts it beyond this phase's reach: choosing here
 * would bury a Finance decision in a `switch` statement.
 *
 * So the mapping is a table, **seeded empty**. Funding cannot post until Finance
 * fills it in, and when they do the accounting changes with no code change —
 * which is §3.3's principle applied one level up, to the choice of line role
 * rather than the choice of account.
 */
export const logisticsFundingStageRole = pgTable(
  'logistics_funding_stage_role',
  {
    /** The job's status at the moment the funding is posted. */
    jobStatus: documentStatus('job_status').primaryKey(),
    /** The posting line role to credit — resolved to an account by §3.3's mapping. */
    lineRole: text('line_role').notNull(),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('logistics_funding_stage_role_role', sql`btrim(${t.lineRole}) <> ''`)],
);

// ---------------------------------------------------------------------------
// 10.2 The logistics job
// ---------------------------------------------------------------------------

/**
 * Appendix B — Logistics Job. Owner: Logistics. Source document: Client Import
 * File. Accounting effect: *"Job cost and service revenue"*.
 *
 * Statuses Draft, Approved, In Progress, Delivered, Settled, Closed, Cancelled,
 * mapped onto §3.2's shared vocabulary in `domain/logistics.ts`. Appendix B gives
 * this document no *Pending Approval* state, so it has none here.
 */
export const logisticsJob = pgTable(
  'logistics_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobNo: text('job_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    /**
     * Appendix B names the Client Import File as this document's source, so the
     * link is required rather than optional. A job with no import file is a job
     * nobody can cross-reference, which is the failure §11 is guarding against.
     */
    importFileId: uuid('import_file_id')
      .notNull()
      .references(() => logisticsClientImportFile.id),

    /** Denormalised from the file so the job's own RLS and reports need no join. */
    clientId: uuid('client_id')
      .notNull()
      .references(() => businessPartner.id),

    serviceTypeCode: text('service_type_code')
      .notNull()
      .references(() => logisticsServiceType.code),
    routeCode: text('route_code').references(() => logisticsRoute.code),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * §2.1 names Logistics as a formal department, and §4.2 makes
     * Department/Cost Centre mandatory on operating expense accounts. The job
     * carries it so every cost posted against the job satisfies that rule from
     * the job's own record rather than from whatever the poster typed.
     */
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),

    jobDate: date('job_date').notNull(),
    promisedDeliveryDate: date('promised_delivery_date'),
    deliveredOn: date('delivered_on'),

    /** The currency the client is charged in. Costs may differ and are converted. */
    currencyCode: text('currency_code')
      .notNull()
      .default('IQD')
      .references(() => currency.code),

    description: text('description'),
    note: text('note'),

    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_job_no_uniq').on(t.jobNo),
    index('logistics_job_file_idx').on(t.importFileId),
    index('logistics_job_client_idx').on(t.clientId, t.status),
    index('logistics_job_branch_idx').on(t.branchCode, t.jobDate),
    index('logistics_job_status_idx').on(t.status, t.jobDate),

    check(
      'logistics_job_approval_complete',
      sql`(${t.approvedBy} is null and ${t.approvedAt} is null)
          or (${t.approvedBy} is not null and ${t.approvedAt} is not null)`,
    ),

    // §5.4 — a cancellation states its reason, or it is not a record of a
    // decision.
    check(
      'logistics_job_cancellation_has_reason',
      sql`(${t.cancelledBy} is null and ${t.cancelledAt} is null)
          or (${t.cancelledBy} is not null and ${t.cancelledAt} is not null
              and coalesce(btrim(${t.cancellationReason}), '') <> '')`,
    ),

    // Delivery is what moves the job to 'Delivered'; a delivery date on a job
    // that has not got there is a claim about the future.
    check(
      'logistics_job_delivered_has_date',
      sql`${t.deliveredOn} is null
          or ${t.status} in ('executed', 'settled', 'closed')`,
    ),
  ],
);

/**
 * One carrier movement within a job — §11.1's *"Routes and Legs"*.
 *
 * Legs, not a single carrier field on the job, because 10.3 requires that *"a
 * job supports multiple legs with distinct carriers"*: an import typically moves
 * sea freight to a port, road haulage inland and a courier for the last mile,
 * and each of those is a separate payable to a separate counterparty.
 */
export const logisticsJobLeg = pgTable(
  'logistics_job_leg',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id, { onDelete: 'cascade' }),
    legNo: integer('leg_no').notNull(),

    carrierCode: text('carrier_code')
      .notNull()
      .references(() => logisticsCarrier.code),

    mode: text('mode').notNull(),
    origin: text('origin').notNull(),
    destination: text('destination').notNull(),

    plannedDeparture: date('planned_departure'),
    plannedArrival: date('planned_arrival'),
    actualDeparture: date('actual_departure'),
    actualArrival: date('actual_arrival'),

    /** Waybill, bill of lading or consignment note — §11.1's shipping documents. */
    transportDocumentNo: text('transport_document_no'),

    status: text('status').notNull().default('planned'),
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_job_leg_no_uniq').on(t.jobId, t.legNo),
    index('logistics_job_leg_carrier_idx').on(t.carrierCode, t.status),

    check(
      'logistics_job_leg_status',
      sql`${t.status} in ('planned', 'in_transit', 'completed', 'cancelled')`,
    ),
    check(
      'logistics_job_leg_mode',
      sql`${t.mode} in ('road', 'rail', 'sea', 'air', 'courier', 'multimodal')`,
    ),
    check('logistics_job_leg_endpoints_differ', sql`${t.origin} <> ${t.destination}`),
    // A completed leg is one that arrived. Carrier performance is measured off
    // this column, so a leg that completes without one would silently drop out
    // of the numerator and flatter the carrier.
    check(
      'logistics_job_leg_completed_has_arrival',
      sql`${t.status} <> 'completed' or ${t.actualArrival} is not null`,
    ),
    check(
      'logistics_job_leg_arrival_after_departure',
      sql`${t.actualDeparture} is null or ${t.actualArrival} is null
          or ${t.actualArrival} >= ${t.actualDeparture}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 10.4 Client charges and funding
// ---------------------------------------------------------------------------

/**
 * What the client is charged for the service — §11.3's *"logistics service
 * charge"*, the figure job margin is measured against.
 *
 * A charge is an agreement, not a posting. Nothing reaches the ledger until the
 * settlement recognises it (§11.4's recognition row), because revenue recognises
 * *"on service completion"* and a charge agreed in week one is not evidence that
 * anything was done.
 */
export const logisticsClientCharge = pgTable(
  'logistics_client_charge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    chargeType: text('charge_type').notNull(),
    description: text('description').notNull(),

    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currency.code),

    /** Set when a settlement carries this charge into revenue. Null until then. */
    settlementId: uuid('settlement_id'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_client_charge_line_uniq').on(t.jobId, t.lineNo),
    index('logistics_client_charge_settlement_idx').on(t.settlementId),

    check('logistics_client_charge_amount_positive', sql`${t.amount} > 0`),
    check(
      'logistics_client_charge_type',
      sql`${t.chargeType} in ('freight', 'customs', 'handling', 'documentation', 'storage', 'other')`,
    ),
  ],
);

/**
 * Money the client puts in against a job — §11.3's *"Logistics charges paid by
 * the client are added to the client account **from the Logistics module**"*.
 *
 * §11.4: *Dr Bank, Cash or Client Account / Cr Client Logistics Clearing or
 * Deferred Service Balance according to document stage.* The debit side is
 * `receivedVia`; the credit side comes from `logistics_funding_stage_role`,
 * which Finance configures.
 */
export const logisticsClientFunding = pgTable(
  'logistics_client_funding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fundingNo: text('funding_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    fundingDate: date('funding_date').notNull(),

    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currency.code),

    /** §11.4's debit side: Bank, Cash or the client's own account. */
    receivedVia: text('received_via').notNull(),
    bankCashAccountId: uuid('bank_cash_account_id').references(() => bankCashAccount.id),

    /**
     * The role the credit resolved to, copied from the stage mapping at the
     * moment of posting.
     *
     * Stored rather than recomputed: the mapping is configuration and Finance
     * may change it, and a posted document must still be able to say which rule
     * it was posted under (§24's drill-down, §5.5's configuration review).
     */
    clearingRole: text('clearing_role'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),

    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_client_funding_no_uniq').on(t.fundingNo),
    index('logistics_client_funding_job_idx').on(t.jobId, t.status),
    index('logistics_client_funding_branch_idx').on(t.branchCode, t.fundingDate),

    check('logistics_client_funding_amount_positive', sql`${t.amount} > 0`),
    check(
      'logistics_client_funding_received_via',
      sql`${t.receivedVia} in ('bank', 'cash', 'client_account')`,
    ),
    // Bank and cash are held in a bank/cash account; a client-account transfer
    // moves an existing balance and touches no account of the company's.
    check(
      'logistics_client_funding_account_matches_method',
      sql`(${t.receivedVia} in ('bank', 'cash') and ${t.bankCashAccountId} is not null)
          or (${t.receivedVia} = 'client_account' and ${t.bankCashAccountId} is null)`,
    ),
    check(
      'logistics_client_funding_posted_complete',
      sql`(${t.postedBy} is null and ${t.postedAt} is null and ${t.journalEntryId} is null
           and ${t.clearingRole} is null)
          or (${t.postedBy} is not null and ${t.postedAt} is not null
              and ${t.journalEntryId} is not null and ${t.clearingRole} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 10.5 Third-party cost
// ---------------------------------------------------------------------------

/**
 * A direct third-party expense on a job — §11.4's *Dr Logistics Job Cost / Cr
 * Bank or Supplier A/P*.
 *
 * Appendix C, Logistics direct cost: **"Job link mandatory."** Enforced as a
 * NOT NULL foreign key rather than a service check, because §11.3's *"The
 * company does not absorb logistics costs"* is exactly the rule that erodes when
 * somebody is in a hurry: a cost with nowhere to go finds an overhead account.
 * Here it has nowhere to go *at all* — the row cannot be written.
 */
export const logisticsJobCost = pgTable(
  'logistics_job_cost',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    costNo: text('cost_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    /** Appendix C — mandatory. Not nullable, in any state, ever. */
    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id),

    /** Which leg incurred it, where the cost is a carrier's. Optional: customs
     *  duty and documentation belong to the job, not to a movement. */
    legId: uuid('leg_id').references(() => logisticsJobLeg.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    costDate: date('cost_date').notNull(),
    costType: text('cost_type').notNull(),
    description: text('description').notNull(),

    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    currencyCode: text('currency_code')
      .notNull()
      .references(() => currency.code),

    /** §11.4's credit side: paid straight from the bank, or accrued to A/P. */
    settlementMode: text('settlement_mode').notNull(),
    bankCashAccountId: uuid('bank_cash_account_id').references(() => bankCashAccount.id),
    supplierId: uuid('supplier_id').references(() => businessPartner.id),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),

    supplierReference: text('supplier_reference'),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_job_cost_no_uniq').on(t.costNo),
    index('logistics_job_cost_job_idx').on(t.jobId, t.status),
    index('logistics_job_cost_leg_idx').on(t.legId),
    index('logistics_job_cost_supplier_idx').on(t.supplierId, t.status),
    index('logistics_job_cost_branch_idx').on(t.branchCode, t.costDate),

    check('logistics_job_cost_amount_positive', sql`${t.amount} > 0`),
    check(
      'logistics_job_cost_settlement_mode',
      sql`${t.settlementMode} in ('bank', 'supplier_payable')`,
    ),
    // Exactly one counterparty, decided by how the cost is settled. Both would
    // make the credit side ambiguous; neither would make it unpostable.
    check(
      'logistics_job_cost_counterparty_matches_mode',
      sql`(${t.settlementMode} = 'bank'
             and ${t.bankCashAccountId} is not null and ${t.supplierId} is null)
          or (${t.settlementMode} = 'supplier_payable'
             and ${t.supplierId} is not null and ${t.bankCashAccountId} is null)`,
    ),
    check(
      'logistics_job_cost_type',
      sql`${t.costType} in ('freight', 'customs_duty', 'clearance', 'handling', 'storage',
                            'insurance', 'documentation', 'other')`,
    ),
    check(
      'logistics_job_cost_posted_complete',
      sql`(${t.postedBy} is null and ${t.postedAt} is null and ${t.journalEntryId} is null)
          or (${t.postedBy} is not null and ${t.postedAt} is not null
              and ${t.journalEntryId} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 10.7 Delivery evidence and claims
// ---------------------------------------------------------------------------

/**
 * Proof that the goods reached the client — §11.1's *"Proof of Delivery"*.
 *
 * The document itself is held by the Phase 01 attachment service, which already
 * carries versioning, malware scanning, access logging and retention (§21). This
 * table records *that* a required kind of evidence exists and points at it; it
 * does not store files, because a second file store would be a second set of
 * retention rules.
 */
export const logisticsDeliveryEvidence = pgTable(
  'logistics_delivery_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id, { onDelete: 'cascade' }),

    /** Matches an evidence type the service type requires (or an extra one). */
    evidenceType: text('evidence_type').notNull(),

    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachment.id),

    receivedOn: date('received_on').notNull(),
    note: text('note'),

    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_delivery_evidence_uniq').on(t.jobId, t.evidenceType),
    index('logistics_delivery_evidence_attachment_idx').on(t.attachmentId),
    check('logistics_delivery_evidence_type', sql`btrim(${t.evidenceType}) <> ''`),
  ],
);

/**
 * A delivery exception — §11.1's *"Claims and Exceptions"*, reported by §11.5's
 * Delivery Exceptions report.
 *
 * **A claim posts nothing.** Appendix C has no row for one, and what a claim
 * does to the ledger — provision, receivable against the carrier, reduction of
 * the client charge — is an accounting outcome §28.1 reserves to the Business
 * Process Owner. `estimatedAmount` is a note of exposure for the report, which
 * is why it is nullable and why no journal link exists to fill in. Recorded as
 * Q10-4.
 */
export const logisticsClaim = pgTable(
  'logistics_claim',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    claimNo: text('claim_no').notNull(),

    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id),
    legId: uuid('leg_id').references(() => logisticsJobLeg.id),

    claimType: text('claim_type').notNull(),
    status: text('status').notNull().default('open'),

    raisedOn: date('raised_on').notNull(),
    description: text('description').notNull(),

    /** Exposure, for the exceptions report. Never posted — see the note above. */
    estimatedAmount: numeric('estimated_amount', { precision: 19, scale: 4 }),
    currencyCode: text('currency_code').references(() => currency.code),

    resolution: text('resolution'),
    resolvedBy: uuid('resolved_by').references(() => appUser.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),

    raisedBy: uuid('raised_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_claim_no_uniq').on(t.claimNo),
    index('logistics_claim_job_idx').on(t.jobId, t.status),
    index('logistics_claim_leg_idx').on(t.legId),

    check(
      'logistics_claim_type',
      sql`${t.claimType} in ('damage', 'loss', 'delay', 'shortage', 'documentation', 'other')`,
    ),
    check(
      'logistics_claim_status',
      sql`${t.status} in ('open', 'under_review', 'resolved', 'rejected')`,
    ),
    check(
      'logistics_claim_amount_positive',
      sql`${t.estimatedAmount} is null or ${t.estimatedAmount} > 0`,
    ),
    // An amount without a currency is a number, not money (§14.5).
    check(
      'logistics_claim_amount_has_currency',
      sql`(${t.estimatedAmount} is null) = (${t.currencyCode} is null)`,
    ),
    check(
      'logistics_claim_resolution_complete',
      sql`(${t.status} in ('open', 'under_review')
             and ${t.resolvedBy} is null and ${t.resolvedAt} is null)
          or (${t.status} in ('resolved', 'rejected')
             and ${t.resolvedBy} is not null and ${t.resolvedAt} is not null
             and coalesce(btrim(${t.resolution}), '') <> '')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 10.8 Settlement
// ---------------------------------------------------------------------------

/**
 * Service completion and recognition — §11.4's third row: *Dr Client Logistics
 * Clearing / Client A/R, Cr Logistics Revenue.*
 *
 * This is where logistics revenue reaches the ledger, and the only place it
 * does. Appendix C: *"Logistics service recognition … **Separate from Money
 * Transfer margin**"* — kept separate by the line role it posts under, which
 * resolves through §3.3's mapping to a logistics revenue account that no money
 * transfer event names.
 *
 * The split between clearing and receivable is `splitRecognition` in
 * `domain/logistics.ts`, and the CHECK below makes the two halves add back to
 * the whole so no rounding or hand-edit can lose money between them.
 */
export const logisticsJobSettlement = pgTable(
  'logistics_job_settlement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    settlementNo: text('settlement_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    jobId: uuid('job_id')
      .notNull()
      .references(() => logisticsJob.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    settlementDate: date('settlement_date').notNull(),

    recognisedAmount: numeric('recognised_amount', { precision: 19, scale: 4 }).notNull(),
    /** Discharged against client funding already held. */
    fromClearingAmount: numeric('from_clearing_amount', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    /** Billed to the client — §11.4's Client A/R leg. */
    fromReceivableAmount: numeric('from_receivable_amount', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    currencyCode: text('currency_code')
      .notNull()
      .references(() => currency.code),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),

    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('logistics_job_settlement_no_uniq').on(t.settlementNo),
    index('logistics_job_settlement_job_idx').on(t.jobId, t.status),
    index('logistics_job_settlement_branch_idx').on(t.branchCode, t.settlementDate),

    check('logistics_job_settlement_amount_positive', sql`${t.recognisedAmount} > 0`),
    check(
      'logistics_job_settlement_split_non_negative',
      sql`${t.fromClearingAmount} >= 0 and ${t.fromReceivableAmount} >= 0`,
    ),
    // The two debits are the whole credit. Money cannot leak between them.
    check(
      'logistics_job_settlement_split_totals',
      sql`${t.fromClearingAmount} + ${t.fromReceivableAmount} = ${t.recognisedAmount}`,
    ),
    check(
      'logistics_job_settlement_posted_complete',
      sql`(${t.postedBy} is null and ${t.postedAt} is null and ${t.journalEntryId} is null)
          or (${t.postedBy} is not null and ${t.postedAt} is not null
              and ${t.journalEntryId} is not null)`,
    ),
  ],
);
