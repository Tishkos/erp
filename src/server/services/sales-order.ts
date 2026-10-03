/**
 * Sales Order — Phase 06.2 and 06.3, §7.2, §7.3, §7.4 and §16.
 *
 * The document that commits stock. Appendix B gives its effect as **stock
 * reservation** and nothing else: no journal, no movement, no cost. What it does
 * do is take stock out of Available, which is why §7.4 will not let it be
 * approved unless the stock is there.
 *
 * **The price is not an argument.** `SalesLineInput` has no price field. §7.3
 * says the price cannot be edited in the order and §7.7 says the control cannot
 * be bypassed through the UI or API — and the only way to satisfy the second is
 * for there to be nothing to submit. The service resolves it from the customer's
 * linked price list, effective on the order date, and stores what it found.
 *
 * **Credit is checked in two steps, because they are two different refusals.**
 * A hold means this customer is not supplied on credit at all (§16); a limit
 * means not this much. The first is checked first and no override reaches it.
 *
 * **Availability is checked for every line before any line is reserved.** §7.4
 * says the order shall not be approved when stock is insufficient, and an
 * approval that reserved three lines and then failed on the fourth would leave
 * stock committed to an order that was never approved.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  businessPartner,
  item,
  priceList,
  priceListItem,
  salesOrder,
  salesOrderLine,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import { priceOn, type PriceEntry } from '../domain/payment-terms';
import { documentTotals, totalsFor, type LineDiscount } from '../domain/sales-pricing';
import {
  assertNotOnCreditHold,
  assertOverrideComplete,
  assertWithinCredit,
  positionFor,
  type CreditOverride,
  type ExposureComponents,
} from '../domain/credit-control';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';
import { assertBranchInScope, can } from '../domain/permissions';
import { availableQuantity } from '../domain/inventory';

export const DOCUMENT_TYPE = 'sales_order';
export const PERMISSION_OBJECT = 'sales_order';
const SEQUENCE_KEY = 'SALES_ORDER';

export class SalesOrderNotFoundError extends Error {
  readonly code = 'SALES_ORDER_NOT_FOUND';
  constructor(id: string) {
    super(`No sales order '${id}'.`);
    this.name = 'SalesOrderNotFoundError';
  }
}

export class SalesOrderStateError extends Error {
  readonly code = 'SALES_ORDER_STATE_INVALID';
  constructor(orderNo: string, status: string, detail: string) {
    super(`Sales order ${orderNo} is '${status}': ${detail}`);
    this.name = 'SalesOrderStateError';
  }
}

export class CustomerNotUsableError extends Error {
  readonly code = 'CUSTOMER_NOT_USABLE';
  constructor(
    readonly customerCode: string,
    reason: string,
  ) {
    super(
      `${customerCode} ${reason}, so a sales order cannot be raised for them (§6). ` +
        'Choose an active customer, or ask master data to correct the partner record.',
    );
    this.name = 'CustomerNotUsableError';
  }
}

export class NoPriceListError extends Error {
  readonly code = 'NO_PRICE_LIST';
  constructor(readonly customerCode: string) {
    super(
      `${customerCode} has no price list, and §7.3 takes every unit price from the customer's linked Price List. ` +
        'Link one before selling to them — a price typed on the order is exactly what §7.7 forbids.',
    );
    this.name = 'NoPriceListError';
  }
}

/** §7.2 — the product-sale process carries product items only. */
export class NotAProductError extends Error {
  readonly code = 'NOT_A_PRODUCT';
  constructor(readonly itemCode: string) {
    super(
      `${itemCode} is a service, and the product-sale process carries product items only (§7.2). ` +
        'Installation, transport and other services are sold through their own route, not on this order.',
    );
    this.name = 'NotAProductError';
  }
}

