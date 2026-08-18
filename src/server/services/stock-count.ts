/**
 * Stock counts — Phase 04.8, §9.6.
 *
 * *"Stock Count Plan → Physical Count → Recount where required → Variance
 * Approval → Inventory Adjustment."*
 *
 * The step that carries the control is the fourth. Counting produces a
 * difference; it does not produce an adjustment. Somebody has to look at a
 * variance and decide whether to believe it, and §9.6 puts that decision with a
 * Warehouse Manager — because an adjustment is stock appearing or disappearing,
 * and the accounting consequence of the second is a loss.
 *
 * So `approveVariance` and `adjust` are separate calls with different verbs,
 * and the database refuses an adjustment on a count nobody approved.
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { stockCount, stockCountLine } from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'stock_count';
const DOCUMENT_TYPE = 'stock_count';
const SEQUENCE_KEY = 'STOCK_COUNT';

export type CountScope = 'full' | 'warehouse' | 'item' | 'category';

export class StockCountNotFoundError extends Error {
  readonly code = 'STOCK_COUNT_NOT_FOUND';
  constructor(id: string) {
    super(`No stock count '${id}'.`);
    this.name = 'StockCountNotFoundError';
  }
}

export class StockCountStateError extends Error {
  readonly code = 'STOCK_COUNT_STATE_INVALID';
  constructor(countNo: string, status: string, detail: string) {
    super(`Stock count ${countNo} is '${status}': ${detail}`);
    this.name = 'StockCountStateError';
  }
}

export class VarianceNotApprovedError extends Error {
  readonly code = 'VARIANCE_NOT_APPROVED';
  constructor(readonly countNo: string) {
    // §25 — the reason and what has to happen instead.
    super(
      `Stock count ${countNo} has a variance nobody has approved, so nothing can be adjusted (§9.6). ` +
        'A Warehouse Manager reviews the difference and approves it with a reason; the adjustment follows from that, not from the count.',
    );
    this.name = 'VarianceNotApprovedError';
  }
}

export interface PlanInput {
  readonly branchCode: string;
  readonly warehouseCode: string;
  readonly plannedOn: string;
  readonly scope: CountScope;
  /** Item code or category, depending on the scope. */
  readonly scopeFilter?: string | null;
}

/**
 * §9.6 step 1 — the plan.
 *
 * The item set is resolved now and the book quantity is snapshotted onto each
 * line. Both matter: the scope is what was *intended* to be counted, and a
 * variance is a difference against what the books said when counting began. A
 * snapshot taken at approval time would silently absorb every movement that
 * happened while the counters were walking the aisles.
 */
