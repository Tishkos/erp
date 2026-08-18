/**
 * Client-funded import and Client Inventory — Phase 09.10, §12.4 and §11.3.
 *
 * ── Client Inventory is not a warehouse ─────────────────────────────────────
 * §11.3: *"Goods imported for a client do not enter company warehouses"*;
 * *"Goods remain in a financial intermediary account, Client Inventory, until
 * delivery to the client"*; *"No Sales Invoice is issued for the goods because
 * the company is providing a service rather than selling the goods."* §12.4
 * repeats all three.
 *
 * So there is **no item code, no warehouse code and no quantity column anywhere
 * in this file**, and that absence is the enforcement. Routing client goods
 * through the Phase 04 inventory ledger would create company inventory
 * quantities that §11.3 and §12.4 both prohibit, and a rule saying "do not" can
 * be forgotten by the next person adding a feature; a column that does not exist
 * cannot be filled in by accident. The 09.10 gate asks that a client-funded
 * import create *zero* company inventory quantity — there is no mechanism here
 * by which it could create any.
 *
 * The three stages of §12.4's client-funded import table:
 *
 * | Stage | Debit | Credit |
 * |---|---|---|
 * | Client deposit | Company Bank Account | Client Clearing | (09.2, not here) |
 * | Payment for client goods | Client Inventory | Company Bank Account |
 * | Delivery and financial settlement | Client Account | Client Inventory |
 */
import { sql } from 'drizzle-orm';
import {
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
import { journalEntry } from './journal';
import { bankCashAccount } from './item';
import { moneyTransferClientAccount } from './money-transfer-client';

/**
 * §12.2 — *"Related Client Import File and Logistics Job where the approved
 * process requires it."*
 *
 * The file is the case: one client, one consignment, the payments made for it
 * and the settlement that hands it over. **One register serves both services**
 * (D16, answered 2026-08-18), because §11 opens by saying a logistics job can be
 * linked to *the same* client import file as a money transfer. The Logistics Job
 * names this file; the money transfer names this file; neither needs a copy.
 *
 * §11.3 and §12.4 both insist Money Transfer and Logistics keep separate revenue,
 * expenses and margin even on the same consignment. Nothing in this file records
 * a figure from either service — sharing the case does not share the ledger.
 *
 * `clientId` is the business partner both services know. `clientAccountId` is
 * the Money Transfer client account, and is null on a file that is only ever a
 * logistics job; where it is set, a trigger requires it to belong to `clientId`.
 */
export const clientImportFile = pgTable(
  'client_import_file',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileNo: text('file_no').notNull(),

    /** The business partner. Both services know the client by this. */
    clientId: uuid('client_id')
      .notNull()
      .references(() => businessPartner.id),

    /**
     * Null on a file that never involves a transfer. Where it is set,
     * `client_import_file_account_matches_client` requires its partner to be
     * `clientId` — a file naming one client and its money another would compute
     * §12.4's Remaining Client Balance against a stranger.
     */
    clientAccountId: uuid('client_account_id').references(() => moneyTransferClientAccount.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     *   draft   Opened
     *   posted  Goods paid for; a Client Inventory balance is outstanding
     *   settled Delivered and settled; the Client Inventory balance is zero
     *   closed  Closed
     */
    status: documentStatus('status').notNull().default('draft'),

    openedOn: date('opened_on').notNull(),

    /** Where the goods are coming from, for the Import File Status report. */
    originCountry: text('origin_country'),
    description: text('description'),
    note: text('note'),

    /** The business date it closed on — §18-style dates, never an instant. */
    closedOn: date('closed_on'),
    closedBy: uuid('closed_by').references(() => appUser.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('client_import_file_no_uniq').on(t.fileNo),
    index('client_import_file_account_idx').on(t.clientAccountId, t.status),
    index('client_import_file_client_idx').on(t.clientId, t.status),

    // Phase 10's rule, kept: a closed file states the business date it closed on.
    check(
      'client_import_file_closed_has_date',
      sql`(${t.status} <> 'closed' and ${t.closedOn} is null)
          or (${t.status} = 'closed' and ${t.closedOn} is not null)`,
    ),
  ],
);

/**
 * §12.4 — *"Payment for client goods: Dr Client Inventory / Cr Company Bank
 * Account."*
 *
 * Appendix C adds *"No company warehouse quantity"*. The document therefore
 * records an amount and a payee and nothing else: there is no line table, because
 * a line table would want an item and a quantity, and wanting them is how the
 * prohibition erodes.
 */
export const clientImportPayment = pgTable(
  'client_import_payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentNo: text('payment_no').notNull(),

    clientImportFileId: uuid('client_import_file_id')
      .notNull()
      .references(() => clientImportFile.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    status: documentStatus('status').notNull().default('draft'),

    paymentDate: date('payment_date').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /** Who the company paid on the client's behalf. */
    supplierPartnerId: uuid('supplier_partner_id').references(() => businessPartner.id),
    supplierReference: text('supplier_reference'),

    companyBankAccountId: uuid('company_bank_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('client_import_payment_no_uniq').on(t.paymentNo),
    index('client_import_payment_file_idx').on(t.clientImportFileId, t.status),
    index('client_import_payment_date_idx').on(t.paymentDate, t.branchCode),

    check('client_import_payment_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'client_import_payment_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

/**
 * §12.4 — *"Delivery and financial settlement: Dr Client Account / Cr Client
 * Inventory."*
 *
 * Appendix C: *"No Sales Invoice."* There is none to issue: the company never
 * owned the goods, so there is no sale to invoice — only the client's account
 * being charged for what was bought on their behalf. This document is what
 * clears Client Inventory back to zero, which the 09.10 gate requires it to do.
 */
export const clientGoodsDelivery = pgTable(
  'client_goods_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryNo: text('delivery_no').notNull(),

    clientImportFileId: uuid('client_import_file_id')
      .notNull()
      .references(() => clientImportFile.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    status: documentStatus('status').notNull().default('draft'),

    deliveryDate: date('delivery_date').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** What was handed over, in words. Not a quantity, and not an item. */
    goodsDescription: text('goods_description'),
    receivedBy: text('received_by'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('client_goods_delivery_no_uniq').on(t.deliveryNo),
    index('client_goods_delivery_file_idx').on(t.clientImportFileId, t.status),
    check('client_goods_delivery_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'client_goods_delivery_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);
