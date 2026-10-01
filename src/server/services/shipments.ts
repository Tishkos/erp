/**
 * Shipment & warehouse — REQ-AP-001 Stage 5 (§17, §18, §21.9).
 *
 * "Every container on its own." An import's B/Ls list its containers; each
 * container keeps its own ETA and its own dated stages; the models it carries
 * are its lines. When it reaches the warehouse it is received by a
 * **container receipt**, which:
 *
 *   * moves the import's goods out of transit into the warehouse that received
 *     them — the invoice's own FIFO layers, at the cost they already carry,
 *     through the same `inventory.relocate` every other move uses (§17.4: at
 *     sea the goods are owned, not available);
 *   * records received, damaged and short against the plan; anything that did
 *     not arrive whole sets the container Missing / damaged and opens the claim;
 *   * is idempotent on the form's one-time document id (AGENTS.md).
 *
 * The four-stage shipment (Operations block 8) is not used by imports any
 * more; its rows stay readable and its in-flight shipments keep working.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  appUser,
  billOfLading,
  businessPartner,
  containerReceipt,
  containerReceiptLine,
  containerStatus,
  costLayer,
  inventoryMovement,
  payable,
  payableInstalment,
  payableOrderLine,
  port,
  shipmentContainer,
  shipmentContainerLine,
  shipmentContainerStatusHistory,
  warehouse,
} from '../db/schema';
import {
  ShipmentValidationError,
  STAGE_DATE,
  assertReceiptLines,
  assertStatusMove,
  lineVariance,
  parseContainerList,
  progress,
  receiptOutcome,
  spreadEqually,
} from '../domain/shipments';
import { addDays } from '../domain/payment-applications';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as holds from './payable-holds';
import * as inventory from './inventory';
import * as payables from './payables';
import { allocateDocumentNumber } from './numbering';

export const BL_OBJECT = 'bill_of_lading';
export const CONTAINER_OBJECT = 'shipment_container';
export const RECEIPT_DOCUMENT_TYPE = 'container_receipt';

const today = () => new Date().toISOString().slice(0, 10);
const qty = (value: bigint) => formatQuantity(value);

export class ShipmentNotFoundError extends Error {
  readonly code = 'SHIPMENT_NOT_FOUND';
  constructor(ref: string) {
    super(`No B/L or container '${ref}', or it is outside the branches you may see.`);
    this.name = 'ShipmentNotFoundError';
  }
}

async function openImport(tx: Tx, payableId: string) {
  const row = await payables.load(tx, payableId);
  if (row.payableTypeCode !== 'import') {
    throw new ShipmentValidationError(`${row.payableNo} is not an import; only imports are shipped in containers.`);
  }
  if (row.cancelledAt) throw new ShipmentValidationError(`${row.payableNo} is cancelled.`);
  if (row.closedAt) throw new ShipmentValidationError(`${row.payableNo} is cleared.`);
  return row;
}

async function loadContainer(tx: Tx, id: string) {
  const [row] = await tx.select().from(shipmentContainer).where(eq(shipmentContainer.id, id)).limit(1);
  if (!row) throw new ShipmentNotFoundError(id);
  return row;
}

async function liveLines(tx: Tx, containerId: string) {
  return tx
    .select()
    .from(shipmentContainerLine)
    .where(and(eq(shipmentContainerLine.containerId, containerId), isNull(shipmentContainerLine.supersededAt)))
    .orderBy(asc(shipmentContainerLine.lineNo));
}

/** The import's live order lines (the PI), for spreading a plan. */
async function orderLinesOf(tx: Tx, payableId: string) {
  return tx
    .select()
    .from(payableOrderLine)
    .where(and(eq(payableOrderLine.payableId, payableId), isNull(payableOrderLine.supersededAt)))
    .orderBy(asc(payableOrderLine.lineNo));
}

// ---------------------------------------------------------------------------
// §17.1 — the B/L
// ---------------------------------------------------------------------------

export interface CreateBlInput {
  readonly payableId: string;
  readonly blNo: string;
  readonly blDate: string;
  readonly shippingLine?: string | null;
  readonly vessel?: string | null;
  readonly voyage?: string | null;
  readonly portOfLoading?: string | null;
  readonly portOfDischargeCode?: string | null;
  readonly eta?: string | null;
  /** Pasted container numbers. */
  readonly containers?: string | null;
  readonly sizeType?: string | null;
  /**
   * Spread the import's lines equally over these containers (flagged
   * estimated, for the warehouse to confirm — §24.3). Only when this B/L
   * carries the whole order; otherwise load each container's plan.
   */
  readonly spreadLines?: boolean;
}

