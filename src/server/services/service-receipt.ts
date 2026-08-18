/**
 * Service Receipt / Expense Confirmation — Phase 05.3, §8.6.
 *
 * §8.2: *"Service or expense purchase: Purchase Order → Service Receipt /
 * Expense Confirmation → A/P Invoice → Supplier Payment."*
 *
 * A goods receipt asks the warehouse "did it arrive?". Nothing arrives for a
 * consultancy month or a haulage run, so this document asks the department that
 * commissioned the work the same question — and it is the only document in the
 * purchasing flow that can ask it.
 *
 * **Owned by the benefiting department** (§8.6, Appendix B). Purchasing agreed
 * the price and Finance will pay the invoice; neither of them knows whether the
 * work was done. Enforced twice: here, with a message that names the department,
 * and in the database, because an approval recorded by somebody outside the
 * department is a signature with nothing behind it.
 *
 * **It posts nothing and moves no stock.** Appendix C has no row for this
 * document — the expense reaches the ledger at the A/P Invoice. Appendix B calls
 * the effect *"receipt evidence / accrual"*; whether a period-end accrual is
 * also wanted is D11, open, and not something this service may decide by writing
 * a journal.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  purchaseOrder,
  purchaseOrderLine,
  serviceReceipt,
  serviceReceiptLine,
  userDepartmentScope,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { isLineComplete, outstandingQuantity } from '../domain/receipt-tolerance';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

/** The Appendix B document type this service manages. */
export const DOCUMENT_TYPE = 'service_receipt';
export const PERMISSION_OBJECT = 'service_receipt';
const SEQUENCE_KEY = 'SERVICE_RECEIPT';

export class ServiceReceiptNotFoundError extends Error {
  readonly code = 'SERVICE_RECEIPT_NOT_FOUND';
  constructor(id: string) {
    super(`No service receipt '${id}'.`);
    this.name = 'ServiceReceiptNotFoundError';
  }
}

export class ServiceReceiptStateError extends Error {
  readonly code = 'SERVICE_RECEIPT_STATE_INVALID';
  constructor(receiptNo: string, status: string, detail: string) {
    super(`Service receipt ${receiptNo} is '${status}': ${detail}`);
    this.name = 'ServiceReceiptStateError';
  }
}

export class OrderNotConfirmableError extends Error {
  readonly code = 'ORDER_NOT_CONFIRMABLE';
  constructor(orderNo: string, status: string) {
    super(
      `Purchase order ${orderNo} is '${status}', so nothing can be confirmed against it (§8.2). ` +
        'An approved order is what authorises the work — approve it, or raise a new one.',
    );
    this.name = 'OrderNotConfirmableError';
  }
}

/** §8.6 — the benefiting department, and nobody else, confirms the work. */
export class NotTheBenefitingDepartmentError extends Error {
  readonly code = 'NOT_BENEFITING_DEPARTMENT';
  constructor(
    readonly departmentCode: string,
    readonly receiptNo: string,
  ) {
    super(
      `Confirmation ${receiptNo} is owned by department ${departmentCode} (§8.6), and you do not belong to it. ` +
        'Only the department that asked for the work can confirm it was done — ask them to approve it.',
    );
    this.name = 'NotTheBenefitingDepartmentError';
  }
}

export class NotAServiceLineError extends Error {
  readonly code = 'NOT_A_SERVICE_LINE';
  constructor(lineNo: number, orderNo: string) {
    super(
      `Line ${lineNo} of ${orderNo} is an inventory item (§8.2). ` +
        'Goods are received on a Goods Receipt by the warehouse, not confirmed here.',
    );
    this.name = 'NotAServiceLineError';
  }
}

export class LineNotOnOrderError extends Error {
  readonly code = 'LINE_NOT_ON_ORDER';
  constructor(orderNo: string) {
    super(
      `That line does not belong to purchase order ${orderNo}. ` +
        'A confirmation covers one order; confirm each order on its own document.',
    );
    this.name = 'LineNotOnOrderError';
  }
}

