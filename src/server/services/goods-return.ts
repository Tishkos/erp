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
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  bankCashAccount,
  businessPartner,
  costLayer,
  inventoryMovement,
  item as itemTable,
  warehouse,
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
import * as units from './item-units';
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

/**
 * Which side the debit lands on. `'payable'` reduces what the company owes the
 * supplier; `'bank'` takes their refund into a named bank or cash account.
 */
export type OffsetKind = 'payable' | 'bank';

export class OffsetAccountError extends Error {
  readonly code = 'OFFSET_ACCOUNT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'OffsetAccountError';
  }
}

export interface OffsetChoice {
  /**
   * Block 10's *"Offset Account (Accounts Payable or Bank — one must be
   * selected)"*. No default: a refund booked as a reduced payable leaves the
   * company still expecting to pay a debt that is already settled.
   */
  readonly offsetKind: OffsetKind;
  /** Required when `offsetKind` is 'bank', refused otherwise. */
  readonly offsetBankAccountId?: string | null;
}

export interface CreateGoodsReturnInput extends OffsetChoice {
  readonly goodsReceiptId: string;
  /** §8.2 — the invoice this return credits, where one exists. */
  readonly apInvoiceId?: string | null;
  readonly branchCode: string;
  readonly returnDate: string;
  readonly reason: string;
  readonly supplierReference?: string | null;
  readonly lines: readonly ReturnLineInput[];
}

/**
 * Reads the offset choice, and refuses the two shapes the CHECK would refuse
 * anyway — here, so the person gets a sentence instead of a constraint name.
 */
async function resolveOffset(
  tx: Tx,
  input: OffsetChoice,
): Promise<{ offsetKind: OffsetKind; offsetBankAccountId: string | null }> {
  if (input.offsetKind === 'payable') {
    if (input.offsetBankAccountId) {
      throw new OffsetAccountError(
        'A return offset to Accounts Payable reduces what the company owes the supplier, not a ' +
          'bank balance. Choose Bank if they are refunding the money.',
      );
    }
    return { offsetKind: 'payable', offsetBankAccountId: null };
  }

  if (!input.offsetBankAccountId) {
    throw new OffsetAccountError(
      'A return offset to Bank must name which bank or cash account the refund arrives in.',
    );
  }

  const [account] = await tx
    .select({ id: bankCashAccount.id, active: bankCashAccount.active })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.offsetBankAccountId))
    .limit(1);

  if (!account) {
    throw new OffsetAccountError(`No bank or cash account with id '${input.offsetBankAccountId}'.`);
  }
  if (!account.active) {
    throw new OffsetAccountError(
      'That bank or cash account is closed. A refund cannot be received into it.',
    );
  }

  return { offsetKind: 'bank', offsetBankAccountId: account.id };
}

/**
 * The return and its lines. `lock` holds the header `for update` so that two
 * posts of one return serialise: the second reads `posted` and is refused,
 * rather than taking the goods out of the warehouse a second time.
 */
