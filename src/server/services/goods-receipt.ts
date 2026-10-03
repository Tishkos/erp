/**
 * Goods Receipt — Phase 05.2, §8.4.
 *
 * The document that turns a commitment into stock and a liability. Appendix C:
 * *"Purchase Goods Receipt | Inventory | GRNI | PO and warehouse receipt
 * required; FIFO layer created."*
 *
 * Three things happen together or not at all (§24): the stock movement, the
 * FIFO layer, and the Dr Inventory / Cr GRNI posting. They share the caller's
 * transaction, so a receipt that half-happened cannot exist.
 *
 * **Cost comes from the purchase order, not from the receipt.** The FIFO layer
 * is valued at the ordered price, because that is what the company agreed to
 * pay and what the invoice will be matched against. A receipt that could state
 * its own price would let the warehouse revalue stock, and the three-way match
 * (§8.5) would have nothing fixed to compare.
 *
 * **Over-receipt is a business decision, not an error.** §8.4 asks for a
 * configurable tolerance and a manager's override beyond it. Deliveries arrive
 * over by a pallet; refusing the goods at the gate is rarely what the company
 * wants. So the rule is: within tolerance, receive; beyond it, a manager says
 * yes in writing, and the reason is kept.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  goodsReceipt,
  goodsReceiptLine,
  item,
  purchaseOrder,
  purchaseOrderLine,
  purchaseReceiptTolerance,
  warehouse,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal } from '../domain/money';
import { isLineComplete, isOverReceipt, outstandingQuantity } from '../domain/receipt-tolerance';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as units from './item-units';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, whereOf, type RegisterPage, type RegisterPaging } from './register-page';
import * as payableEvents from './payable-events';
import * as payables from './payables';

/** The Appendix B document type this service manages. */
export const DOCUMENT_TYPE = 'goods_receipt';
export const PERMISSION_OBJECT = 'goods_receipt';
const SEQUENCE_KEY = 'GOODS_RECEIPT';

export class GoodsReceiptNotFoundError extends Error {
  readonly code = 'GOODS_RECEIPT_NOT_FOUND';
  constructor(id: string) {
    super(`No goods receipt '${id}'.`);
    this.name = 'GoodsReceiptNotFoundError';
  }
}

export class GoodsReceiptStateError extends Error {
  readonly code = 'GOODS_RECEIPT_STATE_INVALID';
  constructor(receiptNo: string, status: string, detail: string) {
    super(`Goods receipt ${receiptNo} is '${status}': ${detail}`);
    this.name = 'GoodsReceiptStateError';
  }
}

export class OrderNotReceivableError extends Error {
  readonly code = 'ORDER_NOT_RECEIVABLE';
  constructor(orderNo: string, status: string) {
    super(
      `Purchase order ${orderNo} is '${status}', so nothing can be received against it (§8.2). ` +
        'An approved order is what authorises a receipt — approve it, or raise a new one.',
    );
    this.name = 'OrderNotReceivableError';
  }
}

export class LineNotOnOrderError extends Error {
  readonly code = 'LINE_NOT_ON_ORDER';
  constructor(orderNo: string) {
    super(
      `That line does not belong to purchase order ${orderNo}. ` +
        'A receipt covers one order; receive each order on its own document.',
    );
    this.name = 'LineNotOnOrderError';
  }
}

/**
 * §8.4 — the over-receipt that needs a manager.
 *
 * Carries the numbers rather than a sentence, because the screen has to offer
 * the manager something to decide about: this is what was ordered, this is what
 * has already come, this is what is at the gate.
 */
