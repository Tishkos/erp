/**
 * Delivery Note — Phase 06.5, §7.2 and §7.4.
 *
 * The document that turns reserved stock into delivered stock and a cost of
 * sale. Appendix B: effect **Inventory and COGS**. Appendix C: *"Sales delivery
 * and invoice | Customer A/R; COGS | Sales Revenue; Inventory | Same delivery
 * and invoice date."*
 *
 * **Three things happen together at Delivered, or none of them do** (§24):
 *
 *   1. The order's reservation for the delivered quantity ends — those units are
 *      no longer promised, they are gone.
 *   2. The stock issues at FIFO cost, consuming layers (Phase 04.2).
 *   3. Dr COGS / Cr Inventory posts, in the same transaction as the movement.
 *
 * They share the caller's transaction, so a delivery that half-happened cannot
 * exist. The order matters and is not arbitrary: the reservation is released
 * *first*, because `inventory.issue` checks stock against **Available** — on
 * hand less what is promised — and the units this delivery is carrying are
 * promised to this very order. Issuing before releasing would have the order's
 * own reservation block its own delivery.
 *
 * That ordering is also what makes the 06.5 gate *"delivery consumes the
 * reserved stock, not unreserved stock"* true: with 500 on hand and 100 reserved
 * to this order, delivering 100 leaves 400 on hand and 400 available. Somebody
 * else's 400 was never touched.
 *
 * **Partial deliveries.** §7.2 supports several deliveries against one order, so
 * a partial delivery releases the whole reservation row and re-reserves the
 * remainder. The released row keeps its reason, which is why it is not simply
 * decremented: *"released 100, of which 60 delivered"* is the audit answer, and
 * a mutated quantity would not give it (§5.4).
 */
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  deliveryNote,
  deliveryNoteLine,
  deliveryNoteLineUnit,
  inventoryMovement,
  pickList,
  pickListLine,
  pickListLineUnit,
  proofOfDelivery,
  proofOfDeliveryPhoto,
  salesOrder,
  salesOrderLine,
  stockReservation,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { toDecimalString } from '../domain/money';
import {
  assertProofOfDeliveryComplete,
  assertWithinOrdered,
  orderStatusAfterDelivery,
} from '../domain/delivery';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as pick from './pick-list';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'delivery_note';
export const DOCUMENT_TYPE = 'delivery_note';
const SEQUENCE_KEY = 'DELIVERY_NOTE';

export class PickListNotDeliverableError extends Error {
  readonly code = 'PICK_LIST_NOT_DELIVERABLE';

  constructor(
    readonly pickListNo: string,
    readonly status: string,
  ) {
    super(
      `Pick list ${pickListNo} is '${status}'. A Delivery Note carries the units a picker took off ` +
        'the shelf, so the sheet must be Picked before there is anything to deliver (§7.2).',
    );
    this.name = 'PickListNotDeliverableError';
  }
}

export class AlreadyDeliveredError extends Error {
  readonly code = 'PICK_LIST_ALREADY_DELIVERED';

  constructor(
    readonly pickListNo: string,
    readonly deliveryNoteNo: string,
  ) {
    super(
      `Pick list ${pickListNo} was already delivered on ${deliveryNoteNo}. ` +
        'A second note against the same pick would send the same units twice.',
    );
    this.name = 'AlreadyDeliveredError';
  }
}

export class NotDeliveredError extends Error {
  readonly code = 'DELIVERY_NOT_DELIVERED';

