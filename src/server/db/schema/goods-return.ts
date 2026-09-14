/**
 * Goods Return and Supplier Credit Memo — Phase 05.7, §8.7.
 *
 * > §8.2: *"Purchase return: A/P Invoice → Goods Return → Supplier Credit
 * > Memo."*
 * > §8.7: *"Returned goods do not support replacement. A replacement requires a
 * > new Purchase Order."*
 *
 * **There is no replacement mechanism here, and that is the design.** Not a
 * flag left unset, not a route left unbuilt — no column, no status, no service
 * function anywhere in this flow mentions replacement. A replacement is a new
 * purchase: a new order, a new commitment, a new receipt, a new price. Letting a
 * return quietly turn into one would leave goods arriving against a purchase
 * order that was never raised and never approved, which is the whole of what
 * §8.3's approval exists to prevent.
 *
 * **A return line names the receipt line it came from.** That is what makes
 * *"quantity cannot exceed available return quantity"* (Appendix C) a question
 * with an answer: available is what that receipt brought in, less what has
 * already gone back. It is also what identifies the cost layer, so inventory is
 * credited with what the supplier actually charged rather than with whatever
 * FIFO would have relieved next.
 *
 * **Return Clearing sits between the two documents.** Appendix C: *Goods Return
 * — Dr Return Clearing / Cr Inventory*. The stock has left, but the supplier
 * has not yet agreed to credit it; the clearing account is that gap, and it is
 * emptied by the credit memo (Dr Supplier A/P / Cr Return Clearing). An ageing
 * of that account answers "what have we sent back and not been credited for?",
 * which is a question every A/P department asks and few systems can answer.
 */
import { sql } from 'drizzle-orm';
import {
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
import { appUser, branch } from './platform';
import { businessPartner } from './organisation';
import { warehouse } from './organisation';
import { bankCashAccount, item, unitOfMeasure } from './item';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { costLayer, inventoryMovement } from './inventory';
import { goodsReceipt, goodsReceiptLine } from './goods-receipt';
import { apInvoice, apInvoiceLine } from './ap-invoice';

export const goodsReturn = pgTable(
  'goods_return',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    returnNo: text('return_no').notNull(),

    /**
     * Appendix B: Draft, Approved, Shipped, Posted, Closed — mapped onto §3.2:
     *
     *   draft      Draft
     *   submitted  awaiting approval
     *   approved   Approved — agreed, nothing has moved
     *   posted     Shipped and Posted — the stock has left and the ledger says so
     *   closed     Closed — the credit memo has landed
     *   reversed   the return itself was wrong
     */
    status: documentStatus('status').notNull().default('draft'),

    /**
     * §8.2 — the return follows the invoice. Nullable only for the case §8.7
     * allows implicitly: goods rejected at inspection before anybody has been
     * invoiced for them, where there is no invoice to link to yet.
     */
    apInvoiceId: uuid('ap_invoice_id').references(() => apInvoice.id),

    /** Which delivery the goods came from — the source of the available quantity. */
    /**
     * Null when the return is against a Purchase Invoice that booked the stock
     * itself — Operations block 4 — and no receipt was ever raised.
     */
    goodsReceiptId: uuid('goods_receipt_id')
      .references(() => goodsReceipt.id),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    returnDate: date('return_date').notNull(),

    /**
     * Which side the debit lands on — block 10's *"Offset Account (Accounts
     * Payable or Bank — one must be selected)"*. Goods going back either shrink
     * what the company owes the supplier, or the supplier refunds the money and
     * it arrives in a bank.
     */
    offsetKind: text('offset_kind').notNull(),
    /** Set when — and only when — `offsetKind` is 'bank'. */
    offsetBankAccountId: uuid('offset_bank_account_id').references(() => bankCashAccount.id),

    /**
     * §5.4 — why the goods are going back. Not nullable: a return with no
     * reason is a dispute nobody can settle, and the supplier will ask.
     */
    reason: text('reason').notNull(),
    /** The supplier's authorisation number, where they issue one. */
    supplierReference: text('supplier_reference'),

    /** Appendix C — Dr Return Clearing / Cr Inventory, when it ships. */
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
    uniqueIndex('goods_return_no_uniq').on(t.returnNo),
    index('goods_return_supplier_idx').on(t.supplierId, t.status),
    index('goods_return_receipt_idx').on(t.goodsReceiptId),
    index('goods_return_invoice_idx').on(t.apInvoiceId),

    check('goods_return_reason_not_blank', sql`coalesce(btrim(${t.reason}), '') <> ''`),
    check(
      'goods_return_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
    // One offset must be selected, and only one can be.
    check(
      'goods_return_offset_one_of',
      sql`${t.offsetKind} in ('payable', 'bank')
          and (${t.offsetKind} = 'bank') = (${t.offsetBankAccountId} is not null)`,
    ),
    // A return names the delivery it came in on, the invoice it credits, or
    // both — never neither.
    check(
      'goods_return_has_a_source',
      sql`${t.goodsReceiptId} is not null or ${t.apInvoiceId} is not null`,
    ),
  ],
);

export const goodsReturnLine = pgTable(
  'goods_return_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goodsReturnId: uuid('goods_return_id')
      .notNull()
      .references(() => goodsReturn.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /**
     * The receipt line these goods arrived on. Not nullable: it decides the
     * available quantity, the cost layer and therefore the money.
     */
    /** Null when the invoice line below is the whole source. */
    goodsReceiptLineId: uuid('goods_receipt_line_id')
      .references(() => goodsReceiptLine.id),

    /** The invoice line being credited, where the goods were invoiced. */
    apInvoiceLineId: uuid('ap_invoice_line_id').references(() => apInvoiceLine.id),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),

    /**
     * The layer the goods are taken from, and what they cost.
     *
     * Stored rather than derived because the layer is chosen when the return
     * ships and the credit memo is matched against it later — a derived answer
     * could change in between if the layer were consumed elsewhere.
     */
    costLayerId: uuid('cost_layer_id').references(() => costLayer.id),
    costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /** The outward stock movement, written when the return ships. */
    movementId: uuid('movement_id').references(() => inventoryMovement.id),
  },
  (t) => [
    uniqueIndex('goods_return_line_no_uniq').on(t.goodsReturnId, t.lineNo),
    index('goods_return_line_receipt_line_idx').on(t.goodsReceiptLineId),
    check('goods_return_line_quantity_positive', sql`${t.quantity} > 0`),
    // At least one source. A line naming neither has no cost layer behind it
    // and no remaining quantity to check against.
    check(
      'goods_return_line_one_source',
      sql`(${t.goodsReceiptLineId} is not null)::int + (${t.apInvoiceLineId} is not null)::int >= 1`,
    ),
  ],
);