export class OverReceiptError extends Error {
  readonly code = 'OVER_RECEIPT_BEYOND_TOLERANCE';
  constructor(
    readonly itemCode: string,
    readonly ordered: bigint,
    readonly alreadyReceived: bigint,
    readonly arriving: bigint,
    readonly tolerancePercent: string,
  ) {
    // `formatQuantity` already drops trailing *fractional* zeros. Stripping
    // again here turned 40 into 4, because a second pass cannot tell a
    // fractional zero from the last digit of a round number.
    const asQty = (v: bigint) => formatQuantity(v);
    super(
      `Receiving ${asQty(arriving)} of ${itemCode} would take the total to ` +
        `${asQty(alreadyReceived + arriving)} against ${asQty(ordered)} ordered, ` +
        `beyond the ${tolerancePercent}% tolerance (§8.4). ` +
        'A manager can accept the over-receipt with a reason, or the excess can be refused at the gate.',
    );
    this.name = 'OverReceiptError';
  }
}

export class ToleranceOverrideRequiresReasonError extends Error {
  readonly code = 'TOLERANCE_OVERRIDE_NEEDS_REASON';
  constructor() {
    super(
      'Accepting an over-receipt needs a reason (§5.4). ' +
        'Say what arrived and why it is being taken — the invoice will be matched against this.',
    );
    this.name = 'ToleranceOverrideRequiresReasonError';
  }
}

export interface ReceiptLineInput {
  /** The ordered line this delivery is against. */
  readonly purchaseOrderLineId: string;
  readonly quantity: bigint;
  /**
   * Where the goods actually went. Defaults to the ordered warehouse; §8.4
   * allows a different one, and the difference is recorded as a variance.
   */
  readonly warehouseCode?: string | null;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly expiryDate?: string | null;
  readonly manufacturedOn?: string | null;
}

export interface CreateGoodsReceiptInput {
  readonly purchaseOrderId: string;
  readonly branchCode: string;
  readonly receiptDate: string;
  readonly supplierDeliveryNote?: string | null;
  readonly note?: string | null;
  readonly lines: readonly ReceiptLineInput[];
}

/**
 * §8.4 — the configured tolerance for an item, or the company default.
 *
 * Item first, then the default. Returned as a percentage string because that is
 * how it is configured and how the message reads; the comparison below is done
 * in scaled integers so nothing rounds.
 */
export async function toleranceFor(tx: Tx, itemCode: string): Promise<string> {
  const [specific] = await tx
    .select({ percent: purchaseReceiptTolerance.overReceiptPercent })
    .from(purchaseReceiptTolerance)
    .where(eq(purchaseReceiptTolerance.itemCode, itemCode))
    .limit(1);

  if (specific) return specific.percent;

  const [fallback] = await tx
    .select({ percent: purchaseReceiptTolerance.overReceiptPercent })
    .from(purchaseReceiptTolerance)
    .where(isNull(purchaseReceiptTolerance.itemCode))
    .limit(1);

  // No default row configured at all is treated as no tolerance, not as
  // unlimited: §8.4 asks for a limit, and a missing configuration should not
  // silently remove one.
  return fallback?.percent ?? '0';
}

export { allowedQuantity, isOverReceipt } from '../domain/receipt-tolerance';

interface LoadedReceipt {
  readonly receipt: typeof goodsReceipt.$inferSelect;
  readonly lines: (typeof goodsReceiptLine.$inferSelect)[];
}

async function load(tx: Tx, id: string): Promise<LoadedReceipt> {
  const [receipt] = await tx.select().from(goodsReceipt).where(eq(goodsReceipt.id, id)).limit(1);
  if (!receipt) throw new GoodsReceiptNotFoundError(id);

  const lines = await tx
    .select()
    .from(goodsReceiptLine)
    .where(eq(goodsReceiptLine.goodsReceiptId, id))
    .orderBy(goodsReceiptLine.lineNo);

  return { receipt, lines };
}

/**
 * Raises a receipt as a draft, against an approved order.
 *
 * Nothing moves and nothing posts here — that happens at `post`. A draft
 * receipt is the warehouse writing down what turned up, which is a different
 * act from accepting it.
 */
