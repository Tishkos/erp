/**
 * A/R Invoice — Phase 06.6, §7.4.
 *
 * > *"Every inventory A/R Invoice shall be created from an approved Delivery
 * > Note. The A/R Invoice shall be issued on the same date as delivery."*
 *
 * Appendix B: source **Delivery Note**, effect **A/R and revenue**.
 *
 * **The cost is not posted here.** The Delivery Note posted Dr COGS / Cr
 * Inventory at FIFO cost when the goods left (06.5); this posts Dr Customer A/R
 * / Cr Sales Revenue. Appendix C's single *"Sales delivery and invoice"* row
 * describes the combined event across both documents, and the two halves must
 * not overlap — Appendix B is where the split is stated, and it is the reason
 * `ar_invoice` has no COGS column to record the mistake in.
 *
 * **Nothing here decides the money.** The price was resolved from the customer's
 * price list and locked on the Sales Order (§7.3); the quantity came from the
 * Delivery Note. So `create` takes no price and no free quantity: it takes which
 * delivery lines to bill and how much of each, and reads everything else. §7.7
 * requires the price-list control to survive the UI *and* the API, and the way
 * it survives both is by there being no field to carry an override.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  arInvoice,
  arInvoiceLine,
  costLayer,
  inventoryMovement,
  item,
  businessPartner,
  deliveryNote,
  deliveryNoteLine,
  journalEntry,
  salesOrder,
  salesOrderLine,
  warehouse,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import { totalsFor } from '../domain/sales-pricing';
import type { PostingLineRequest } from '../domain/posting';
import {
  assertInvoiceDateMatchesDelivery,
  assertWithinDelivered,
  settlementStatusFor,
} from '../domain/ar-invoicing';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as inventory from './inventory';
import * as statuses from './statuses';
import * as terms from './payment-terms';
import * as warranty from './warranty';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'ar_invoice';
export const DOCUMENT_TYPE = 'ar_invoice';
const SEQUENCE_KEY = 'AR_INVOICE';

export class DeliveryNotInvoiceableError extends Error {
  readonly code = 'DELIVERY_NOT_INVOICEABLE';

  constructor(
    readonly deliveryNoteNo: string,
    readonly status: string,
  ) {
    super(
      `Delivery Note ${deliveryNoteNo} is '${status}'. §7.4 requires every inventory A/R Invoice to be ` +
        'created from an **approved** Delivery Note, and a note that has not been delivered has not ' +
        'given the customer anything to be billed for.',
    );
    this.name = 'DeliveryNotInvoiceableError';
  }
}

export class AlreadyInvoicedError extends Error {
  readonly code = 'DELIVERY_ALREADY_INVOICED';

  constructor(
    readonly deliveryNoteNo: string,
    readonly invoiceNo: string,
  ) {
    super(
      `Delivery Note ${deliveryNoteNo} was already invoiced on ${invoiceNo}. ` +
        'A second invoice from one delivery would bill the customer twice for one shipment.',
    );
    this.name = 'AlreadyInvoicedError';
  }
}

// ---------------------------------------------------------------------------
// Create — from a delivered note, on the delivery date
// ---------------------------------------------------------------------------

export interface CreateArInvoiceInput {
  readonly deliveryNoteId: string;
  /**
   * Optional, and checked rather than trusted: §7.4 fixes it to the delivery
   * date. Accepted at all only so that a caller who states it and is wrong gets
   * the §25 message explaining why, rather than silently having it overwritten.
   */
  readonly invoiceDate?: string;
  readonly note?: string | null;
  /**
   * Which delivery lines to bill, and how much of each. Omitted, the whole
   * delivery is billed — which is the normal case, since §7.4 pairs one invoice
   * with one delivery on one date.
   */
  readonly lines?: readonly {
    readonly deliveryNoteLineId: string;
    readonly quantity: bigint;
  }[];
}

/**
 * The batch each of these layers holds.
 *
 * A cost layer records what stock cost, not what it is called. What it is
 * called was said by the movement that created it — the goods receipt or the
 * purchase invoice that brought it in — and that is the batch printed on the
 * boxes. Read from there rather than copied onto the layer, so there is one
 * answer rather than two that can differ.
 */
async function batchesOfLayers(tx: Tx, layerIds: readonly string[]): Promise<Map<string, string | null>> {
  if (layerIds.length === 0) return new Map();
  const rows = await tx
    .select({ layerId: costLayer.id, batchNumber: inventoryMovement.batchNumber })
    .from(costLayer)
    .innerJoin(inventoryMovement, eq(inventoryMovement.id, costLayer.createdByMovementId))
    .where(inArray(costLayer.id, [...layerIds]));
  return new Map(rows.map((row) => [row.layerId, row.batchNumber]));
}

/**
 * The two accounts this line's stock posts to — the item's own.
 *
 * Block 1 put them on the item precisely so this could ask. A posting rule
 * keyed on the warehouse would give every item in it the same answer, and two
 * lines of one invoice can be different items held and costed differently.
 */
