/**
 * Warehouse transfers — Phase 04.6, §9.4.
 *
 * *"Inventory Transfer Request → Goods Issue from Source → In Transit → Goods
 * Receipt at Destination"*, with the destination confirming actual receipt and
 * differences remaining in Transit under Investigation.
 *
 * The rule that shapes everything here: **stock in transit is in neither
 * warehouse**. It has left the source, so the source cannot sell it; it has not
 * arrived, so the destination cannot either. Any model that keeps it available
 * at one end is a model that lets a warehouse promise stock which is on a lorry.
 *
 * The second rule: **the destination inherits the source's FIFO costs**. A
 * transfer is not a purchase. Revaluing the goods on arrival would make moving
 * stock between warehouses a way of restating margin, and §9.2's single
 * valuation method exists to stop exactly that.
 */
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { warehouseTransfer, warehouseTransferLine } from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'warehouse_transfer';
const DOCUMENT_TYPE = 'warehouse_transfer';
const SEQUENCE_KEY = 'WAREHOUSE_TRANSFER';

export class TransferNotFoundError extends Error {
  readonly code = 'TRANSFER_NOT_FOUND';
  constructor(id: string) {
    super(`No warehouse transfer '${id}'.`);
    this.name = 'TransferNotFoundError';
  }
}

export class TransferStateError extends Error {
  readonly code = 'TRANSFER_STATE_INVALID';
  constructor(
    readonly transferNo: string,
    readonly status: string,
    detail: string,
  ) {
    // §25 — what is wrong, and what the document's state actually is.
    super(`Transfer ${transferNo} is '${status}': ${detail}`);
    this.name = 'TransferStateError';
  }
}

export class LossApprovalRequiredError extends Error {
  readonly code = 'LOSS_APPROVAL_REQUIRED';
  constructor(readonly transferNo: string) {
    super(
      `Stock issued on transfer ${transferNo} did not arrive. Writing it off is a Warehouse Manager's decision (§9.4), ` +
        'so it needs their approval and a stated reason. Until then the difference stays under investigation, which is where it belongs.',
    );
    this.name = 'LossApprovalRequiredError';
  }
}

export interface TransferLineInput {
  readonly itemCode: string;
  readonly quantity: bigint;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
}

export interface CreateTransferInput {
  readonly sourceWarehouseCode: string;
  readonly destinationWarehouseCode: string;
  readonly branchCode: string;
  readonly requestedOn: string;
  readonly reason?: string | null;
  readonly lines: readonly TransferLineInput[];
}

/**
 * §9.4 step 1 — the request.
 *
 * Nothing moves. A request is a statement of intent, and stock stays available
 * at the source until it is actually issued: reserving it here would take it
 * out of circulation for a transfer that may never be approved.
 */