export async function createBl(tx: Tx, ctx: ActorContext, input: CreateBlInput) {
  const owner = await openImport(tx, input.payableId);
  await authz.authorize(ctx.principal, 'create', BL_OBJECT, { branchCode: owner.branchCode });

  const blNo = input.blNo.trim().toUpperCase();
  if (!blNo) throw new ShipmentValidationError('Give the B/L number as the shipping line issued it.');
  if (!input.blDate) throw new ShipmentValidationError('Give the B/L date.');
  if (input.eta && input.eta < input.blDate) {
    throw new ShipmentValidationError(`An ETA of ${input.eta} is before the B/L was issued on ${input.blDate}.`);
  }
  const [existing] = await tx.select({ id: billOfLading.id }).from(billOfLading).where(eq(billOfLading.blNo, blNo)).limit(1);
  if (existing) throw new ShipmentValidationError(`B/L ${blNo} is already recorded. One B/L, one record.`);
  if (input.portOfDischargeCode) {
    const [known] = await tx.select().from(port).where(eq(port.code, input.portOfDischargeCode)).limit(1);
    if (!known) throw new ShipmentValidationError(`'${input.portOfDischargeCode}' is not a port.`);
  }

  const parsed = parseContainerList(input.containers ?? '');
  if (parsed.invalid.length > 0) {
    throw new ShipmentValidationError(
      `Not container numbers: ${parsed.invalid.join(', ')}. A container number is four letters and seven digits (MSKU1234567).`,
    );
  }

  const [firstBl] = await tx
    .select({ id: billOfLading.id })
    .from(billOfLading)
    .where(and(eq(billOfLading.payableId, owner.id), isNull(billOfLading.cancelledAt)))
    .limit(1);

  const [created] = await tx
    .insert(billOfLading)
    .values({
      payableId: owner.id,
      branchCode: owner.branchCode,
      blNo,
      blDate: input.blDate,
      shippingLine: input.shippingLine?.trim() || null,
      vessel: input.vessel?.trim() || null,
      voyage: input.voyage?.trim() || null,
      portOfLoading: input.portOfLoading?.trim() || null,
      portOfDischargeCode: input.portOfDischargeCode || null,
      eta: input.eta || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: billOfLading.id });

  await events.record(tx, {
    payableId: owner.id,
    eventCode: 'BL_ISSUED',
    summary:
      `B/L ${blNo} issued on ${input.blDate}` +
      (input.vessel ? ` — ${input.vessel.trim()}${input.voyage ? ` / ${input.voyage.trim()}` : ''}` : '') +
      (input.eta ? `, ETA ${input.eta}` : '') +
      (firstBl ? '' : ' — the import is now shipped'),
    sourceType: BL_OBJECT,
    sourceId: created!.id,
    sourceNo: blNo,
    actorUserId: ctx.principal.userId,
  });

  if (parsed.numbers.length > 0) {
    await addContainersTo(tx, ctx, {
      bl: { id: created!.id, blNo, eta: input.eta || null },
      owner,
      numbers: parsed.numbers,
      sizeType: input.sizeType ?? null,
      spreadLines: input.spreadLines ?? false,
    });
  }

  // §15.2 — the B/L triggers get their dates.
  if (!firstBl) await dateInstalmentsFromBl(tx, ctx, owner.id, input.blDate, blNo);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bill_of_lading.created',
    objectType: BL_OBJECT,
    objectId: created!.id,
    branchCode: owner.branchCode,
    after: { blNo, blDate: input.blDate, payableNo: owner.payableNo, containers: parsed.numbers },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, owner.id, ctx.principal.userId);
  return { id: created!.id, blNo, containers: parsed.numbers.length };
}

/** §15.2 — "against B/L" instalments fall due on the B/L date; "days after B/L" that many days later. */
async function dateInstalmentsFromBl(tx: Tx, ctx: ActorContext, payableId: string, blDate: string, blNo: string) {
  const rows = await tx
    .select()
    .from(payableInstalment)
    .where(and(eq(payableInstalment.payableId, payableId), isNull(payableInstalment.supersededAt)));
  const changed: string[] = [];
  for (const row of rows) {
    let expected: string | null = null;
    if (row.triggerCode === 'against_bl_copy' || row.triggerCode === 'against_bl_original') expected = blDate;
    if (row.triggerCode === 'days_after_bl' && row.triggerDays !== null) expected = addDays(blDate, row.triggerDays);
    if (!expected || expected === row.expectedDate) continue;
    await tx.update(payableInstalment).set({ expectedDate: expected }).where(eq(payableInstalment.id, row.id));
    changed.push(`${row.sequence}. ${row.label} → ${expected}`);
  }
  if (changed.length > 0) {
    await events.record(tx, {
      payableId,
      eventCode: 'FIELD_CHANGED',
      summary: `Instalments dated from B/L ${blNo} (${blDate}): ${changed.join(' · ')}`,
      actorUserId: ctx.principal.userId,
    });
  }
}