export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateGoodsReceiptInput,
): Promise<{ id: string; receiptNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error(
      'A goods receipt with no lines records nothing arriving. Add what was delivered, or do not raise it.',
    );
  }

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(eq(purchaseOrder.id, input.purchaseOrderId))
    .limit(1);

  if (!order) throw new Error(`No purchase order with id '${input.purchaseOrderId}'.`);

  if (order.status !== 'approved' && order.status !== 'partially_executed') {
    throw new OrderNotReceivableError(order.orderNo, order.status);
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.receiptDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(goodsReceipt)
    .values({
      receiptNo: allocated.documentNo,
      purchaseOrderId: input.purchaseOrderId,
      branchCode: input.branchCode,
      receiptDate: input.receiptDate,
      supplierDeliveryNote: input.supplierDeliveryNote ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: goodsReceipt.id });

  for (const [index, line] of input.lines.entries()) {
    const [ordered] = await tx
      .select()
      .from(purchaseOrderLine)
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
      .limit(1);

    if (!ordered || ordered.purchaseOrderId !== input.purchaseOrderId) {
      throw new LineNotOnOrderError(order.orderNo);
    }

    // §8.2 — only goods are received into a warehouse. A service, an expense
    // or a fixed asset is confirmed on its own document, and the distinction
    // is what keeps GRNI a stock account.
    if (ordered.lineType !== 'inventory_item' || !ordered.itemCode) {
      throw new Error(
        `Line ${ordered.lineNo} of ${order.orderNo} is a ${ordered.lineType.replace('_', ' ')} line. ` +
          'Only an inventory item is received into a warehouse; a service or expense is confirmed on a ' +
          'Service Receipt / Expense Confirmation (§8.2), and a fixed asset is capitalised (§13).',
      );
    }

    // §9.3 — a tracked item is identified at the point it is written down, not
    // at the point it posts. The inventory service refuses an untracked
    // movement too, but by then the warehouse has typed the whole delivery in
    // and the message names a movement rather than a line.
    const [stocked] = await tx
      .select({ tracking: item.tracking })
      .from(item)
      .where(eq(item.code, ordered.itemCode))
      .limit(1);

    inventory.assertTrackingSupplied(ordered.itemCode, stocked?.tracking ?? null, line);

    // §8.4 — the receipt's own warehouse, defaulting to the ordered one.
    const destination = line.warehouseCode ?? ordered.warehouseCode;
    if (!destination) {
      throw new Error(
        `Line ${ordered.lineNo} of ${order.orderNo} names no warehouse, and none was given for the receipt. ` +
          'Stock has to be received somewhere.',
      );
    }

    // §14.3 — the receipt posts to one branch, so the goods must be standing in
    // it. Without this, a Baghdad receipt could put stock in an Erbil warehouse
    // and the inventory account of the wrong branch would carry it.
    const [destinationWarehouse] = await tx
      .select({ branchCode: warehouse.branchCode })
      .from(warehouse)
      .where(eq(warehouse.code, destination))
      .limit(1);

    if (destinationWarehouse && destinationWarehouse.branchCode !== input.branchCode) {
      throw new Error(
        `Warehouse ${destination} belongs to branch ${destinationWarehouse.branchCode}, and this receipt is ` +
          `being made in ${input.branchCode}. A receipt posts to one branch (§14.3) — receive the goods in the ` +
          'branch they arrived at, or send them on with a warehouse transfer (§9.4).',
      );
    }

    await tx.insert(goodsReceiptLine).values({
      goodsReceiptId: created!.id,
      lineNo: index + 1,
      purchaseOrderLineId: ordered.id,
      itemCode: ordered.itemCode,
      quantity: formatQuantity(line.quantity),
      uomCode: ordered.uomCode,
      warehouseCode: destination,
      warehouseVariance: destination !== ordered.warehouseCode,
      serialNumber: line.serialNumber ?? null,
      batchNumber: line.batchNumber ?? null,
      expiryDate: line.expiryDate ?? null,
      manufacturedOn: line.manufacturedOn ?? null,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_receipt.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { receiptNo: allocated.documentNo, orderNo: order.orderNo, lines: input.lines.length },
    outcome: 'success',
  });

  return { id: created!.id, receiptNo: allocated.documentNo };
}

export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { receipt } = await load(tx, id);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
  });

  if (receipt.status !== 'draft') {
    throw new GoodsReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'only a draft receipt can be submitted.',
    );
  }

  // The allow-list in `document_status_transition` is what §3.2's status
  // machine actually is; checking it here keeps those rows load-bearing rather
  // than documentary.
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'submitted');

  await tx
    .update(goodsReceipt)
    .set({ status: 'submitted', updatedAt: new Date() })
    .where(eq(goodsReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_receipt.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
  });
}

