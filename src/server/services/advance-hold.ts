/**
 * An import bought with an advance, held until the advance is paid — by
 * direction 2026-10-06:
 *
 *   "the advanced option has one extra warehouse, On Process (Without SWIFT)
 *    … once its payment application of its own is done, then it goes In
 *    Process and continues like other applications — but their payment
 *    application has to be done."
 *
 * So an import invoice that agrees an advance lands its goods in the branch's
 * On Process (Without SWIFT) warehouse when it posts (`ap-invoice.post` asks
 * `holdWarehouseOf`), and they stay there until a payment application of the
 * import is Paid (`payment-applications.confirm` calls `release`), when they
 * move to In Process and the import goes on as any other. A container cannot
 * be received out of the hold (`shipments.receive` asks `heldOf`): the goods
 * reach their warehouse through In Process, as every import's do. The hold is
 * the import's and is released once: an invoice linked to the import after an
 * application of it is Paid is not held (`advancePaid`).
 *
 * Nothing here posts: a move between two transit warehouses of one branch is
 * the same stock at the same cost (`inventory.relocate`).
 */
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { apInvoice, apInvoiceLine, costLayer, inventoryMovement, paymentApplication, warehouse } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal } from '../domain/money';
import { parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as inventory from './inventory';
import * as events from './payable-events';

/** The stage code of the hold (0405). */
export const HOLD_STAGE = 'without_swift' as const;

async function stageWarehouseOf(tx: Tx, branchCode: string, stage: 'without_swift' | 'in_process'): Promise<string | null> {
  const [row] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(and(eq(warehouse.shipmentStage, stage), eq(warehouse.branchCode, branchCode), eq(warehouse.active, true)))
    .limit(1);
  return row?.code ?? null;
}

/** The branch's On Process (Without SWIFT) warehouse, or null when none is set up. */
export function holdWarehouseOf(tx: Tx, branchCode: string): Promise<string | null> {
  return stageWarehouseOf(tx, branchCode, HOLD_STAGE);
}

/** The branch's In Process warehouse, where held goods go when the advance is paid. */
export function inProcessWarehouseOf(tx: Tx, branchCode: string): Promise<string | null> {
  return stageWarehouseOf(tx, branchCode, 'in_process');
}

/**
 * The import's advance is paid: a payment application of the import is Paid
 * (confirmed) or Debited. A later invoice linked to such an import is not
 * held — its goods go to In Process like any import's — because the hold is
 * the import's, released once, and "linked purchases cannot go back to steps"
 * (2026-10-07, by direction).
 */
export async function advancePaid(tx: Tx, payableId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: paymentApplication.id })
    .from(paymentApplication)
    .where(and(eq(paymentApplication.payableId, payableId), inArray(paymentApplication.status, ['confirmed', 'debited'])))
    .limit(1);
  return Boolean(row);
}

/** The import's posted (and not reversed) invoices — the ones whose goods can be held. */
async function postedInvoicesOf(tx: Tx, payableId: string) {
  return tx
    .select({ id: apInvoice.id, invoiceNo: apInvoice.invoiceNo, branchCode: apInvoice.branchCode })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), ne(apInvoice.status, 'reversed'), isNull(apInvoice.reversedAt)))
    .orderBy(asc(apInvoice.invoiceNo));
}

/** The layers the import's invoices still have in a hold warehouse, oldest first. */
async function heldLayers(tx: Tx, invoiceIds: readonly string[]) {
  if (invoiceIds.length === 0) return [];
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
      invoiceId: inventoryMovement.sourceDocumentId,
      lineId: inventoryMovement.sourceLineId,
    })
    .from(costLayer)
    .innerJoin(inventoryMovement, eq(inventoryMovement.id, costLayer.createdByMovementId))
    .innerJoin(warehouse, eq(warehouse.code, costLayer.warehouseCode))
    .where(
      and(
        inArray(inventoryMovement.sourceDocumentId, [...invoiceIds]),
        eq(warehouse.shipmentStage, HOLD_STAGE),
        sql`${costLayer.remainingQuantity} > 0`,
      ),
    )
    .orderBy(asc(costLayer.layerDate), asc(costLayer.sequence))
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        originalQuantity: parseQuantity(row.originalQuantity),
        remainingQuantity: parseQuantity(row.remainingQuantity),
        unitCostIqd: parseDecimal(row.unitCostIqd, 4n),
      })),
    );
}

/**
 * What of this import still waits for its advance, per item, in base units —
 * one statement, because the import's page reads it on every open (HD14).
 */