/** §7.4 — *"shall not approve a Sales Order when Available Stock is insufficient."* */
export class InsufficientAvailableError extends Error {
  readonly code = 'INSUFFICIENT_AVAILABLE_STOCK';
  constructor(
    readonly itemCode: string,
    readonly warehouseCode: string,
    available: bigint,
    requested: bigint,
  ) {
    super(
      `${warehouseCode} has ${formatQuantity(available)} of ${itemCode} available and this order needs ` +
        `${formatQuantity(requested)} (§7.4). Available excludes stock already reserved, in quarantine, ` +
        'damaged or in returns — approving anyway would promise the same goods twice.',
    );
    this.name = 'InsufficientAvailableError';
  }
}

export interface SalesLineInput {
  readonly itemCode: string;
  readonly quantity: bigint;
  readonly uomCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly deliveryLocation?: string | null;
  readonly costCentreCode?: string | null;
  readonly description?: string | null;
  /**
   * §7.3 — the only negotiable figure, and only per line. A percentage **or** an
   * amount; the domain refuses both together.
   *
   * Note what is absent: there is no `unitPriceIqd`. That is the §7.7 control.
   */
  readonly discount?: LineDiscount;
}

export interface CreateSalesOrderInput {
  readonly customerId: string;
  readonly branchCode: string;
  readonly orderDate: string;
  readonly requestedDeliveryDate?: string | null;
  readonly currency?: string;
  readonly customerReference?: string | null;
  /**
   * §4.2 — which department and line of business this sale belongs to.
   *
   * Optional here and enforced where it matters: the posting engine refuses a
   * posting whose account requires a dimension it was not given, naming the
   * account and the dimension. COGS and revenue accounts require these by
   * default (migration 0005), so an order without them is one that cannot be
   * delivered or invoiced — and the message says so at that point, rather than
   * this service guessing which accounts the sale will eventually touch.
   */
  readonly departmentCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly note?: string | null;
  readonly lines: readonly SalesLineInput[];
}

interface LoadedOrder {
  readonly order: typeof salesOrder.$inferSelect;
  readonly lines: (typeof salesOrderLine.$inferSelect)[];
}

async function load(tx: Tx, id: string): Promise<LoadedOrder> {
  const [order] = await tx.select().from(salesOrder).where(eq(salesOrder.id, id)).limit(1);
  if (!order) throw new SalesOrderNotFoundError(id);

  const lines = await tx
    .select()
    .from(salesOrderLine)
    .where(eq(salesOrderLine.salesOrderId, id))
    .orderBy(salesOrderLine.lineNo);

  return { order, lines };
}

/** §6 — the customer must be an active partner holding the Customer role. */
async function assertCustomerUsable(tx: Tx, customerId: string) {
  const [partner] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, customerId))
    .limit(1);

  if (!partner) throw new Error(`No business partner with id '${customerId}'.`);
  if (!partner.isCustomer) throw new CustomerNotUsableError(partner.code, 'is not a customer');
  if (!partner.active) throw new CustomerNotUsableError(partner.code, 'has been deactivated');
  if (partner.status !== 'active') {
    throw new CustomerNotUsableError(partner.code, `is ${partner.status.replace('_', ' ')}`);
  }

  return partner;
}

/**
 * §7.3 — the price, from the customer's list, effective on the order date.
 *
 * Resolved through the Phase 03 domain so that "the price on this date" is the
 * same answer everywhere it is asked, and so the 03.6 determinism gate covers
 * this path too.
 */