export interface PostOptions {
  /** §8.4 — a manager accepting an over-receipt, and why. */
  readonly acceptOverReceipt?: boolean;
  readonly overReceiptReason?: string | null;
}

/**
 * Posts the receipt: stock in, FIFO layer created, Dr Inventory / Cr GRNI.
 *
 * The order of work matters. Tolerance is checked for **every** line before any
 * stock moves, so a receipt that will be refused does not leave three lines
 * received and the fourth rejected — §24's atomicity is about the document, not
 * the line.
 */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  options: PostOptions = {},
): Promise<{ movementIds: readonly string[]; orderStatus: string }> {
  const { receipt, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
  });

  if (receipt.status !== 'submitted') {
    throw new GoodsReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'a receipt is posted from submitted — the warehouse records what arrived, then it is accepted.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'executed');

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(eq(purchaseOrder.id, receipt.purchaseOrderId))
    .limit(1);

  if (!order) throw new Error(`Goods receipt ${receipt.receiptNo} has no purchase order.`);
  if (order.status !== 'approved' && order.status !== 'partially_executed') {
    throw new OrderNotReceivableError(order.orderNo, order.status);
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, order.supplierId))
    .limit(1);
  const supplierCode = supplier?.code ?? null;

  // ---- Pass one: judge every line before moving anything. -------------------
  const planned: {
    line: typeof goodsReceiptLine.$inferSelect;
    ordered: typeof purchaseOrderLine.$inferSelect;
    quantity: bigint;
    unitCostIqd: bigint;
  }[] = [];

  let needsOverride = false;

  /**
   * What this document has already put against each ordered line.
   *
   * Two receipt lines can answer to the same PO line — two batches on one
   * delivery is the ordinary case. Judging each against the *stored* received
   * quantity would let 60 and 60 through against 100 ordered, because neither
   * exceeds it on its own and neither has been written yet.
   */
  const claimedInThisReceipt = new Map<string, bigint>();

  for (const line of lines) {
    const [ordered] = await tx
      .select()
      .from(purchaseOrderLine)
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
      .limit(1);

    if (!ordered) throw new LineNotOnOrderError(order.orderNo);

    const quantity = parseQuantity(line.quantity);
    const orderedQty = parseQuantity(ordered.quantity);
    const receivedQty =
      parseQuantity(ordered.receivedQuantity) + (claimedInThisReceipt.get(ordered.id) ?? 0n);
    claimedInThisReceipt.set(ordered.id, (claimedInThisReceipt.get(ordered.id) ?? 0n) + quantity);
    const tolerance = await toleranceFor(tx, line.itemCode);

    if (
      isOverReceipt({
        ordered: orderedQty,
        alreadyReceived: receivedQty,
        arriving: quantity,
        tolerancePercent: tolerance,
      })
    ) {
      if (!options.acceptOverReceipt) {
        throw new OverReceiptError(line.itemCode, orderedQty, receivedQty, quantity, tolerance);
      }
      if (!options.overReceiptReason || options.overReceiptReason.trim().length === 0) {
        throw new ToleranceOverrideRequiresReasonError();
      }
      needsOverride = true;
    }

    planned.push({
      line,
      ordered,
      quantity,
      // The ordered price, not a price the receipt states. §8.5's three-way
      // match compares PO, receipt and invoice; the receipt is the quantity
      // leg of it, never the price leg.
      unitCostIqd: parseDecimal(ordered.unitPrice, 4n),
    });
  }

  // §8.4 — the override is a manager's act, recorded before the stock moves.
  if (needsOverride) {
    await tx
      .update(goodsReceipt)
      .set({
        toleranceOverrideBy: ctx.principal.userId,
        toleranceOverrideAt: new Date(),
        toleranceOverrideReason: options.overReceiptReason!.trim(),
        updatedAt: new Date(),
      })
      .where(eq(goodsReceipt.id, id));
  }

  // ---- Pass two: move the stock and post. ----------------------------------
  const movementIds: string[] = [];

  for (const plan of planned) {
    // REQ-FIX-001 FIX-4 — received in the order's unit, counted in the base.
    const baseQuantity = await units.toBaseQuantity(tx, plan.line.itemCode, plan.line.uomCode, plan.quantity);
    const movement = await inventory.receive(tx, ctx, {
      itemCode: plan.line.itemCode,
      warehouseCode: plan.line.warehouseCode,
      branchCode: receipt.branchCode,
      quantity: baseQuantity,
      // The order's price is per its unit; a base unit costs that share of it.
      unitCostIqd: baseQuantity === plan.quantity || baseQuantity === 0n ? plan.unitCostIqd : (plan.unitCostIqd * plan.quantity) / baseQuantity,
      movementDate: receipt.receiptDate,
      kind: 'goods_receipt',
      sourceDocumentType: PERMISSION_OBJECT,
      sourceDocumentId: id,
      sourceLineId: plan.line.id,
      serialNumber: plan.line.serialNumber,
      batchNumber: plan.line.batchNumber,
      expiryDate: plan.line.expiryDate,
      manufacturedOn: plan.line.manufacturedOn,
      // Appendix C — Dr Inventory / Cr GRNI, in this transaction.
      post: true,
      // §4.2's dimensions, from the document that knows them. The supplier is
      // the analytical fact a receipt carries that a movement cannot know on
      // its own; `branch` and `warehouse` are added by `postingRequestFor`.
      // The PO line's cost centre is deliberately not passed: §4.2 does not
      // list cost centre among the seven dimensions, and inventing an eighth
      // here would put a dimension in the ledger that no account can require.
      dimensions: { business_partner: supplierCode },
    });

    movementIds.push(movement.movementId);

    await tx
      .update(goodsReceiptLine)
      .set({ movementId: movement.movementId })
      .where(eq(goodsReceiptLine.id, plan.line.id));

    await tx
      .update(purchaseOrderLine)
      .set({
        receivedQuantity: sql`${purchaseOrderLine.receivedQuantity} + ${formatQuantity(plan.quantity)}`,
      })
      .where(eq(purchaseOrderLine.id, plan.ordered.id));
  }

  await tx
    .update(goodsReceipt)
    .set({
      status: 'executed',
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(goodsReceipt.id, id));

  const orderStatus = await refreshOrderStatus(tx, receipt.purchaseOrderId);

  // REQ-AP-001 §11 — a local-goods payable hears its warehouse lane move.
  {
    const { payable: payableTable } = await import('../db/schema');
    const { and: andOp, eq: eqOp, isNull: isNullOp } = await import('drizzle-orm');
    const [owner] = await tx
      .select({ id: payableTable.id })
      .from(payableTable)
      .where(
        andOp(
          eqOp(payableTable.purchaseOrderId, receipt.purchaseOrderId),
          isNullOp(payableTable.cancelledAt),
        ),
      )
      .limit(1);
    if (owner) {
      await payableEvents.record(tx, {
        payableId: owner.id,
        eventCode: 'GOODS_RECEIVED',
        summary: `Goods receipt ${receipt.receiptNo} posted`,
        sourceType: 'goods_receipt',
        sourceId: receipt.id,
        sourceNo: receipt.receiptNo,
        actorUserId: ctx.principal.userId,
      });
      await payables.recomputeStage(tx, owner.id, ctx.principal.userId);
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_receipt.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: 'submitted' },
    after: {
      status: 'executed',
      movements: movementIds.length,
      orderStatus,
      overReceiptAccepted: needsOverride,
    },
    outcome: 'success',
  });

  return { movementIds, orderStatus };
}