export async function plan(
  tx: Tx,
  ctx: ActorContext,
  input: PlanInput,
): Promise<{ id: string; countNo: string; lines: number }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const items = await itemsInScope(tx, input);

  if (items.length === 0) {
    throw new Error(
      `Nothing is in scope for this count: ${describeScope(input)}. ` +
        'Widen the scope, or check that the warehouse holds the stock you meant.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.plannedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [count] = await tx
    .insert(stockCount)
    .values({
      countNo: allocated.documentNo,
      branchCode: input.branchCode,
      warehouseCode: input.warehouseCode,
      scope: input.scope,
      scopeFilter: input.scopeFilter ?? null,
      plannedOn: input.plannedOn,
      plannedBy: ctx.principal.userId,
    })
    .returning({ id: stockCount.id });

  for (const [index, entry] of items.entries()) {
    await tx.insert(stockCountLine).values({
      stockCountId: count!.id,
      lineNo: index + 1,
      itemCode: entry.itemCode,
      // §9.6 — visible to the counter, and frozen here.
      systemQuantity: formatQuantity(entry.onHand),
      serialNumber: entry.serialNumber,
      batchNumber: entry.batchNumber,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'stock_count.planned',
    objectType: PERMISSION_OBJECT,
    objectId: count!.id,
    branchCode: input.branchCode,
    after: {
      countNo: allocated.documentNo,
      warehouse: input.warehouseCode,
      scope: input.scope,
      scopeFilter: input.scopeFilter ?? null,
      lines: items.length,
    },
    outcome: 'success',
  });

  return { id: count!.id, countNo: allocated.documentNo, lines: items.length };
}

function describeScope(input: PlanInput): string {
  switch (input.scope) {
    case 'full':
      return `everything in ${input.warehouseCode}`;
    case 'warehouse':
      return `all stock in ${input.warehouseCode}`;
    case 'item':
      return `item ${input.scopeFilter} in ${input.warehouseCode}`;
    case 'category':
      return `category ${input.scopeFilter} in ${input.warehouseCode}`;
  }
}

/**
 * §9.6 — "full, by warehouse, item, category or filter".
 *
 * Resolved from the position view, so a count covers what is actually there.
 * An item with no stock in this warehouse is not in scope: counting zero of
 * something that has never been stocked produces variance lines nobody reads,
 * and hides the ones that matter.
 */
async function itemsInScope(
  tx: Tx,
  input: PlanInput,
): Promise<
  { itemCode: string; onHand: bigint; serialNumber: string | null; batchNumber: string | null }[]
> {
  const filters = [sql`m.warehouse_code = ${input.warehouseCode}`];

  if (input.scope === 'item') {
    filters.push(sql`m.item_code = ${input.scopeFilter ?? ''}`);
  }
  if (input.scope === 'category') {
    filters.push(sql`i.category = ${input.scopeFilter ?? ''}`);
  }

  // Grouped by tracking identity, not only by item. A counter walking the aisle
  // counts "batch B-1: 92" — and §9.3 requires every movement to carry the
  // identity, so an adjustment line that knew only the item total could not be
  // written at all. For an untracked item the identity columns are null and the
  // grouping collapses back to one line per item.
  const result = await tx.execute(sql`
    select m.item_code,
           m.serial_number,
           m.batch_number,
           sum(m.quantity) as on_hand
      from inventory_movement m
      join item i on i.code = m.item_code
     where ${sql.join(filters, sql` and `)}
     group by m.item_code, m.serial_number, m.batch_number
    having sum(m.quantity) <> 0
     order by m.item_code, m.batch_number nulls first, m.serial_number nulls first
  `);

  return (
    result as unknown as {
      rows: {
        item_code: string;
        serial_number: string | null;
        batch_number: string | null;
        on_hand: string;
      }[];
    }
  ).rows.map((row) => ({
    itemCode: row.item_code,
    onHand: parseQuantity(row.on_hand),
    serialNumber: row.serial_number,
    batchNumber: row.batch_number,
  }));
}

async function load(tx: Tx, id: string) {
  const [count] = await tx.select().from(stockCount).where(eq(stockCount.id, id)).limit(1);
  if (!count) throw new StockCountNotFoundError(id);

  const lines = await tx
    .select()
    .from(stockCountLine)
    .where(eq(stockCountLine.stockCountId, id))
    .orderBy(stockCountLine.lineNo);

  return { count, lines };
}

export interface RecordCountInput {
  readonly countedOn: string;
  /** Line number → quantity physically found. */
  readonly quantities: Readonly<Record<number, bigint>>;
  readonly notes?: Readonly<Record<number, string>>;
}

/** §9.6 step 2 — the physical count. */
export async function recordCount(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: RecordCountInput,
): Promise<void> {
  const { count, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: count.branchCode,
  });

  if (count.status !== 'planned' && count.status !== 'recount') {
    throw new StockCountStateError(
      count.countNo,
      count.status,
      'a count can only be recorded while it is planned or being recounted.',
    );
  }

  const isRecount = count.status === 'recount';

  for (const line of lines) {
    const counted = input.quantities[line.lineNo];
    if (counted === undefined) continue;

    await tx
      .update(stockCountLine)
      .set(
        isRecount
          ? { recountQuantity: formatQuantity(counted), note: input.notes?.[line.lineNo] ?? line.note }
          : { countedQuantity: formatQuantity(counted), note: input.notes?.[line.lineNo] ?? line.note },
      )
      .where(eq(stockCountLine.id, line.id));
  }

  await tx
    .update(stockCount)
    .set({
      status: 'counted',
      countedOn: input.countedOn,
      countedBy: ctx.principal.userId,
      updatedAt: new Date(),
    })
    .where(eq(stockCount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: isRecount ? 'stock_count.recounted' : 'stock_count.counted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: count.branchCode,
    before: { status: count.status },
    after: { status: 'counted', countedOn: input.countedOn },
    outcome: 'success',
  });
}

/** §9.6 step 3 — send it back to be counted again. */
export async function requestRecount(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const { count } = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: count.branchCode,
  });

  if (count.status !== 'counted') {
    throw new StockCountStateError(
      count.countNo,
      count.status,
      'only a completed count can be sent for recount.',
    );
  }

  if (!reason.trim()) {
    throw new Error(
      'A recount costs the warehouse a day. §5.4 keeps the reason with it — state what looked wrong.',
    );
  }

  await tx
    .update(stockCount)
    .set({ status: 'recount', updatedAt: new Date() })
    .where(eq(stockCount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'stock_count.recount_requested',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: count.branchCode,
    before: { status: 'counted' },
    after: { status: 'recount' },
    reason,
    outcome: 'success',
  });
}

export interface Variance {
  readonly lineNo: number;
  readonly itemCode: string;
  readonly systemQuantity: bigint;
  readonly countedQuantity: bigint;
  readonly variance: bigint;
}

/**
 * §9.6 — *"the system calculates physical-to-book differences"*.
 *
 * The recount supersedes the first count where one was taken; both are kept on
 * the line, because "we counted it twice and got different answers" is itself a
 * finding.
 */
