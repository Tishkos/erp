/**
 * Purchase Orders — Phase 05.1, §8.3.
 *
 * §8.2: *"purchasing begins directly with a Purchase Order"*. Quotations are
 * collected in Excel, outside the system, and §8.3 asks for the consequence to
 * be handled properly rather than resented: *"grid accepts multi-line copy and
 * paste from Excel with validation of item codes, UOMs, prices and required
 * fields"*.
 *
 * That is why `parsePastedLines` exists and why it reports **per row**. A paste
 * of two hundred lines that fails with one message names one problem out of
 * however many there are, so the buyer fixes it, pastes again, and finds the
 * next one. Two hundred rows and a list of what is wrong with each is one
 * correction pass instead of eleven.
 */
import { asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessPartner, purchaseOrder, purchaseOrderLine } from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, whereOf, type RegisterPage, type RegisterPaging } from './register-page';
import * as execution from './project-execution';

export const PERMISSION_OBJECT = 'purchase_order';
const SEQUENCE_KEY = 'PURCHASE_ORDER';

export type PurchaseLineType = 'inventory_item' | 'service' | 'fixed_asset' | 'expense';

export class PurchaseOrderNotFoundError extends Error {
  readonly code = 'PURCHASE_ORDER_NOT_FOUND';
  constructor(id: string) {
    super(`No purchase order '${id}'.`);
    this.name = 'PurchaseOrderNotFoundError';
  }
}

export class PurchaseOrderStateError extends Error {
  readonly code = 'PURCHASE_ORDER_STATE_INVALID';
  constructor(orderNo: string, status: string, detail: string) {
    super(`Purchase order ${orderNo} is '${status}': ${detail}`);
    this.name = 'PurchaseOrderStateError';
  }
}

export class SupplierNotUsableError extends Error {
  readonly code = 'SUPPLIER_NOT_USABLE';
  constructor(
    readonly supplierCode: string,
    reason: string,
  ) {
    // §25 — the field, the reason, the corrective action.
    super(
      `${supplierCode} ${reason}, so a purchase order cannot be raised against them (§6). ` +
        'Choose an active supplier, or ask master data to correct the partner record.',
    );
    this.name = 'SupplierNotUsableError';
  }
}

/** One problem with one pasted row — §8.3's per-row reporting. */
export interface LineError {
  readonly rowNumber: number;
  readonly column: string;
  readonly message: string;
}

export interface PurchaseLineInput {
  readonly lineType: PurchaseLineType;
  readonly itemCode?: string | null;
  readonly description: string;
  readonly quantity: bigint;
  readonly uomCode: string;
  readonly unitPriceIqd: bigint;
  readonly branchCode: string;
  readonly warehouseCode?: string | null;
  readonly costCentreCode?: string | null;
}

export interface CreatePurchaseOrderInput {
  readonly supplierId: string;
  readonly branchCode: string;
  readonly orderDate: string;
  readonly expectedDate?: string | null;
  readonly currency?: string;
  readonly paymentTermsCode?: string | null;
  readonly reference?: string | null;
  readonly note?: string | null;
  /** REQ-PM-001 §8 — the project, the element and the cost code the order is assigned to; the three together, or none. */
  readonly projectCode?: string | null;
  readonly wbsCode?: string | null;
  readonly costCode?: string | null;
  readonly lines: readonly PurchaseLineInput[];
}

/**
 * §8.3 — the supplier must be an active partner holding the Supplier role.
 *
 * Read and refused here so the message names the partner and says what to do;
 * the trigger in migration 0031 refuses the same thing for anything that does
 * not come through this function.
 */