/**
 * Moves the order to Partially Received or Received (Appendix B).
 *
 * A line counts as complete when the received quantity reaches the ordered one
 * — an over-receipt completes it too, and a line closed by cancellation (§8.7)
 * is complete by a different route. Both are "nothing further is expected".
 */
export async function refreshOrderStatus(tx: Tx, purchaseOrderId: string): Promise<string> {
  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, purchaseOrderId));

  const stockLines = lines.filter((l) => l.lineType === 'inventory_item');
  if (stockLines.length === 0) return 'approved';

  const complete = stockLines.filter((l) =>
    isLineComplete({
      ordered: parseQuantity(l.quantity),
      received: parseQuantity(l.receivedQuantity),
      closed: parseQuantity(l.closedQuantity),
    }),
  );

  const anyReceived = stockLines.some((l) => parseQuantity(l.receivedQuantity) > 0n);

  const status =
    complete.length === stockLines.length ? 'executed' : anyReceived ? 'partially_executed' : null;

  if (!status) return 'approved';

  await tx
    .update(purchaseOrder)
    .set({ status, updatedAt: new Date() })
    .where(eq(purchaseOrder.id, purchaseOrderId));

  return status;
}

/**
 * §8.4 — the variance report.
 *
 * *"Receipt into a different warehouse allowed, remaining visible as a variance
 * from the source line."* Visible means somewhere a person looks, so it is a
 * query rather than a flag on a screen nobody opens.
 */