async function stockAccountsFor(
  tx: Tx,
  line: { itemCode: string; lineNo: number },
): Promise<{ inventory: string; cogs: string }> {
  const [row] = await tx
    .select({ inventory: item.inventoryAccountId, cogs: item.cogsAccountId })
    .from(item)
    .where(eq(item.code, line.itemCode))
    .limit(1);

  if (!row?.inventory) {
    throw new DirectSalesLineError(
      line.lineNo,
      `sells ${line.itemCode}, which names no inventory account. Set one on the item.`,
    );
  }
  if (!row.cogs) {
    throw new DirectSalesLineError(
      line.lineNo,
      `sells ${line.itemCode}, which names no COGS account, so its cost has nowhere to go. Set one on the item.`,
    );
  }
  return { inventory: row.inventory, cogs: row.cogs };
}

/** One line of a directly-raised Sales Invoice cannot do what it asks. */
export class DirectSalesLineError extends Error {
  readonly code = 'DIRECT_SALES_LINE';

  constructor(
    readonly lineNo: number,
    detail: string,
  ) {
    super(`Line ${lineNo} ${detail}`);
    this.name = 'DirectSalesLineError';
  }
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateArInvoiceInput,
): Promise<{ id: string; invoiceNo: string }> {
  const [note] = await tx
    .select()
    .from(deliveryNote)
    .where(eq(deliveryNote.id, input.deliveryNoteId))
    .limit(1);

  if (!note) throw new Error(`No delivery note with id '${input.deliveryNoteId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: note.branchCode,
  });

  // §7.4 — *approved*, and in this build's vocabulary a note that has actually
  // delivered is 'executed'. A note still merely approved is one on a van.
  if (note.status !== 'executed') {
    throw new DeliveryNotInvoiceableError(note.deliveryNoteNo, note.status);
  }

  const [existing] = await tx
    .select({ invoiceNo: arInvoice.invoiceNo })
    .from(arInvoice)
    .where(and(eq(arInvoice.deliveryNoteId, note.id), ne(arInvoice.status, 'reversed')))
    .limit(1);

  if (existing) throw new AlreadyInvoicedError(note.deliveryNoteNo, existing.invoiceNo);

  // §7.4 — the same date as the delivery, checked rather than assumed.
  const invoiceDate = input.invoiceDate ?? note.deliveryDate;
  assertInvoiceDateMatchesDelivery(invoiceDate, note.deliveryDate);

  const [order] = await tx
    .select()
    .from(salesOrder)
    .where(eq(salesOrder.id, note.salesOrderId))
    .limit(1);

  const noteLines = await tx
    .select()
    .from(deliveryNoteLine)
    .where(eq(deliveryNoteLine.deliveryNoteId, note.id))
    .orderBy(deliveryNoteLine.lineNo);

  const requested =
    input.lines ??
    noteLines
      .map((line) => ({
        deliveryNoteLineId: line.id,
        quantity: parseQuantity(line.quantity) - parseQuantity(line.invoicedQuantity),
      }))
      .filter((line) => line.quantity > 0n);

  if (requested.length === 0) {
    throw new Error(
      `Delivery Note ${note.deliveryNoteNo} has nothing left to invoice. ` +
        'Every delivered unit is already billed.',
    );
  }

  const byId = new Map(noteLines.map((line) => [line.id, line]));

  // §4.3 — the due date comes from the order's payment terms, applied to the
  // invoice date. Without terms the invoice is due on issue, which is what
  // "no terms" means rather than a reason to leave the date empty.
  const dueDate = await terms.dueDateOn(tx, order?.paymentTermsCode ?? null, invoiceDate);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: note.branchCode, year: Number(invoiceDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(arInvoice)
    .values({
      invoiceNo: allocated.documentNo,
      deliveryNoteId: note.id,
      salesOrderId: note.salesOrderId,
      customerId: order!.customerId,
      branchCode: note.branchCode,
      invoiceDate,
      paymentTermsCode: order?.paymentTermsCode ?? null,
      dueDate,
      currency: order?.currency ?? 'IQD',
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: arInvoice.id });

  const priced: { grossIqd: bigint; discountIqd: bigint; netIqd: bigint }[] = [];

  for (const [index, request] of requested.entries()) {
    const noteLine = byId.get(request.deliveryNoteLineId);
    if (!noteLine) {
      throw new Error(
        `Delivery line '${request.deliveryNoteLineId}' is not on ${note.deliveryNoteNo}.`,
      );
    }

    // §7.7 — billed quantities reconcile to what was delivered, cumulatively.
    assertWithinDelivered(
      noteLine.itemCode,
      {
        delivered: parseQuantity(noteLine.quantity),
        alreadyInvoiced: parseQuantity(noteLine.invoicedQuantity),
      },
      request.quantity,
    );

    const [ordered] = await tx
      .select()
      .from(salesOrderLine)
      .where(eq(salesOrderLine.id, noteLine.salesOrderLineId))
      .limit(1);

    // §7.3 — the price is the order's, and the discount with it. Read, never
    // taken from the caller: `CreateArInvoiceInput` has nowhere to put one.
    const totals = totalsFor({
      quantity: request.quantity,
      unitPriceIqd: parseDecimal(ordered!.unitPrice, 4n),
      discount: {
        ...(ordered!.discountPercent ? { percent: parseDecimal(ordered!.discountPercent, 4n) } : {}),
        ...(ordered!.discountAmountIqd
          ? // The order's discount is for the *ordered* quantity; a partial
            // invoice takes its share, or a half-delivery would carry a whole
            // order's discount and the customer would be billed too little.
            {
              amountIqd:
                (parseDecimal(ordered!.discountAmountIqd, 4n) * request.quantity) /
                parseQuantity(ordered!.quantity),
            }
          : {}),
      },
    });

    priced.push(totals);

    await tx.insert(arInvoiceLine).values({
      arInvoiceId: created!.id,
      lineNo: index + 1,
      deliveryNoteLineId: noteLine.id,
      salesOrderLineId: noteLine.salesOrderLineId,
      itemCode: noteLine.itemCode,
      description: noteLine.description,
      uomCode: noteLine.uomCode,
      quantity: formatQuantity(request.quantity),
      unitPrice: ordered!.unitPrice,
      discountPercent: ordered!.discountPercent,
      discountAmountIqd: totals.discountIqd > 0n ? toDecimalString(totals.discountIqd, 4n) : null,
      grossIqd: toDecimalString(totals.grossIqd, 4n),
      netIqd: toDecimalString(totals.netIqd, 4n),
    });
  }

  const total = {
    grossIqd: priced.reduce((sum, line) => sum + line.grossIqd, 0n),
    discountIqd: priced.reduce((sum, line) => sum + line.discountIqd, 0n),
    netIqd: priced.reduce((sum, line) => sum + line.netIqd, 0n),
  };

  await tx
    .update(arInvoice)
    .set({
      grossIqd: toDecimalString(total.grossIqd, 4n),
      discountIqd: toDecimalString(total.discountIqd, 4n),
      netIqd: toDecimalString(total.netIqd, 4n),
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, created!.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: note.branchCode,
    outcome: 'success',
    after: {
      invoiceNo: allocated.documentNo,
      deliveryNoteNo: note.deliveryNoteNo,
      invoiceDate,
      dueDate,
      netIqd: toDecimalString(total.netIqd, 4n),
      lines: requested.length,
    },
  });

  return { id: created!.id, invoiceNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// Approve — draft → approved
// ---------------------------------------------------------------------------

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const invoice = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'approved');

  await tx
    .update(arInvoice)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    outcome: 'success',
    before: { status: invoice.status },
    after: { status: 'approved' },
  });
}

// ---------------------------------------------------------------------------
// Post — Dr Customer A/R / Cr Sales Revenue (Appendix B, C)
// ---------------------------------------------------------------------------

/**
 * A Sales Invoice raised on its own — Operations block 5 (2026-09-12).
 *
 * The sponsor's document is the first in the chain, not the last: it sells the
 * stock itself rather than billing a delivery somebody else made.
 *
 *   Lines    Item Code; Item Name; Quantity; Unit Price; Discount;
 *            Total Price; Supplier; Warehouse.
 *   Effect   decreases stock from the selected warehouse.
 *   Journal  Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. / COGS Dr.
 *   COGS     FIFO, following the item, the supplier and the warehouse.
 *
 * The delivery-driven route above is untouched. Which one an invoice took is
 * read off its lines: a line names a warehouse, or it names a delivery line,
 * and the database refuses both — moving the same stock twice is the one
 * mistake this document must not be able to make.
 */
export interface DirectSalesLineInput {
  readonly itemCode: string;
  readonly description?: string | null;
  readonly quantity: bigint;
  readonly unitPriceIqd: bigint;
  /** Money off the line. The total is quantity x unit price less this. */
  readonly discountIqd?: bigint;
  readonly warehouseCode: string;
  /**
   * Whose stock to sell. The cost follows this supplier's layers and no
   * others — the same item bought from two suppliers is two pools. Omitted,
   * the oldest stock of any supplier is consumed.
   */
  readonly supplierId?: string | null;
  readonly uomCode?: string;
}

export interface CreateDirectArInvoiceInput {
  readonly customerId: string;
  readonly branchCode: string;
  readonly invoiceDate: string;
  /** Omitted, it comes from the customer's payment terms. */
  readonly dueDate?: string;
  readonly note?: string | null;
  readonly lines: readonly DirectSalesLineInput[];
}

/**
 * Raises a Sales Invoice with no order and no delivery behind it.
 *
 * Nothing moves yet. The stock leaves and the journal posts when the invoice
 * is posted, which is after approval — the sponsor: "the invoice is not posted
 * until CEO approval."
 */
export async function createDirect(
  tx: Tx,
  ctx: ActorContext,
  input: CreateDirectArInvoiceInput,
): Promise<{ id: string; invoiceNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error('A Sales Invoice needs at least one line.');
  }

  const [customer] = await tx
    .select({ id: businessPartner.id, paymentTermsCode: businessPartner.paymentTermsCode })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.customerId))
    .limit(1);
  if (!customer) throw new Error(`No customer with id '${input.customerId}'.`);

  const dueDate =
    input.dueDate ?? (await terms.dueDateOn(tx, customer.paymentTermsCode ?? null, input.invoiceDate));

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.invoiceDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(arInvoice)
    .values({
      invoiceNo: allocated.documentNo,
      deliveryNoteId: null,
      salesOrderId: null,
      customerId: input.customerId,
      branchCode: input.branchCode,
      invoiceDate: input.invoiceDate,
      paymentTermsCode: customer.paymentTermsCode ?? null,
      dueDate,
      currency: 'IQD',
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: arInvoice.id });

  let grossTotal = 0n;
  let discountTotal = 0n;
  let netTotal = 0n;

  for (const [index, line] of input.lines.entries()) {
    const gross = (line.quantity * line.unitPriceIqd) / 1_000_000n;
    const discount = line.discountIqd ?? 0n;
    if (discount < 0n || discount > gross) {
      throw new DirectSalesLineError(
        index + 1,
        'has a discount larger than the line, which would make it a credit note.',
      );
    }
    const net = gross - discount;
    grossTotal += gross;
    discountTotal += discount;
    netTotal += net;

    const [stockItem] = await tx
      .select({ name: item.name })
      .from(item)
      .where(eq(item.code, line.itemCode))
      .limit(1);
    if (!stockItem) throw new DirectSalesLineError(index + 1, `names no item '${line.itemCode}'.`);

    await tx.insert(arInvoiceLine).values({
      arInvoiceId: created!.id,
      lineNo: index + 1,
      deliveryNoteLineId: null,
      salesOrderLineId: null,
      itemCode: line.itemCode,
      // The sponsor: selecting the Item Code brings the Item Name. It is read
      // from the master rather than taken from the caller, so an invoice
      // cannot name an item one thing and the chart another.
      description: line.description ?? stockItem.name,
      uomCode: line.uomCode ?? 'EA',
      quantity: formatQuantity(line.quantity),
      unitPrice: toDecimalString(line.unitPriceIqd, 4n),
      discountAmountIqd: discount === 0n ? null : toDecimalString(discount, 4n),
      grossIqd: toDecimalString(gross, 4n),
      netIqd: toDecimalString(net, 4n),
      warehouseCode: line.warehouseCode,
      supplierId: line.supplierId ?? null,
    });
  }

  await tx
    .update(arInvoice)
    .set({
      grossIqd: toDecimalString(grossTotal, 4n),
      // The header's own total, which the database holds to
      // net = gross - discount. Two places for one figure, and the constraint
      // is what stops them drifting.
      discountIqd: toDecimalString(discountTotal, 4n),
      netIqd: toDecimalString(netTotal, 4n),
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, created!.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      invoiceNo: allocated.documentNo,
      direct: true,
      lines: input.lines.length,
      netIqd: toDecimalString(netTotal, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, invoiceNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// The lines of a draft, typed in place — by direction, 2026-09-16
// ---------------------------------------------------------------------------

/**
 * The Journal Entry's grid, on the document that bills the customer.
 *
 * A line is saved the moment it is complete and left, and a new one opens under
 * it. `edit_draft` has been granted to both accounting roles since migration
 * 0047 and no screen had ever used it, so a mistyped invoice had to be
 * abandoned and raised again under a new number.
 *
 * **Only an invoice raised on its own.** §7.4 makes the Delivery Note the
 * source of an inventory invoice: its lines are the shipment's, the item is
 * carried down the chain rather than chosen at invoicing, and a trigger has
 * refused anything else since 0047. Those are corrected on the delivery.
 */
export interface DraftSalesLineInput {
  readonly itemCode: string;
  readonly quantity: bigint;
  readonly unitPriceIqd: bigint;
  readonly discountIqd?: bigint;
  readonly warehouseCode: string;
  /** Whose stock the line draws from. Blank is the oldest of any supplier. */
  readonly supplierId?: string | null;
}

/** The draft, and the reasons it may be typed into. */
async function editableDraft(tx: Tx, ctx: ActorContext, id: string) {
  const seen = await view(tx, id);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: seen.branchCode,
    objectId: id,
  });

  if (seen.status !== 'draft') {
    throw new Error(
      `Sales Invoice ${seen.invoiceNo} is ${seen.status} and its lines can no longer be changed. An approved invoice goes back to draft first, and a posted one is reversed.`,
    );
  }

  if (seen.deliveryNoteId) {
    throw new Error(
      `Sales Invoice ${seen.invoiceNo} bills a Delivery Note, so its lines are the shipment's (§7.4). Correct the delivery, or raise an invoice on its own.`,
    );
  }

  return seen;
}