async function assertSupplierUsable(tx: Tx, supplierId: string): Promise<void> {
  const [partner] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, supplierId))
    .limit(1);

  if (!partner) {
    throw new Error(`No business partner with id '${supplierId}'.`);
  }

  if (!partner.isSupplier) {
    throw new SupplierNotUsableError(partner.code, 'is not a supplier');
  }

  if (!partner.active) {
    throw new SupplierNotUsableError(partner.code, 'has been deactivated');
  }

  if (partner.status !== 'active') {
    throw new SupplierNotUsableError(partner.code, `is ${partner.status.replace('_', ' ')}`);
  }
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreatePurchaseOrderInput,
): Promise<{ id: string; orderNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error(
      'A purchase order with no lines commits the company to nothing. Add what is being bought, or do not raise it.',
    );
  }

  await assertSupplierUsable(tx, input.supplierId);
  // REQ-PM-001 §8 — checked before the number is spent.
  const assignment = await execution.checkAssignment(tx, input);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.orderDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [order] = await tx
    .insert(purchaseOrder)
    .values({
      orderNo: allocated.documentNo,
      supplierId: input.supplierId,
      branchCode: input.branchCode,
      orderDate: input.orderDate,
      expectedDate: input.expectedDate ?? null,
      currency: input.currency ?? 'IQD',
      paymentTermsCode: input.paymentTermsCode ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      projectCode: assignment?.projectCode ?? null,
      wbsCode: assignment?.wbsCode ?? null,
      costCode: assignment?.costCode ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: purchaseOrder.id });

  for (const [index, line] of input.lines.entries()) {
    await tx.insert(purchaseOrderLine).values({
      purchaseOrderId: order!.id,
      lineNo: index + 1,
      lineType: line.lineType,
      itemCode: line.itemCode ?? null,
      description: line.description,
      quantity: formatQuantity(line.quantity),
      uomCode: line.uomCode,
      unitPrice: toDecimalString(line.unitPriceIqd, 4n),
      branchCode: line.branchCode,
      warehouseCode: line.warehouseCode ?? null,
      costCentreCode: line.costCentreCode ?? null,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'purchase_order.created',
    objectType: PERMISSION_OBJECT,
    objectId: order!.id,
    branchCode: input.branchCode,
    after: { orderNo: allocated.documentNo, lines: input.lines.length },
    outcome: 'success',
  });

  return { id: order!.id, orderNo: allocated.documentNo };
}

async function load(tx: Tx, id: string) {
  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(eq(purchaseOrder.id, id))
    .limit(1);

  if (!order) throw new PurchaseOrderNotFoundError(id);

  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, id))
    .orderBy(purchaseOrderLine.lineNo);

  return { order, lines };
}

export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { order } = await load(tx, id);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: order.branchCode,
  });

  if (order.status !== 'draft') {
    throw new PurchaseOrderStateError(
      order.orderNo,
      order.status,
      'only a draft can be submitted.',
    );
  }

  await tx
    .update(purchaseOrder)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(purchaseOrder.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'purchase_order.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: order.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
  });
}

/**
 * Approval — Appendix B: *"commitment only"*.
 *
 * Nothing posts. The order becomes a promise to pay on delivery, and the
 * commitment it creates is reportable (Phase 14 budgets consume it), but the
 * General Ledger does not move until goods or a service are received.
 */
export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { order } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: order.branchCode,
  });

  if (order.status !== 'submitted') {
    throw new PurchaseOrderStateError(
      order.orderNo,
      order.status,
      'only a submitted order can be approved.',
    );
  }

  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (order.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new PurchaseOrderStateError(
      order.orderNo,
      order.status,
      'the person who raised a purchase order cannot approve it — approving it commits the company to pay (§5.2).',
    );
  }

  // Re-checked at approval: the supplier may have been blocked between raising
  // and approving, and approval is the act that creates the commitment.
  await assertSupplierUsable(tx, order.supplierId);

  await tx
    .update(purchaseOrder)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrder.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'purchase_order.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: order.branchCode,
    before: { status: 'submitted' },
    after: { status: 'approved' },
    outcome: 'success',
  });

  // REQ-PM-001 §8 — approval is the act that creates the commitment: an
  // order assigned to an element promises its total there, against the
  // element's availability, in this same transaction.
  await execution.commitForOrder(tx, ctx, id);
}