export class OverConfirmationError extends Error {
  readonly code = 'OVER_CONFIRMATION';
  constructor(
    readonly lineNo: number,
    ordered: bigint,
    alreadyConfirmed: bigint,
    arriving: bigint,
  ) {
    const q = (v: bigint) => formatQuantity(v);
    super(
      `Confirming ${q(arriving)} on line ${lineNo} would take the total to ${q(alreadyConfirmed + arriving)} ` +
        `against ${q(ordered)} ordered (§8.4). ` +
        'Confirm only what was delivered; if more was done than was ordered, the order is varied first.',
    );
    this.name = 'OverConfirmationError';
  }
}

export interface ConfirmationLineInput {
  readonly purchaseOrderLineId: string;
  readonly quantity: bigint;
  /** Defaults to the ordered line's description. */
  readonly description?: string | null;
  readonly costCentreCode?: string | null;
}

export interface CreateServiceReceiptInput {
  readonly purchaseOrderId: string;
  /** §8.6 — the department that asked for the work and will confirm it. */
  readonly departmentCode: string;
  readonly branchCode: string;
  readonly serviceDate: string;
  readonly supplierReference?: string | null;
  readonly note?: string | null;
  readonly lines: readonly ConfirmationLineInput[];
}

async function load(tx: Tx, id: string) {
  const [receipt] = await tx
    .select()
    .from(serviceReceipt)
    .where(eq(serviceReceipt.id, id))
    .limit(1);
  if (!receipt) throw new ServiceReceiptNotFoundError(id);

  const lines = await tx
    .select()
    .from(serviceReceiptLine)
    .where(eq(serviceReceiptLine.serviceReceiptId, id))
    .orderBy(serviceReceiptLine.lineNo);

  return { receipt, lines };
}