export async function addContainers(
  tx: Tx,
  ctx: ActorContext,
  blId: string,
  input: { containers: string; sizeType?: string | null },
) {
  const [bl] = await tx.select().from(billOfLading).where(eq(billOfLading.id, blId)).limit(1);
  if (!bl) throw new ShipmentNotFoundError(blId);
  const owner = await openImport(tx, bl.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', BL_OBJECT, { branchCode: owner.branchCode });
  if (bl.cancelledAt) throw new ShipmentValidationError(`B/L ${bl.blNo} is cancelled.`);
  const parsed = parseContainerList(input.containers);
  if (parsed.invalid.length > 0) {
    throw new ShipmentValidationError(`Not container numbers: ${parsed.invalid.join(', ')}.`);
  }
  if (parsed.numbers.length === 0) throw new ShipmentValidationError('Paste at least one container number.');
  await addContainersTo(tx, ctx, {
    bl: { id: bl.id, blNo: bl.blNo, eta: bl.eta },
    owner,
    numbers: parsed.numbers,
    sizeType: input.sizeType ?? null,
    spreadLines: false,
  });
  await payables.recomputeStage(tx, owner.id, ctx.principal.userId);
}

async function addContainersTo(
  tx: Tx,
  ctx: ActorContext,
  input: {
    bl: { id: string; blNo: string; eta: string | null };
    owner: typeof payable.$inferSelect;
    numbers: readonly string[];
    sizeType: string | null;
    spreadLines: boolean;
  },
) {
  const live = await tx
    .select({ containerNo: shipmentContainer.containerNo, blId: shipmentContainer.blId })
    .from(shipmentContainer)
    .where(
      and(
        inArray(shipmentContainer.containerNo, [...input.numbers]),
        isNull(shipmentContainer.receivedOn),
        isNull(shipmentContainer.cancelledAt),
      ),
    );
  if (live.length > 0) {
    throw new ShipmentValidationError(
      `Already on a live B/L: ${live.map((row) => row.containerNo).join(', ')}. ` +
        'A number recurs only after its container has been received (§17.2).',
    );
  }

  const orderLines = input.spreadLines ? await orderLinesOf(tx, input.owner.id) : [];
  const shares = orderLines.map((line) =>
    spreadEqually(line.quantity ? parseQuantity(line.quantity) : 0n, input.numbers.length),
  );

  for (const [index, containerNo] of input.numbers.entries()) {
    const [container] = await tx
      .insert(shipmentContainer)
      .values({
        blId: input.bl.id,
        payableId: input.owner.id,
        branchCode: input.owner.branchCode,
        containerNo,
        sizeType: input.sizeType?.trim() || null,
        eta: input.bl.eta,
        linesEstimated: orderLines.length > 0,
        createdBy: ctx.principal.userId,
      })
      .returning({ id: shipmentContainer.id });
    await tx.insert(shipmentContainerStatusHistory).values({
      containerId: container!.id,
      statusCode: 'not_loaded',
      effectiveDate: today(),
      source: 'user',
      note: `On B/L ${input.bl.blNo}`,
      recordedBy: ctx.principal.userId,
    });
    let lineNo = 0;
    for (const [lineIndex, line] of orderLines.entries()) {
      const planned = shares[lineIndex]![index]!;
      if (planned <= 0n) continue;
      lineNo += 1;
      await tx.insert(shipmentContainerLine).values({
        containerId: container!.id,
        lineNo,
        itemCode: line.itemCode,
        description: line.description,
        plannedQty: qty(planned),
        uomCode: line.uomCode,
        createdBy: ctx.principal.userId,
      });
    }
  }

  await events.record(tx, {
    payableId: input.owner.id,
    eventCode: 'CONTAINER_ADDED',
    summary:
      `${input.numbers.length} container${input.numbers.length === 1 ? '' : 's'} on B/L ${input.bl.blNo}: ${input.numbers.join(', ')}` +
      (orderLines.length > 0 ? ' — lines spread equally (estimated; the warehouse confirms)' : ''),
    sourceType: BL_OBJECT,
    sourceId: input.bl.id,
    sourceNo: input.bl.blNo,
    actorUserId: ctx.principal.userId,
  });
  await checkPlannedTotal(tx, ctx, input.owner);
}

/** §17.1 — the containers' plan against the PI: a warning, never a block. */
async function checkPlannedTotal(tx: Tx, ctx: ActorContext, owner: typeof payable.$inferSelect) {
  if (!owner.quantity) return;
  const result = await tx.execute(sql`
    select coalesce(sum(l.planned_qty), 0)::text as planned
      from shipment_container_line l
      join shipment_container c on c.id = l.container_id
     where c.payable_id = ${owner.id} and c.cancelled_at is null and l.superseded_at is null`);
  const planned = parseQuantity((result.rows[0] as { planned: string }).planned);
  const ordered = parseQuantity(owner.quantity);
  if (planned > ordered) {
    await events.record(tx, {
      payableId: owner.id,
      eventCode: 'QUANTITY_VARIANCE',
      summary: `Containers plan ${qty(planned)} against ${qty(ordered)} on the invoice — check the B/L`,
      actorUserId: ctx.principal.userId,
    });
  }
}

/** A container's plan: what models it carries, how many of each. Superseded, never rewritten. */
export async function setContainerLines(
  tx: Tx,
  ctx: ActorContext,
  containerId: string,
  lines: readonly { itemCode: string | null; description: string; plannedQty: string; uomCode?: string | null }[],
) {
  const container = await loadContainer(tx, containerId);
  await authz.authorize(ctx.principal, 'edit_draft', CONTAINER_OBJECT, { branchCode: container.branchCode });
  if (container.receivedOn) throw new ShipmentValidationError(`${container.containerNo} has been received; its plan is closed.`);
  const clean = lines.filter((line) => line.plannedQty.trim() !== '');
  if (clean.length === 0) throw new ShipmentValidationError('A container carries at least one model.');
  const current = await liveLines(tx, containerId);
  if (current.length > 0) {
    await tx
      .update(shipmentContainerLine)
      .set({ supersededAt: new Date(), supersededBy: ctx.principal.userId })
      .where(inArray(shipmentContainerLine.id, current.map((line) => line.id)));
  }
  for (const [index, line] of clean.entries()) {
    const planned = parseQuantity(line.plannedQty.trim());
    if (planned <= 0n) throw new ShipmentValidationError(`Line ${index + 1}: plan a quantity above zero.`);
    await tx.insert(shipmentContainerLine).values({
      containerId,
      lineNo: index + 1,
      itemCode: line.itemCode || null,
      description: line.description.trim() || line.itemCode || 'Goods',
      plannedQty: qty(planned),
      uomCode: line.uomCode || null,
      createdBy: ctx.principal.userId,
    });
  }
  await tx
    .update(shipmentContainer)
    .set({ linesEstimated: false, updatedAt: new Date() })
    .where(eq(shipmentContainer.id, containerId));
  await events.record(tx, {
    payableId: container.payableId,
    eventCode: 'FIELD_CHANGED',
    summary: `${container.containerNo} carries: ${clean.map((l) => `${l.itemCode ?? l.description} ${l.plannedQty}`).join(', ')}`,
    sourceType: CONTAINER_OBJECT,
    sourceId: container.id,
    sourceNo: container.containerNo,
    actorUserId: ctx.principal.userId,
  });
  const owner = await payables.load(tx, container.payableId);
  await checkPlannedTotal(tx, ctx, owner);
}

// ---------------------------------------------------------------------------
// §17.3 — the stages
// ---------------------------------------------------------------------------

export async function changeStatus(
  tx: Tx,
  ctx: ActorContext,
  containerId: string,
  input: { statusCode: string; date: string; note?: string | null },
) {
  const container = await loadContainer(tx, containerId);
  await authz.authorize(ctx.principal, 'edit_draft', CONTAINER_OBJECT, { branchCode: container.branchCode });
  if (container.cancelledAt) throw new ShipmentValidationError(`${container.containerNo} is cancelled.`);
  assertStatusMove(container.containerNo, container.statusCode, input.statusCode);
  if (!input.date) throw new ShipmentValidationError('Give the date of the stage.');
  const column = STAGE_DATE[input.statusCode];
  const [from] = await tx.select().from(containerStatus).where(eq(containerStatus.code, container.statusCode)).limit(1);
  const [to] = await tx.select().from(containerStatus).where(eq(containerStatus.code, input.statusCode)).limit(1);

  await tx
    .update(shipmentContainer)
    .set({
      statusCode: input.statusCode,
      statusDate: input.date,
      ...(column ? { [column]: input.date } : {}),
      updatedAt: new Date(),
    })
    .where(eq(shipmentContainer.id, containerId));
  await tx.insert(shipmentContainerStatusHistory).values({
    containerId,
    statusCode: input.statusCode,
    effectiveDate: input.date,
    note: input.note?.trim() || null,
    source: 'user',
    recordedBy: ctx.principal.userId,
  });
  await events.record(tx, {
    payableId: container.payableId,
    eventCode: 'CONTAINER_STATUS_CHANGED',
    summary: `${container.containerNo}: ${from?.name ?? container.statusCode} → ${to?.name ?? input.statusCode} on ${input.date}${
      input.note?.trim() ? ` — ${input.note.trim()}` : ''
    }`,
    sourceType: CONTAINER_OBJECT,
    sourceId: container.id,
    sourceNo: container.containerNo,
    before: { status: container.statusCode },
    after: { status: input.statusCode, date: input.date },
    actorUserId: ctx.principal.userId,
  });
  await payables.recomputeStage(tx, container.payableId, ctx.principal.userId);
}

/** §21.9 — the vessel docked: every container of the B/L still at sea moves together. */
export async function changeStatusForBl(
  tx: Tx,
  ctx: ActorContext,
  blId: string,
  input: { statusCode: string; date: string; note?: string | null },
) {
  const containers = await tx
    .select()
    .from(shipmentContainer)
    .where(and(eq(shipmentContainer.blId, blId), isNull(shipmentContainer.cancelledAt), isNull(shipmentContainer.receivedOn)));
  let moved = 0;
  for (const container of containers) {
    try {
      assertStatusMove(container.containerNo, container.statusCode, input.statusCode);
    } catch {
      continue; // already past it — the bulk move takes the ones it applies to
    }
    await changeStatus(tx, ctx, container.id, input);
    moved += 1;
  }
  if (moved === 0) throw new ShipmentValidationError('No container of this B/L can move to that stage.');
  return { moved };
}

export async function changeEta(
  tx: Tx,
  ctx: ActorContext,
  containerId: string,
  input: { eta: string; note?: string | null },
) {
  const container = await loadContainer(tx, containerId);
  await authz.authorize(ctx.principal, 'edit_draft', CONTAINER_OBJECT, { branchCode: container.branchCode });
  if (container.receivedOn) throw new ShipmentValidationError(`${container.containerNo} has arrived.`);
  if (!input.eta) throw new ShipmentValidationError('Give the new ETA.');
  if (input.eta === container.eta) return;
  await tx.update(shipmentContainer).set({ eta: input.eta, updatedAt: new Date() }).where(eq(shipmentContainer.id, containerId));
  await events.record(tx, {
    payableId: container.payableId,
    eventCode: 'ETA_CHANGED',
    summary: `${container.containerNo}: ETA ${container.eta ?? '—'} → ${input.eta}${input.note?.trim() ? ` — ${input.note.trim()}` : ''}`,
    sourceType: CONTAINER_OBJECT,
    sourceId: container.id,
    sourceNo: container.containerNo,
    before: { eta: container.eta },
    after: { eta: input.eta },
    actorUserId: ctx.principal.userId,
  });
}

/** §16.2 — the port file for a cleared container went to customs. */
export async function portFileSent(tx: Tx, ctx: ActorContext, containerId: string, date: string) {
  const container = await loadContainer(tx, containerId);
  await authz.authorize(ctx.principal, 'edit_draft', CONTAINER_OBJECT, { branchCode: container.branchCode });
  if (!container.customsClearedOn) {
    throw new ShipmentValidationError(`${container.containerNo} is not customs cleared yet; its port file follows the clearance.`);
  }
  if (container.portFileSentOn) throw new ShipmentValidationError(`${container.containerNo}'s port file was sent on ${container.portFileSentOn}.`);
  if (!date) throw new ShipmentValidationError('Give the date the port file was sent.');
  await tx.update(shipmentContainer).set({ portFileSentOn: date, updatedAt: new Date() }).where(eq(shipmentContainer.id, containerId));
  await events.record(tx, {
    payableId: container.payableId,
    eventCode: 'PORT_FILE_SENT',
    summary: `Port file sent for ${container.containerNo} on ${date}`,
    sourceType: CONTAINER_OBJECT,
    sourceId: container.id,
    sourceNo: container.containerNo,
    actorUserId: ctx.principal.userId,
  });
}

// ---------------------------------------------------------------------------
// §18 — Receive container
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  /** The form's one-time id: the receipt's id, so a repeat answers with it. */
  readonly documentId: string;
  readonly containerId: string;
  readonly warehouseCode: string;
  readonly receiptDate: string;
  readonly lines: readonly {
    readonly containerLineId: string;
    readonly receivedQty: bigint;
    readonly damagedQty?: bigint;
    readonly shortQty?: bigint;
  }[];
  readonly varianceReason?: string | null;
  readonly note?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The layers this import's invoice lines have standing anywhere but `destination`, transit first. */
async function invoiceLayers(tx: Tx, invoiceLineIds: readonly string[], invoiceIds: readonly string[], destination: string) {
  if (invoiceLineIds.length === 0) return [];
  return tx
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
      isTransit: warehouse.isTransit,
      shipmentStage: warehouse.shipmentStage,
    })
    .from(costLayer)
    .innerJoin(inventoryMovement, eq(inventoryMovement.id, costLayer.createdByMovementId))
    .innerJoin(warehouse, eq(warehouse.code, costLayer.warehouseCode))
    .where(
      and(
        inArray(inventoryMovement.sourceDocumentId, [...invoiceIds]),
        inArray(inventoryMovement.sourceLineId, [...invoiceLineIds]),
        sql`${costLayer.remainingQuantity} > 0`,
        sql`${costLayer.warehouseCode} <> ${destination}`,
      ),
    )
    .orderBy(
      sql`case when ${warehouse.isTransit} or ${warehouse.shipmentStage} is not null then 0 else 1 end`,
      asc(costLayer.layerDate),
      asc(costLayer.sequence),
    );
}

