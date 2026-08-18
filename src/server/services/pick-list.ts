/**
 * Pick List — Phase 06.4, §7.2.
 *
 * The warehouse's step between a commitment and a movement. Appendix B: effect
 * **Operational** — no accounting entry, no stock movement. The stock is still
 * on the shelf, still owned by the company, still reserved to the same order;
 * what changed is that somebody now knows which units to take, and afterwards,
 * which ones they took.
 *
 * So this service posts nothing and moves nothing, and the way that is made
 * true is worth stating: it does not import the posting engine or the inventory
 * movement writer at all. `schema/pick-list.ts` has no journal column to fill
 * in, and this file has nothing to fill it in with.
 *
 * **What it does enforce.** Two things, both from the 06.4 gate:
 *
 *   1. *Picked quantity cannot exceed the reserved quantity* — cumulatively,
 *      across every pick list raised against the same order line. Stock picked
 *      beyond the reservation is stock promised to another customer.
 *   2. *Serial/batch selection at pick is carried through to the Delivery Note*
 *      — captured here, complete, and read back by 06.5. §9.9 wants a serial
 *      followable from receipt to delivery, and the pick is the first point at
 *      which a particular unit is committed to a particular customer.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  item,
  pickList,
  pickListLine,
  pickListLineUnit,
  salesOrder,
  salesOrderLine,
  warehouse,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import {
  assertIdentitiesComplete,
  assertWithinReservation,
  pickShortfall,
  type ItemTracking,
  type PickedUnit,
} from '../domain/picking';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'pick_list';
export const DOCUMENT_TYPE = 'pick_list';
const SEQUENCE_KEY = 'PICK_LIST';

export class OrderNotPickableError extends Error {
  readonly code = 'ORDER_NOT_PICKABLE';

  constructor(
    readonly orderNo: string,
    readonly status: string,
  ) {
    super(
      `Sales Order ${orderNo} is '${status}', so nothing can be picked against it. ` +
        'Stock is reserved when the order is approved (§7.4); a pick list draws that reservation down.',
    );
    this.name = 'OrderNotPickableError';
  }
}

export class LineNotOnOrderError extends Error {
  readonly code = 'LINE_NOT_ON_ORDER';

  constructor(readonly orderNo: string) {
    super(
      `A pick list line names a line that is not on Sales Order ${orderNo}. ` +
        'A pick draws down that order’s reservation, so every line must belong to it.',
    );
    this.name = 'LineNotOnOrderError';
  }
}

export class WrongWarehouseError extends Error {
  readonly code = 'PICK_WRONG_WAREHOUSE';

  constructor(
    readonly itemCode: string,
    readonly lineWarehouse: string,
    readonly pickWarehouse: string,
  ) {
    super(
      `${itemCode} is to be delivered from ${lineWarehouse}, but this pick list is for ${pickWarehouse}. ` +
        'A picker walks one building, so an order that spans warehouses is picked on one list per warehouse (§7.2).',
    );
    this.name = 'WrongWarehouseError';
  }
}

export class NothingOutstandingError extends Error {
  readonly code = 'NOTHING_OUTSTANDING';

  constructor(
    readonly orderNo: string,
    readonly warehouseCode: string,
  ) {
    super(
      `Sales Order ${orderNo} has nothing left to pick in ${warehouseCode}. ` +
        'Every reserved unit is already on a pick list.',
    );
    this.name = 'NothingOutstandingError';
  }
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * How much of an order line is already spoken for by a pick list.
 *
 * Cancelled pick lists do not count — the units went back on the shelf and the
 * reservation is whole again. Everything else does, including a list still in
 * draft: a second picker must not be sent for the same units while the first
 * sheet is on somebody's clipboard.
 */