/**
 * §8.2 — the Supplier Credit Memo, which closes the loop.
 *
 * Links to **both** the Goods Return and the original A/P Invoice, which is the
 * 05.7 gate's own requirement and not merely convenient: the return says what
 * left, the invoice says what was charged, and the memo is the supplier
 * agreeing that the two cancel. Without both links the credit is a number
 * floating against a supplier, and reconciliation becomes a conversation rather
 * than a query.
 */
export const supplierCreditMemo = pgTable(
  'supplier_credit_memo',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoNo: text('memo_no').notNull(),
    /** The supplier's own credit note number. */
    supplierMemoNo: text('supplier_memo_no').notNull(),

    /** Appendix B: Draft, Approved, Posted, Allocated, Reversed. */
    status: documentStatus('status').notNull().default('draft'),

    /** §8.2 and the 05.7 gate — both links, both required. */
    goodsReturnId: uuid('goods_return_id')
      .notNull()
      .references(() => goodsReturn.id),
    apInvoiceId: uuid('ap_invoice_id')
      .notNull()
      .references(() => apInvoice.id),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    memoDate: date('memo_date').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** How much of the memo has been applied to the invoice (§15). */
    allocatedAmountIqd: numeric('allocated_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    note: text('note'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_credit_memo_no_uniq').on(t.memoNo),
    // §15's duplicate control, the same shape as the A/P invoice's.
    uniqueIndex('supplier_credit_memo_supplier_number_uniq').on(t.supplierId, t.supplierMemoNo),
    index('supplier_credit_memo_return_idx').on(t.goodsReturnId),
    index('supplier_credit_memo_invoice_idx').on(t.apInvoiceId),

    check('supplier_credit_memo_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'supplier_credit_memo_not_over_allocated',
      sql`${t.allocatedAmountIqd} >= 0 and ${t.allocatedAmountIqd} <= ${t.amountIqd}`,
    ),
  ],
);