/**
 * The header's three figures, restated from the lines.
 *
 * `net = gross − discount` is a CHECK on the table, and the ageing, the
 * receipts and Appendix B's Partially Paid all read `net_iqd`. So the header is
 * rewritten from the lines on every change rather than adjusted by the
 * difference, which is how two figures for one invoice start to disagree.
 */
async function restateTotals(tx: Tx, id: string): Promise<void> {
  const rows = await tx
    .select({ grossIqd: arInvoiceLine.grossIqd, netIqd: arInvoiceLine.netIqd })
    .from(arInvoiceLine)
    .where(eq(arInvoiceLine.arInvoiceId, id));

  let gross = 0n;
  let net = 0n;
  for (const row of rows) {
    gross += parseDecimal(row.grossIqd, 4n);
    net += parseDecimal(row.netIqd, 4n);
  }

  await tx
    .update(arInvoice)
    .set({
      grossIqd: toDecimalString(gross, 4n),
      discountIqd: toDecimalString(gross - net, 4n),
      netIqd: toDecimalString(net, 4n),
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, id));
}

export async function saveLine(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  lineId: string | null,
  input: DraftSalesLineInput,
): Promise<{ lineNo: number }> {
  const invoice = await editableDraft(tx, ctx, id);

  const existing = lineId ? invoice.lines.find((line) => line.id === lineId) : undefined;
  if (lineId && !existing) {
    throw new Error(`That line is not on invoice ${invoice.invoiceNo}.`);
  }
  const lineNo =
    existing?.lineNo ?? invoice.lines.reduce((max, line) => Math.max(max, line.lineNo), 0) + 1;

  const [stockItem] = await tx
    .select({
      code: item.code,
      name: item.name,
      uomCode: item.baseUomCode,
      active: item.active,
    })
    .from(item)
    .where(eq(item.code, input.itemCode))
    .limit(1);
  if (!stockItem) throw new DirectSalesLineError(lineNo, `names no item '${input.itemCode}'.`);
  if (!stockItem.active) {
    throw new DirectSalesLineError(lineNo, `names ${stockItem.code}, which is no longer active.`);
  }

  const [house] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(eq(warehouse.code, input.warehouseCode))
    .limit(1);
  if (!house) {
    throw new DirectSalesLineError(lineNo, `names no warehouse '${input.warehouseCode}'.`);
  }

  if (input.quantity <= 0n) {
    throw new DirectSalesLineError(lineNo, 'has no quantity. An invoice bills for something.');
  }
  if (input.unitPriceIqd < 0n) {
    throw new DirectSalesLineError(lineNo, 'has a negative price. A refund is a credit note.');
  }

  // Quantity carries six decimal places and the price four, so their product
  // carries ten; the divisor brings it back to the four money is stored at.
  const gross = (input.quantity * input.unitPriceIqd) / 1_000_000n;
  const discount = input.discountIqd ?? 0n;
  if (discount < 0n || discount > gross) {
    throw new DirectSalesLineError(
      lineNo,
      'has a discount larger than the line, which would make it a credit note.',
    );
  }

  const values = {
    itemCode: stockItem.code,
    // The sponsor: selecting the Item Code brings the Item Name. It is read
    // from the master rather than taken from the caller, so an invoice cannot
    // name an item one thing and the chart another.
    description: stockItem.name,
    uomCode: stockItem.uomCode,
    quantity: formatQuantity(input.quantity),
    unitPrice: toDecimalString(input.unitPriceIqd, 4n),
    discountAmountIqd: discount === 0n ? null : toDecimalString(discount, 4n),
    grossIqd: toDecimalString(gross, 4n),
    netIqd: toDecimalString(gross - discount, 4n),
    warehouseCode: house.code,
    supplierId: input.supplierId ?? null,
  };

  if (existing) {
    await tx.update(arInvoiceLine).set(values).where(eq(arInvoiceLine.id, existing.id));
  } else {
    await tx.insert(arInvoiceLine).values({
      arInvoiceId: id,
      lineNo,
      deliveryNoteLineId: null,
      salesOrderLineId: null,
      ...values,
    });
  }

  await restateTotals(tx, id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: existing ? 'ar_invoice.line_changed' : 'ar_invoice.line_added',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    ...(existing
      ? {
          before: {
            lineNo: existing.lineNo,
            itemCode: existing.itemCode,
            quantity: existing.quantity,
            unitPrice: existing.unitPrice,
            netIqd: existing.netIqd,
            warehouseCode: existing.warehouseCode,
          },
        }
      : {}),
    after: { lineNo, ...values },
    outcome: 'success',
  });

  return { lineNo };
}