/** Whether this user belongs to the department (§8.6, §4.3). */
async function isInDepartment(tx: Tx, userId: string, departmentCode: string): Promise<boolean> {
  const [row] = await tx
    .select({ code: userDepartmentScope.departmentCode })
    .from(userDepartmentScope)
    .where(
      and(
        eq(userDepartmentScope.userId, userId),
        eq(userDepartmentScope.departmentCode, departmentCode),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * How much of an ordered line has already been confirmed, on approved
 * confirmations only.
 *
 * Drafts do not count. A confirmation somebody is still typing is not evidence
 * that anything was delivered, and counting it would let two half-finished
 * documents between them confirm the whole order.
 */
export async function confirmedQuantity(tx: Tx, purchaseOrderLineId: string): Promise<bigint> {
  const rows = await tx
    .select({ quantity: serviceReceiptLine.quantity })
    .from(serviceReceiptLine)
    .innerJoin(serviceReceipt, eq(serviceReceipt.id, serviceReceiptLine.serviceReceiptId))
    .where(
      and(
        eq(serviceReceiptLine.purchaseOrderLineId, purchaseOrderLineId),
        eq(serviceReceipt.status, 'approved'),
      ),
    );

  return rows.reduce((total, row) => total + parseQuantity(row.quantity), 0n);
}

/**
 * Raises a confirmation as a draft.
 *
 * Nothing is evidence yet: a draft is the department writing down what it
 * believes was delivered, which is a different act from standing behind it.
 */
export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateServiceReceiptInput,
): Promise<{ id: string; receiptNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error(
      'A confirmation with no lines confirms nothing. Say what was delivered, or do not raise it.',
    );
  }

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(eq(purchaseOrder.id, input.purchaseOrderId))
    .limit(1);

  if (!order) throw new Error(`No purchase order with id '${input.purchaseOrderId}'.`);
  if (order.status !== 'approved' && order.status !== 'partially_executed') {
    throw new OrderNotConfirmableError(order.orderNo, order.status);
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.serviceDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(serviceReceipt)
    .values({
      receiptNo: allocated.documentNo,
      purchaseOrderId: input.purchaseOrderId,
      departmentCode: input.departmentCode,
      branchCode: input.branchCode,
      serviceDate: input.serviceDate,
      supplierReference: input.supplierReference ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: serviceReceipt.id });

  // What this document has already claimed against each ordered line — two
  // lines can answer to the same one, and neither is written yet.
  const claimed = new Map<string, bigint>();

  for (const [index, line] of input.lines.entries()) {
    const [ordered] = await tx
      .select()
      .from(purchaseOrderLine)
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
      .limit(1);

    if (!ordered || ordered.purchaseOrderId !== input.purchaseOrderId) {
      throw new LineNotOnOrderError(order.orderNo);
    }

    if (ordered.lineType === 'inventory_item') {
      throw new NotAServiceLineError(ordered.lineNo, order.orderNo);
    }

    const already =
      (await confirmedQuantity(tx, ordered.id)) + (claimed.get(ordered.id) ?? 0n);
    claimed.set(ordered.id, (claimed.get(ordered.id) ?? 0n) + line.quantity);

    // §8.4's tolerance is about *quantity received into a warehouse*: a lorry
    // arrives with an extra pallet. Nobody accidentally delivers an extra month
    // of consultancy, so a confirmation beyond the order is refused outright
    // rather than tolerated — the order is varied first.
    if (already + line.quantity > parseQuantity(ordered.quantity)) {
      throw new OverConfirmationError(
        ordered.lineNo,
        parseQuantity(ordered.quantity),
        already,
        line.quantity,
      );
    }

    await tx.insert(serviceReceiptLine).values({
      serviceReceiptId: created!.id,
      lineNo: index + 1,
      purchaseOrderLineId: ordered.id,
      description: line.description ?? ordered.description,
      quantity: formatQuantity(line.quantity),
      uomCode: ordered.uomCode,
      costCentreCode: line.costCentreCode ?? ordered.costCentreCode,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'service_receipt.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      receiptNo: allocated.documentNo,
      orderNo: order.orderNo,
      department: input.departmentCode,
      lines: input.lines.length,
    },
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
    throw new ServiceReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'only a draft confirmation can be submitted.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'submitted');

  await tx
    .update(serviceReceipt)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(serviceReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'service_receipt.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
  });
}

/**
 * §8.6 — the benefiting department confirms the work was done.
 *
 * Three separate things have to be true, and they are different questions:
 * the actor holds the `approve` permission, they belong to the benefiting
 * department, and they are not the person who raised the document (§5.2).
 */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ orderStatus: string }> {
  const { receipt } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
  });

  if (receipt.status !== 'submitted') {
    throw new ServiceReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'only a submitted confirmation can be approved.',
    );
  }

  if (
    !ctx.principal.isSuperUser &&
    !(await isInDepartment(tx, ctx.principal.userId, receipt.departmentCode))
  ) {
    throw new NotTheBenefitingDepartmentError(receipt.departmentCode, receipt.receiptNo);
  }

  if (receipt.createdBy === ctx.principal.userId) {
    throw new ServiceReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'the person who raised a confirmation cannot approve it — the approval is what makes it evidence (§5.2).',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'approved');

  await tx
    .update(serviceReceipt)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(serviceReceipt.id, id));

  const orderStatus = await refreshOrderStatus(tx, receipt.purchaseOrderId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'service_receipt.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: 'submitted' },
    after: { status: 'approved', department: receipt.departmentCode, orderStatus },
    outcome: 'success',
  });

  return { orderStatus };
}

/**
 * Appendix B gives this document a **Reversed** status and no Cancelled one.
 *
 * The distinction is the point: a confirmation that was wrong is withdrawn on
 * the record, with a reason, because an A/P Invoice may already have been
 * matched against it.
 */
export async function reverse(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const { receipt } = await load(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
  });

  if (receipt.status !== 'approved') {
    throw new ServiceReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'only an approved confirmation is reversed — a draft is simply corrected.',
    );
  }

  if (reason.trim().length === 0) {
    throw new Error(
      'Withdrawing a confirmation needs a reason (§5.4). The invoice may already have been matched against it.',
    );
  }

  // The reason goes to the status machine too: §5.4 makes it a property of the
  // transition, not a field this service happens to fill in.
  await statuses.assertTransitionAllowed(
    tx,
    DOCUMENT_TYPE,
    receipt.status,
    'reversed',
    reason.trim(),
  );

  await tx
    .update(serviceReceipt)
    .set({
      status: 'reversed',
      reversedBy: ctx.principal.userId,
      reversedAt: new Date(),
      reversalReason: reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(serviceReceipt.id, id));

  const orderStatus = await refreshOrderStatus(tx, receipt.purchaseOrderId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'service_receipt.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: 'approved' },
    after: { status: 'reversed', orderStatus },
    reason: reason.trim(),
    outcome: 'success',
  });
}

