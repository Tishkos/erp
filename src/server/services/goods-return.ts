/**
 * Goods Return and Supplier Credit Memo — Phase 05.7, §8.7.
 *
 * > §8.2: *"Purchase return: A/P Invoice → Goods Return → Supplier Credit
 * > Memo."*
 * > §8.7: *"Returned goods do not support replacement. A replacement requires a
 * > new Purchase Order."*
 *
 * **Search this file for "replacement" and you will find it only in prose.**
 * There is no function that creates one, no flag that requests one, no status
 * that means one is expected. A replacement is a new purchase — new order, new
 * commitment, new approval, new price — and a return that could quietly become
 * one would let goods arrive against an order nobody raised.
 *
 * **Available return quantity** (Appendix C) is what that delivery brought in,
 * less what has already gone back on it. Measured per receipt *line*, not per
 * item, because a supplier who delivered the same item twice at two prices has
 * sent two different things as far as the credit note is concerned.
 *
 * **The money.** Inventory is credited at the layer that receipt created, so
 * the return is valued at what the supplier charged. Return Clearing holds the
 * balance until the credit memo arrives; an ageing of that account is the
 * answer to *"what have we sent back and not been credited for?"*
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  businessPartner,
  goodsReceipt,
  goodsReceiptLine,
  goodsReturn,
  goodsReturnLine,
  supplierCreditMemo,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'goods_return';
export const PERMISSION_OBJECT = 'goods_return';
export const MEMO_DOCUMENT_TYPE = 'supplier_credit_memo';
export const MEMO_PERMISSION_OBJECT = 'supplier_credit_memo';
const SEQUENCE_KEY = 'GOODS_RETURN';
const MEMO_SEQUENCE_KEY = 'SUPPLIER_CREDIT_MEMO';

export class GoodsReturnNotFoundError extends Error {
  readonly code = 'GOODS_RETURN_NOT_FOUND';
  constructor(id: string) {
    super(`No goods return '${id}'.`);
    this.name = 'GoodsReturnNotFoundError';
  }
}

export class GoodsReturnStateError extends Error {
  readonly code = 'GOODS_RETURN_STATE_INVALID';
  constructor(returnNo: string, status: string, detail: string) {
    super(`Goods return ${returnNo} is '${status}': ${detail}`);
    this.name = 'GoodsReturnStateError';
  }
}

/** Appendix C — *"quantity cannot exceed available return quantity"*. */
export class ReturnQuantityError extends Error {
  readonly code = 'RETURN_QUANTITY_EXCEEDED';
  constructor(
    readonly itemCode: string,
    available: bigint,
    requested: bigint,
  ) {
    const q = (v: bigint) => formatQuantity(v);
    super(
      `Only ${q(available)} of ${itemCode} is available to return from that delivery, and ${q(requested)} was asked for (§8.7). ` +
        'Check what has already gone back; goods from another delivery are returned on their own document.',
    );
    this.name = 'ReturnQuantityError';
  }
}

export interface ReturnLineInput {
  /** The receipt line the goods arrived on. Decides quantity, layer and money. */
  readonly goodsReceiptLineId: string;
  readonly quantity: bigint;
  /** The invoice line being credited, where the goods were invoiced. */
  readonly apInvoiceLineId?: string | null;
}

export interface CreateGoodsReturnInput {
  readonly goodsReceiptId: string;
  /** §8.2 — the invoice this return credits, where one exists. */
  readonly apInvoiceId?: string | null;
  readonly branchCode: string;
  readonly returnDate: string;
  readonly reason: string;
  readonly supplierReference?: string | null;
  readonly lines: readonly ReturnLineInput[];
}

async function load(tx: Tx, id: string) {
  const [document] = await tx.select().from(goodsReturn).where(eq(goodsReturn.id, id)).limit(1);
  if (!document) throw new GoodsReturnNotFoundError(id);

  const lines = await tx
    .select()
    .from(goodsReturnLine)
    .where(eq(goodsReturnLine.goodsReturnId, id))
    .orderBy(goodsReturnLine.lineNo);

  return { document, lines };
}

/**
 * Appendix C — how much of a delivery is still available to send back.
 *
 * Counts only returns that have actually shipped. A draft return is somebody
 * thinking about it, and two drafts for the same goods must not between them
 * reserve more than exists.
 */