/** Taking one line off a draft. The rest renumber, so the grid stays 1..n. */
export async function removeLine(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  lineId: string,
): Promise<void> {
  const invoice = await editableDraft(tx, ctx, id);

  const line = invoice.lines.find((row) => row.id === lineId);
  if (!line) throw new Error(`That line is not on invoice ${invoice.invoiceNo}.`);
  if (invoice.lines.length === 1) {
    throw new Error(
      `${invoice.invoiceNo} would be left billing for nothing. Change this line, or cancel the invoice.`,
    );
  }

  await tx.delete(arInvoiceLine).where(eq(arInvoiceLine.id, lineId));

  // Out of the way and back: the numbers are unique per invoice, so closing the
  // gap in place would collide with the row above it.
  await tx.execute(
    sql`update ar_invoice_line set line_no = line_no + 1000
         where ar_invoice_id = ${id} and line_no > ${line.lineNo}`,
  );
  await tx.execute(
    sql`update ar_invoice_line set line_no = line_no - 1001
         where ar_invoice_id = ${id} and line_no > 1000`,
  );

  await restateTotals(tx, id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.line_removed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: {
      lineNo: line.lineNo,
      itemCode: line.itemCode,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      netIqd: line.netIqd,
      warehouseCode: line.warehouseCode,
    },
    outcome: 'success',
  });
}