/**
 * Moves the order on as its service lines are confirmed (Appendix B).
 *
 * Goods and services are counted the same way and against the same statuses,
 * because an order may carry both and "Received" has to mean the whole order
 * arrived — not the half of it that came on a lorry.
 */
export async function refreshOrderStatus(tx: Tx, purchaseOrderId: string): Promise<string> {
  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, purchaseOrderId));

  if (lines.length === 0) return 'approved';

  const serviceLineIds = lines.filter((l) => l.lineType !== 'inventory_item').map((l) => l.id);

  const confirmed = new Map<string, bigint>();
  if (serviceLineIds.length > 0) {
    const rows = await tx
      .select({
        lineId: serviceReceiptLine.purchaseOrderLineId,
        quantity: serviceReceiptLine.quantity,
      })
      .from(serviceReceiptLine)
      .innerJoin(serviceReceipt, eq(serviceReceipt.id, serviceReceiptLine.serviceReceiptId))
      .where(
        and(
          inArray(serviceReceiptLine.purchaseOrderLineId, serviceLineIds),
          eq(serviceReceipt.status, 'approved'),
        ),
      );

    for (const row of rows) {
      confirmed.set(row.lineId, (confirmed.get(row.lineId) ?? 0n) + parseQuantity(row.quantity));
    }
  }

  const done = lines.filter((line) =>
    isLineComplete({
      ordered: parseQuantity(line.quantity),
      received:
        line.lineType === 'inventory_item'
          ? parseQuantity(line.receivedQuantity)
          : (confirmed.get(line.id) ?? 0n),
      closed: parseQuantity(line.closedQuantity),
    }),
  );

  const anyProgress = lines.some(
    (line) =>
      parseQuantity(line.receivedQuantity) > 0n || (confirmed.get(line.id) ?? 0n) > 0n,
  );

  const status = done.length === lines.length ? 'executed' : anyProgress ? 'partially_executed' : null;
  if (!status) return 'approved';

  await tx
    .update(purchaseOrder)
    .set({ status, updatedAt: new Date() })
    .where(eq(purchaseOrder.id, purchaseOrderId));

  return status;
}

/** What is still to be confirmed against an order's service lines (§8.2). */
export async function outstanding(tx: Tx, purchaseOrderId: string) {
  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, purchaseOrderId))
    .orderBy(purchaseOrderLine.lineNo);

  const result = [];
  for (const line of lines.filter((l) => l.lineType !== 'inventory_item')) {
    const ordered = parseQuantity(line.quantity);
    const received = await confirmedQuantity(tx, line.id);
    const closed = parseQuantity(line.closedQuantity);
    result.push({
      lineNo: line.lineNo,
      lineType: line.lineType,
      description: line.description,
      ordered,
      confirmed: received,
      ...outstandingQuantity({ ordered, received, closed }),
    });
  }
  return result;
}

/**
 * §8.4 — *"Every A/P Invoice must be created from both a Purchase Order and
 * Goods Receipt, or from a Purchase Order and Service Receipt / Expense
 * Confirmation."*
 *
 * The question the A/P Invoice will ask in 05.5, answered here so there is one
 * definition of "confirmed" rather than two.
 */
export async function isConfirmed(tx: Tx, purchaseOrderLineId: string): Promise<boolean> {
  return (await confirmedQuantity(tx, purchaseOrderLineId)) > 0n;
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/** Confirmations awaiting a department's approval — §8.6's work queue. */
export async function awaitingDepartment(tx: Tx, departmentCode: string) {
  return tx
    .select({
      id: serviceReceipt.id,
      receiptNo: serviceReceipt.receiptNo,
      serviceDate: serviceReceipt.serviceDate,
      createdBy: serviceReceipt.createdBy,
      lines: sql<number>`(select count(*)::int from service_receipt_line l
                           where l.service_receipt_id = service_receipt.id)`,
    })
    .from(serviceReceipt)
    .where(
      and(
        eq(serviceReceipt.departmentCode, departmentCode),
        eq(serviceReceipt.status, 'submitted'),
      ),
    )
    .orderBy(serviceReceipt.serviceDate);
}