export async function availableToReturn(tx: Tx, goodsReceiptLineId: string): Promise<bigint> {
  const [received] = await tx
    .select({ quantity: goodsReceiptLine.quantity })
    .from(goodsReceiptLine)
    .where(eq(goodsReceiptLine.id, goodsReceiptLineId))
    .limit(1);

  if (!received) return 0n;

  const returned = await tx
    .select({ quantity: goodsReturnLine.quantity })
    .from(goodsReturnLine)
    .innerJoin(goodsReturn, eq(goodsReturn.id, goodsReturnLine.goodsReturnId))
    .where(
      and(
        eq(goodsReturnLine.goodsReceiptLineId, goodsReceiptLineId),
        sql`${goodsReturn.status} in ('posted', 'closed')`,
      ),
    );

  const already = returned.reduce((total, row) => total + parseQuantity(row.quantity), 0n);
  const available = parseQuantity(received.quantity) - already;
  return available > 0n ? available : 0n;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateGoodsReturnInput,
): Promise<{ id: string; returnNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error('A return with no lines sends nothing back. Say what is being returned.');
  }

  if (input.reason.trim().length === 0) {
    throw new Error(
      'A return needs a reason (§5.4). The supplier will ask, and a return nobody can explain is a dispute nobody can settle.',
    );
  }

  const [receipt] = await tx
    .select()
    .from(goodsReceipt)
    .where(eq(goodsReceipt.id, input.goodsReceiptId))
    .limit(1);

  if (!receipt) throw new Error(`No goods receipt with id '${input.goodsReceiptId}'.`);
  if (receipt.status !== 'executed') {
    throw new Error(
      `Goods receipt ${receipt.receiptNo} has not posted, so there is nothing in stock to return (§8.7).`,
    );
  }

  const [order] = await tx
    .select({ supplierId: sql<string>`supplier_id` })
    .from(sql`purchase_order`)
    .where(sql`id = ${receipt.purchaseOrderId}`)
    .limit(1);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.returnDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(goodsReturn)
    .values({
      returnNo: allocated.documentNo,
      apInvoiceId: input.apInvoiceId ?? null,
      goodsReceiptId: receipt.id,
      supplierId: order!.supplierId,
      branchCode: input.branchCode,
      returnDate: input.returnDate,
      reason: input.reason.trim(),
      supplierReference: input.supplierReference ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: goodsReturn.id });

  // What this document has already claimed against each receipt line: two lines
  // can name the same delivery line, and neither is written yet.
  const claimed = new Map<string, bigint>();

  for (const [index, line] of input.lines.entries()) {
    const [receiptLine] = await tx
      .select()
      .from(goodsReceiptLine)
      .where(eq(goodsReceiptLine.id, line.goodsReceiptLineId))
      .limit(1);

    if (!receiptLine || receiptLine.goodsReceiptId !== receipt.id) {
      throw new Error(
        `That line does not belong to goods receipt ${receipt.receiptNo}. A return covers one delivery.`,
      );
    }

    const available =
      (await availableToReturn(tx, receiptLine.id)) - (claimed.get(receiptLine.id) ?? 0n);
    claimed.set(receiptLine.id, (claimed.get(receiptLine.id) ?? 0n) + line.quantity);

    if (line.quantity > available) {
      throw new ReturnQuantityError(receiptLine.itemCode, available, line.quantity);
    }

    await tx.insert(goodsReturnLine).values({
      goodsReturnId: created!.id,
      lineNo: index + 1,
      goodsReceiptLineId: receiptLine.id,
      apInvoiceLineId: line.apInvoiceLineId ?? null,
      itemCode: receiptLine.itemCode,
      quantity: formatQuantity(line.quantity),
      uomCode: receiptLine.uomCode,
      warehouseCode: receiptLine.warehouseCode,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_return.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      returnNo: allocated.documentNo,
      receiptNo: receipt.receiptNo,
      lines: input.lines.length,
    },
    reason: input.reason.trim(),
    outcome: 'success',
  });

  return { id: created!.id, returnNo: allocated.documentNo };
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { document } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: document.branchCode,
  });

  if (document.status !== 'draft') {
    throw new GoodsReturnStateError(
      document.returnNo,
      document.status,
      'only a draft return can be approved.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, document.status, 'approved');

  await tx
    .update(goodsReturn)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(goodsReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_return.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'draft' },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

/**
 * Ships the return: stock leaves, Dr Return Clearing / Cr Inventory.
 *
 * The layer is the one the receipt created, so what is credited to inventory is
 * what the supplier charged (§8.7, and `issueFromLayer` in the FIFO domain for
 * why that is not a departure from §9.2's single valuation method).
 */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ movementIds: readonly string[]; costIqd: bigint }> {
  const { document, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: document.branchCode,
  });

  if (document.status !== 'approved') {
    throw new GoodsReturnStateError(
      document.returnNo,
      document.status,
      'a return ships once it has been approved.',
    );
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, document.supplierId))
    .limit(1);

  const movementIds: string[] = [];
  let costIqd = 0n;

  for (const line of lines) {
    const [receiptLine] = await tx
      .select()
      .from(goodsReceiptLine)
      .where(eq(goodsReceiptLine.id, line.goodsReceiptLineId))
      .limit(1);

    if (!receiptLine?.movementId) {
      throw new Error(
        `The delivery line behind return ${document.returnNo} has no stock movement, so nothing can be taken back out.`,
      );
    }

    const layerId = await inventory.layerForMovement(tx, receiptLine.movementId);
    if (!layerId) {
      throw new Error(
        `The delivery behind return ${document.returnNo} created no cost layer, so the return cannot be valued (§9.2).`,
      );
    }

    const movement = await inventory.issueFromLayer(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: line.warehouseCode,
      branchCode: document.branchCode,
      costLayerId: layerId,
      quantity: parseQuantity(line.quantity),
      movementDate: document.returnDate,
      kind: 'goods_return',
      sourceDocumentType: PERMISSION_OBJECT,
      sourceDocumentId: id,
      sourceLineId: line.id,
      serialNumber: receiptLine.serialNumber,
      batchNumber: receiptLine.batchNumber,
      // Appendix C — Dr Return Clearing / Cr Inventory, in this transaction.
      post: true,
      dimensions: { business_partner: supplier?.code ?? null },
    });

    movementIds.push(movement.movementId);
    costIqd += movement.costIqd ?? 0n;

    await tx
      .update(goodsReturnLine)
      .set({
        movementId: movement.movementId,
        costLayerId: layerId,
        costIqd: toDecimalString(movement.costIqd ?? 0n, 4n),
      })
      .where(eq(goodsReturnLine.id, line.id));
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, document.status, 'posted');

  await tx
    .update(goodsReturn)
    .set({
      status: 'posted',
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(goodsReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_return.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'approved' },
    after: { status: 'posted', movements: movementIds.length, costIqd: toDecimalString(costIqd, 4n) },
    outcome: 'success',
  });

  return { movementIds, costIqd };
}