export async function request(
  tx: Tx,
  ctx: ActorContext,
  input: CreateTransferInput,
): Promise<{ id: string; transferNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error(
      'A transfer with no lines moves nothing. Add the items being moved, or cancel the request.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.requestedOn.slice(0, 4)) },
    ctx.principal.userId,
  );
  const transferNo = allocated.documentNo;

  const [transfer] = await tx
    .insert(warehouseTransfer)
    .values({
      transferNo,
      sourceWarehouseCode: input.sourceWarehouseCode,
      destinationWarehouseCode: input.destinationWarehouseCode,
      branchCode: input.branchCode,
      requestedOn: input.requestedOn,
      reason: input.reason ?? null,
      requestedBy: ctx.principal.userId,
    })
    .returning({ id: warehouseTransfer.id });

  for (const [index, line] of input.lines.entries()) {
    await tx.insert(warehouseTransferLine).values({
      transferId: transfer!.id,
      lineNo: index + 1,
      itemCode: line.itemCode,
      requestedQuantity: formatQuantity(line.quantity),
      serialNumber: line.serialNumber ?? null,
      batchNumber: line.batchNumber ?? null,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse_transfer.requested',
    objectType: PERMISSION_OBJECT,
    objectId: transfer!.id,
    branchCode: input.branchCode,
    after: {
      transferNo,
      from: input.sourceWarehouseCode,
      to: input.destinationWarehouseCode,
      lines: input.lines.length,
    },
    outcome: 'success',
  });

  return { id: transfer!.id, transferNo };
}

async function load(tx: Tx, transferId: string) {
  const [transfer] = await tx
    .select()
    .from(warehouseTransfer)
    .where(eq(warehouseTransfer.id, transferId))
    .limit(1);

  if (!transfer) throw new TransferNotFoundError(transferId);

  const lines = await tx
    .select()
    .from(warehouseTransferLine)
    .where(eq(warehouseTransferLine.transferId, transferId))
    .orderBy(warehouseTransferLine.lineNo);

  return { transfer, lines };
}

/** §9.4 — approval, before anything leaves. */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  transferId: string,
): Promise<void> {
  const { transfer } = await load(tx, transferId);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
  });

  if (transfer.status !== 'requested') {
    throw new TransferStateError(
      transfer.transferNo,
      transfer.status,
      'only a requested transfer can be approved.',
    );
  }

  if (transfer.requestedBy === ctx.principal.userId) {
    // The same segregation §5.2 applies to every document: the person who
    // asked for the stock does not also authorise it leaving.
    throw new TransferStateError(
      transfer.transferNo,
      transfer.status,
      'the person who requested a transfer cannot approve it. Ask another approver (§5.2).',
    );
  }

  await tx
    .update(warehouseTransfer)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(warehouseTransfer.id, transferId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse_transfer.approved',
    objectType: PERMISSION_OBJECT,
    objectId: transferId,
    branchCode: transfer.branchCode,
    before: { status: transfer.status },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

export interface IssueTransferInput {
  readonly issuedOn: string;
  /** Line number → quantity actually issued. Absent means the full request. */
  readonly quantities?: Readonly<Record<number, bigint>>;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.4 step 2 — goods issue from the source.
 *
 * The stock leaves the source warehouse and enters in-transit: available at
 * neither end until the destination confirms. Appendix C: *Dr Inventory in
 * Transit / Cr Source Warehouse Inventory* — which is what `transfer_issue`
 * posts.
 */
export async function issue(
  tx: Tx,
  ctx: ActorContext,
  transferId: string,
  input: IssueTransferInput,
): Promise<void> {
  const { transfer, lines } = await load(tx, transferId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
  });

  if (transfer.status !== 'approved') {
    throw new TransferStateError(
      transfer.transferNo,
      transfer.status,
      'stock can only be issued once the transfer is approved (§9.4).',
    );
  }

  for (const line of lines) {
    const quantity = input.quantities?.[line.lineNo] ?? parseQuantity(line.requestedQuantity);
    if (quantity === 0n) continue;

    const movement = await inventory.issue(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: transfer.sourceWarehouseCode,
      branchCode: transfer.branchCode,
      quantity,
      movementDate: input.issuedOn,
      kind: 'transfer_issue',
      sourceDocumentType: DOCUMENT_TYPE,
      sourceDocumentId: transfer.id,
      sourceLineId: String(line.lineNo),
      serialNumber: line.serialNumber ?? null,
      batchNumber: line.batchNumber ?? null,
      post: input.post ?? false,
      dimensions: input.dimensions,
    });

    await tx
      .update(warehouseTransferLine)
      .set({
        issuedQuantity: formatQuantity(quantity),
        issueMovementId: movement.movementId,
      })
      .where(eq(warehouseTransferLine.id, line.id));
  }

  await tx
    .update(warehouseTransfer)
    .set({
      status: 'in_transit',
      issuedOn: input.issuedOn,
      issuedBy: ctx.principal.userId,
      updatedAt: new Date(),
    })
    .where(eq(warehouseTransfer.id, transferId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse_transfer.issued',
    objectType: PERMISSION_OBJECT,
    objectId: transferId,
    branchCode: transfer.branchCode,
    before: { status: transfer.status },
    after: { status: 'in_transit', issuedOn: input.issuedOn },
    outcome: 'success',
  });
}