export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const invoice = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'posted');

  const lines = await tx
    .select()
    .from(arInvoiceLine)
    .where(eq(arInvoiceLine.arInvoiceId, id))
    .orderBy(arInvoiceLine.lineNo);

  const [customer] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, invoice.customerId))
    .limit(1);

  // Null on a directly-raised invoice, which has no order behind it. The
  // dimensions it would have carried are then the ones the accounts require
  // of the lines themselves.
  const [order] = invoice.salesOrderId
    ? await tx.select().from(salesOrder).where(eq(salesOrder.id, invoice.salesOrderId)).limit(1)
    : [];

  const criteria = { branchCode: invoice.branchCode };
  const base = {
    branch: invoice.branchCode,
    business_partner: customer?.code ?? null,
    // §4.2 — from the order, where the sale was attributed. The revenue account
    // requires business line by default (migration 0005), and this is the same
    // value the delivery's COGS carried, so the two halves of the sale report
    // under one line of business.
    business_line: order?.businessLineCode ?? null,
    department: order?.departmentCode ?? null,
  };

  // Revenue line by line, receivable in one.
  //
  // §4.2 makes a dimension a property of the line as well as the account, and
  // two lines of one invoice may belong to different cost centres. The
  // receivable does not: the customer owes one amount, and splitting it would
  // make the subledger disagree with the invoice it came from.
  const netIqd = parseDecimal(invoice.netIqd, 4n);

  const postingLines: PostingLineRequest[] = [
    {
      role: 'customer_receivable',
      debit: toDecimalString(netIqd, 4n),
      criteria,
      dimensions: base,
    },
    ...lines.map((line) => ({
      role: 'sales_revenue',
      credit: line.netIqd,
      criteria,
      dimensions: base,
      sourceLineId: line.id,
    })),
  ];

  // ── The stock the invoice sells itself (Operations block 5) ────────────
  //
  // The sponsor's journal has four parts: Accounts Receivable Dr, Revenue Cr,
  // Inventory Cr, COGS Dr. The first two are above and are the price; these
  // two are the cost, and the cost is not the price.
  //
  // FIFO decides it. `issue` locks this item's layers, refuses to leave the
  // warehouse negative (block 11), and returns what the oldest layers
  // actually cost — narrowed to one supplier's stock when the line names one,
  // because the same item from two suppliers is two pools and the sponsor
  // sells from a chosen one.
  //
  // Both accounts come from the item, not from a rule, for the reason block 1
  // put them there: two lines of one invoice can be items held in different
  // stock accounts and charged to different cost accounts.
  for (const line of lines) {
    if (!line.warehouseCode) continue;

    const accounts = await stockAccountsFor(tx, line);

    // One movement per cost layer, rather than one for the line.
    //
    // §9.3 asks every stock movement to name the batch it moved, and §9.9
    // wants that trace to hold from receipt to delivery. A FIFO consumption
    // can span several layers — three batches bought on three invoices — and a
    // single movement could only name one of them, which would put a
    // plausible, wrong batch on two thirds of the goods. Issuing layer by
    // layer says exactly what left.
    //
    // The layers are read here, before anything moves, and narrowed to one
    // supplier when the line names one. The warehouse still refuses to go
    // negative: each `issueFromLayer` checks the position, and a line asking
    // for more than its pool holds runs out of layers with quantity left over,
    // which is the throw below.
    const layers = await inventory.layersOf(
      tx,
      line.itemCode,
      line.warehouseCode,
      line.supplierId,
    );

    // Which batch each layer holds. The layer does not record it; the
    // movement that created the layer does, and that is the batch the goods
    // physically carry.
    const batches = await batchesOfLayers(tx, layers.map((layer) => layer.id));

    let outstanding = parseQuantity(line.quantity);
    let cost = 0n;

    for (const layer of layers) {
      if (outstanding === 0n) break;
      if (layer.remainingQuantity === 0n) continue;

      const take = layer.remainingQuantity < outstanding ? layer.remainingQuantity : outstanding;
      const issued = await inventory.issueFromLayer(tx, ctx, {
        costLayerId: layer.id,
        itemCode: line.itemCode,
        warehouseCode: line.warehouseCode,
        branchCode: invoice.branchCode,
        quantity: take,
        movementDate: invoice.invoiceDate,
        kind: 'delivery',
        batchNumber: batches.get(layer.id) ?? null,
        sourceDocumentType: DOCUMENT_TYPE,
        sourceDocumentId: id,
        sourceLineId: line.id,
      });
      cost += issued.costIqd ?? 0n;
      outstanding -= take;
    }

    if (outstanding > 0n) {
      throw new DirectSalesLineError(
        line.lineNo,
        `sells more ${line.itemCode} than ${line.warehouseCode} holds` +
          `${line.supplierId ? ' of that supplier’s stock' : ''}. Negative stock is not allowed.`,
      );
    }
    if (cost === 0n) continue;

    postingLines.push(
      {
        role: 'cogs',
        accountId: accounts.cogs,
        debit: toDecimalString(cost, 4n),
        criteria: { ...criteria, warehouseCode: line.warehouseCode },
        dimensions: base,
        sourceLineId: line.id,
      },
      {
        role: 'inventory',
        accountId: accounts.inventory,
        credit: toDecimalString(cost, 4n),
        criteria: { ...criteria, warehouseCode: line.warehouseCode },
        dimensions: base,
        sourceLineId: line.id,
      },
    );
  }

  const result = await posting.post(tx, ctx, {
    eventType: 'sales.ar_invoice',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'sales', documentId: id, event: 'posted' },
    branchCode: invoice.branchCode,
    documentDate: invoice.invoiceDate,
    // §7.4 — the delivery date, which is the invoice date, which is the posting
    // date. One date, so the cost and the revenue of a sale share a period.
    postingDate: invoice.invoiceDate,
    description: `A/R invoice ${invoice.invoiceNo} — ${customer?.code ?? 'customer'}`,
    lines: postingLines,
  });

  await tx
    .update(arInvoice)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, id));

  // The delivery and order lines carry what has been billed, so 06.9's returns
  // and credit memos have something to reduce and §7.7's reconciliation has a
  // figure to show.
  for (const line of lines) {
    // A directly-raised line has no delivery or order to credit; it moved the
    // stock itself, above.
    if (!line.deliveryNoteLineId || !line.salesOrderLineId) continue;

    await tx
      .update(deliveryNoteLine)
      .set({ invoicedQuantity: sql`${deliveryNoteLine.invoicedQuantity} + ${line.quantity}` })
      .where(eq(deliveryNoteLine.id, line.deliveryNoteLineId));

    await tx
      .update(salesOrderLine)
      .set({ invoicedQuantity: sql`${salesOrderLine.invoicedQuantity} + ${line.quantity}` })
      .where(eq(salesOrderLine.id, line.salesOrderLineId));
  }

  // §7.4 — *"Warranty starts on the A/R Invoice date."* Registered here, in the
  // same transaction, because that is the moment the clause names — and because
  // a warranty that had to be registered as a separate step is the one that gets
  // forgotten on a busy day and disputed two years later.
  const warranties = await warranty.registerForInvoice(tx, ctx, id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    outcome: 'success',
    before: { status: invoice.status },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      netIqd: invoice.netIqd,
      warrantiesRegistered: warranties.registered,
    },
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// Settlement — Appendix B's Partially Paid and Paid
// ---------------------------------------------------------------------------