async function load(tx: Tx, id: string, options: { lock?: boolean } = {}) {
  const header = tx.select().from(goodsReturn).where(eq(goodsReturn.id, id)).limit(1);
  const [document] = await (options.lock ? header.for('update') : header);
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

  const offset = await resolveOffset(tx, input);

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
      offsetKind: offset.offsetKind,
      offsetBankAccountId: offset.offsetBankAccountId,
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

/**
 * How much of a Purchase Invoice line is still available to send back.
 *
 * The sponsor controls the quantity against the invoice — *"the remaining
 * returnable quantity from the original Purchase Invoice after considering
 * previous returns"* — so this counts what the invoice billed less what has
 * already gone back against it. A cancelled return is not a return.
 */
export async function availableToReturnFromInvoice(
  tx: Tx,
  apInvoiceLineId: string,
): Promise<bigint> {
  const [invoiced] = await tx
    .select({ quantity: apInvoiceLine.quantity })
    .from(apInvoiceLine)
    .where(eq(apInvoiceLine.id, apInvoiceLineId))
    .limit(1);

  if (!invoiced) return 0n;

  const [returned] = await tx
    .select({
      quantity: sql<string>`coalesce(sum(${goodsReturnLine.quantity}), 0)`,
    })
    .from(goodsReturnLine)
    .innerJoin(goodsReturn, eq(goodsReturn.id, goodsReturnLine.goodsReturnId))
    .where(
      and(
        eq(goodsReturnLine.apInvoiceLineId, apInvoiceLineId),
        ne(goodsReturn.status, 'cancelled'),
      ),
    );

  const remaining = parseQuantity(invoiced.quantity) - parseQuantity(returned?.quantity ?? '0');
  return remaining > 0n ? remaining : 0n;
}

export interface InvoiceReturnLineInput {
  readonly apInvoiceLineId: string;
  readonly quantity: bigint;
  /**
   * Block 10 — *"Warehouse (from which the item will be returned)"*. Blank
   * means where the invoice booked it; the goods may have moved since.
   */
  readonly warehouseCode?: string | null;
}

export interface CreateFromInvoiceInput extends OffsetChoice {
  readonly apInvoiceId: string;
  readonly returnDate: string;
  readonly reason: string;
  readonly supplierReference?: string | null;
  readonly lines: readonly InvoiceReturnLineInput[];
}

/**
 * Block 10 — a Purchase Return raised against the invoice itself.
 *
 * The chain this module was built for is purchase order, goods receipt,
 * invoice, and a return keys to the receipt line because that is the line
 * carrying the cost layer. Block 4 added the sponsor's own route, where the
 * invoice books stock straight into a warehouse and there is no receipt at
 * all — and a return against one of those could not be raised.
 *
 * Everything downstream is unchanged: the same approval, the same shipment,
 * the same credit memo. Only the source of the line differs, and `post` finds
 * the cost layer through the invoice's own receipt movement instead.
 */
export async function createFromInvoice(
  tx: Tx,
  ctx: ActorContext,
  input: CreateFromInvoiceInput,
): Promise<{ id: string; returnNo: string }> {
  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);

  if (!invoice) throw new Error(`No purchase invoice with id '${input.apInvoiceId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error('A return with no lines sends nothing back. Say what is being returned.');
  }

  if (input.reason.trim().length === 0) {
    throw new Error(
      'A return needs a reason (§5.4). The supplier will ask, and a return nobody can explain is a dispute nobody can settle.',
    );
  }

  // Stock that has not been booked in cannot be sent back out. Posted means
  // any of the three: paid in part or in full, the goods still came in.
  if (!['posted', 'partially_executed', 'settled'].includes(invoice.status)) {
    throw new Error(
      `Purchase invoice ${invoice.invoiceNo} is '${invoice.status}'. Until it posts, nothing it ` +
        'names is in a warehouse to return.',
    );
  }

  const offset = await resolveOffset(tx, input);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: invoice.branchCode, year: Number(input.returnDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(goodsReturn)
    .values({
      returnNo: allocated.documentNo,
      apInvoiceId: invoice.id,
      goodsReceiptId: null,
      supplierId: invoice.supplierId,
      branchCode: invoice.branchCode,
      returnDate: input.returnDate,
      offsetKind: offset.offsetKind,
      offsetBankAccountId: offset.offsetBankAccountId,
      reason: input.reason.trim(),
      supplierReference: input.supplierReference ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: goodsReturn.id });

  // What this document has already claimed against each invoice line: two lines
  // can name the same one, and neither is written yet.
  const claimed = new Map<string, bigint>();

  for (const [index, line] of input.lines.entries()) {
    const [invoiceLine] = await tx
      .select()
      .from(apInvoiceLine)
      .where(eq(apInvoiceLine.id, line.apInvoiceLineId))
      .limit(1);

    if (!invoiceLine || invoiceLine.apInvoiceId !== invoice.id) {
      throw new Error(
        `That line does not belong to purchase invoice ${invoice.invoiceNo}. A return reconciles ` +
          'to the invoice it names.',
      );
    }

    if (!invoiceLine.warehouseCode) {
      throw new Error(
        `Line ${invoiceLine.lineNo} of ${invoice.invoiceNo} booked no stock into a warehouse, so ` +
          'there is nothing of it to send back.',
      );
    }

    const available =
      (await availableToReturnFromInvoice(tx, invoiceLine.id)) - (claimed.get(invoiceLine.id) ?? 0n);
    claimed.set(invoiceLine.id, (claimed.get(invoiceLine.id) ?? 0n) + line.quantity);

    if (line.quantity > available) {
      throw new ReturnQuantityError(invoiceLine.itemCode!, available, line.quantity);
    }

    await tx.insert(goodsReturnLine).values({
      goodsReturnId: created!.id,
      lineNo: index + 1,
      goodsReceiptLineId: null,
      apInvoiceLineId: invoiceLine.id,
      itemCode: invoiceLine.itemCode!,
      quantity: formatQuantity(line.quantity),
      uomCode: invoiceLine.uomCode,
      warehouseCode: await returnWarehouse(tx, line.warehouseCode, invoiceLine.warehouseCode, invoice.branchCode),
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_return.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: invoice.branchCode,
    after: {
      returnNo: allocated.documentNo,
      invoiceNo: invoice.invoiceNo,
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
/** Where the goods came in, when a goods receipt brought them. */
async function receiptSource(tx: Tx, goodsReceiptLineId: string) {
  const [receiptLine] = await tx
    .select()
    .from(goodsReceiptLine)
    .where(eq(goodsReceiptLine.id, goodsReceiptLineId))
    .limit(1);

  return {
    movementId: receiptLine?.movementId ?? null,
    serialNumber: receiptLine?.serialNumber ?? null,
    batchNumber: receiptLine?.batchNumber ?? null,
  };
}

/**
 * Where the goods came in, when the Purchase Invoice booked them itself.
 *
 * The invoice's own receipt movement carries the layer and the batch, so a
 * return against it is valued and identified from the same row the receipt
 * would have been.
 */
async function invoiceSource(tx: Tx, apInvoiceLineId: string | null) {
  if (!apInvoiceLineId) return { movementId: null, serialNumber: null, batchNumber: null };

  const [movement] = await tx
    .select({
      id: inventoryMovement.id,
      serialNumber: inventoryMovement.serialNumber,
      batchNumber: inventoryMovement.batchNumber,
    })
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.sourceDocumentType, 'ap_invoice'),
        eq(inventoryMovement.sourceLineId, apInvoiceLineId),
      ),
    )
    .limit(1);

  return {
    movementId: movement?.id ?? null,
    serialNumber: movement?.serialNumber ?? null,
    batchNumber: movement?.batchNumber ?? null,
  };
}

export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ movementIds: readonly string[]; costIqd: bigint }> {
  const { document, lines } = await load(tx, id, { lock: true });

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

  // Raised against a Purchase Invoice that booked its own stock — Operations
  // block 10. Everything about it is settled here, in one journal; see below.
  const direct = Boolean(document.apInvoiceId) && lines.every((line) => !line.goodsReceiptLineId);
  /** Each line's inventory credit, by the item's own inventory account. */
  const inventoryCredits: { accountId: string | null; costIqd: bigint; warehouseCode: string }[] = [];

  for (const line of lines) {
    if (direct) {
      const moved = await returnInvoicedGoods(tx, ctx, document, line);
      movementIds.push(...moved.movementIds);
      costIqd += moved.costIqd;
      inventoryCredits.push({
        accountId: await itemInventoryAccount(tx, line.itemCode),
        costIqd: moved.costIqd,
        warehouseCode: line.warehouseCode,
      });
      await tx
        .update(goodsReturnLine)
        .set({
          movementId: moved.movementIds[0] ?? null,
          costLayerId: moved.firstLayerId,
          costIqd: toDecimalString(moved.costIqd, 4n),
        })
        .where(eq(goodsReturnLine.id, line.id));
      continue;
    }

    // The movement that put these goods into the warehouse. Usually the goods
    // receipt's; on a return against a Purchase Invoice that booked its own
    // stock — Operations block 4 — it is the invoice's, and there is no receipt
    // line at all. Either way the return leaves by the layer it arrived on, so
    // it goes back out at what it came in at.
    const source = line.goodsReceiptLineId
      ? await receiptSource(tx, line.goodsReceiptLineId)
      : await invoiceSource(tx, line.apInvoiceLineId);

    if (!source.movementId) {
      throw new Error(
        `The delivery line behind return ${document.returnNo} has no stock movement, so nothing can be taken back out.`,
      );
    }

    const layerId = await inventory.layerForMovement(tx, source.movementId);
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
      // REQ-FIX-001 FIX-4 — returned in the unit it was bought in; the layer is in the base.
      quantity: await units.toBaseQuantity(tx, line.itemCode, line.uomCode, parseQuantity(line.quantity)),
      movementDate: document.returnDate,
      kind: 'goods_return',
      sourceDocumentType: PERMISSION_OBJECT,
      sourceDocumentId: id,
      sourceLineId: line.id,
      serialNumber: source.serialNumber,
      batchNumber: source.batchNumber,
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

  /*
   * Block 10's journal, whole: *"Accounts Payable or Bank Dr. / Inventory Cr."*
   *
   * One entry, posted with the goods. It used to be two — the stock left into
   * Return Clearing here, and the payable or the bank was only debited by a
   * Supplier Credit Memo that no screen ever raised — so a return posted from
   * the screen took the goods out of the warehouse and never reduced what the
   * company owed, and the supplier's statement never showed it.
   *
   * The debit is the payable the invoice credited (the account it chose, or the
   * purchase-invoice mapping), or the bank the refund arrived in. The credit is
   * each item's own inventory account (block 1). Both are the return's value
   * at what the invoice paid for these goods, so they balance by construction.
   */
  let journalEntryId: string | null = null;
  if (direct && costIqd > 0n) {
    const [invoice] = await tx
      .select({ payableAccountId: apInvoice.payableAccountId, invoiceNo: apInvoice.invoiceNo })
      .from(apInvoice)
      .where(eq(apInvoice.id, document.apInvoiceId!))
      .limit(1);
    const criteria = { branchCode: document.branchCode };
    const dimensions = { branch: document.branchCode, business_partner: supplier?.code ?? null };
    const amount = toDecimalString(costIqd, 4n);
    const debitAccount =
      document.offsetKind === 'bank'
        ? await bankGlAccount(tx, document.offsetBankAccountId!)
        : (invoice?.payableAccountId ??
          (await posting.mappedAccountFor(
            tx,
            'purchasing.ap_invoice',
            'supplier_payable',
            document.branchCode,
          )));

    const result = await posting.post(tx, ctx, {
      eventType: 'purchasing.goods_return',
      documentTypeCode: DOCUMENT_TYPE,
      source: { module: 'purchasing', documentId: id, event: 'posted' },
      branchCode: document.branchCode,
      documentDate: document.returnDate,
      postingDate: document.returnDate,
      description: `Purchase return ${document.returnNo} against ${invoice?.invoiceNo ?? 'invoice'}`,
      lines: [
        {
          role: document.offsetKind === 'bank' ? 'bank' : 'supplier_payable',
          ...(debitAccount ? { accountId: debitAccount } : {}),
          debit: amount,
          criteria,
          dimensions,
        },
        ...inventoryCredits
          .filter((credit) => credit.costIqd > 0n)
          .map((credit) => ({
            role: 'inventory',
            ...(credit.accountId ? { accountId: credit.accountId } : {}),
            credit: toDecimalString(credit.costIqd, 4n),
            criteria: { ...criteria, warehouseCode: credit.warehouseCode },
            dimensions: { ...dimensions, warehouse: credit.warehouseCode },
          })),
      ],
    });
    journalEntryId = result.journalEntryId;

    // Goods sent back against the debt reduce what is still owed on the
    // invoice, the way a payment does. A refund into the bank does not: the
    // money came back, and the invoice was already paid.
    if (document.offsetKind !== 'bank') {
      await tx
        .update(apInvoice)
        .set({
          settledAmountIqd: sql`${apInvoice.settledAmountIqd} + ${amount}`,
          updatedAt: new Date(),
        })
        .where(eq(apInvoice.id, document.apInvoiceId!));
      const [after] = await tx
        .select({ totalIqd: apInvoice.totalIqd, settledAmountIqd: apInvoice.settledAmountIqd })
        .from(apInvoice)
        .where(eq(apInvoice.id, document.apInvoiceId!))
        .limit(1);
      const owed = parseDecimal(after!.totalIqd, 4n) - parseDecimal(after!.settledAmountIqd, 4n);
      await tx
        .update(apInvoice)
        .set({ status: owed <= 0n ? 'settled' : 'partially_executed', updatedAt: new Date() })
        .where(eq(apInvoice.id, document.apInvoiceId!));
    }
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, document.status, 'posted');

  await tx
    .update(goodsReturn)
    .set({
      status: 'posted',
      ...(journalEntryId ? { journalEntryId } : {}),
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
    after: {
      status: 'posted',
      movements: movementIds.length,
      costIqd: toDecimalString(costIqd, 4n),
      journalEntryId,
    },
    outcome: 'success',
  });

  return { movementIds, costIqd };
}

/**
 * Takes one return line's goods out of the warehouse it names — block 10.
 *
 * The goods are the ones that invoice line bought: the same supplier, the same
 * unit cost and the same FIFO date as the layer the invoice created. Matching
 * on those rather than on that one layer is what lets a return follow the goods
 * after they have moved — through the shipment stages (block 8) or a transfer
 * (block 7) — because a move keeps all three (`inventory.relocate`) while the
 * layer the invoice first created is left empty behind it.
 *
 * Posts nothing itself: the return's one journal is written by `post`.
 */
async function returnInvoicedGoods(
  tx: Tx,
  ctx: ActorContext,
  document: typeof goodsReturn.$inferSelect,
  line: typeof goodsReturnLine.$inferSelect,
): Promise<{ movementIds: string[]; costIqd: bigint; firstLayerId: string | null }> {
  const source = await invoiceSource(tx, line.apInvoiceLineId);
  const originLayerId = source.movementId
    ? await inventory.layerForMovement(tx, source.movementId)
    : null;
  if (!originLayerId) {
    throw new Error(
      `The invoice line behind return ${document.returnNo} brought no stock in, so nothing can be sent back on it.`,
    );
  }
  const [origin] = await tx
    .select({
      supplierId: costLayer.supplierId,
      unitCostIqd: costLayer.unitCostIqd,
      layerDate: costLayer.layerDate,
    })
    .from(costLayer)
    .where(eq(costLayer.id, originLayerId))
    .limit(1);
  const originCost = parseDecimal(origin!.unitCostIqd, 4n);

  const pool = (
    await inventory.layersOf(tx, line.itemCode, line.warehouseCode, origin!.supplierId)
  ).filter(
    (layer) =>
      layer.remainingQuantity > 0n &&
      layer.unitCostIqd === originCost &&
      layer.layerDate === origin!.layerDate,
  );

  // REQ-FIX-001 FIX-4 — in the item's base unit, as the layers are.
  let outstanding = await units.toBaseQuantity(tx, line.itemCode, line.uomCode, parseQuantity(line.quantity));
  const held = pool.reduce((sum, layer) => sum + layer.remainingQuantity, 0n);
  if (held < outstanding) {
    throw new Error(
      `Only ${formatQuantity(held)} of the ${line.itemCode} on this invoice are in ${line.warehouseCode}, ` +
        `and the return sends back ${formatQuantity(outstanding)}. Return them from the warehouse they are in. ` +
        'Negative stock is not allowed.',
    );
  }

  const movementIds: string[] = [];
  let costIqd = 0n;
  for (const layer of pool) {
    if (outstanding === 0n) break;
    const take = layer.remainingQuantity < outstanding ? layer.remainingQuantity : outstanding;
    const movement = await inventory.issueFromLayer(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: line.warehouseCode,
      branchCode: document.branchCode,
      costLayerId: layer.id,
      quantity: take,
      movementDate: document.returnDate,
      kind: 'goods_return',
      sourceDocumentType: PERMISSION_OBJECT,
      sourceDocumentId: document.id,
      sourceLineId: line.id,
      serialNumber: source.serialNumber,
      batchNumber: source.batchNumber,
    });
    movementIds.push(movement.movementId);
    costIqd += movement.costIqd ?? 0n;
    outstanding -= take;
  }
  return { movementIds, costIqd, firstLayerId: pool[0]?.id ?? null };
}

/** The warehouse a return line sends goods back from: the one chosen, else the invoice's. */
async function returnWarehouse(
  tx: Tx,
  chosen: string | null | undefined,
  booked: string,
  branchCode: string,
): Promise<string> {
  const code = chosen?.trim() || booked;
  if (code === booked) return booked;
  const [row] = await tx
    .select({ branchCode: warehouse.branchCode, active: warehouse.active })
    .from(warehouse)
    .where(eq(warehouse.code, code))
    .limit(1);
  if (!row || !row.active || row.branchCode !== branchCode) {
    throw new Error(`Choose an active warehouse of this branch to return the goods from; '${code}' is not one.`);
  }
  return code;
}

/** The inventory account an item names for itself (block 1), if it names one. */
async function itemInventoryAccount(tx: Tx, itemCode: string): Promise<string | null> {
  const [row] = await tx
    .select({ accountId: itemTable.inventoryAccountId })
    .from(itemTable)
    .where(eq(itemTable.code, itemCode))
    .limit(1);
  return row?.accountId ?? null;
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
/**
 * The G/L account a bank or cash position is carried in. A refund lands in the
 * account the money actually arrived in, so the cash the books show is the cash
 * the bank shows.
 */
async function bankGlAccount(tx: Tx, bankCashAccountId: string): Promise<string> {
  const [account] = await tx
    .select({ glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, bankCashAccountId))
    .limit(1);

  if (!account) {
    throw new Error(
      `No bank or cash account with id '${bankCashAccountId}'. The return names it as the offset, ` +
        'so the refund has nowhere to land.',
    );
  }
  return account.glAccountId;
}

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

  if (document.journalEntryId) {
    // A return raised from a Purchase Invoice settles the supplier itself when
    // it posts (block 10). A memo on top would reduce the same debt twice.
    throw new GoodsReturnStateError(
      document.returnNo,
      document.status,
      'it already debited the payable or the bank when it posted, so there is nothing left to credit.',
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
      // Block 10 — *"Accounts Payable or Bank Dr."*. The return said which, and
      // the sign is the mirror of a sales return: goods going back either
      // shrink what the company owes, or the supplier refunds the money and it
      // arrives in a bank.
      document.offsetKind === 'bank'
        ? {
            // Named outright rather than mapped: which bank the refund arrived
            // in is a fact about this credit, and no posting rule can know it.
            role: 'bank',
            accountId: await bankGlAccount(tx, document.offsetBankAccountId!),
            debit: amount,
            criteria,
            dimensions,
          }
        : { role: 'supplier_payable', debit: amount, criteria, dimensions },
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

/** The register — Operations block 10's list of Purchase Returns. */
export async function list(tx: Tx) {
  return tx
    .select({
      id: goodsReturn.id,
      returnNo: goodsReturn.returnNo,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
      invoiceNo: apInvoice.invoiceNo,
      returnDate: goodsReturn.returnDate,
      offsetKind: goodsReturn.offsetKind,
      status: goodsReturn.status,
      branchCode: goodsReturn.branchCode,
    })
    .from(goodsReturn)
    .leftJoin(businessPartner, eq(businessPartner.id, goodsReturn.supplierId))
    .leftJoin(apInvoice, eq(apInvoice.id, goodsReturn.apInvoiceId))
    .orderBy(desc(goodsReturn.returnDate), desc(goodsReturn.returnNo));
}

/** The return a person is looking at, found by the number printed on it. */
export async function viewByNo(tx: Tx, returnNo: string) {
  const [row] = await tx
    .select({ id: goodsReturn.id })
    .from(goodsReturn)
    .where(eq(goodsReturn.returnNo, returnNo))
    .limit(1);
  if (!row) return null;
  return load(tx, row.id);
}

/**
 * Posted Purchase Invoices a return can be raised against.
 *
 * Only the ones that booked stock into a warehouse: an invoice for a service
 * has nothing to send back, and offering it would end in a refusal a line
 * later.
 */
export async function returnableInvoices(tx: Tx) {
  return tx
    .selectDistinct({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      invoiceDate: apInvoice.invoiceDate,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
    })
    .from(apInvoice)
    .innerJoin(apInvoiceLine, eq(apInvoiceLine.apInvoiceId, apInvoice.id))
    .leftJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .where(
      and(
        inArray(apInvoice.status, ['posted', 'partially_executed', 'settled']),
        isNotNull(apInvoiceLine.warehouseCode),
      ),
    )
    .orderBy(desc(apInvoice.invoiceDate));
}

/** Every line of one invoice, with how much of it is still returnable. */
export async function returnableLinesFor(tx: Tx, apInvoiceId: string) {
  const lines = await tx
    .select({
      id: apInvoiceLine.id,
      lineNo: apInvoiceLine.lineNo,
      itemCode: apInvoiceLine.itemCode,
      // The item's own name — block 10's "Item Name" — not the line's text.
      description: sql<string>`coalesce(${itemTable.name}, ${apInvoiceLine.description})`,
      quantity: apInvoiceLine.quantity,
      unitPrice: apInvoiceLine.unitPrice,
      warehouseCode: apInvoiceLine.warehouseCode,
    })
    .from(apInvoiceLine)
    .leftJoin(itemTable, eq(itemTable.code, apInvoiceLine.itemCode))
    .where(eq(apInvoiceLine.apInvoiceId, apInvoiceId))
    .orderBy(apInvoiceLine.lineNo);

  const out = [];
  for (const line of lines) {
    if (!line.warehouseCode) continue;
    out.push({ ...line, returnable: await availableToReturnFromInvoice(tx, line.id) });
  }
  return out;
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