export interface ReceiveTransferInput {
  readonly receivedOn: string;
  /** Line number → quantity actually counted at the destination. */
  readonly quantities: Readonly<Record<number, bigint>>;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.4 step 4 — goods receipt at the destination.
 *
 * The destination counts what actually arrived. Where that is less than what
 * left, the difference stays in transit and the transfer moves to
 * `investigating` — §9.4 requires it to remain visible, not to be absorbed.
 *
 * The layers the source consumed are recreated at the destination **at their
 * original costs** (04.6's gate), so the same goods are worth the same money
 * wherever they are standing.
 */
export async function receive(
  tx: Tx,
  ctx: ActorContext,
  transferId: string,
  input: ReceiveTransferInput,
): Promise<{ status: string; shortfall: bigint }> {
  const { transfer, lines } = await load(tx, transferId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
  });

  if (transfer.status !== 'in_transit' && transfer.status !== 'partially_received') {
    throw new TransferStateError(
      transfer.transferNo,
      transfer.status,
      'only stock that is in transit can be received.',
    );
  }

  let shortfall = 0n;

  for (const line of lines) {
    const issued = parseQuantity(line.issuedQuantity);
    const alreadyReceived = parseQuantity(line.receivedQuantity);
    const arriving = input.quantities[line.lineNo] ?? 0n;

    if (arriving > 0n) {
      // The destination's layers are the source's layers, at their own costs.
      const consumed = await inventory.consumptionsOf(tx, line.issueMovementId!);
      await receiveInheritingCosts(tx, ctx, {
        transfer,
        line,
        quantity: arriving,
        issued,
        consumed,
        receivedOn: input.receivedOn,
        post: input.post ?? false,
        dimensions: input.dimensions,
      });
    }

    const received = alreadyReceived + arriving;
    shortfall += issued - received;

    await tx
      .update(warehouseTransferLine)
      .set({ receivedQuantity: formatQuantity(received) })
      .where(eq(warehouseTransferLine.id, line.id));
  }

  // §9.4 — "Differences remain in Transit under Investigation."
  const status = shortfall > 0n ? 'investigating' : 'received';

  await tx
    .update(warehouseTransfer)
    .set({
      status,
      receivedOn: input.receivedOn,
      receivedBy: ctx.principal.userId,
      updatedAt: new Date(),
    })
    .where(eq(warehouseTransfer.id, transferId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse_transfer.received',
    objectType: PERMISSION_OBJECT,
    objectId: transferId,
    branchCode: transfer.branchCode,
    before: { status: transfer.status },
    after: { status, shortfall: formatQuantity(shortfall) },
    outcome: 'success',
  });

  return { status, shortfall };
}

/**
 * Recreates the source's layers at the destination.
 *
 * Proportional where a receipt is partial: taking the oldest layers first would
 * make a short receipt arrive cheaper or dearer than the goods actually were,
 * and the remainder would carry the balance — a valuation difference created by
 * a lorry being late.
 */
async function receiveInheritingCosts(
  tx: Tx,
  ctx: ActorContext,
  input: {
    transfer: typeof warehouseTransfer.$inferSelect;
    line: typeof warehouseTransferLine.$inferSelect;
    quantity: bigint;
    issued: bigint;
    consumed: Awaited<ReturnType<typeof inventory.consumptionsOf>>;
    receivedOn: string;
    post: boolean;
    dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
  },
): Promise<void> {
  let remaining = input.quantity;

  for (const [index, consumption] of input.consumed.entries()) {
    if (remaining === 0n) break;

    const fromThisLayer = parseQuantity(consumption.quantity);
    // The last layer takes whatever is left, so rounding never loses a unit.
    const share =
      index === input.consumed.length - 1
        ? remaining
        : min(remaining, (fromThisLayer * input.quantity) / input.issued);

    if (share <= 0n) continue;

    const movement = await inventory.receive(tx, ctx, {
      itemCode: input.line.itemCode,
      warehouseCode: input.transfer.destinationWarehouseCode,
      branchCode: input.transfer.branchCode,
      quantity: share,
      unitCostIqd: BigInt(consumption.unitCostIqd.replace('.', '')),
      movementDate: input.receivedOn,
      kind: 'transfer_receipt',
      sourceDocumentType: DOCUMENT_TYPE,
      sourceDocumentId: input.transfer.id,
      sourceLineId: String(input.line.lineNo),
      serialNumber: input.line.serialNumber ?? null,
      batchNumber: input.line.batchNumber ?? null,
      post: input.post,
      dimensions: input.dimensions,
    });

    if (index === 0) {
      await tx
        .update(warehouseTransferLine)
        .set({ receiptMovementId: movement.movementId })
        .where(eq(warehouseTransferLine.id, input.line.id));
    }

    remaining -= share;
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export interface ResolveInput {
  readonly outcome: 'found' | 'not_found';
  readonly resolvedOn: string;
  readonly reason: string;
  /** Line number → quantity found, for the 'found' outcome. */
  readonly quantities?: Readonly<Record<number, bigint>>;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.4 — resolving an investigation.
 *
 * *"Found: destination receipt completed. Not found: Warehouse Manager approves
 * Inventory Loss and the system posts the loss."*
 *
 * "Not found" needs the `approve` verb, a named approver and a stated reason.
 * Stock that left a warehouse and never arrived is either somewhere or gone,
 * and deciding it is gone has a cost — Appendix C posts it to Inventory Loss
 * Expense, and §5.4 keeps who decided and why.
 */
export async function resolveInvestigation(
  tx: Tx,
  ctx: ActorContext,
  transferId: string,
  input: ResolveInput,
): Promise<void> {
  const { transfer, lines } = await load(tx, transferId);

  if (transfer.status !== 'investigating') {
    throw new TransferStateError(
      transfer.transferNo,
      transfer.status,
      'there is nothing under investigation on this transfer.',
    );
  }

  if (!input.reason.trim()) {
    throw new LossApprovalRequiredError(transfer.transferNo);
  }

  if (input.outcome === 'found') {
    await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
      branchCode: transfer.branchCode,
    });

    // The stock turned up: complete the receipt exactly as if it had arrived
    // with the rest, layers and all.
    await tx
      .update(warehouseTransfer)
      .set({ status: 'in_transit', updatedAt: new Date() })
      .where(eq(warehouseTransfer.id, transferId));

    await receive(tx, ctx, transferId, {
      receivedOn: input.resolvedOn,
      quantities: input.quantities ?? {},
      post: input.post ?? false,
      dimensions: input.dimensions,
    });

    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'warehouse_transfer.investigation_resolved',
      objectType: PERMISSION_OBJECT,
      objectId: transferId,
      branchCode: transfer.branchCode,
      after: { outcome: 'found' },
      reason: input.reason,
      outcome: 'success',
    });
    return;
  }