/**
 * Records money applied to an invoice and moves its status accordingly.
 *
 * Called by the Customer Receipt (06.10) and the Credit Memo (06.9); here
 * because the rule belongs to the invoice, and two callers implementing it
 * separately is how an invoice ends up marked Paid with a balance on it.
 */
export async function applyAllocation(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  amountIqd: bigint,
): Promise<{ status: string; allocatedIqd: bigint }> {
  const invoice = await load(tx, id);

  const allocated = parseDecimal(invoice.allocatedIqd, 4n) + amountIqd;
  const total = parseDecimal(invoice.netIqd, 4n);

  const target = settlementStatusFor({ totalIqd: total, allocatedIqd: allocated });

  if (target !== invoice.status) {
    await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, target);
  }

  await tx
    .update(arInvoice)
    .set({
      allocatedIqd: toDecimalString(allocated, 4n),
      status: target,
      updatedAt: new Date(),
    })
    .where(eq(arInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.allocated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    outcome: 'success',
    before: { status: invoice.status, allocatedIqd: invoice.allocatedIqd },
    after: { status: target, allocatedIqd: toDecimalString(allocated, 4n) },
  });

  return { status: target, allocatedIqd: allocated };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [invoice] = await tx.select().from(arInvoice).where(eq(arInvoice.id, id)).limit(1);
  if (!invoice) throw new Error(`No A/R invoice with id '${id}'.`);
  return invoice;
}