export async function warehouseVariances(tx: Tx, purchaseOrderId: string) {
  const rows = await tx
    .select({
      receiptNo: goodsReceipt.receiptNo,
      lineNo: goodsReceiptLine.lineNo,
      itemCode: goodsReceiptLine.itemCode,
      quantity: goodsReceiptLine.quantity,
      orderedWarehouse: purchaseOrderLine.warehouseCode,
      receivedWarehouse: goodsReceiptLine.warehouseCode,
    })
    .from(goodsReceiptLine)
    .innerJoin(goodsReceipt, eq(goodsReceipt.id, goodsReceiptLine.goodsReceiptId))
    .innerJoin(purchaseOrderLine, eq(purchaseOrderLine.id, goodsReceiptLine.purchaseOrderLineId))
    .where(
      and(
        eq(goodsReceipt.purchaseOrderId, purchaseOrderId),
        eq(goodsReceiptLine.warehouseVariance, true),
      ),
    )
    .orderBy(goodsReceipt.receiptNo, goodsReceiptLine.lineNo);

  return rows;
}

/** What is still expected against an order, line by line (§8.4). */
export async function outstanding(tx: Tx, purchaseOrderId: string) {
  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, purchaseOrderId))
    .orderBy(purchaseOrderLine.lineNo);

  return lines.map((line) => {
    const ordered = parseQuantity(line.quantity);
    const received = parseQuantity(line.receivedQuantity);
    const closed = parseQuantity(line.closedQuantity);
    return {
      lineNo: line.lineNo,
      itemCode: line.itemCode,
      ordered,
      received,
      closed,
      ...outstandingQuantity({ ordered, received, closed }),
    };
  });
}