  // Not found — a Warehouse Manager's decision, and it costs money.
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
  });

  for (const line of lines) {
    const missing = parseQuantity(line.issuedQuantity) - parseQuantity(line.receivedQuantity);
    if (missing <= 0n) continue;

    // The loss is written against the *source*, because that is where the
    // stock was last counted and where its layers still are. Appendix C:
    // Dr Inventory Loss Expense / Cr Inventory in Transit.
    const movement = await inventory.receive(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: transfer.destinationWarehouseCode,
      branchCode: transfer.branchCode,
      quantity: missing,
      unitCostIqd: await lossUnitCost(tx, line.issueMovementId!),
      movementDate: input.resolvedOn,
      kind: 'transfer_receipt',
      sourceDocumentType: DOCUMENT_TYPE,
      sourceDocumentId: transfer.id,
      sourceLineId: String(line.lineNo),
      serialNumber: line.serialNumber ?? null,
      batchNumber: line.batchNumber ?? null,
      post: false,
    });

    const written = await inventory.issue(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: transfer.destinationWarehouseCode,
      branchCode: transfer.branchCode,
      quantity: missing,
      movementDate: input.resolvedOn,
      kind: 'write_off',
      sourceDocumentType: DOCUMENT_TYPE,
      sourceDocumentId: transfer.id,
      sourceLineId: String(line.lineNo),
      serialNumber: line.serialNumber ?? null,
      batchNumber: line.batchNumber ?? null,
      post: input.post ?? false,
      dimensions: input.dimensions,
    });

    void movement;

    await tx
      .update(warehouseTransferLine)
      .set({ lossMovementId: written.movementId })
      .where(eq(warehouseTransferLine.id, line.id));
  }

  await tx
    .update(warehouseTransfer)
    .set({
      status: 'closed',
      lossApprovedBy: ctx.principal.userId,
      lossApprovedAt: new Date(),
      lossReason: input.reason,
      updatedAt: new Date(),
    })
    .where(eq(warehouseTransfer.id, transferId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse_transfer.loss_approved',
    objectType: PERMISSION_OBJECT,
    objectId: transferId,
    branchCode: transfer.branchCode,
    after: { outcome: 'not_found', status: 'closed' },
    reason: input.reason,
    outcome: 'success',
  });
}

/** The FIFO cost the missing stock left at — what the loss is worth. */
async function lossUnitCost(tx: Tx, issueMovementId: string): Promise<bigint> {
  const consumed = await inventory.consumptionsOf(tx, issueMovementId);
  if (consumed.length === 0) return 0n;

  const total = consumed.reduce((sum, c) => sum + BigInt(c.costIqd.replace('.', '')), 0n);
  const quantity = consumed.reduce((sum, c) => sum + parseQuantity(c.quantity), 0n);
  if (quantity === 0n) return 0n;

  // Weighted across the layers the issue actually consumed — not an average of
  // the item's cost, which would value the loss at stock that never left.
  return (total * 1_000_000n) / quantity;
}

/** Closes a transfer whose stock is fully accounted for. */
export async function close(tx: Tx, ctx: ActorContext, transferId: string): Promise<void> {
  const { transfer } = await load(tx, transferId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
  });

  await tx
    .update(warehouseTransfer)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(warehouseTransfer.id, transferId));
}

/** §9.9 — transfer variances stay visible until completed or written off. */
export async function openVariances(tx: Tx) {
  const result = await tx.execute(sql`
    select t.transfer_no,
           t.status,
           t.source_warehouse_code,
           t.destination_warehouse_code,
           l.line_no,
           l.item_code,
           (l.issued_quantity - l.received_quantity)::text as outstanding
      from warehouse_transfer t
      join warehouse_transfer_line l on l.transfer_id = t.id
     where t.status in ('in_transit','partially_received','investigating')
       and l.issued_quantity > l.received_quantity
     order by t.transfer_no, l.line_no
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}

/** The transfer as a record page would show it. */
export async function view(tx: Tx, transferId: string) {
  const { transfer, lines } = await load(tx, transferId);
  return { transfer, lines };
}