export async function heldOf(tx: Tx, payableId: string): Promise<{ readonly itemCode: string; readonly quantity: bigint; readonly warehouseCode: string }[]> {
  const layers = await tx
    .select({ itemCode: costLayer.itemCode, warehouseCode: costLayer.warehouseCode, remainingQuantity: costLayer.remainingQuantity })
    .from(costLayer)
    .innerJoin(inventoryMovement, eq(inventoryMovement.id, costLayer.createdByMovementId))
    .innerJoin(warehouse, eq(warehouse.code, costLayer.warehouseCode))
    .innerJoin(apInvoice, sql`${apInvoice.id}::text = ${inventoryMovement.sourceDocumentId}`)
    .where(
      and(
        eq(apInvoice.payableId, payableId),
        ne(apInvoice.status, 'reversed'),
        eq(warehouse.shipmentStage, HOLD_STAGE),
        sql`${costLayer.remainingQuantity} > 0`,
      ),
    )
    .then((rows) => rows.map((row) => ({ ...row, remainingQuantity: parseQuantity(row.remainingQuantity) })));
  const byItem = new Map<string, { itemCode: string; quantity: bigint; warehouseCode: string }>();
  for (const layer of layers) {
    const key = `${layer.itemCode}|${layer.warehouseCode}`;
    const seen = byItem.get(key) ?? { itemCode: layer.itemCode, quantity: 0n, warehouseCode: layer.warehouseCode };
    seen.quantity += layer.remainingQuantity;
    byItem.set(key, seen);
  }
  return [...byItem.values()];
}

/**
 * The advance is paid: every unit of the import still in On Process (Without
 * SWIFT) moves to In Process, layer by layer, at the cost it came in at.
 * Returns how many base units moved (0 when nothing was held — an import
 * without an advance, or one released already).
 */
export async function release(
  tx: Tx,
  ctx: ActorContext,
  payableId: string,
  because:
    | { readonly applicationNo: string; readonly on?: string | null }
    /** Released without a payment: the import is paid after the goods arrive (0426). */
    | { readonly reason: string; readonly on?: string | null },
): Promise<bigint> {
  const invoices = await postedInvoicesOf(tx, payableId);
  const layers = await heldLayers(tx, invoices.map((invoice) => invoice.id));
  if (layers.length === 0) return 0n;

  const lines = await tx
    .select({ id: apInvoiceLine.id, apInvoiceId: apInvoiceLine.apInvoiceId })
    .from(apInvoiceLine)
    .where(inArray(apInvoiceLine.apInvoiceId, invoices.map((invoice) => invoice.id)));
  const known = new Set(lines.map((line) => line.id));
  const branchOf = new Map(invoices.map((invoice) => [invoice.id, invoice.branchCode] as const));

  // One move per invoice line and warehouse: the layers of one line travel together.
  const groups = new Map<string, typeof layers>();
  for (const layer of layers) {
    const key = `${layer.invoiceId}|${layer.lineId ?? ''}|${layer.warehouseCode}|${layer.itemCode}`;
    groups.set(key, [...(groups.get(key) ?? []), layer]);
  }

  let moved = 0n;
  const movedItems: string[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const branchCode = branchOf.get(first.invoiceId!) ?? ctx.branchCode;
    const target = await inProcessWarehouseOf(tx, branchCode);
    if (!target) {
      throw new Error(
        `${branchCode} has no In Process warehouse, so the goods held for the advance have nowhere to go. ` +
          'Set up the branch’s transit warehouses (Warehouses) and confirm again.',
      );
    }
    const quantity = group.reduce((sum, layer) => sum + layer.remainingQuantity, 0n);
    const result = await inventory.relocate(tx, ctx, {
      itemCode: first.itemCode,
      fromWarehouseCode: first.warehouseCode,
      toWarehouseCode: target,
      branchCode,
      quantity,
      movementDate: because.on ?? businessToday(),
      layers: group.map(({ invoiceId: _invoice, lineId: _line, ...layer }) => layer),
      sourceDocumentType: 'ap_invoice',
      sourceDocumentId: first.invoiceId!,
      sourceLineId: first.lineId && known.has(first.lineId) ? first.lineId : null,
    });
    moved += result.moved;
    movedItems.push(first.itemCode);
  }

  const items = [...new Set(movedItems)].join(', ');
  await events.record(tx, {
    payableId,
    eventCode: 'ADVANCE_RELEASED',
    ...('applicationNo' in because
      ? {
          summary:
            `${because.applicationNo} paid — the goods held for the advance (${items}) ` +
            'moved from On Process (Without SWIFT) to In Process; the import goes on as any other.',
          sourceType: 'payment_application',
          sourceNo: because.applicationNo,
        }
      : {
          summary:
            `Paid after the goods arrive — the goods held for the advance (${items}) moved from ` +
            `On Process (Without SWIFT) to In Process without a payment: ${because.reason}`,
        }),
    actorUserId: ctx.principal.userId,
  });
  return moved;
}