/** §8.4 — configure the tolerance. Manager only; it is a commercial limit. */
export async function setTolerance(
  tx: Tx,
  ctx: ActorContext,
  input: { itemCode?: string | null; percent: string; note?: string | null },
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const itemCode = input.itemCode ?? null;

  if (itemCode) {
    const [known] = await tx.select().from(item).where(eq(item.code, itemCode)).limit(1);
    if (!known) throw new Error(`No item '${itemCode}' to set a receipt tolerance for.`);
  }

  const existing = itemCode
    ? await tx
        .select({ id: purchaseReceiptTolerance.id })
        .from(purchaseReceiptTolerance)
        .where(eq(purchaseReceiptTolerance.itemCode, itemCode))
        .limit(1)
    : await tx
        .select({ id: purchaseReceiptTolerance.id })
        .from(purchaseReceiptTolerance)
        .where(isNull(purchaseReceiptTolerance.itemCode))
        .limit(1);

  if (existing[0]) {
    await tx
      .update(purchaseReceiptTolerance)
      .set({
        overReceiptPercent: input.percent,
        note: input.note ?? null,
        updatedBy: ctx.principal.userId,
        updatedAt: new Date(),
      })
      .where(eq(purchaseReceiptTolerance.id, existing[0].id));
  } else {
    await tx.insert(purchaseReceiptTolerance).values({
      itemCode,
      overReceiptPercent: input.percent,
      note: input.note ?? null,
      updatedBy: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'goods_receipt.tolerance_set',
    objectType: PERMISSION_OBJECT,
    objectId: existing[0]?.id ?? null,
    branchCode: ctx.branchCode,
    after: { itemCode, percent: input.percent },
    outcome: 'success',
  });
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/** Whether a warehouse holds stock that is on hand but not saleable (§8.4). */
export async function isQuarantine(tx: Tx, warehouseCode: string): Promise<boolean> {
  const [row] = await tx
    .select({ type: warehouse.warehouseType })
    .from(warehouse)
    .where(eq(warehouse.code, warehouseCode))
    .limit(1);
  return row?.type === 'quarantine';
}


/** §21.6 — the list: what arrived, against which order, into which warehouse. */
export interface GoodsReceiptListRow {
  readonly id: string;
  readonly receiptNo: string;
  readonly status: string;
  readonly orderNo: string | null;
  readonly supplierName: string | null;
  readonly receiptDate: string;
  readonly warehouses: string | null;
  readonly lineCount: number;
}

export interface GoodsReceiptListFilter extends RegisterPaging {
  readonly status?: string | null;
}

/** HD15 — one page of fifty, newest first, with the true count. */
export async function listForScreen(
  tx: Tx,
  filter: GoodsReceiptListFilter = {},
): Promise<RegisterPage<GoodsReceiptListRow>> {
  const from = sql`
      from goods_receipt r
      left join purchase_order o on o.id = r.purchase_order_id
      left join business_partner bp on bp.id = o.supplier_id
     ${whereOf([filter.status ? sql`r.status::text = ${filter.status}` : null])}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select r.id,
               r.receipt_no as "receiptNo",
               r.status::text as status,
               o.order_no as "orderNo",
               bp.legal_name as "supplierName",
               r.receipt_date::text as "receiptDate",
               (select string_agg(distinct l.warehouse_code, ', ')
                  from goods_receipt_line l where l.goods_receipt_id = r.id) as warehouses,
               (select count(*)::int from goods_receipt_line l where l.goods_receipt_id = r.id)
                 as "lineCount"
          ${from}
         order by r.created_at desc, r.id desc
         limit ${limit} offset ${offset}`);
      return result.rows as unknown as GoodsReceiptListRow[];
    },
  });
}

/** §21.6 — the record, by its number. */
export async function viewByNo(tx: Tx, receiptNo: string) {
  const [receipt] = await tx
    .select()
    .from(goodsReceipt)
    .where(eq(goodsReceipt.receiptNo, receiptNo))
    .limit(1);
  if (!receipt) return null;
  const lines = await tx
    .select()
    .from(goodsReceiptLine)
    .where(eq(goodsReceiptLine.goodsReceiptId, receipt.id))
    .orderBy(asc(goodsReceiptLine.lineNo));
  const [order] = receipt.purchaseOrderId
    ? await tx
        .select({ orderNo: purchaseOrder.orderNo })
        .from(purchaseOrder)
        .where(eq(purchaseOrder.id, receipt.purchaseOrderId))
        .limit(1)
    : [];
  return { receipt, lines, orderNo: order?.orderNo ?? null };
}
