/**
 * Invoice Status Tracking — Operations build, block 8 (2026-09-12).
 *
 *   In Process   A Purchase Invoice is automatically copied to this section
 *                with all invoice details. The items are booked to the In
 *                Process warehouse.
 *   On Board     the items are moved to the On Board warehouse.
 *   On Port      the items are moved to the On Port warehouse.
 *   In Bounded   a warehouse must be selected, and the items are moved there.
 *   Notification Every status change notifies the selected system users.
 *
 * Goods bought abroad belong to the company for months before anybody can
 * touch them. They are paid for, they are on a ship, and they are in no
 * warehouse a picker can walk into — but they are stock, and a balance sheet
 * that leaves them out is wrong by whatever is at sea. This follows them from
 * the invoice to the shelf.
 *
 * ── Nothing is copied ──────────────────────────────────────────────────────
 * "Copied to this section with all invoice details" is a screen reading the
 * invoice it points at. A second set of figures beside the first is a second
 * set of figures that can disagree with it — and when they do, nobody can say
 * which is the shipment and which is the debt.
 *
 * ── A status change is a transfer ──────────────────────────────────────────
 * Moving the status moves the goods, in the same transaction, through the same
 * inventory engine every other movement uses: issued out of the warehouse they
 * were in, received into the next, at the cost they already carry. The
 * shipment does not value anything itself. A stage that valued its own stock
 * would be a second opinion about what the company paid.
 *
 * Which warehouse is "the On Board warehouse" is a property of the warehouse,
 * the way being a transit warehouse already is — see 0190. Two warehouses
 * cannot both claim a stage.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  businessPartner,
  costLayer,
  inventoryMovement,
  shipmentWatcher,
  supplierShipment,
  warehouse,
} from '../db/schema';
import { parseQuantity } from '../domain/uom';
import { parseDecimal } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as notifications from './notifications';
import * as inventory from './inventory';

export const PERMISSION_OBJECT = 'supplier_shipment';

/** The stages, in the order goods pass through them. */
export const SHIPMENT_STATUSES = ['in_process', 'on_board', 'on_port', 'in_bounded'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** The three stages that name a warehouse of their own. The fourth is chosen. */
const STAGE_OF = {
  in_process: 'in_process',
  on_board: 'on_board',
  on_port: 'on_port',
} as const;

export class ShipmentError extends Error {
  readonly code = 'SHIPMENT';

  constructor(detail: string) {
    super(detail);
    this.name = 'ShipmentError';
  }
}

/** The warehouse that holds one stage, or nothing when none has been set up. */
export async function warehouseForStage(
  tx: Tx,
  stage: keyof typeof STAGE_OF,
): Promise<string | null> {
  const [row] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(eq(warehouse.shipmentStage, STAGE_OF[stage]))
    .limit(1);
  return row?.code ?? null;
}

/**
 * Opens tracking for a purchase invoice that received into the In Process
 * warehouse.
 *
 * Called when the invoice posts. Whether a shipment is tracked is not a flag
 * somebody sets: goods that landed in the In Process warehouse *are* in
 * process, and goods that landed anywhere else arrived by other means and have
 * nothing to track. Invoices that are neither are left alone, silently,
 * because most of them are.
 */
export async function openForInvoice(
  tx: Tx,
  ctx: ActorContext,
  apInvoiceId: string,
): Promise<{ id: string } | null> {
  const inProcess = await warehouseForStage(tx, 'in_process');
  if (!inProcess) return null;

  const [invoice] = await tx
    .select({ id: apInvoice.id, invoiceNo: apInvoice.invoiceNo, branchCode: apInvoice.branchCode })
    .from(apInvoice)
    .where(eq(apInvoice.id, apInvoiceId))
    .limit(1);
  if (!invoice) return null;

  const [landed] = await tx
    .select({ id: apInvoiceLine.id })
    .from(apInvoiceLine)
    .where(
      and(eq(apInvoiceLine.apInvoiceId, apInvoiceId), eq(apInvoiceLine.warehouseCode, inProcess)),
    )
    .limit(1);
  if (!landed) return null;

  const [existing] = await tx
    .select({ id: supplierShipment.id })
    .from(supplierShipment)
    .where(eq(supplierShipment.apInvoiceId, apInvoiceId))
    .limit(1);
  if (existing) return { id: existing.id };

  const [created] = await tx
    .insert(supplierShipment)
    .values({
      apInvoiceId,
      status: 'in_process',
      warehouseCode: inProcess,
      branchCode: invoice.branchCode,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: supplierShipment.id });

  await tell(tx, ctx, {
    shipmentId: created!.id,
    branchCode: invoice.branchCode,
    subject: `Shipment opened — ${invoice.invoiceNo}`,
    body: `Purchase invoice ${invoice.invoiceNo} is in process. The goods are in ${inProcess}.`,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_shipment.opened',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: invoice.branchCode,
    after: { status: 'in_process', warehouseCode: inProcess, apInvoiceId },
    outcome: 'success',
  });

  return { id: created!.id };
}

/**
 * Moves a shipment to its next stage, and the goods with it.
 *
 * Forward only, one stage at a time. A container cannot un-dock, and letting a
 * status jump backwards would ask the warehouse to receive goods it had never
 * issued — the inventory engine would refuse, but later and less clearly than
 * this does.
 */
export async function advance(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  to: ShipmentStatus,
  /** Required for `in_bounded`: the warehouse the goods finally land in. */
  destinationWarehouseCode?: string | null,
): Promise<void> {
  // Held `for update` until the move commits. Two advances of one shipment
  // arriving together would each read the same stage and each try to carry
  // the goods on; the inventory lock would stop the second, but late and with
  // a message about stock rather than about the stage. Held here, the second
  // waits, reads the new stage, and is told the goods have already moved.
  const [shipment] = await tx
    .select()
    .from(supplierShipment)
    .where(eq(supplierShipment.id, id))
    .limit(1)
    .for('update');
  if (!shipment) throw new ShipmentError(`No shipment '${id}'.`);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: shipment.branchCode,
    objectId: id,
  });

  // An invoice reversed after it opened tracking took its goods with it —
  // the receipt was undone, so there is nothing on this shipment to move.
  const [behind] = await tx
    .select({ status: apInvoice.status, invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(eq(apInvoice.id, shipment.apInvoiceId))
    .limit(1);
  if (behind?.status === 'reversed') {
    throw new ShipmentError(
      `Purchase invoice ${behind.invoiceNo} was reversed, so this shipment carries nothing. There is no stage to move it to.`,
    );
  }

  const from = shipment.status as ShipmentStatus;
  const next = SHIPMENT_STATUSES[SHIPMENT_STATUSES.indexOf(from) + 1];
  if (to !== next) {
    throw new ShipmentError(
      from === 'in_bounded'
        ? 'These goods have arrived. A shipment ends when it is in bounded.'
        : `A shipment goes from ${from} to ${next}, one stage at a time. Goods do not un-ship.`,
    );
  }

  // Where they are going. The three stages name their own warehouse; the last
  // is chosen, because bonded goods go wherever there is room for them.
  const destination =
    to === 'in_bounded'
      ? destinationWarehouseCode?.trim() || null
      : await warehouseForStage(tx, to as keyof typeof STAGE_OF);

  if (!destination) {
    throw new ShipmentError(
      to === 'in_bounded'
        ? 'Choose the warehouse these goods are going into. In bounded is the stage where they stop being a shipment and start being stock somebody can pick.'
        : `No warehouse is set up for ${to}. Mark one on the Warehouses screen before moving a shipment into it.`,
    );
  }

  const [exists] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(eq(warehouse.code, destination))
    .limit(1);
  if (!exists) throw new ShipmentError(`No warehouse '${destination}'.`);

  await move(tx, ctx, shipment.apInvoiceId, shipment.warehouseCode, destination, shipment.branchCode);

  await tx
    .update(supplierShipment)
    .set({ status: to, warehouseCode: destination, updatedAt: new Date() })
    .where(eq(supplierShipment.id, id));

  const [invoice] = await tx
    .select({ invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(eq(apInvoice.id, shipment.apInvoiceId))
    .limit(1);

  await tell(tx, ctx, {
    shipmentId: id,
    branchCode: shipment.branchCode,
    subject: `Shipment ${to.replace('_', ' ')} — ${invoice?.invoiceNo ?? ''}`,
    body: `The goods on ${invoice?.invoiceNo ?? 'this invoice'} moved from ${shipment.warehouseCode} to ${destination}.`,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_shipment.advanced',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: shipment.branchCode,
    before: { status: from, warehouseCode: shipment.warehouseCode },
    after: { status: to, warehouseCode: destination },
    outcome: 'success',
  });
}

/**
 * Carries every line of the invoice from one warehouse to the next.
 *
 * Only this invoice's own goods, and all of them: the layers its lines created
 * when it posted, followed stage by stage. Taking "the oldest stock in the In
 * Process warehouse" instead would ship another supplier's panels under this
 * invoice's name whenever two containers were in process at once.
 *
 * Each layer keeps its unit cost, its supplier and its FIFO date wherever it
 * goes (`inventory.relocate`). A stage that priced its own stock would be a
 * second opinion about what the company paid; a stage that forgot the
 * supplier would land the goods where a sale that names that supplier —
 * block 5 — could not find them.
 *
 * Only the lines that went into the warehouse the shipment is leaving. An
 * invoice can carry freight and services beside the goods, and those never
 * boarded anything. A line part-sold out of a staging warehouse moves what is
 * left rather than failing the whole shipment.
 */
async function move(
  tx: Tx,
  ctx: ActorContext,
  apInvoiceId: string,
  fromWarehouse: string,
  toWarehouse: string,
  branchCode: string,
): Promise<void> {
  const lines = await tx
    .select({
      id: apInvoiceLine.id,
      itemCode: apInvoiceLine.itemCode,
      quantity: apInvoiceLine.quantity,
    })
    .from(apInvoiceLine)
    .where(eq(apInvoiceLine.apInvoiceId, apInvoiceId))
    .orderBy(asc(apInvoiceLine.lineNo));

  const [invoice] = await tx
    .select({ invoiceDate: apInvoice.invoiceDate })
    .from(apInvoice)
    .where(eq(apInvoice.id, apInvoiceId))
    .limit(1);
  const movementDate = invoice?.invoiceDate ?? new Date().toISOString().slice(0, 10);

  for (const line of lines) {
    if (!line.itemCode) continue;

    const layers = await layersOfLine(tx, apInvoiceId, line.id, fromWarehouse);
    await inventory.relocate(tx, ctx, {
      itemCode: line.itemCode,
      fromWarehouseCode: fromWarehouse,
      toWarehouseCode: toWarehouse,
      branchCode,
      quantity: parseQuantity(line.quantity),
      movementDate,
      layers,
      sourceDocumentType: PERMISSION_OBJECT,
      sourceDocumentId: apInvoiceId,
      sourceLineId: line.id,
    });
  }
}

/**
 * The layers one invoice line has standing in one warehouse, oldest first.
 *
 * A layer belongs to the line whose movement created it: the invoice's own
 * receipt into In Process, then each stage's receipt after that — every one of
 * them written with the invoice as its source document and the line as its
 * source line.
 */
async function layersOfLine(
  tx: Tx,
  apInvoiceId: string,
  lineId: string,
  warehouseCode: string,
): Promise<inventory.StockLayer[]> {
  const rows = await tx
    .select({
      id: costLayer.id,
      itemCode: costLayer.itemCode,
      warehouseCode: costLayer.warehouseCode,
      layerDate: costLayer.layerDate,
      sequence: costLayer.sequence,
      originalQuantity: costLayer.originalQuantity,
      remainingQuantity: costLayer.remainingQuantity,
      unitCostIqd: costLayer.unitCostIqd,
      supplierId: costLayer.supplierId,
    })
    .from(costLayer)
    .innerJoin(inventoryMovement, eq(inventoryMovement.id, costLayer.createdByMovementId))
    .where(
      and(
        eq(costLayer.warehouseCode, warehouseCode),
        eq(inventoryMovement.sourceDocumentId, apInvoiceId),
        eq(inventoryMovement.sourceLineId, lineId),
        sql`${costLayer.remainingQuantity} > 0`,
      ),
    )
    .orderBy(asc(costLayer.layerDate), asc(costLayer.sequence));

  return rows.map((row) => ({
    ...row,
    originalQuantity: parseQuantity(row.originalQuantity),
    remainingQuantity: parseQuantity(row.remainingQuantity),
    unitCostIqd: parseDecimal(row.unitCostIqd, 4n),
  }));
}

/**
 * Tells the people who asked to be told.
 *
 * Selected once per branch rather than named on each shipment: the people who
 * need to know a container has docked are the same people every time, and
 * asking whoever moves the status to remember them is how somebody stops being
 * told.
 */
async function tell(
  tx: Tx,
  ctx: ActorContext,
  message: { shipmentId: string; branchCode: string; subject: string; body: string },
): Promise<number> {
  const watchers = await tx
    .select({ userId: shipmentWatcher.userId })
    .from(shipmentWatcher)
    .where(eq(shipmentWatcher.branchCode, message.branchCode));

  let sent = 0;
  for (const watcher of watchers) {
    const inserted = await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: 'shipment.status_changed',
      objectType: PERMISSION_OBJECT,
      objectId: message.shipmentId,
      recipientUserId: watcher.userId,
      subject: message.subject,
      body: message.body,
      context: { shipmentId: message.shipmentId },
      // One per recipient per status change: the subject carries the stage,
      // so moving on and moving back would be two messages, not one
      // suppressed.
      dedupeKey: `shipment:${message.shipmentId}:${message.subject}:${watcher.userId}`,
      branchCode: message.branchCode,
    });
    if (inserted !== null) sent += 1;
  }
  return sent;
}

/** Who is told when a shipment moves, in this branch. */
export async function watchers(tx: Tx, branchCode: string) {
  return tx
    .select({ userId: shipmentWatcher.userId })
    .from(shipmentWatcher)
    .where(eq(shipmentWatcher.branchCode, branchCode));
}

export async function watch(
  tx: Tx,
  ctx: ActorContext,
  branchCode: string,
  userId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, { branchCode });
  await tx.insert(shipmentWatcher).values({ branchCode, userId }).onConflictDoNothing();
}