export async function variances(tx: Tx, id: string): Promise<Variance[]> {
  const { lines } = await load(tx, id);

  return lines
    .filter((line) => line.countedQuantity !== null || line.recountQuantity !== null)
    .map((line) => {
      const system = parseQuantity(line.systemQuantity);
      const counted = parseQuantity(line.recountQuantity ?? line.countedQuantity!);
      return {
        lineNo: line.lineNo,
        itemCode: line.itemCode,
        systemQuantity: system,
        countedQuantity: counted,
        variance: counted - system,
      };
    })
    .filter((v) => v.variance !== 0n);
}

/**
 * §9.6 step 4 — variance approval, by a Warehouse Manager.
 *
 * The `approve` verb. A count that finds less stock than the books say is a
 * loss, and §9.6 makes writing it off a decision with a name against it rather
 * than an arithmetic consequence of counting.
 */
export async function approveVariance(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<{ variances: Variance[] }> {
  const { count } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: count.branchCode,
  });

  if (count.status !== 'counted') {
    throw new StockCountStateError(
      count.countNo,
      count.status,
      'a variance can only be approved once the stock has been counted.',
    );
  }

  if (!reason.trim()) {
    throw new Error(
      'Approving a variance moves stock and may post a loss. §5.4 keeps the reason with it — state what the difference was and why it is accepted.',
    );
  }

  const found = await variances(tx, id);

  await tx
    .update(stockCount)
    .set({
      status: 'pending_approval',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      approvalReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(stockCount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'stock_count.variance_approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: count.branchCode,
    after: {
      variances: found.length,
      net: formatQuantity(found.reduce((sum, v) => sum + v.variance, 0n)),
    },
    reason,
    outcome: 'success',
  });

  return { variances: found };
}

export interface AdjustInput {
  readonly adjustedOn: string;
  /** The unit cost to bring a *surplus* on at. Shortfalls use FIFO. */
  readonly surplusUnitCostIqd?: bigint;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.6 step 5 — the inventory adjustment.
 *
 * A shortfall issues stock at its FIFO cost, which is what the loss is worth. A
 * surplus receives stock, and the cost has to come from somewhere: the caller
 * states it, because the system genuinely does not know what unrecorded stock
 * cost and guessing would put an invented figure into the valuation.
 */
export async function adjust(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: AdjustInput,
): Promise<{ movementIds: readonly string[] }> {
  const { count, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: count.branchCode,
  });

  if (count.approvedBy === null) {
    throw new VarianceNotApprovedError(count.countNo);
  }

  if (count.status !== 'pending_approval') {
    throw new StockCountStateError(
      count.countNo,
      count.status,
      'the adjustment follows an approved variance.',
    );
  }

  const movementIds: string[] = [];

  for (const line of lines) {
    const counted = line.recountQuantity ?? line.countedQuantity;
    if (counted === null) continue;

    const variance = parseQuantity(counted) - parseQuantity(line.systemQuantity);
    if (variance === 0n) continue;

    const movement =
      variance > 0n
        ? await inventory.receive(tx, ctx, {
            itemCode: line.itemCode,
            warehouseCode: count.warehouseCode,
            branchCode: count.branchCode,
            quantity: variance,
            unitCostIqd: input.surplusUnitCostIqd ?? 0n,
            movementDate: input.adjustedOn,
            kind: 'count_adjustment',
            sourceDocumentType: DOCUMENT_TYPE,
            sourceDocumentId: count.id,
            sourceLineId: String(line.lineNo),
            serialNumber: line.serialNumber,
            batchNumber: line.batchNumber,
            post: input.post ?? false,
            dimensions: input.dimensions,
          })
        : await inventory.issue(tx, ctx, {
            itemCode: line.itemCode,
            warehouseCode: count.warehouseCode,
            branchCode: count.branchCode,
            quantity: -variance,
            movementDate: input.adjustedOn,
            kind: 'count_adjustment',
            sourceDocumentType: DOCUMENT_TYPE,
            sourceDocumentId: count.id,
            sourceLineId: String(line.lineNo),
            serialNumber: line.serialNumber,
            batchNumber: line.batchNumber,
            post: input.post ?? false,
            dimensions: input.dimensions,
          });

    movementIds.push(movement.movementId);

    await tx
      .update(stockCountLine)
      .set({ movementId: movement.movementId })
      .where(eq(stockCountLine.id, line.id));
  }

  await tx
    .update(stockCount)
    .set({ status: 'adjusted', adjustedOn: input.adjustedOn, updatedAt: new Date() })
    .where(eq(stockCount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'stock_count.adjusted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: count.branchCode,
    before: { status: 'pending_approval' },
    after: { status: 'adjusted', movements: movementIds.length },
    outcome: 'success',
  });

  return { movementIds };
}

/** §9.9 — variances that are still open, for the report that keeps them visible. */
export async function openVariances(tx: Tx) {
  const result = await tx.execute(sql`
    select count_no, status, warehouse_code, line_no, item_code,
           system_quantity::text  as system_quantity,
           counted_quantity::text as counted_quantity,
           variance::text         as variance
      from stock_count_variance
     order by count_no, line_no
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}

/** The count as a record page would show it. */
export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