async function pickedAgainst(tx: Tx, salesOrderLineIds: readonly string[]) {
  if (salesOrderLineIds.length === 0) return new Map<string, bigint>();

  const rows = await tx
    .select({
      salesOrderLineId: pickListLine.salesOrderLineId,
      // Draft and released lines have picked nothing yet but have *claimed* the
      // units, so the claim is the greater of the two.
      claimed: sql<string>`sum(greatest(${pickListLine.pickedQuantity}, ${pickListLine.requestedQuantity}))`,
    })
    .from(pickListLine)
    .innerJoin(pickList, eq(pickList.id, pickListLine.pickListId))
    .where(
      and(
        inArray(pickListLine.salesOrderLineId, [...salesOrderLineIds]),
        ne(pickList.status, 'cancelled'),
      ),
    )
    .groupBy(pickListLine.salesOrderLineId);

  return new Map(rows.map((r) => [r.salesOrderLineId, parseQuantity(r.claimed ?? '0')]));
}

export interface OutstandingLine {
  readonly salesOrderLineId: string;
  readonly lineNo: number;
  readonly itemCode: string;
  readonly description: string;
  readonly uomCode: string;
  readonly warehouseCode: string;
  readonly reserved: bigint;
  readonly alreadyClaimed: bigint;
  readonly outstanding: bigint;
}

/**
 * What is left to pick on an order, in one warehouse.
 *
 * The screen calls this to build a pick list, and `create` calls it to fill one
 * in. Same answer both times, which is what keeps the sheet the warehouse is
 * handed the same as the sheet the screen offered.
 */