export async function unwatch(
  tx: Tx,
  ctx: ActorContext,
  branchCode: string,
  userId: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, { branchCode });
  await tx
    .delete(shipmentWatcher)
    .where(and(eq(shipmentWatcher.branchCode, branchCode), eq(shipmentWatcher.userId, userId)));
}

/**
 * Replaces who is told when a shipment moves in this branch — block 8's
 * "the selected system users", selected on the Invoice Status Tracking screen.
 */
export async function setWatchers(
  tx: Tx,
  ctx: ActorContext,
  branchCode: string,
  userIds: readonly string[],
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, { branchCode });
  const wanted = new Set(userIds.filter(Boolean));
  const current = new Set((await watchers(tx, branchCode)).map((row) => row.userId));
  for (const userId of wanted) {
    if (!current.has(userId)) await watch(tx, ctx, branchCode, userId);
  }
  for (const userId of current) {
    if (!wanted.has(userId)) await unwatch(tx, ctx, branchCode, userId);
  }
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_shipment.watchers_set',
    objectType: PERMISSION_OBJECT,
    objectId: branchCode,
    branchCode,
    before: { users: [...current] },
    after: { users: [...wanted] },
    outcome: 'success',
  });
}

/**
 * The shipments, with the invoice each one is following.
 *
 * The invoice's details are read from the invoice, not held here — see the
 * note at the top of the file.
 */