/**
 * The register — Operations block 5's list of Sales Invoices.
 *
 * The customer's name is joined rather than copied onto the invoice, so a
 * customer renamed this year still reads correctly on last year's invoice.
 */
export async function list(tx: Tx) {
  return tx
    .select({
      id: arInvoice.id,
      invoiceNo: arInvoice.invoiceNo,
      customerName: businessPartner.legalName,
      customerCode: businessPartner.code,
      invoiceDate: arInvoice.invoiceDate,
      dueDate: arInvoice.dueDate,
      netIqd: arInvoice.netIqd,
      status: arInvoice.status,
      branchCode: arInvoice.branchCode,
    })
    .from(arInvoice)
    .leftJoin(businessPartner, eq(businessPartner.id, arInvoice.customerId))
    .orderBy(desc(arInvoice.invoiceDate), desc(arInvoice.invoiceNo));
}

/** The invoice a person is looking at, found by the number printed on it. */
export async function viewByNo(tx: Tx, invoiceNo: string) {
  const [row] = await tx
    .select({ id: arInvoice.id })
    .from(arInvoice)
    .where(eq(arInvoice.invoiceNo, invoiceNo))
    .limit(1);
  if (!row) return null;

  const seen = await view(tx, row.id);

  // Everybody the document passed through, as the Journal Entry names them.
  // Approving and posting are two verbs — "the invoice is not posted until CEO
  // approval" — so they are two names, even when one person did both. Rolling
  // them into a single "carried by" hid which of the two steps had happened.
  const people = await tx
    .select({ id: appUser.id, displayName: appUser.displayName })
    .from(appUser)
    .where(
      inArray(
        appUser.id,
        [seen.createdBy, seen.approvedBy, seen.postedBy, seen.reversedBy].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    );
  const name = (id: string | null) =>
    id ? (people.find((person) => person.id === id)?.displayName ?? null) : null;

  // The posting, by the number a person would read out, so the invoice drills
  // to its own journal rather than to an id nobody can type.
  const [posted] = seen.journalEntryId
    ? await tx
        .select({ entryNo: journalEntry.entryNo })
        .from(journalEntry)
        .where(eq(journalEntry.id, seen.journalEntryId))
        .limit(1)
    : [];

  return {
    ...seen,
    raisedBy: name(seen.createdBy),
    approvedByName: name(seen.approvedBy),
    postedByName: name(seen.postedBy),
    reversedByName: name(seen.reversedBy),
    journalEntryNo: posted?.entryNo ?? null,
  };
}

export async function view(tx: Tx, id: string) {
  const invoice = await load(tx, id);
  const lines = await tx
    .select()
    .from(arInvoiceLine)
    .where(eq(arInvoiceLine.arInvoiceId, id))
    .orderBy(arInvoiceLine.lineNo);

  return { ...invoice, lines };
}

/**
 * §7.7 — *"Every posted sales journal drills to the Sales Order, Delivery Note
 * and A/R Invoice."*
 *
 * The drill-back, as a query. A journal that could not answer this would be one
 * whose source document had to be found by hand, which is the thing §14.8 calls
 * a broken audit trail.
 */
export async function drillBack(tx: Tx, journalEntryId: string) {
  const result = await tx.execute(sql`
    select 'ar_invoice'                as "documentType",
           i.invoice_no                as "documentNo",
           i.id::text                  as "documentId",
           o.order_no                  as "salesOrderNo",
           o.id::text                  as "salesOrderId",
           n.delivery_note_no          as "deliveryNoteNo",
           n.id::text                  as "deliveryNoteId",
           n.journal_entry_id::text    as "cogsJournalEntryId"
      from ar_invoice i
      join sales_order o  on o.id = i.sales_order_id
      join delivery_note n on n.id = i.delivery_note_id
     where i.journal_entry_id = ${journalEntryId}
    union all
    select 'delivery_note',
           n.delivery_note_no,
           n.id::text,
           o.order_no,
           o.id::text,
           n.delivery_note_no,
           n.id::text,
           n.journal_entry_id::text
      from delivery_note n
      join sales_order o on o.id = n.sales_order_id
     where n.journal_entry_id = ${journalEntryId}
  `);

  return (result as unknown as { rows: Record<string, string | null>[] }).rows;
}
