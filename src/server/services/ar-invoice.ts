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
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  arInvoiceLine,
  businessPartner,
  deliveryNote,
  deliveryNoteLine,
  paymentTerms,
  paymentTermInstalment,
  salesOrder,
  salesOrderLine,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import { totalsFor } from '../domain/sales-pricing';
import { dueDateFor } from '../domain/payment-terms';
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
import * as statuses from './statuses';
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
  const dueDate = await dueDateFrom(tx, order?.paymentTermsCode ?? null, invoiceDate);

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

async function dueDateFrom(
  tx: Tx,
  paymentTermsCode: string | null,
  invoiceDate: string,
): Promise<string> {
  if (!paymentTermsCode) return invoiceDate;

  const [terms] = await tx
    .select()
    .from(paymentTerms)
    .where(eq(paymentTerms.code, paymentTermsCode))
    .limit(1);

  if (!terms) return invoiceDate;

  const instalments = await tx
    .select()
    .from(paymentTermInstalment)
    .where(eq(paymentTermInstalment.termsCode, paymentTermsCode))
    .orderBy(paymentTermInstalment.sequence);

  return dueDateFor(
    {
      code: terms.code,
      name: terms.name,
      basis: terms.basis,
      dueDays: terms.dueDays,
      instalments: instalments.map((row) => ({
        sequence: row.sequence,
        daysAfter: row.daysAfter,
        percentage: row.percentage,
      })),
    },
    invoiceDate,
  );
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

  const [order] = await tx
    .select()
    .from(salesOrder)
    .where(eq(salesOrder.id, invoice.salesOrderId))
    .limit(1);

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