export async function receive(tx: Tx, ctx: ActorContext, input: ReceiveInput) {
  if (!UUID.test(input.documentId)) {
    throw new ShipmentValidationError('The form carries no document id. Open the receipt form again and submit it once.');
  }
  // A repeated submit answers with the receipt the first one made.
  const [already] = await tx.select().from(containerReceipt).where(eq(containerReceipt.id, input.documentId)).limit(1);
  if (already) {
    if (already.containerId !== input.containerId) {
      throw new ShipmentValidationError('That document id belongs to another container’s receipt.');
    }
    return { id: already.id, receiptNo: already.receiptNo, repeated: true };
  }

  // Locked: two receipts of one container arriving together receive it once.
  const [container] = await tx
    .select()
    .from(shipmentContainer)
    .where(eq(shipmentContainer.id, input.containerId))
    .limit(1)
    .for('update');
  if (!container) throw new ShipmentNotFoundError(input.containerId);
  await authz.authorize(ctx.principal, 'execute', CONTAINER_OBJECT, { branchCode: container.branchCode });
  if (container.cancelledAt) throw new ShipmentValidationError(`${container.containerNo} is cancelled.`);
  if (container.receivedOn) {
    throw new ShipmentValidationError(`${container.containerNo} was received on ${container.receivedOn}. One container, one receipt.`);
  }
  const owner = await openImport(tx, container.payableId);

  // §18 — a warehouse of the import's branch that stock is put away in.
  const [house] = await tx.select().from(warehouse).where(eq(warehouse.code, input.warehouseCode)).limit(1);
  if (!house || !house.active) throw new ShipmentValidationError(`'${input.warehouseCode}' is not an active warehouse.`);
  if (house.branchCode !== owner.branchCode) {
    throw new ShipmentValidationError(
      `${house.code} belongs to ${house.branchCode} and ${owner.payableNo} to ${owner.branchCode}. Receive into a warehouse of the import's branch.`,
    );
  }
  if (house.isTransit || house.shipmentStage) {
    throw new ShipmentValidationError(`${house.code} holds goods in transit. Receive into the warehouse the goods are put away in.`);
  }
  if (!input.receiptDate) throw new ShipmentValidationError('Give the date the container was received.');

  const planned = await liveLines(tx, container.id);
  const byId = new Map(planned.map((line) => [line.id, line]));
  const given = new Map(input.lines.map((line) => [line.containerLineId, line]));
  const counted = planned.map((line) => {
    const entry = given.get(line.id);
    return {
      line,
      planned: parseQuantity(line.plannedQty),
      received: entry?.receivedQty ?? 0n,
      damaged: entry?.damagedQty ?? 0n,
      short: entry?.shortQty ?? 0n,
    };
  });
  for (const id of given.keys()) {
    if (!byId.has(id)) throw new ShipmentValidationError('A line of the form is not a line of this container’s plan.');
  }
  assertReceiptLines(counted, input.varianceReason);

  // The goods enter the books at the invoice (D25): its layers carry them.
  const invoices = await tx
    .select({ id: apInvoice.id, invoiceNo: apInvoice.invoiceNo, status: apInvoice.status })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, owner.id), isNull(apInvoice.reversedAt)));
  const posted = invoices.filter((invoice) => ['posted', 'partially_executed', 'settled'].includes(invoice.status));
  if (counted.some((c) => c.received > 0n) && posted.length === 0) {
    throw new ShipmentValidationError(
      `${owner.payableNo}'s invoice is not posted yet. The goods enter the books at the invoice's cost — ` +
        'post the invoice (CEO approval), then receive the container.',
    );
  }
  const invoiceLines = posted.length
    ? await tx
        .select({ id: apInvoiceLine.id, itemCode: apInvoiceLine.itemCode, apInvoiceId: apInvoiceLine.apInvoiceId })
        .from(apInvoiceLine)
        .where(inArray(apInvoiceLine.apInvoiceId, posted.map((invoice) => invoice.id)))
    : [];

  const allocated = await allocateDocumentNumber(
    tx,
    'CONTAINER_RECEIPT',
    { branchCode: owner.branchCode, year: Number(input.receiptDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  // Move the goods first, then write the receipt with what moved.
  const receiptLines: (typeof containerReceiptLine.$inferInsert)[] = [];
  for (const entry of counted) {
    const receiptLineId = randomUUID();
    let moved = 0n;
    let cost = 0n;
    if (entry.received > 0n) {
      if (!entry.line.itemCode) {
        throw new ShipmentValidationError(`Line ${entry.line.lineNo} names no item, so there is no stock to receive.`);
      }
      const lineIds = invoiceLines.filter((line) => line.itemCode === entry.line.itemCode).map((line) => line.id);
      const layers = await invoiceLayers(tx, lineIds, posted.map((invoice) => invoice.id), house.code);
      let outstanding = entry.received;
      const byWarehouse = new Map<string, typeof layers>();
      for (const layer of layers) {
        byWarehouse.set(layer.warehouseCode, [...(byWarehouse.get(layer.warehouseCode) ?? []), layer]);
      }
      for (const [from, standing] of byWarehouse) {
        if (outstanding <= 0n) break;
        const result = await inventory.relocate(tx, ctx, {
          itemCode: entry.line.itemCode,
          fromWarehouseCode: from,
          toWarehouseCode: house.code,
          branchCode: owner.branchCode,
          quantity: outstanding,
          movementDate: input.receiptDate,
          layers: standing.map((layer) => ({
            ...layer,
            originalQuantity: parseQuantity(layer.originalQuantity),
            remainingQuantity: parseQuantity(layer.remainingQuantity),
            unitCostIqd: parseDecimal(layer.unitCostIqd, 4n),
          })),
          sourceDocumentType: RECEIPT_DOCUMENT_TYPE,
          sourceDocumentId: input.documentId,
          sourceLineId: receiptLineId,
        });
        moved += result.moved;
        cost += result.costIqd;
        outstanding -= result.moved;
      }
      if (outstanding > 0n) {
        throw new ShipmentValidationError(
          `${entry.line.itemCode}: ${qty(entry.received)} received, but the invoice's goods still in transit hold only ` +
            `${qty(moved)}. Receive what the invoice bought; an excess is the supplier's to invoice.`,
        );
      }
    }
    receiptLines.push({
      id: receiptLineId,
      receiptId: input.documentId,
      containerLineId: entry.line.id,
      lineNo: entry.line.lineNo,
      itemCode: entry.line.itemCode,
      plannedQty: qty(entry.planned),
      receivedQty: qty(entry.received),
      damagedQty: qty(entry.damaged),
      shortQty: qty(entry.short),
      movedQty: qty(moved),
      costIqd: toDecimalString(cost, 4n),
    });
  }

  await tx.insert(containerReceipt).values({
    id: input.documentId,
    receiptNo: allocated.documentNo,
    containerId: container.id,
    payableId: owner.id,
    branchCode: owner.branchCode,
    warehouseCode: house.code,
    receiptDate: input.receiptDate,
    varianceReason: input.varianceReason?.trim() || null,
    note: input.note?.trim() || null,
    createdBy: ctx.principal.userId,
  });
  await tx.insert(containerReceiptLine).values(receiptLines);

  for (const entry of counted) {
    await tx
      .update(shipmentContainerLine)
      .set({
        receivedQty: qty(entry.received),
        damagedQty: qty(entry.damaged),
        shortQty: qty(entry.short),
        warehouseCode: house.code,
      })
      .where(eq(shipmentContainerLine.id, entry.line.id));
  }

  const outcome = receiptOutcome(counted);
  await tx
    .update(shipmentContainer)
    .set({
      statusCode: outcome,
      statusDate: input.receiptDate,
      receivedOn: input.receiptDate,
      warehouseCode: house.code,
      containerReceiptId: input.documentId,
      updatedAt: new Date(),
    })
    .where(eq(shipmentContainer.id, container.id));
  await tx.insert(shipmentContainerStatusHistory).values({
    containerId: container.id,
    statusCode: outcome,
    effectiveDate: input.receiptDate,
    note: `${allocated.documentNo} into ${house.code}${input.varianceReason?.trim() ? ` — ${input.varianceReason.trim()}` : ''}`,
    source: 'receipt',
    recordedBy: ctx.principal.userId,
  });

  const summaryLines = counted
    .map((c) => `${c.line.itemCode ?? c.line.description} ${qty(c.received)} of ${qty(c.planned)}`)
    .join(', ');
  await events.record(tx, {
    payableId: owner.id,
    eventCode: 'CONTAINER_RECEIVED',
    summary: `${container.containerNo} received into ${house.code} on ${input.receiptDate} — ${summaryLines}`,
    sourceType: RECEIPT_DOCUMENT_TYPE,
    sourceId: input.documentId,
    sourceNo: allocated.documentNo,
    actorUserId: ctx.principal.userId,
  });

  if (outcome === 'missing_damaged') {
    const detail = counted
      .filter((c) => lineVariance(c) !== 0n || c.damaged > 0n || c.short > 0n)
      .map(
        (c) =>
          `${c.line.itemCode ?? c.line.description}: planned ${qty(c.planned)}, received ${qty(c.received)}, damaged ${qty(c.damaged)}, short ${qty(c.short)}`,
      )
      .join('; ');
    await events.record(tx, {
      payableId: owner.id,
      eventCode: 'QUANTITY_VARIANCE',
      summary: `${container.containerNo}: ${detail} — ${input.varianceReason?.trim()}`,
      sourceType: RECEIPT_DOCUMENT_TYPE,
      sourceId: input.documentId,
      sourceNo: allocated.documentNo,
      actorUserId: ctx.principal.userId,
    });
    // §18 — the claim for purchasing: a hold that wants its owner and next step.
    await holds.openAutomatic(tx, {
      payableId: owner.id,
      laneCode: 'warehouse',
      checkCode: 'receipt_variance',
      startedAt: new Date(`${input.receiptDate}T00:00:00Z`),
      summary: `Claim: ${container.containerNo} arrived short or damaged — ${input.varianceReason?.trim()}`,
      sourceType: RECEIPT_DOCUMENT_TYPE,
      sourceId: input.documentId,
    });
  }

  // §17.5 — Y of Y.
  const all = await containersOf(tx, owner.id);
  const state = progress(all);
  if (state.all) {
    await events.record(tx, {
      payableId: owner.id,
      eventCode: 'ALL_CONTAINERS_RECEIVED',
      summary: `All containers in — ${state.received} of ${state.total} received`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'container_receipt.posted',
    objectType: CONTAINER_OBJECT,
    objectId: container.id,
    branchCode: owner.branchCode,
    after: {
      receiptNo: allocated.documentNo,
      containerNo: container.containerNo,
      warehouse: house.code,
      receiptDate: input.receiptDate,
      outcome,
    },
    reason: input.varianceReason?.trim() || null,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await payables.recomputeStage(tx, owner.id, ctx.principal.userId);
  return { id: input.documentId, receiptNo: allocated.documentNo, repeated: false };
}

// ---------------------------------------------------------------------------
// The sweep's part — §17.3 "Container late"
// ---------------------------------------------------------------------------

/** Containers whose ETA has passed while still loading or at sea become Late, once. */
export async function lateSweep(tx: Tx, asOf: string): Promise<number> {
  const late = await tx
    .select()
    .from(shipmentContainer)
    .where(
      and(
        isNull(shipmentContainer.receivedOn),
        isNull(shipmentContainer.cancelledAt),
        inArray(shipmentContainer.statusCode, ['not_loaded', 'on_sea']),
        sql`${shipmentContainer.eta} < ${asOf}::date`,
      ),
    );
  for (const container of late) {
    await tx
      .update(shipmentContainer)
      .set({ statusCode: 'late', statusDate: asOf, updatedAt: new Date() })
      .where(eq(shipmentContainer.id, container.id));
    await tx.insert(shipmentContainerStatusHistory).values({
      containerId: container.id,
      statusCode: 'late',
      effectiveDate: asOf,
      note: `ETA ${container.eta} passed`,
      source: 'sweep',
    });
    await events.record(tx, {
      payableId: container.payableId,
      eventCode: 'CONTAINER_LATE',
      summary: `${container.containerNo} late — ETA ${container.eta} passed and it has not arrived`,
      sourceType: CONTAINER_OBJECT,
      sourceId: container.id,
      sourceNo: container.containerNo,
      actorUserId: null,
    });
  }
  return late.length;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function containersOf(tx: Tx, payableId: string) {
  const rows = await tx
    .select({
      id: shipmentContainer.id,
      containerNo: shipmentContainer.containerNo,
      statusCode: shipmentContainer.statusCode,
      countsAsReceived: containerStatus.countsAsReceived,
      cancelledAt: shipmentContainer.cancelledAt,
    })
    .from(shipmentContainer)
    .innerJoin(containerStatus, eq(containerStatus.code, shipmentContainer.statusCode))
    .where(eq(shipmentContainer.payableId, payableId));
  return rows.map((row) => ({ ...row, cancelled: Boolean(row.cancelledAt) }));
}

export async function ports(tx: Tx) {
  return tx.select().from(port).where(eq(port.active, true)).orderBy(asc(port.name));
}

export async function statuses(tx: Tx) {
  return tx.select().from(containerStatus).orderBy(asc(containerStatus.sequence));
}

export async function listBls(tx: Tx, filter: { payableId?: string | null } = {}) {
  const rows = await tx
    .select({
      id: billOfLading.id,
      blNo: billOfLading.blNo,
      blDate: sql<string>`${billOfLading.blDate}::text`,
      vessel: billOfLading.vessel,
      voyage: billOfLading.voyage,
      shippingLine: billOfLading.shippingLine,
      eta: sql<string | null>`${billOfLading.eta}::text`,
      portName: port.name,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      supplierName: businessPartner.legalName,
      cancelledAt: billOfLading.cancelledAt,
      total: sql<number>`(select count(*)::int from shipment_container c where c.bl_id = ${billOfLading.id} and c.cancelled_at is null)`,
      received: sql<number>`(select count(*)::int from shipment_container c join container_status s on s.code = c.status_code
                               where c.bl_id = ${billOfLading.id} and c.cancelled_at is null and s.counts_as_received)`,
      leastStatus: sql<string | null>`(select s.name from shipment_container c join container_status s on s.code = c.status_code
                               where c.bl_id = ${billOfLading.id} and c.cancelled_at is null
                               order by case when s.is_exception and not s.counts_as_received then 0 else s.sequence end limit 1)`,
      leastStatusCode: sql<string | null>`(select s.code from shipment_container c join container_status s on s.code = c.status_code
                               where c.bl_id = ${billOfLading.id} and c.cancelled_at is null
                               order by case when s.is_exception and not s.counts_as_received then 0 else s.sequence end limit 1)`,
    })
    .from(billOfLading)
    .innerJoin(payable, eq(payable.id, billOfLading.payableId))
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .leftJoin(port, eq(port.code, billOfLading.portOfDischargeCode))
    .where(filter.payableId ? eq(billOfLading.payableId, filter.payableId) : undefined)
    .orderBy(desc(billOfLading.blDate), desc(billOfLading.createdAt));
  return rows;
}

export interface ContainerFilter {
  readonly view?: 'in_transit' | 'late' | 'received' | 'all' | null;
  readonly payableId?: string | null;
  readonly blId?: string | null;
}

export async function listContainers(tx: Tx, filter: ContainerFilter = {}) {
  const asOf = today();
  const rows = await tx
    .select({
      id: shipmentContainer.id,
      containerNo: shipmentContainer.containerNo,
      sizeType: shipmentContainer.sizeType,
      statusCode: shipmentContainer.statusCode,
      statusName: containerStatus.name,
      countsAsReceived: containerStatus.countsAsReceived,
      isException: containerStatus.isException,
      eta: sql<string | null>`${shipmentContainer.eta}::text`,
      receivedOn: sql<string | null>`${shipmentContainer.receivedOn}::text`,
      warehouseCode: shipmentContainer.warehouseCode,
      linesEstimated: shipmentContainer.linesEstimated,
      portFileSentOn: sql<string | null>`${shipmentContainer.portFileSentOn}::text`,
      blNo: billOfLading.blNo,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      supplierName: businessPartner.legalName,
      portName: port.name,
      cancelledAt: shipmentContainer.cancelledAt,
      planned: sql<string>`(select coalesce(sum(l.planned_qty), 0)::text from shipment_container_line l
                              where l.container_id = ${shipmentContainer.id} and l.superseded_at is null)`,
      received: sql<string>`(select coalesce(sum(l.received_qty), 0)::text from shipment_container_line l
                              where l.container_id = ${shipmentContainer.id} and l.superseded_at is null)`,
    })
    .from(shipmentContainer)
    .innerJoin(containerStatus, eq(containerStatus.code, shipmentContainer.statusCode))
    .innerJoin(billOfLading, eq(billOfLading.id, shipmentContainer.blId))
    .innerJoin(payable, eq(payable.id, shipmentContainer.payableId))
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .leftJoin(port, eq(port.code, billOfLading.portOfDischargeCode))
    .where(
      and(
        filter.payableId ? eq(shipmentContainer.payableId, filter.payableId) : undefined,
        filter.blId ? eq(shipmentContainer.blId, filter.blId) : undefined,
      ),
    )
    .orderBy(sql`${shipmentContainer.eta} asc nulls last`, asc(shipmentContainer.containerNo));

  const withDays = rows.map((row) => ({
    ...row,
    daysSinceEta:
      row.eta && !row.receivedOn
        ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${row.eta}T00:00:00Z`)) / 86_400_000)
        : null,
  }));
  switch (filter.view ?? 'all') {
    case 'in_transit':
      return withDays.filter((row) => !row.receivedOn && !row.cancelledAt);
    case 'late':
      return withDays.filter((row) => row.statusCode === 'late');
    case 'received':
      return withDays.filter((row) => Boolean(row.receivedOn));
    default:
      return withDays;
  }
}

export async function viewBl(tx: Tx, blNo: string) {
  const [bl] = await tx.select().from(billOfLading).where(eq(billOfLading.blNo, blNo.toUpperCase())).limit(1);
  if (!bl) throw new ShipmentNotFoundError(blNo);
  const owner = await payables.load(tx, bl.payableId);
  const [supplier] = await tx
    .select({ name: businessPartner.legalName, code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, owner.supplierId))
    .limit(1);
  const [discharge] = bl.portOfDischargeCode
    ? await tx.select().from(port).where(eq(port.code, bl.portOfDischargeCode)).limit(1)
    : [];
  const containers = await listContainers(tx, { blId: bl.id });
  return { bl, owner, supplier: supplier ?? null, port: discharge ?? null, containers, progress: progress(containers.map((c) => ({ countsAsReceived: c.countsAsReceived, cancelled: Boolean(c.cancelledAt) }))) };
}

export async function viewContainer(tx: Tx, containerNo: string, id?: string | null) {
  const candidates = await tx
    .select()
    .from(shipmentContainer)
    .where(id ? eq(shipmentContainer.id, id) : eq(shipmentContainer.containerNo, containerNo.toUpperCase()))
    .orderBy(sql`${shipmentContainer.receivedOn} desc nulls first`, desc(shipmentContainer.createdAt));
  const container = candidates[0];
  if (!container) throw new ShipmentNotFoundError(containerNo);
  const [bl] = await tx.select().from(billOfLading).where(eq(billOfLading.id, container.blId)).limit(1);
  const owner = await payables.load(tx, container.payableId);
  const [supplier] = await tx
    .select({ name: businessPartner.legalName, code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, owner.supplierId))
    .limit(1);
  const [status] = await tx.select().from(containerStatus).where(eq(containerStatus.code, container.statusCode)).limit(1);
  const lines = await liveLines(tx, container.id);
  const history = await tx
    .select({
      id: shipmentContainerStatusHistory.id,
      statusCode: shipmentContainerStatusHistory.statusCode,
      statusName: containerStatus.name,
      effectiveDate: sql<string>`${shipmentContainerStatusHistory.effectiveDate}::text`,
      note: shipmentContainerStatusHistory.note,
      source: shipmentContainerStatusHistory.source,
      recordedBy: appUser.displayName,
    })
    .from(shipmentContainerStatusHistory)
    .innerJoin(containerStatus, eq(containerStatus.code, shipmentContainerStatusHistory.statusCode))
    .leftJoin(appUser, eq(appUser.id, shipmentContainerStatusHistory.recordedBy))
    .where(eq(shipmentContainerStatusHistory.containerId, container.id))
    .orderBy(desc(shipmentContainerStatusHistory.recordedAt));
  const [receipt] = container.containerReceiptId
    ? await tx.select().from(containerReceipt).where(eq(containerReceipt.id, container.containerReceiptId)).limit(1)
    : [];
  const receiptLines = receipt
    ? await tx.select().from(containerReceiptLine).where(eq(containerReceiptLine.receiptId, receipt.id)).orderBy(asc(containerReceiptLine.lineNo))
    : [];
  // Where it may be put away: the import's branch, warehouses stock is put away in.
  const houses = await tx
    .select({ code: warehouse.code, name: warehouse.name })
    .from(warehouse)
    .where(
      and(
        eq(warehouse.branchCode, owner.branchCode),
        eq(warehouse.active, true),
        eq(warehouse.isTransit, false),
        isNull(warehouse.shipmentStage),
      ),
    )
    .orderBy(asc(warehouse.code));
  const orderLines = await orderLinesOf(tx, owner.id);
  return {
    container,
    bl: bl!,
    owner,
    supplier: supplier ?? null,
    status: status!,
    lines,
    history,
    receipt: receipt ?? null,
    receiptLines,
    houses,
    orderLines,
    others: candidates.slice(1).map((row) => ({ id: row.id, receivedOn: row.receivedOn })),
  };
}

/** The import page's Shipment section. */
export async function forPayable(tx: Tx, payableId: string) {
  const bls = await listBls(tx, { payableId });
  const containers = await listContainers(tx, { payableId });
  const state = progress(containers.map((c) => ({ countsAsReceived: c.countsAsReceived, cancelled: Boolean(c.cancelledAt) })));
  return { bls, containers, progress: state };
}

/** §18 — the received quantity of an import is Σ received over container lines. */
export async function receivedQuantity(tx: Tx, payableId: string): Promise<bigint> {
  const result = await tx.execute(sql`
    select coalesce(sum(l.received_qty), 0)::text as received
      from shipment_container_line l join shipment_container c on c.id = l.container_id
     where c.payable_id = ${payableId} and c.cancelled_at is null and l.superseded_at is null`);
  return parseQuantity((result.rows[0] as { received: string }).received);
}