/** What a return is worth — the FIFO cost of what went back. */
export async function returnValue(tx: Tx, id: string): Promise<bigint> {
  const { lines } = await load(tx, id);
  return lines.reduce((total, line) => total + parseDecimal(line.costIqd, 4n), 0n);
}

export interface CreateCreditMemoInput {
  readonly goodsReturnId: string;
  readonly supplierMemoNo: string;
  readonly memoDate: string;
  /** What the supplier has agreed to credit. Usually the return's value. */
  readonly amountIqd: bigint;
  readonly note?: string | null;
}

/**
 * §8.2 — the Supplier Credit Memo, which closes the loop.
 *
 * Links to the Goods Return *and* the original A/P Invoice, both required.
 * Posts Dr Supplier A/P / Cr Return Clearing: the debt shrinks by what the
 * supplier has agreed, and the clearing account empties.
 *
 * The amount is the supplier's, not ours. It usually equals the return's cost
 * and sometimes does not — a restocking fee, a price the supplier disputes —
 * and the difference stays visible in Return Clearing rather than being
 * silently absorbed, because somebody has to chase it.
 */
export async function creditMemo(
  tx: Tx,
  ctx: ActorContext,
  input: CreateCreditMemoInput,
): Promise<{ id: string; memoNo: string; journalEntryId: string }> {
  const { document } = await load(tx, input.goodsReturnId);

  await authz.authorize(ctx.principal, 'post', MEMO_PERMISSION_OBJECT, {
    branchCode: document.branchCode,
  });

  if (document.status !== 'posted') {
    throw new GoodsReturnStateError(
      document.returnNo,
      document.status,
      'a credit memo follows a return that has actually shipped (§8.2).',
    );
  }

  if (!document.apInvoiceId) {
    throw new Error(
      `Return ${document.returnNo} is not linked to an A/P invoice, so there is no debt for a credit memo to reduce (§8.2). ` +
        'Link the invoice being credited, or leave the return in Return Clearing until one arrives.',
    );
  }

  if (input.amountIqd <= 0n) {
    throw new Error('A credit memo for nothing credits nothing. State the amount agreed.');
  }

  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, document.apInvoiceId))
    .limit(1);

  if (!invoice) throw new Error('The linked A/P invoice no longer exists.');

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, document.supplierId))
    .limit(1);

  const allocated = await allocateDocumentNumber(
    tx,
    MEMO_SEQUENCE_KEY,
    { branchCode: document.branchCode, year: Number(input.memoDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const criteria = { branchCode: document.branchCode };
  const dimensions = { branch: document.branchCode, business_partner: supplier?.code ?? null };
  const amount = toDecimalString(input.amountIqd, 4n);

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_credit_memo',
    documentTypeCode: MEMO_DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: input.goodsReturnId, event: 'credited' },
    branchCode: document.branchCode,
    documentDate: input.memoDate,
    postingDate: input.memoDate,
    description: `Credit memo ${allocated.documentNo} against return ${document.returnNo}`,
    lines: [
      { role: 'supplier_payable', debit: amount, criteria, dimensions },
      { role: 'return_clearing', credit: amount, criteria, dimensions },
    ],
  });

  const [memo] = await tx
    .insert(supplierCreditMemo)
    .values({
      memoNo: allocated.documentNo,
      supplierMemoNo: input.supplierMemoNo.trim(),
      status: 'posted',
      goodsReturnId: input.goodsReturnId,
      apInvoiceId: document.apInvoiceId,
      supplierId: document.supplierId,
      branchCode: document.branchCode,
      memoDate: input.memoDate,
      amountIqd: amount,
      note: input.note ?? null,
      journalEntryId: result.journalEntryId,
      createdBy: ctx.principal.userId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
    })
    .returning({ id: supplierCreditMemo.id });

  // The credit reduces what is owed on the invoice, the same way an advance
  // settlement does (§15 — "credit notes and advances are allocated
  // transparently").
  await tx
    .update(apInvoice)
    .set({
      settledAmountIqd: sql`${apInvoice.settledAmountIqd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, document.apInvoiceId));

  const [invoiceAfter] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, document.apInvoiceId))
    .limit(1);

  const owed =
    parseDecimal(invoiceAfter!.totalIqd, 4n) - parseDecimal(invoiceAfter!.settledAmountIqd, 4n);

  await tx
    .update(apInvoice)
    .set({ status: owed === 0n ? 'settled' : 'partially_executed', updatedAt: new Date() })
    .where(eq(apInvoice.id, document.apInvoiceId));

  await tx
    .update(goodsReturn)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(goodsReturn.id, input.goodsReturnId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.posted',
    objectType: MEMO_PERMISSION_OBJECT,
    objectId: memo!.id,
    branchCode: document.branchCode,
    after: {
      memoNo: allocated.documentNo,
      returnNo: document.returnNo,
      invoiceNo: invoice.invoiceNo,
      amountIqd: amount,
    },
    outcome: 'success',
  });

  return { id: memo!.id, memoNo: allocated.documentNo, journalEntryId: result.journalEntryId };
}

/**
 * §15 — returns shipped and not yet credited.
 *
 * The Return Clearing balance, itemised. *"What have we sent back and not been
 * credited for?"* is a question every A/P department asks at month end, and one
 * that is normally answered by a spreadsheet.
 */
export async function awaitingCredit(tx: Tx) {
  const rows = await tx
    .select({
      returnNo: goodsReturn.returnNo,
      supplierCode: businessPartner.code,
      returnDate: goodsReturn.returnDate,
      reason: goodsReturn.reason,
      costIqd: sql<string>`(select coalesce(sum(l.cost_iqd), 0)
                              from goods_return_line l
                             where l.goods_return_id = goods_return.id)`,
    })
    .from(goodsReturn)
    .innerJoin(businessPartner, eq(businessPartner.id, goodsReturn.supplierId))
    .where(eq(goodsReturn.status, 'posted'))
    .orderBy(goodsReturn.returnDate);

  return rows;
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/** The credit memos raised against one invoice — §15's allocation transparency. */
export async function creditMemosFor(tx: Tx, apInvoiceId: string) {
  return tx
    .select({
      memoNo: supplierCreditMemo.memoNo,
      supplierMemoNo: supplierCreditMemo.supplierMemoNo,
      amountIqd: supplierCreditMemo.amountIqd,
      memoDate: supplierCreditMemo.memoDate,
      returnNo: goodsReturn.returnNo,
    })
    .from(supplierCreditMemo)
    .innerJoin(goodsReturn, eq(goodsReturn.id, supplierCreditMemo.goodsReturnId))
    .where(eq(supplierCreditMemo.apInvoiceId, apInvoiceId))
    .orderBy(supplierCreditMemo.memoDate);
}

/** Unused, and named so the 05.7 gate can assert its absence (§8.7). */
export const REPLACEMENT_IS_NOT_SUPPORTED =
  'A replacement requires a new Purchase Order (§8.7). This flow has no route to one.';