async function resolvePrice(
  tx: Tx,
  priceListCode: string,
  itemCode: string,
  uomCode: string,
  onDate: string,
): Promise<{ unitPriceIqd: bigint; priceListItemId: string }> {
  const rows = await tx
    .select({
      id: priceListItem.id,
      itemId: priceListItem.itemId,
      uomCode: priceListItem.uomCode,
      unitPrice: priceListItem.unitPrice,
      effectiveFrom: priceListItem.effectiveFrom,
      itemCode: item.code,
    })
    .from(priceListItem)
    .innerJoin(item, eq(item.id, priceListItem.itemId))
    .where(and(eq(priceListItem.priceListCode, priceListCode), eq(item.code, itemCode)));

  const entries: (PriceEntry & { id: string })[] = rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    uomCode: row.uomCode,
    unitPrice: row.unitPrice,
    effectiveFrom: row.effectiveFrom,
  }));

  if (entries.length === 0) {
    // Reuses the domain's message, which already names the §7.3 rule.
    priceOn([], itemCode, uomCode, onDate, itemCode);
  }

  const chosen = priceOn(entries, entries[0]!.itemId, uomCode, onDate, itemCode) as PriceEntry & {
    id: string;
  };

  return { unitPriceIqd: parseDecimal(chosen.unitPrice, 4n), priceListItemId: chosen.id };
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateSalesOrderInput,
): Promise<{ id: string; orderNo: string; netIqd: bigint }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error(
      'A sales order with no lines sells nothing. Add what the customer is buying, or do not raise it.',
    );
  }

  const customer = await assertCustomerUsable(tx, input.customerId);
  if (!customer.priceListCode) throw new NoPriceListError(customer.code);

  const [list] = await tx
    .select()
    .from(priceList)
    .where(eq(priceList.code, customer.priceListCode))
    .limit(1);

  if (!list?.active) {
    throw new Error(
      `Price list ${customer.priceListCode} is not active, so ${customer.code} cannot be sold to (§7.3). ` +
        'Activate it, or link the customer to a current list.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.orderDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(salesOrder)
    .values({
      orderNo: allocated.documentNo,
      customerId: input.customerId,
      priceListCode: customer.priceListCode,
      branchCode: input.branchCode,
      orderDate: input.orderDate,
      requestedDeliveryDate: input.requestedDeliveryDate ?? null,
      currency: input.currency ?? 'IQD',
      paymentTermsCode: customer.paymentTermsCode ?? null,
      customerReference: input.customerReference ?? null,
      departmentCode: input.departmentCode ?? null,
      businessLineCode: input.businessLineCode ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: salesOrder.id });

  const priced: { quantity: bigint; unitPriceIqd: bigint; discount?: LineDiscount }[] = [];

  for (const [index, line] of input.lines.entries()) {
    const [stocked] = await tx
      .select({ isStock: item.isStock, name: item.name })
      .from(item)
      .where(eq(item.code, line.itemCode))
      .limit(1);

    if (!stocked) throw new Error(`No item '${line.itemCode}'.`);
    // §7.2 — product items only.
    if (!stocked.isStock) throw new NotAProductError(line.itemCode);

    const { unitPriceIqd, priceListItemId } = await resolvePrice(
      tx,
      customer.priceListCode,
      line.itemCode,
      line.uomCode,
      input.orderDate,
    );

    const totals = totalsFor({
      quantity: line.quantity,
      unitPriceIqd,
      ...(line.discount ? { discount: line.discount } : {}),
    });

    priced.push({
      quantity: line.quantity,
      unitPriceIqd,
      ...(line.discount ? { discount: line.discount } : {}),
    });

    await tx.insert(salesOrderLine).values({
      salesOrderId: created!.id,
      lineNo: index + 1,
      itemCode: line.itemCode,
      description: line.description ?? stocked.name,
      quantity: formatQuantity(line.quantity),
      uomCode: line.uomCode,
      unitPrice: toDecimalString(unitPriceIqd, 4n),
      priceListItemId,
      discountPercent:
        line.discount?.percent !== undefined && line.discount.percent !== 0n
          ? toDecimalString(line.discount.percent, 4n)
          : null,
      discountAmountIqd:
        line.discount?.amountIqd !== undefined && line.discount.amountIqd !== 0n
          ? toDecimalString(line.discount.amountIqd, 4n)
          : null,
      grossIqd: toDecimalString(totals.grossIqd, 4n),
      netIqd: toDecimalString(totals.netIqd, 4n),
      branchCode: line.branchCode,
      warehouseCode: line.warehouseCode,
      deliveryLocation: line.deliveryLocation ?? null,
      costCentreCode: line.costCentreCode ?? null,
    });
  }

  const totals = documentTotals(priced);

  await tx
    .update(salesOrder)
    .set({
      grossIqd: toDecimalString(totals.grossIqd, 4n),
      discountIqd: toDecimalString(totals.discountIqd, 4n),
      netIqd: toDecimalString(totals.netIqd, 4n),
      updatedAt: new Date(),
    })
    .where(eq(salesOrder.id, created!.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_order.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      orderNo: allocated.documentNo,
      customer: customer.code,
      priceListCode: customer.priceListCode,
      lines: input.lines.length,
      netIqd: toDecimalString(totals.netIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, orderNo: allocated.documentNo, netIqd: totals.netIqd };
}

/**
 * §7.3 — the approval route.
 *
 * *"Ordinary Sales users require Sales Manager approval; Sales Manager orders
 * finalise directly."* Read off the **grant**, not the role code: somebody who
 * holds approval authority on sales orders is by definition the person a second
 * approval would be asked of, and asking them to approve their own order would
 * be ceremony rather than control.
 *
 * Where they do not hold it, the order goes to submitted and waits.
 */
export function finalisesDirectly(principal: ActorContext['principal']): boolean {
  return can(principal, 'approve', PERMISSION_OBJECT);
}

export async function submit(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ status: string; awaitingApproval: boolean }> {
  const { order } = await load(tx, id);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: order.branchCode,
  });

  if (order.status !== 'draft') {
    throw new SalesOrderStateError(
      order.orderNo,
      order.status,
      'only a draft order can be submitted.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, order.status, 'submitted');

  await tx
    .update(salesOrder)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(salesOrder.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_order.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: order.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted', finalisesDirectly: finalisesDirectly(ctx.principal) },
    outcome: 'success',
  });

  return { status: 'submitted', awaitingApproval: !finalisesDirectly(ctx.principal) };
}

/**
 * §16, §7.7 — the customer's exposure, recomputed from the documents.
 *
 * Read live rather than maintained, because §7.3 asks for it *"in real time"* and
 * a maintained figure is a figure that can lag. The components stay separate so
 * a credit controller can say *why* a customer is at their limit.
 */
export async function exposureFor(tx: Tx, customerId: string): Promise<ExposureComponents> {
  // Approved, undelivered order value. The commitment to supply on credit.
  const orders = await tx
    .select({
      netIqd: salesOrderLine.netIqd,
      quantity: salesOrderLine.quantity,
      delivered: salesOrderLine.deliveredQuantity,
      closed: salesOrderLine.closedQuantity,
    })
    .from(salesOrderLine)
    .innerJoin(salesOrder, eq(salesOrder.id, salesOrderLine.salesOrderId))
    .where(
      and(
        eq(salesOrder.customerId, customerId),
        inArray(salesOrder.status, ['approved', 'partially_executed']),
      ),
    );

  let openOrdersIqd = 0n;
  for (const line of orders) {
    const ordered = parseQuantity(line.quantity);
    const outstanding =
      ordered - parseQuantity(line.delivered) - parseQuantity(line.closed);
    if (outstanding <= 0n) continue;
    // Pro-rata: the undelivered share of the line's net value.
    openOrdersIqd += (parseDecimal(line.netIqd, 4n) * outstanding) / ordered;
  }

  // Posted A/R invoices, unpaid. Phase 06.6 writes these; until then the query
  // simply finds none, which is the right answer rather than a missing one.
  const invoices = await tx
    .select({
      totalIqd: apInvoice.totalIqd,
      settledIqd: apInvoice.settledAmountIqd,
    })
    .from(apInvoice)
    .where(sql`false`);

  const outstandingInvoicesIqd = invoices.reduce(
    (total, row) => total + parseDecimal(row.totalIqd, 4n) - parseDecimal(row.settledIqd, 4n),
    0n,
  );

  // Delivered and not invoiced — §16 names it, and Phase 06.5 fills it in.
  const deliveredNotInvoicedIqd = orders.reduce((total, line) => {
    const ordered = parseQuantity(line.quantity);
    const gap = parseQuantity(line.delivered) - parseQuantity(line.closed);
    if (gap <= 0n) return total;
    return total + (parseDecimal(line.netIqd, 4n) * gap) / ordered;
  }, 0n);

  return {
    outstandingInvoicesIqd,
    openOrdersIqd,
    deliveredNotInvoicedIqd,
    unappliedCreditMemosIqd: 0n,
    customerAdvancesIqd: 0n,
  };
}

export interface ApproveOptions {
  /** §16 — the Sales Manager raising the ceiling, with all four things. */
  readonly creditOverride?: CreditOverride;
}

/**
 * §7.4 — approves the order, checks the credit and reserves the stock.
 *
 * The order of work is the design:
 *
 *   1. the credit **hold** — a different refusal from a limit, and no override
 *      touches it (§16 criterion 3)
 *   2. the credit **limit**, including this order's value
 *   3. **availability for every line**, before any reservation is made
 *   4. the reservations, all of them
 *
 * Steps 3 and 4 are separate for the reason §24 gives: a partial approval that
 * reserved three lines and failed on the fourth would leave stock committed to
 * an order nobody approved.
 */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  options: ApproveOptions = {},
): Promise<{ reservations: readonly string[]; availableAfter: readonly bigint[] }> {
  const { order, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: order.branchCode,
  });

  if (order.status !== 'draft' && order.status !== 'submitted') {
    throw new SalesOrderStateError(
      order.orderNo,
      order.status,
      'only a draft or submitted order can be approved.',
    );
  }

  // §5.2 — the person who raised an order does not approve it, unless they hold
  // approval authority in their own right (§7.3's "Sales Manager orders finalise
  // directly").
  // the super user approves alone, by direction 2026-10-03.
  if (order.createdBy === ctx.principal.userId && !finalisesDirectly(ctx.principal) && !ctx.principal.isSuperUser) {
    throw new SalesOrderStateError(
      order.orderNo,
      order.status,
      'the person who raised an order cannot approve it (§5.2). A Sales Manager finalises their own; a Sales user does not.',
    );
  }

  const [customer] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, order.customerId))
    .limit(1);

  // 1 · The hold. Checked first, and no override reaches it (§16 criterion 3).
  assertNotOnCreditHold(customer!.code, customer!.onCreditHold);

  // 2 · The limit, including this order.
  if (options.creditOverride) assertOverrideComplete(options.creditOverride);

  const components = await exposureFor(tx, order.customerId);
  const position = assertWithinCredit({
    customerCode: customer!.code,
    limitIqd: parseDecimal(customer!.creditLimitIqd ?? '0', 4n),
    components,
    ...(options.creditOverride ? { override: options.creditOverride } : {}),
    onDate: order.orderDate,
    requestedIqd: parseDecimal(order.netIqd, 4n),
  });

  // 3 · Availability, for every line, before anything is reserved.
  const wanted = new Map<string, bigint>();
  const availableAfter: bigint[] = [];

  for (const line of lines) {
    const key = `${line.itemCode}|${line.warehouseCode}|${line.branchCode}`;
    const quantity = parseQuantity(line.quantity);

    const stock = await inventory.positionOf(
      tx,
      line.itemCode,
      line.warehouseCode,
      line.branchCode,
    );
    // Lines of the same order competing for the same shelf: the second must be
    // judged against what the first has already claimed.
    //
    // `availableQuantity` is Phase 04's own rule (§9.5) — on hand less
    // reserved, quarantine, damaged and returns. Using it here rather than a
    // fresh subtraction is what keeps "available" meaning one thing.
    const claimed = wanted.get(key) ?? 0n;
    const available = availableQuantity(stock) - claimed;

    if (quantity > available) {
      throw new InsufficientAvailableError(
        line.itemCode,
        line.warehouseCode,
        available,
        quantity,
      );
    }

    wanted.set(key, claimed + quantity);
    availableAfter.push(available - quantity);
  }

  // 4 · The reservations.
  //
  // §7.2 lets one order carry lines for several branches, and under D10
  // (2026-08-17) that works without ceremony: branch security is the user's
  // *permitted* branches, and the Active Branch is only a default. A user with
  // Baghdad and Erbil reserves in both from one session.
  //
  // The scope check stays, and is the real control. The row-level policy asks
  // the same question of the database; this asks it of the person, in time to
  // give them a sentence rather than a policy violation.
  const reservations: string[] = [];

  for (const line of lines) {
    assertBranchInScope(ctx.principal, line.branchCode);

    const reserved = await inventory.reserve(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: line.warehouseCode,
      branchCode: line.branchCode,
      quantity: parseQuantity(line.quantity),
      documentType: DOCUMENT_TYPE,
      documentId: id,
      documentLineId: line.id,
    });
    reservations.push(reserved.reservationId);

    await tx
      .update(salesOrderLine)
      .set({ reservedQuantity: line.quantity })
      .where(eq(salesOrderLine.id, line.id));
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, order.status, 'approved');

  await tx
    .update(salesOrder)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      ...(options.creditOverride
        ? {
            creditOverrideBy: options.creditOverride.approvedByUserId,
            creditOverrideAt: new Date(),
            creditOverrideReason: options.creditOverride.reason.trim(),
            creditOverrideAmountIqd: toDecimalString(options.creditOverride.amountIqd, 4n),
            creditOverrideExpiresOn: options.creditOverride.expiresOn,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(salesOrder.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_order.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: order.branchCode,
    before: { status: order.status },
    after: {
      status: 'approved',
      reservations: reservations.length,
      exposureIqd: toDecimalString(position.exposureIqd, 4n),
      availableCreditIqd: toDecimalString(position.availableIqd, 4n),
      creditOverride: Boolean(options.creditOverride),
    },
    ...(options.creditOverride ? { reason: options.creditOverride.reason.trim() } : {}),
    outcome: 'success',
  });

  return { reservations, availableAfter };
}