export async function outstandingFor(
  tx: Tx,
  salesOrderId: string,
  warehouseCode: string,
): Promise<OutstandingLine[]> {
  const lines = await tx
    .select()
    .from(salesOrderLine)
    .where(
      and(
        eq(salesOrderLine.salesOrderId, salesOrderId),
        eq(salesOrderLine.warehouseCode, warehouseCode),
      ),
    )
    .orderBy(salesOrderLine.lineNo);

  const claimed = await pickedAgainst(
    tx,
    lines.map((l) => l.id),
  );

  return lines
    .map((line) => {
      const reserved = parseQuantity(line.reservedQuantity);
      const alreadyClaimed = claimed.get(line.id) ?? 0n;
      const outstanding = reserved - alreadyClaimed;

      return {
        salesOrderLineId: line.id,
        lineNo: line.lineNo,
        itemCode: line.itemCode,
        description: line.description,
        uomCode: line.uomCode,
        warehouseCode: line.warehouseCode,
        reserved,
        alreadyClaimed,
        outstanding: outstanding > 0n ? outstanding : 0n,
      };
    })
    .filter((line) => line.outstanding > 0n);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatePickListInput {
  readonly salesOrderId: string;
  readonly warehouseCode: string;
  readonly pickDate: string;
  readonly assignedTo?: string | null;
  readonly note?: string | null;
  /**
   * Which order lines to put on the sheet, and how much of each. Omitted
   * entirely, the whole outstanding position for the warehouse goes on it —
   * which is what a warehouse supervisor means by "pick this order".
   */
  readonly lines?: readonly {
    readonly salesOrderLineId: string;
    readonly quantity: bigint;
  }[];
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreatePickListInput,
): Promise<{ id: string; pickListNo: string }> {
  const [order] = await tx
    .select()
    .from(salesOrder)
    .where(eq(salesOrder.id, input.salesOrderId))
    .limit(1);

  if (!order) throw new Error(`No sales order with id '${input.salesOrderId}'.`);

  // §7.4 — stock is reserved at approval, and a pick draws that reservation
  // down. Before approval there is nothing reserved to draw.
  if (order.status !== 'approved' && order.status !== 'partially_executed') {
    throw new OrderNotPickableError(order.orderNo, order.status);
  }

  const [store] = await tx
    .select({ branchCode: warehouse.branchCode })
    .from(warehouse)
    .where(eq(warehouse.code, input.warehouseCode))
    .limit(1);

  if (!store) throw new Error(`No warehouse '${input.warehouseCode}'.`);

  // The pick list belongs to the warehouse's branch, not the order's header
  // branch: §7.2 lets one order span branches, and the people who will do this
  // job work in the branch the goods are in.
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: store.branchCode,
  });

  const outstanding = await outstandingFor(tx, input.salesOrderId, input.warehouseCode);
  const byLineId = new Map(outstanding.map((line) => [line.salesOrderLineId, line]));

  const requested =
    input.lines ??
    outstanding.map((line) => ({ salesOrderLineId: line.salesOrderLineId, quantity: line.outstanding }));

  if (requested.length === 0) {
    throw new NothingOutstandingError(order.orderNo, input.warehouseCode);
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: store.branchCode, year: Number(input.pickDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(pickList)
    .values({
      pickListNo: allocated.documentNo,
      salesOrderId: input.salesOrderId,
      warehouseCode: input.warehouseCode,
      branchCode: store.branchCode,
      pickDate: input.pickDate,
      assignedTo: input.assignedTo ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: pickList.id });

  for (const [index, line] of requested.entries()) {
    const position = byLineId.get(line.salesOrderLineId);

    if (!position) {
      // Either the line is not on this order, or it is in another warehouse, or
      // it is fully claimed. Distinguishing the three is worth the extra query
      // — §25 wants the reason, and "not outstanding" would be a lie if the
      // real answer is "wrong warehouse".
      const [ordered] = await tx
        .select()
        .from(salesOrderLine)
        .where(eq(salesOrderLine.id, line.salesOrderLineId))
        .limit(1);

      if (!ordered || ordered.salesOrderId !== input.salesOrderId) {
        throw new LineNotOnOrderError(order.orderNo);
      }
      if (ordered.warehouseCode !== input.warehouseCode) {
        throw new WrongWarehouseError(ordered.itemCode, ordered.warehouseCode, input.warehouseCode);
      }
      throw new NothingOutstandingError(order.orderNo, input.warehouseCode);
    }

    if (line.quantity > position.outstanding) {
      throw new Error(
        `Line ${position.lineNo}: ${formatQuantity(line.quantity)} of ${position.itemCode} was asked for, ` +
          `but only ${formatQuantity(position.outstanding)} is still to be picked. ` +
          `Reserved: ${formatQuantity(position.reserved)}; already on a pick list: ${formatQuantity(position.alreadyClaimed)}.`,
      );
    }

    await tx.insert(pickListLine).values({
      pickListId: created!.id,
      lineNo: index + 1,
      salesOrderLineId: line.salesOrderLineId,
      itemCode: position.itemCode,
      description: position.description,
      uomCode: position.uomCode,
      requestedQuantity: formatQuantity(line.quantity),
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'pick_list.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: store.branchCode,
    outcome: 'success',
    after: {
      pickListNo: allocated.documentNo,
      salesOrderId: input.salesOrderId,
      warehouseCode: input.warehouseCode,
      lines: requested.length,
    },
  });

  return { id: created!.id, pickListNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// Release — draft → approved
// ---------------------------------------------------------------------------

export async function release(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const sheet = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: sheet.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, sheet.status, 'approved');

  await tx
    .update(pickList)
    .set({
      status: 'approved',
      releasedBy: ctx.principal.userId,
      releasedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pickList.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'pick_list.released',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: sheet.branchCode,
    outcome: 'success',
    before: { status: sheet.status },
    after: { status: 'approved' },
  });
}

// ---------------------------------------------------------------------------
// Pick — approved → executed
// ---------------------------------------------------------------------------

export interface PickedLineInput {
  readonly pickListLineId: string;
  readonly quantity: bigint;
  readonly shortfallReason?: string | null;
  /** Serials and batches taken. Required for a tracked item, refused otherwise. */
  readonly units?: readonly PickedUnit[];
}

/**
 * The picker's report: what they took, and which units.
 *
 * A line left out of `lines` was not picked at all, which is a legitimate
 * outcome — the shelf was empty. It is recorded as a picked quantity of zero
 * with the shortfall visible, rather than by deleting the line, because the
 * warehouse supervisor's question afterwards is *"what did we fail to find?"*
 */
export async function pick(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  lines: readonly PickedLineInput[],
): Promise<{ shortfalls: { itemCode: string; short: bigint }[] }> {
  const sheet = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: sheet.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, sheet.status, 'executed');

  const sheetLines = await tx
    .select()
    .from(pickListLine)
    .where(eq(pickListLine.pickListId, id))
    .orderBy(pickListLine.lineNo);

  const byId = new Map(sheetLines.map((line) => [line.id, line]));
  const reported = new Map(lines.map((line) => [line.pickListLineId, line]));

  for (const key of reported.keys()) {
    if (!byId.has(key)) {
      throw new Error(`Pick list line '${key}' is not on ${sheet.pickListNo}.`);
    }
  }

  // The claim this sheet already holds is excluded from `alreadyPicked`, or the
  // sheet would be judged against itself.
  const claimed = await pickedAgainst(
    tx,
    sheetLines.map((l) => l.salesOrderLineId),
  );

  const shortfalls: { itemCode: string; short: bigint }[] = [];

  for (const line of sheetLines) {
    const report = reported.get(line.id);
    const picked = report?.quantity ?? 0n;
    const requested = parseQuantity(line.requestedQuantity);

    if (picked > 0n) {
      const [ordered] = await tx
        .select({ reserved: salesOrderLine.reservedQuantity })
        .from(salesOrderLine)
        .where(eq(salesOrderLine.id, line.salesOrderLineId))
        .limit(1);

      const reserved = parseQuantity(ordered?.reserved ?? '0');
      const claimedElsewhere = (claimed.get(line.salesOrderLineId) ?? 0n) - requested;

      assertWithinReservation(
        line.itemCode,
        { reserved, alreadyPicked: claimedElsewhere > 0n ? claimedElsewhere : 0n },
        picked,
      );

      const [stocked] = await tx
        .select({ tracking: item.tracking })
        .from(item)
        .where(eq(item.code, line.itemCode))
        .limit(1);

      assertIdentitiesComplete({
        itemCode: line.itemCode,
        tracking: (stocked?.tracking ?? null) as ItemTracking,
        pickedQuantity: picked,
        units: report?.units ?? [],
      });
    } else if ((report?.units?.length ?? 0) > 0) {
      throw new Error(
        `Line ${line.lineNo}: units were selected for ${line.itemCode} but nothing was picked. ` +
          'Record the quantity taken, or remove the selections.',
      );
    }

    const short = pickShortfall({ requested, picked });
    if (short > 0n) shortfalls.push({ itemCode: line.itemCode, short });

    await tx
      .update(pickListLine)
      .set({
        pickedQuantity: formatQuantity(picked),
        shortfallReason: short > 0n ? (report?.shortfallReason ?? null) : null,
      })
      .where(eq(pickListLine.id, line.id));

    // Rewriting rather than merging: the picker's report is the whole answer
    // for that line, and a merge would leave a serial from a previous attempt
    // attached to a unit that went back on the shelf.
    await tx.delete(pickListLineUnit).where(eq(pickListLineUnit.pickListLineId, line.id));

    for (const unit of report?.units ?? []) {
      await tx.insert(pickListLineUnit).values({
        pickListLineId: line.id,
        serialNumber: unit.serialNumber?.trim() || null,
        batchNumber: unit.batchNumber?.trim() || null,
        quantity: formatQuantity(unit.quantity),
      });
    }
  }

  await tx
    .update(pickList)
    .set({
      status: 'executed',
      pickedBy: ctx.principal.userId,
      pickedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pickList.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'pick_list.picked',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: sheet.branchCode,
    outcome: 'success',
    before: { status: sheet.status },
    after: {
      status: 'executed',
      shortfalls: shortfalls.map((s) => ({ itemCode: s.itemCode, short: formatQuantity(s.short) })),
    },
  });

  return { shortfalls };
}

// ---------------------------------------------------------------------------
// Complete — executed → closed, by the Delivery Note (06.5)
// ---------------------------------------------------------------------------

export async function complete(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const sheet = await load(tx, id);

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, sheet.status, 'closed');

  await tx
    .update(pickList)
    .set({
      status: 'closed',
      completedBy: ctx.principal.userId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(pickList.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'pick_list.completed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: sheet.branchCode,
    outcome: 'success',
    before: { status: sheet.status },
    after: { status: 'closed' },
  });
}

export async function cancel(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const sheet = await load(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: sheet.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, sheet.status, 'cancelled', reason);

  await tx
    .update(pickList)
    .set({
      status: 'cancelled',
      cancelledBy: ctx.principal.userId,
      cancelledAt: new Date(),
      cancellationReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(pickList.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'pick_list.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: sheet.branchCode,
    outcome: 'success',
    reason,
    before: { status: sheet.status },
    after: { status: 'cancelled' },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [sheet] = await tx.select().from(pickList).where(eq(pickList.id, id)).limit(1);
  if (!sheet) throw new Error(`No pick list with id '${id}'.`);
  return sheet;
}

export interface PickedUnitRow {
  readonly pickListLineId: string;
  readonly salesOrderLineId: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly serialNumber: string | null;
  readonly batchNumber: string | null;
  readonly quantity: string;
}

/**
 * The selections, flattened — what the Delivery Note (06.5) inherits.
 *
 * The 06.4 gate is that the selection is *carried through*, so this is the
 * function that carries it: one place both the pick and the delivery agree on,
 * rather than the delivery re-deriving which units were taken and being able to
 * derive it differently.
 */
export async function pickedUnits(tx: Tx, pickListId: string): Promise<PickedUnitRow[]> {
  const rows = await tx
    .select({
      pickListLineId: pickListLineUnit.pickListLineId,
      salesOrderLineId: pickListLine.salesOrderLineId,
      itemCode: pickListLine.itemCode,
      warehouseCode: pickList.warehouseCode,
      serialNumber: pickListLineUnit.serialNumber,
      batchNumber: pickListLineUnit.batchNumber,
      quantity: pickListLineUnit.quantity,
    })
    .from(pickListLineUnit)
    .innerJoin(pickListLine, eq(pickListLine.id, pickListLineUnit.pickListLineId))
    .innerJoin(pickList, eq(pickList.id, pickListLine.pickListId))
    .where(eq(pickList.id, pickListId))
    .orderBy(pickListLine.lineNo, pickListLineUnit.serialNumber, pickListLineUnit.batchNumber);

  return rows;
}

export async function view(tx: Tx, id: string) {
  const sheet = await load(tx, id);
  const lines = await tx
    .select()
    .from(pickListLine)
    .where(eq(pickListLine.pickListId, id))
    .orderBy(pickListLine.lineNo);

  return { ...sheet, lines, units: await pickedUnits(tx, id) };
}

/**
 * Whether anything remains unpicked on a sheet.
 *
 * Appendix B gives the Pick List no partial status, so this is how a supervisor
 * finds the short picks: a query, not a state.
 */
export async function shortPicks(tx: Tx, pickListId: string) {
  return tx
    .select({
      lineNo: pickListLine.lineNo,
      itemCode: pickListLine.itemCode,
      requested: pickListLine.requestedQuantity,
      picked: pickListLine.pickedQuantity,
      reason: pickListLine.shortfallReason,
    })
    .from(pickListLine)
    .where(
      and(
        eq(pickListLine.pickListId, pickListId),
        sql`${pickListLine.pickedQuantity} < ${pickListLine.requestedQuantity}`,
      ),
    )
    .orderBy(pickListLine.lineNo);
}