/**
 * §8.7 — cancellation.
 *
 * *"An unexecuted PO may be cancelled (no accounting or inventory effect).
 * After partial receipt, only the remaining open quantity is closed; previous
 * receipts unchanged."*
 *
 * So this never touches a receipt. What it does is close the open balance, and
 * the distinction matters: a cancelled order and a closed remainder are
 * different facts, and a system that conflated them would let someone cancel
 * their way out of goods already in the warehouse.
 */
export async function cancel(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<{ status: string; closedQuantity: bigint }> {
  const { order, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: order.branchCode,
  });

  if (!reason.trim()) {
    throw new Error(
      'Cancelling a purchase order releases a commitment the supplier may be relying on. §5.4 keeps the reason with it — state why.',
    );
  }

  if (order.status === 'cancelled' || order.status === 'closed') {
    throw new PurchaseOrderStateError(order.orderNo, order.status, 'it is already finished.');
  }

  const received = lines.reduce((sum, l) => sum + parseQuantity(l.receivedQuantity), 0n);
  let closedQuantity = 0n;

  for (const line of lines) {
    const open =
      parseQuantity(line.quantity) -
      parseQuantity(line.receivedQuantity) -
      parseQuantity(line.closedQuantity);
    if (open <= 0n) continue;

    closedQuantity += open;
    await tx
      .update(purchaseOrderLine)
      .set({ closedQuantity: formatQuantity(parseQuantity(line.closedQuantity) + open) })
      .where(eq(purchaseOrderLine.id, line.id));
  }

  // Nothing received: the order never happened, and `cancelled` says so.
  // Something received: those receipts stand, and the order is `closed` with
  // its open balance released.
  const status = received === 0n ? 'cancelled' : 'closed';

  await tx
    .update(purchaseOrder)
    .set({
      status,
      cancelledBy: ctx.principal.userId,
      cancelledAt: new Date(),
      cancellationReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(purchaseOrder.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'purchase_order.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: order.branchCode,
    before: { status: order.status },
    after: { status, closedQuantity: formatQuantity(closedQuantity) },
    reason,
    outcome: 'success',
  });

  // REQ-PM-001 §8 — what the order still promised is given back, with the reason.
  await execution.releaseFor(tx, ctx, { purchaseOrderId: id }, `Order ${order.orderNo} ${status}: ${reason.trim()}`);

  return { status, closedQuantity };
}

// ---------------------------------------------------------------------------
// §8.3 — the Excel paste
// ---------------------------------------------------------------------------

export interface PasteResult {
  readonly lines: readonly PurchaseLineInput[];
  readonly errors: readonly LineError[];
}

/**
 * Parses a block pasted from Excel into lines, reporting **every** problem.
 *
 * Tab-separated, because that is what a spreadsheet puts on the clipboard.
 * Every row is checked even after one fails: §8.3's gate asks for errors
 * "per row", and stopping at the first is what makes a buyer paste the same
 * two hundred rows eleven times.
 *
 * Pure — no database. The codes it cannot check without one (does this item
 * exist? is this UOM real?) are checked by `validateLines` below, which is the
 * same split the import framework uses.
 */
export function parsePastedLines(
  block: string,
  defaults: { branchCode: string; warehouseCode?: string | null },
): PasteResult {
  // Rows are not trimmed, only cells. Trimming the row would strip a leading
  // tab, and a leading tab is precisely how a paste with a **missing item
  // code** arrives — the commonest mistake of all. Stripping it shifts every
  // cell left, so the quantity column is read as a unit of measure and the
  // buyer is told four things are wrong when one is.
  const rows = block.split(/\r?\n/).filter((row) => row.trim().length > 0);

  const lines: PurchaseLineInput[] = [];
  const errors: LineError[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const cells = row.split('\t').map((cell) => cell.trim());
    const [itemCode, description, quantity, uomCode, unitPrice, branchCode, warehouseCode] = cells;

    const before = errors.length;

    if (!itemCode) {
      errors.push({ rowNumber, column: 'item_code', message: 'The item code is missing.' });
    }
    if (!quantity) {
      errors.push({ rowNumber, column: 'quantity', message: 'The quantity is missing.' });
    }
    if (!uomCode) {
      errors.push({ rowNumber, column: 'uom_code', message: 'The unit of measure is missing.' });
    }
    if (!unitPrice) {
      errors.push({ rowNumber, column: 'unit_price', message: 'The price is missing.' });
    }

    let parsedQuantity = 0n;
    if (quantity) {
      try {
        parsedQuantity = parseQuantity(quantity);
        if (parsedQuantity <= 0n) {
          errors.push({
            rowNumber,
            column: 'quantity',
            message: `"${quantity}" is not a quantity to order. Enter a positive number.`,
          });
        }
      } catch {
        errors.push({
          rowNumber,
          column: 'quantity',
          message: `"${quantity}" is not a number. Quantities carry up to six decimal places.`,
        });
      }
    }

    let parsedPrice = 0n;
    if (unitPrice) {
      try {
        parsedPrice = parseDecimal(unitPrice.replace(/[, ]/g, ''), 4n);
        if (parsedPrice < 0n) {
          errors.push({
            rowNumber,
            column: 'unit_price',
            message: `"${unitPrice}" is negative. A price cannot be less than nothing.`,
          });
        }
      } catch {
        errors.push({
          rowNumber,
          column: 'unit_price',
          message: `"${unitPrice}" is not a price. Prices carry up to four decimal places.`,
        });
      }
    }

    if (errors.length > before) continue;

    lines.push({
      lineType: 'inventory_item',
      itemCode: itemCode!,
      description: description || itemCode!,
      quantity: parsedQuantity,
      uomCode: uomCode!,
      unitPriceIqd: parsedPrice,
      branchCode: branchCode || defaults.branchCode,
      warehouseCode: warehouseCode || defaults.warehouseCode || null,
    });
  }

  return { lines, errors };
}

/**
 * The checks that need the database: does the item exist, is it stocked, is the
 * UOM one the item is bought in, does the warehouse exist.
 *
 * Reported per row like the parse, so a buyer sees every problem at once.
 */
export async function validateLines(
  tx: Tx,
  lines: readonly PurchaseLineInput[],
): Promise<LineError[]> {
  const errors: LineError[] = [];

  for (const [index, line] of lines.entries()) {
    const rowNumber = index + 1;

    if (line.itemCode) {
      const found = await tx.execute(sql`
        select i.code, i.is_stock,
               exists (select 1 from item_uom u
                        where u.item_id = i.id and u.uom_code = ${line.uomCode}) as uom_ok
          from item i where i.code = ${line.itemCode}
      `);
      const row = (
        found as unknown as { rows: { code: string; is_stock: boolean; uom_ok: boolean }[] }
      ).rows[0];

      if (!row) {
        errors.push({
          rowNumber,
          column: 'item_code',
          message: `"${line.itemCode}" is not an item. Check the code against the Item Master (§4.4).`,
        });
        continue;
      }

      if (!row.uom_ok) {
        errors.push({
          rowNumber,
          column: 'uom_code',
          message: `${line.itemCode} is not bought in "${line.uomCode}". Use one of the units configured for the item (§9.3).`,
        });
      }

      if (line.lineType === 'inventory_item' && !row.is_stock) {
        errors.push({
          rowNumber,
          column: 'line_type',
          message: `${line.itemCode} is a service, so it is received as a Service Receipt rather than into a warehouse (§8.2).`,
        });
      }
    }

    if (line.lineType === 'inventory_item' && !line.warehouseCode) {
      errors.push({
        rowNumber,
        column: 'warehouse_code',
        message: 'Stock has to be delivered somewhere. Name the destination warehouse (§8.3).',
      });
    }
  }

  return errors;
}

/** The order as a record page would show it. */
export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/** Open commitment by supplier — Appendix B's "commitment only" made visible. */
export async function openCommitments(tx: Tx) {
  const result = await tx.execute(sql`
    select o.order_no,
           p.code as supplier_code,
           o.status::text as status,
           sum((l.quantity - l.received_quantity - l.closed_quantity) * l.unit_price)::text
             as open_value_iqd
      from purchase_order o
      join business_partner p on p.id = o.supplier_id
      join purchase_order_line l on l.purchase_order_id = o.id
     where o.status in ('approved', 'partially_executed')
     group by o.order_no, p.code, o.status
    having sum(l.quantity - l.received_quantity - l.closed_quantity) > 0
     order by o.order_no
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}


/** §21.6 — the list: commitment, fulfilment and billing at a glance. */
export interface OrderListRow {
  readonly id: string;
  readonly orderNo: string;
  readonly supplierName: string;
  readonly orderDate: string;
  readonly status: string;
  readonly totalIqd: string;
  readonly receivedShare: string;
  readonly invoicedShare: string;
  readonly payableNo: string | null;
}

export interface OrderListFilter extends RegisterPaging {
  readonly status?: string | null;
}

/** HD15 — one page of fifty, newest first, with the true count. */
export async function listForScreen(
  tx: Tx,
  filter: OrderListFilter = {},
): Promise<RegisterPage<OrderListRow>> {
  const where = whereOf([filter.status ? sql`o.status::text = ${filter.status}` : null]);
  return registerPage({
    paging: filter,
    count: () => countOf(tx, sql`from purchase_order o ${where}`),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select o.id,
               o.order_no as "orderNo",
               bp.legal_name as "supplierName",
               o.order_date::text as "orderDate",
               o.status::text as status,
               coalesce(sum(l.quantity * l.unit_price), 0)::text as "totalIqd",
               -- trim_scale so a whole number reads as one: the column's
               -- scale is six, and "0.000000 / 50.000000" is the database's
               -- idea of a quantity rather than a person's (2026-10-03).
               trim_scale(coalesce(sum(l.received_quantity), 0))::text || ' / ' ||
                 trim_scale(coalesce(sum(l.quantity), 0))::text as "receivedShare",
               trim_scale(coalesce(sum(l.invoiced_quantity), 0))::text || ' / ' ||
                 trim_scale(coalesce(sum(l.quantity), 0))::text as "invoicedShare",
               (select p.payable_no from payable p where p.purchase_order_id = o.id limit 1)
                 as "payableNo"
          from purchase_order o
          join business_partner bp on bp.id = o.supplier_id
          left join purchase_order_line l on l.purchase_order_id = o.id
         ${where}
         group by o.id, o.order_no, bp.legal_name, o.order_date, o.status, o.created_at
         order by o.created_at desc, o.id desc
         limit ${limit} offset ${offset}`);
      return result.rows as unknown as OrderListRow[];
    },
  });
}

/** §21.6 — the record, by its number: the order, its lines, who it binds. */
export async function viewByNo(tx: Tx, orderNo: string) {
  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(eq(purchaseOrder.orderNo, orderNo))
    .limit(1);
  if (!order) return null;
  const lines = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.purchaseOrderId, order.id))
    .orderBy(asc(purchaseOrderLine.lineNo));
  const [supplier] = await tx
    .select({ legalName: businessPartner.legalName, code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, order.supplierId))
    .limit(1);
  const linked = await tx.execute(sql`
    select payable_no as "payableNo" from payable where purchase_order_id = ${order.id} limit 1`);
  const payableNo =
    ((linked.rows[0] as { payableNo?: string } | undefined)?.payableNo ?? null) as string | null;
  return { order, lines, supplier: supplier ?? null, payableNo };
}