/**
 * §7.4 — cancels the order and releases the reservation in full.
 *
 * A reservation is a promise about stock, and a cancelled order has stopped
 * making it. Releasing part of it would leave goods committed to nothing, which
 * is worse than not reserving them: the next order is refused for stock that is
 * sitting there.
 */
export async function cancel(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<{ released: number }> {
  const { order } = await load(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: order.branchCode,
  });

  if (!reason.trim()) {
    throw new Error(
      'Cancelling a sales order releases stock the customer was promised. §5.4 keeps the reason with it — state why.',
    );
  }

  if (order.status === 'cancelled' || order.status === 'closed') {
    throw new SalesOrderStateError(order.orderNo, order.status, 'it is already finished.');
  }

  // Every reservation this order holds, in every branch it touched.
  //
  // Under D10 one query finds them all, because the reader's permitted branches
  // are the boundary rather than their Active Branch. Under the session-branch
  // reading this loop released one of two and left Erbil stock committed to a
  // cancelled order — which is worse than either releasing all or refusing.
  const held = await inventory.reservationsFor(tx, DOCUMENT_TYPE, id);
  let released = 0;

  for (const reservation of held) {
    if (reservation.releasedAt) continue;
    assertBranchInScope(ctx.principal, reservation.branchCode);

    await inventory.releaseReservation(
      tx,
      ctx,
      reservation.id,
      `Sales order ${order.orderNo} cancelled: ${reason.trim()}`,
    );
    released += 1;
  }

  await tx
    .update(salesOrderLine)
    .set({ reservedQuantity: '0' })
    .where(eq(salesOrderLine.salesOrderId, id));

  await tx
    .update(salesOrder)
    .set({
      status: 'cancelled',
      cancelledBy: ctx.principal.userId,
      cancelledAt: new Date(),
      cancellationReason: reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(salesOrder.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_order.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: order.branchCode,
    before: { status: order.status },
    after: { status: 'cancelled', reservationsReleased: released },
    reason: reason.trim(),
    outcome: 'success',
  });

  return { released };
}

/** §7.3 — the credit position a screen shows before anybody presses approve. */
export async function creditPositionFor(tx: Tx, customerId: string, onDate: string) {
  const [customer] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, customerId))
    .limit(1);

  const components = await exposureFor(tx, customerId);

  return {
    customerCode: customer?.code ?? null,
    onCreditHold: customer?.onCreditHold ?? false,
    components,
    ...positionFor({
      limitIqd: parseDecimal(customer?.creditLimitIqd ?? '0', 4n),
      components,
      onDate,
    }),
  };
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}