  constructor(
    readonly deliveryNoteNo: string,
    readonly status: string,
  ) {
    super(
      `Delivery Note ${deliveryNoteNo} is '${status}', so there is nothing to reverse or invoice yet.`,
    );
    this.name = 'NotDeliveredError';
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * How much of each order line has been delivered.
 *
 * Reversed notes do not count — the goods came back and the posting was undone,
 * so the line owes what it owed before.
 */
async function deliveredAgainst(tx: Tx, salesOrderLineIds: readonly string[]) {
  if (salesOrderLineIds.length === 0) return new Map<string, bigint>();

  const rows = await tx
    .select({
      salesOrderLineId: deliveryNoteLine.salesOrderLineId,
      delivered: sql<string>`sum(${deliveryNoteLine.quantity})`,
    })
    .from(deliveryNoteLine)
    .innerJoin(deliveryNote, eq(deliveryNote.id, deliveryNoteLine.deliveryNoteId))
    .where(
      and(
        inArray(deliveryNoteLine.salesOrderLineId, [...salesOrderLineIds]),
        ne(deliveryNote.status, 'reversed'),
      ),
    )
    .groupBy(deliveryNoteLine.salesOrderLineId);

  return new Map(rows.map((r) => [r.salesOrderLineId, parseQuantity(r.delivered ?? '0')]));
}

// ---------------------------------------------------------------------------
// Create — from a picked sheet
// ---------------------------------------------------------------------------

export interface CreateDeliveryNoteInput {
  readonly pickListId: string;
  readonly deliveryDate: string;
  readonly deliveryLocation?: string | null;
  readonly note?: string | null;
}

/**
 * Raises a note for everything on a picked sheet.
 *
 * There is no line input: the note carries what the picker picked, including
 * the serials they scanned. Letting the caller restate the quantities would
 * create a second opinion about what is in the van, and §9.9's traceability
 * depends on there being only one.
 */
export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateDeliveryNoteInput,
): Promise<{ id: string; deliveryNoteNo: string }> {
  const [sheet] = await tx.select().from(pickList).where(eq(pickList.id, input.pickListId)).limit(1);
  if (!sheet) throw new Error(`No pick list with id '${input.pickListId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: sheet.branchCode,
  });

  if (sheet.status !== 'executed') {
    throw new PickListNotDeliverableError(sheet.pickListNo, sheet.status);
  }

  const [existing] = await tx
    .select({ deliveryNoteNo: deliveryNote.deliveryNoteNo })
    .from(deliveryNote)
    .where(and(eq(deliveryNote.pickListId, sheet.id), ne(deliveryNote.status, 'reversed')))
    .limit(1);

  if (existing) throw new AlreadyDeliveredError(sheet.pickListNo, existing.deliveryNoteNo);

  const sheetLines = await tx
    .select()
    .from(pickListLine)
    .where(eq(pickListLine.pickListId, sheet.id))
    .orderBy(pickListLine.lineNo);

  const picked = sheetLines.filter((line) => parseQuantity(line.pickedQuantity) > 0n);

  if (picked.length === 0) {
    throw new Error(
      `Nothing was picked on ${sheet.pickListNo}, so there is nothing to deliver. ` +
        'A sheet that found no stock is a shortfall for the warehouse, not a delivery.',
    );
  }

  const delivered = await deliveredAgainst(
    tx,
    picked.map((line) => line.salesOrderLineId),
  );

  const [order] = await tx
    .select()
    .from(salesOrder)
    .where(eq(salesOrder.id, sheet.salesOrderId))
    .limit(1);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: sheet.branchCode, year: Number(input.deliveryDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(deliveryNote)
    .values({
      deliveryNoteNo: allocated.documentNo,
      salesOrderId: sheet.salesOrderId,
      pickListId: sheet.id,
      warehouseCode: sheet.warehouseCode,
      branchCode: sheet.branchCode,
      deliveryDate: input.deliveryDate,
      deliveryLocation: input.deliveryLocation ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: deliveryNote.id });

  for (const [index, line] of picked.entries()) {
    const quantity = parseQuantity(line.pickedQuantity);

    const [ordered] = await tx
      .select()
      .from(salesOrderLine)
      .where(eq(salesOrderLine.id, line.salesOrderLineId))
      .limit(1);

    // §7.7 — the delivery reconciles to the order, cumulatively across notes.
    assertWithinOrdered(
      line.itemCode,
      {
        ordered: parseQuantity(ordered!.quantity),
        alreadyDelivered: delivered.get(line.salesOrderLineId) ?? 0n,
        picked: quantity,
      },
      quantity,
    );

    const [noteLine] = await tx
      .insert(deliveryNoteLine)
      .values({
        deliveryNoteId: created!.id,
        lineNo: index + 1,
        salesOrderLineId: line.salesOrderLineId,
        pickListLineId: line.id,
        itemCode: line.itemCode,
        description: line.description,
        uomCode: line.uomCode,
        quantity: formatQuantity(quantity),
      })
      .returning({ id: deliveryNoteLine.id });

    // The identified units, copied down rather than joined to. See the schema.
    const units = await tx
      .select()
      .from(pickListLineUnit)
      .where(eq(pickListLineUnit.pickListLineId, line.id));

    for (const unit of units) {
      await tx.insert(deliveryNoteLineUnit).values({
        deliveryNoteLineId: noteLine!.id,
        serialNumber: unit.serialNumber,
        batchNumber: unit.batchNumber,
        quantity: unit.quantity,
      });
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'delivery_note.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: sheet.branchCode,
    outcome: 'success',
    after: {
      deliveryNoteNo: allocated.documentNo,
      salesOrderNo: order?.orderNo ?? null,
      pickListNo: sheet.pickListNo,
      lines: picked.length,
    },
  });

  return { id: created!.id, deliveryNoteNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// Approve — draft → approved
// ---------------------------------------------------------------------------

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const note = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: note.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, note.status, 'approved');

  await tx
    .update(deliveryNote)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(deliveryNote.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'delivery_note.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: note.branchCode,
    outcome: 'success',
    before: { status: note.status },
    after: { status: 'approved' },
  });
}

// ---------------------------------------------------------------------------
// Proof of Delivery — §7.2
// ---------------------------------------------------------------------------

export interface ProofOfDeliveryInput {
  readonly recipientName: string;
  readonly recipientRole?: string | null;
  readonly signatureAttachmentId: string;
  readonly photoAttachmentIds: readonly string[];
  readonly receivedAt: Date;
  readonly note?: string | null;
}

/**
 * Records the proof — §7.2's four elements.
 *
 * Separate from `deliver()` because it is a separate act by a separate person:
 * the driver at the customer's door, not the clerk in the warehouse. `deliver()`
 * then refuses to proceed without it, which is how *"shall capture"* becomes a
 * property of the system rather than a habit.
 */
export async function recordProofOfDelivery(
  tx: Tx,
  ctx: ActorContext,
  deliveryNoteId: string,
  input: ProofOfDeliveryInput,
): Promise<{ id: string }> {
  const note = await load(tx, deliveryNoteId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: note.branchCode,
    objectId: deliveryNoteId,
  });

  if (note.status !== 'approved') {
    throw new Error(
      `Delivery Note ${note.deliveryNoteNo} is '${note.status}'. A Proof of Delivery is recorded ` +
        'against an approved note — before approval there is nothing the customer has been given.',
    );
  }

  assertProofOfDeliveryComplete({
    recipientName: input.recipientName,
    signatureAttachmentId: input.signatureAttachmentId,
    photoCount: input.photoAttachmentIds.length,
  });

  const [pod] = await tx
    .insert(proofOfDelivery)
    .values({
      deliveryNoteId,
      recipientName: input.recipientName.trim(),
      recipientRole: input.recipientRole ?? null,
      signatureAttachmentId: input.signatureAttachmentId,
      receivedAt: input.receivedAt,
      capturedBy: ctx.principal.userId,
      note: input.note ?? null,
    })
    .returning({ id: proofOfDelivery.id });

  for (const [index, attachmentId] of input.photoAttachmentIds.entries()) {
    await tx.insert(proofOfDeliveryPhoto).values({
      proofOfDeliveryId: pod!.id,
      attachmentId,
      sequence: index + 1,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'delivery_note.proof_recorded',
    objectType: PERMISSION_OBJECT,
    objectId: deliveryNoteId,
    branchCode: note.branchCode,
    outcome: 'success',
    after: {
      recipientName: input.recipientName.trim(),
      photos: input.photoAttachmentIds.length,
      receivedAt: input.receivedAt.toISOString(),
    },
  });

  return { id: pod!.id };
}

/** The proof, if there is one — for the record page and for `deliver()`. */
export async function proofFor(tx: Tx, deliveryNoteId: string) {
  const [pod] = await tx
    .select()
    .from(proofOfDelivery)
    .where(eq(proofOfDelivery.deliveryNoteId, deliveryNoteId))
    .limit(1);

  if (!pod) return null;

  const photos = await tx
    .select()
    .from(proofOfDeliveryPhoto)
    .where(eq(proofOfDeliveryPhoto.proofOfDeliveryId, pod.id))
    .orderBy(proofOfDeliveryPhoto.sequence);

  return { ...pod, photos };
}

// ---------------------------------------------------------------------------
// Deliver — approved → executed. The stock moves and COGS posts.
// ---------------------------------------------------------------------------

export async function deliver(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ cogsIqd: bigint; movementIds: string[] }> {
  const note = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: note.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, note.status, 'executed');

  // §7.2 — the proof is a precondition of the delivery, not a follow-up to it.
  const pod = await proofFor(tx, id);
  assertProofOfDeliveryComplete({
    recipientName: pod?.recipientName ?? null,
    signatureAttachmentId: pod?.signatureAttachmentId ?? null,
    photoCount: pod?.photos.length ?? 0,
  });

  const lines = await tx
    .select()
    .from(deliveryNoteLine)
    .where(eq(deliveryNoteLine.deliveryNoteId, id))
    .orderBy(deliveryNoteLine.lineNo);

  const [order] = await tx
    .select()
    .from(salesOrder)
    .where(eq(salesOrder.id, note.salesOrderId))
    .limit(1);

  // The business-partner dimension is the customer's *code*, not its id: §4.2's
  // dimension values are the codes a person reads on a report.
  const [customer] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, order!.customerId))
    .limit(1);

  const customerCode = customer?.code ?? null;

  let totalCogs = 0n;
  const movementIds: string[] = [];

  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);

    const [ordered] = await tx
      .select()
      .from(salesOrderLine)
      .where(eq(salesOrderLine.id, line.salesOrderLineId))
      .limit(1);

    // 1. End the promise for what is leaving, and re-promise what is not.
    //
    // The reservation is released whole and the remainder re-reserved, rather
    // than decremented: §5.4's question afterwards is "who let this stock go,
    // when, and why", and a quantity that was edited in place answers none of
    // it.
    await releaseAndRebook(tx, ctx, {
      salesOrderId: note.salesOrderId,
      salesOrderLineId: line.salesOrderLineId,
      itemCode: line.itemCode,
      warehouseCode: note.warehouseCode,
      branchCode: ordered!.branchCode,
      delivering: quantity,
      deliveryNoteNo: note.deliveryNoteNo,
    });

    // 2 and 3. The stock issues at FIFO cost and the posting is made in the
    // same transaction — Appendix C's Dr COGS / Cr Inventory.
    const units = await tx
      .select()
      .from(deliveryNoteLineUnit)
      .where(eq(deliveryNoteLineUnit.deliveryNoteLineId, line.id));

    // An identified item issues per unit, so each serial's movement carries its
    // own identity. §9.9 traces a serial, not a line.
    const movements = units.length > 0 ? units : [{ serialNumber: null, batchNumber: null, quantity: line.quantity }];

    let lineCogs = 0n;

    for (const unit of movements) {
      const result = await inventory.issue(
        tx,
        { principal: ctx.principal, branchCode: ordered!.branchCode },
        {
          itemCode: line.itemCode,
          warehouseCode: note.warehouseCode,
          branchCode: ordered!.branchCode,
          quantity: parseQuantity(unit.quantity),
          movementDate: note.deliveryDate,
          kind: 'delivery',
          sourceDocumentType: DOCUMENT_TYPE,
          sourceDocumentId: id,
          sourceLineId: line.id,
          serialNumber: unit.serialNumber,
          batchNumber: unit.batchNumber,
          post: true,
          // §4.2 — from the Sales Order, which is where the sale was
          // attributed. The COGS account requires department and business line
          // by default (migration 0005), and neither is something a delivery
          // could work out on its own.
          dimensions: {
            department: order?.departmentCode ?? null,
            business_line: order?.businessLineCode ?? null,
            business_partner: customerCode,
          },
        },
      );

      lineCogs += result.costIqd ?? 0n;
      movementIds.push(result.movementId);
    }

    totalCogs += lineCogs;

    await tx
      .update(deliveryNoteLine)
      .set({ cogsIqd: toDecimalString(lineCogs, 4n), inventoryMovementId: movementIds.at(-1) ?? null })
      .where(eq(deliveryNoteLine.id, line.id));

    // The order line's running total. §7.7 — this is what the invoice is
    // measured against.
    await tx
      .update(salesOrderLine)
      .set({
        deliveredQuantity: formatQuantity(parseQuantity(ordered!.deliveredQuantity) + quantity),
      })
      .where(eq(salesOrderLine.id, line.salesOrderLineId));
  }

  // The journal the movements posted into. One per delivery, because every
  // movement in this transaction carried the same source document — so `max`
  // here is picking the only value there is, not choosing between two.
  const [posted] = await tx
    .select({ journalEntryId: sql<string | null>`max(${inventoryMovement.journalEntryId}::text)` })
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.sourceDocumentType, DOCUMENT_TYPE),
        eq(inventoryMovement.sourceDocumentId, id),
      ),
    );

  await tx
    .update(deliveryNote)
    .set({
      status: 'executed',
      deliveredBy: ctx.principal.userId,
      deliveredAt: new Date(),
      cogsIqd: toDecimalString(totalCogs, 4n),
      journalEntryId: posted?.journalEntryId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(deliveryNote.id, id));

  // The pick sheet's job is done — Appendix B's *Completed*.
  await pick.complete(tx, ctx, note.pickListId);

  await advanceOrderStatus(tx, ctx, note.salesOrderId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'delivery_note.delivered',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: note.branchCode,
    outcome: 'success',
    before: { status: note.status },
    after: {
      status: 'executed',
      cogsIqd: toDecimalString(totalCogs, 4n),
      movements: movementIds.length,
    },
  });

  return { cogsIqd: totalCogs, movementIds };
}

/**
 * Releases this order line's live reservation and re-reserves what is left.
 *
 * See the note in `deliver()`: whole-row release keeps the audit answer intact.
 */
async function releaseAndRebook(
  tx: Tx,
  ctx: ActorContext,
  input: {
    salesOrderId: string;
    salesOrderLineId: string;
    itemCode: string;
    warehouseCode: string;
    branchCode: string;
    delivering: bigint;
    deliveryNoteNo: string;
  },
): Promise<void> {
  const rows = await tx
    .select({ id: stockReservation.id, quantity: stockReservation.quantity })
    .from(stockReservation)
    .where(
      and(
        eq(stockReservation.documentType, 'sales_order'),
        eq(stockReservation.documentId, input.salesOrderId),
        eq(stockReservation.documentLineId, input.salesOrderLineId),
        isNull(stockReservation.releasedAt),
      ),
    );

  const reserved = rows.reduce((total, row) => total + parseQuantity(row.quantity), 0n);

  for (const row of rows) {
    await inventory.releaseReservation(
      tx,
      ctx,
      row.id,
      `Delivered on ${input.deliveryNoteNo}: ${formatQuantity(input.delivering)} of ${formatQuantity(reserved)} reserved.`,
    );
  }

  const remainder = reserved - input.delivering;
  if (remainder > 0n) {
    await inventory.reserve(tx, ctx, {
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      branchCode: input.branchCode,
      quantity: remainder,
      documentType: 'sales_order',
      documentId: input.salesOrderId,
      documentLineId: input.salesOrderLineId,
    });
  }
}

/**
 * Moves the order to Partially Delivered or Delivered — Appendix B.
 *
 * Derived from the lines by `orderStatusAfterDelivery`, so the order cannot
 * claim to be delivered while a line still owes something.
 */
async function advanceOrderStatus(tx: Tx, ctx: ActorContext, salesOrderId: string): Promise<void> {
  const lines = await tx
    .select()
    .from(salesOrderLine)
    .where(eq(salesOrderLine.salesOrderId, salesOrderId));

  const target = orderStatusAfterDelivery(
    lines.map((line) => ({
      ordered: parseQuantity(line.quantity),
      delivered: parseQuantity(line.deliveredQuantity),
    })),
  );

  if (!target) return;

  const [order] = await tx.select().from(salesOrder).where(eq(salesOrder.id, salesOrderId)).limit(1);
  if (!order || order.status === target) return;

  await statuses.assertTransitionAllowed(tx, 'sales_order', order.status, target);

  await tx
    .update(salesOrder)
    .set({ status: target, updatedAt: new Date() })
    .where(eq(salesOrder.id, salesOrderId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `sales_order.${target}`,
    objectType: 'sales_order',
    objectId: salesOrderId,
    branchCode: order.branchCode,
    outcome: 'success',
    before: { status: order.status },
    after: { status: target },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [note] = await tx.select().from(deliveryNote).where(eq(deliveryNote.id, id)).limit(1);
  if (!note) throw new Error(`No delivery note with id '${id}'.`);
  return note;
}

export async function view(tx: Tx, id: string) {
  const note = await load(tx, id);

  const lines = await tx
    .select()
    .from(deliveryNoteLine)
    .where(eq(deliveryNoteLine.deliveryNoteId, id))
    .orderBy(deliveryNoteLine.lineNo);

  const units = await tx
    .select({
      deliveryNoteLineId: deliveryNoteLineUnit.deliveryNoteLineId,
      itemCode: deliveryNoteLine.itemCode,
      serialNumber: deliveryNoteLineUnit.serialNumber,
      batchNumber: deliveryNoteLineUnit.batchNumber,
      quantity: deliveryNoteLineUnit.quantity,
    })
    .from(deliveryNoteLineUnit)
    .innerJoin(deliveryNoteLine, eq(deliveryNoteLine.id, deliveryNoteLineUnit.deliveryNoteLineId))
    .where(eq(deliveryNoteLine.deliveryNoteId, id))
    .orderBy(deliveryNoteLine.lineNo);

  return { ...note, lines, units, proof: await proofFor(tx, id) };
}

/**
 * §7.7 — *"reservation, delivery, invoice and receipt quantities reconcile to
 * the source Sales Order."*
 *
 * One row per order line: what was ordered, reserved, picked, delivered and
 * invoiced. The reconciliation the gate asks for, as a query rather than as a
 * claim, so anyone can check it in a second.
 */
export async function reconcileToOrder(tx: Tx, salesOrderId: string) {
  const result = await tx.execute(sql`
    select l.line_no                                        as "lineNo",
           l.item_code                                      as "itemCode",
           l.quantity::text                                 as "ordered",
           -- The **live** reservation, not the column the order set at approval.
           -- Delivering releases the promise, and a report that still showed 100
           -- reserved against a fully delivered line would contradict the stock
           -- position on the next screen (§7.7 asks these to reconcile).
           coalesce((select sum(r.quantity)
                       from stock_reservation r
                      where r.document_type = 'sales_order'
                        and r.document_line_id = l.id::text
                        and r.released_at is null), 0::numeric(24,6))::text as "reserved",
           coalesce((select sum(pl.picked_quantity)
                       from pick_list_line pl
                       join pick_list p on p.id = pl.pick_list_id
                      where pl.sales_order_line_id = l.id
                        and p.status <> 'cancelled'), 0)::text as "picked",
           l.delivered_quantity::text                       as "delivered",
           l.invoiced_quantity::text                        as "invoiced"
      from sales_order_line l
     where l.sales_order_id = ${salesOrderId}
     order by l.line_no
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}