export async function list(tx: Tx, filter: { status?: ShipmentStatus } = {}) {
  return tx
    .select({
      id: supplierShipment.id,
      status: supplierShipment.status,
      warehouseCode: supplierShipment.warehouseCode,
      warehouseName: warehouse.name,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      invoiceDate: apInvoice.invoiceDate,
      totalIqd: apInvoice.totalIqd,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
      updatedAt: supplierShipment.updatedAt,
    })
    .from(supplierShipment)
    .innerJoin(apInvoice, eq(apInvoice.id, supplierShipment.apInvoiceId))
    .innerJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .innerJoin(warehouse, eq(warehouse.code, supplierShipment.warehouseCode))
    .where(
      and(
        // A reversed invoice's shipment is history, not a container to follow.
        sql`${apInvoice.status} <> 'reversed'`,
        filter.status ? eq(supplierShipment.status, filter.status) : sql`true`,
      ),
    )
    .orderBy(asc(apInvoice.invoiceDate), asc(apInvoice.invoiceNo));
}

/** One shipment, and where its goods are now. */
export async function view(tx: Tx, id: string) {
  const [shipment] = await tx
    .select()
    .from(supplierShipment)
    .where(eq(supplierShipment.id, id))
    .limit(1);
  if (!shipment) throw new ShipmentError(`No shipment '${id}'.`);

  const movements = await tx
    .select({
      kind: inventoryMovement.kind,
      warehouseCode: inventoryMovement.warehouseCode,
      quantity: inventoryMovement.quantity,
      movementDate: inventoryMovement.movementDate,
      itemCode: inventoryMovement.itemCode,
    })
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.sourceDocumentType, PERMISSION_OBJECT),
        eq(inventoryMovement.sourceDocumentId, shipment.apInvoiceId),
      ),
    )
    .orderBy(asc(inventoryMovement.createdAt));

  return { ...shipment, movements };
}
