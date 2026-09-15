/**
 * A/P Invoice and three-way match — Phase 05.4 and 05.5, §8.4 and §15.
 *
 * Where the two purchasing flows converge. Goods arrived on a Goods Receipt
 * (05.2), services were confirmed by the benefiting department (05.3), and this
 * is the document that says what the company owes for them.
 *
 * **The match runs on every change, not on demand.** §8.4's gate asks that
 * *"match status is visible on the invoice at all times"*, and a status computed
 * only when somebody presses a button is visible only after they press it. So
 * `rematch()` runs when lines are added and again at submission, and the stored
 * status is always the answer to "as of now".
 *
 * **Posting (Appendix C).** Inventory lines clear GRNI — the account the goods
 * receipt credited — so a fully received and fully invoiced order leaves GRNI at
 * zero, which is 05.5's gate. Service lines go straight to expense. Any variance
 * posts to its **own account**, never into inventory: stock was valued at the PO
 * price when it arrived, and letting an invoice restate that would put the FIFO
 * layers and the inventory control account out of step, which §9.9's
 * reconciliation exists to detect.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  item,
  apMatchException,
  apMatchTolerance,
  businessPartner,
  goodsReceipt,
  goodsReceiptLine,
  purchaseOrder,
  purchaseOrderLine,
  serviceReceipt,
  serviceReceiptLine,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  NO_TOLERANCE,
  describeVariance,
  matchDocument,
  matchLine,
  type MatchResult,
  type MatchStatus,
  type MatchTolerance,
} from '../domain/three-way-match';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as inventory from './inventory';
import * as shipments from './supplier-shipment';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'ap_invoice';
export const PERMISSION_OBJECT = 'ap_invoice';
const SEQUENCE_KEY = 'AP_INVOICE';

export class ApInvoiceNotFoundError extends Error {
  readonly code = 'AP_INVOICE_NOT_FOUND';
  constructor(id: string) {
    super(`No A/P invoice '${id}'.`);
    this.name = 'ApInvoiceNotFoundError';
  }
}

/** One line of an invoice cannot do what it is being asked to do. */
export class ApInvoiceLineError extends Error {
  readonly code = 'AP_INVOICE_LINE';

  constructor(
    readonly lineNo: number,
    detail: string,
  ) {
    super(`Line ${lineNo} ${detail}`);
    this.name = 'ApInvoiceLineError';
  }
}

export class ApInvoiceStateError extends Error {
  readonly code = 'AP_INVOICE_STATE_INVALID';
  constructor(invoiceNo: string, status: string, detail: string) {
    super(`A/P invoice ${invoiceNo} is '${status}': ${detail}`);
    this.name = 'ApInvoiceStateError';
  }
}

/** §15 — one supplier invoice number per supplier, exceptions approved. */
export class DuplicateSupplierInvoiceError extends Error {
  readonly code = 'DUPLICATE_SUPPLIER_INVOICE';
  constructor(
    readonly supplierInvoiceNo: string,
    readonly existingInvoiceNo: string,
  ) {
    super(
      `Supplier invoice ${supplierInvoiceNo} has already been entered as ${existingInvoiceNo} (§15). ` +
        'Check whether this is the same charge; if it genuinely is a second invoice with the same number, ' +
        'a manager records a duplicate exception with the reason.',
    );
    this.name = 'DuplicateSupplierInvoiceError';
  }
}

/** §8.4 — nothing received, nothing to invoice. */
export class NothingReceivedError extends Error {
  readonly code = 'NOTHING_RECEIVED';
  constructor(
    readonly orderNo: string,
    readonly lineNo: number,
    isInventory: boolean,
  ) {
    super(
      `Line ${lineNo} of ${orderNo} has nothing received against it, so it cannot be invoiced (§8.4). ` +
        (isInventory
          ? 'The warehouse records a Goods Receipt first.'
          : 'The benefiting department confirms the service first (§8.6).'),
    );
    this.name = 'NothingReceivedError';
  }
}

export class VarianceNotApprovedError extends Error {
  readonly code = 'VARIANCE_NOT_APPROVED';
  constructor(
    readonly invoiceNo: string,
    readonly exceptions: number,
  ) {
    super(
      `Invoice ${invoiceNo} has ${exceptions} unresolved match exception(s) (§8.4). ` +
        'A manager accepts each variance with a reason, or the invoice is corrected — variances are allowed only after approval.',
    );
    this.name = 'VarianceNotApprovedError';
  }
}

/** §15 — an invoice with no purchase order takes the stronger route. */
export class NonPoEvidenceRequiredError extends Error {
  readonly code = 'NON_PO_EVIDENCE_REQUIRED';
  constructor() {
    super(
      'An invoice with no purchase order needs a written justification and a second approver (§15). ' +
        'Say what was bought and why it was not ordered, and have a manager approve it — ' +
        'the three-way match cannot protect a charge that no order and no receipt describe.',
    );
    this.name = 'NonPoEvidenceRequiredError';
  }
}

export interface InvoiceLineInput {
  /** Null only on the §15 non-PO route. */
  readonly purchaseOrderLineId?: string | null;
  readonly description?: string | null;
  readonly quantity: bigint;
  readonly unitPriceIqd: bigint;
  /** Required on the non-PO route, where there is no ordered line to read. */
  readonly uomCode?: string | null;
  readonly itemCode?: string | null;
  readonly isInventory?: boolean;
  readonly costCentreCode?: string | null;
  /**
   * Where this line receives stock — Operations block 4.
   *
   * Naming one makes this the direct route: the invoice brings the goods in
   * itself and debits the item's own inventory account. Leaving it null keeps
   * the route that existed before, where a Goods Receipt already did that and
   * the invoice clears GRNI.
   */
  readonly warehouseCode?: string | null;
  /** Money off this line. The total is quantity x unit price less this. */
  readonly discountIqd?: bigint;
}

export interface CreateApInvoiceInput {
  readonly supplierId: string;
  readonly supplierInvoiceNo: string;
  /** Null takes the §15 non-PO route, which costs a justification. */
  readonly purchaseOrderId?: string | null;
  readonly branchCode: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly currency?: string;
  readonly note?: string | null;
  readonly lines: readonly InvoiceLineInput[];
  /** §15 — required when there is no purchase order. */
  readonly nonPoJustification?: string | null;
  readonly nonPoApprovedBy?: string | null;
  /** §15 — a manager's decision that this repeated number is not a duplicate. */
  readonly duplicateApprovedBy?: string | null;
  readonly duplicateApprovalReason?: string | null;
}

async function load(tx: Tx, id: string) {
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, id)).limit(1);
  if (!invoice) throw new ApInvoiceNotFoundError(id);

  const lines = await tx
    .select()
    .from(apInvoiceLine)
    .where(eq(apInvoiceLine.apInvoiceId, id))
    .orderBy(apInvoiceLine.lineNo);

  return { invoice, lines };
}

/** §8.4 — the tolerance for this supplier, or the company default. */
export async function toleranceFor(tx: Tx, supplierId: string): Promise<MatchTolerance> {
  const [specific] = await tx
    .select()
    .from(apMatchTolerance)
    .where(eq(apMatchTolerance.supplierId, supplierId))
    .limit(1);

  const row =
    specific ??
    (
      await tx
        .select()
        .from(apMatchTolerance)
        .where(isNull(apMatchTolerance.supplierId))
        .limit(1)
    )[0];

  // No configuration at all means no tolerance, not unlimited: §8.4 asks for a
  // control, and a missing row should not silently remove one.
  if (!row) return NO_TOLERANCE;

  return {
    quantityPercent: row.quantityPercent,
    pricePercent: row.pricePercent,
    valuePercent: row.valuePercent,
  };
}

/**
 * How much of an ordered line the receipt evidence supports.
 *
 * Goods: posted receipts. Services: approved confirmations. Drafts of either
 * count for nothing — evidence is what somebody stood behind.
 */
export async function receivedQuantityFor(
  tx: Tx,
  purchaseOrderLineId: string,
  isInventory: boolean,
): Promise<bigint> {
  if (isInventory) {
    const rows = await tx
      .select({ quantity: goodsReceiptLine.quantity })
      .from(goodsReceiptLine)
      .innerJoin(goodsReceipt, eq(goodsReceipt.id, goodsReceiptLine.goodsReceiptId))
      .where(
        and(
          eq(goodsReceiptLine.purchaseOrderLineId, purchaseOrderLineId),
          eq(goodsReceipt.status, 'executed'),
        ),
      );
    return rows.reduce((total, row) => total + parseQuantity(row.quantity), 0n);
  }

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

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateApInvoiceInput,
): Promise<{ id: string; invoiceNo: string; matchStatus: MatchStatus }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error('An invoice with no lines charges nothing. Add what is being charged for.');
  }

  /*
   * §15 — the non-PO route costs a justification and a second approver.
   *
   * Unless the invoice receives its own stock. The rule exists because "the
   * three-way match cannot protect a charge that no order and no receipt
   * describe" — and Operations block 4's invoice describes the receipt: every
   * line names the warehouse its goods arrive in, and posting puts them there.
   * The evidence §15 asks for is the document being approved.
   *
   * What is left unguarded is the charge, and block 4 holds that behind "the
   * invoice is not posted until CEO approval" — a separate verb the person who
   * raised it does not hold. So the control is not removed, it is the one the
   * sponsor specified.
   *
   * Narrow on purpose: one service line among the stock lines and the evidence
   * is owed again, because that line has no receipt of any kind behind it.
   */
  const receivesItsOwnStock = input.lines.every((line) => Boolean(line.warehouseCode));

  if (!input.purchaseOrderId && !receivesItsOwnStock) {
    if (
      !input.nonPoJustification ||
      input.nonPoJustification.trim().length === 0 ||
      !input.nonPoApprovedBy
    ) {
      throw new NonPoEvidenceRequiredError();
    }
    if (input.nonPoApprovedBy === ctx.principal.userId) {
      throw new NonPoEvidenceRequiredError();
    }
  }

  // §15 — the duplicate control. Checked here for a message that names the
  // earlier invoice; the partial unique index refuses it by any other path.
  if (!input.duplicateApprovedBy) {
    const [existing] = await tx
      .select({ invoiceNo: apInvoice.invoiceNo })
      .from(apInvoice)
      .where(
        and(
          eq(apInvoice.supplierId, input.supplierId),
          eq(apInvoice.supplierInvoiceNo, input.supplierInvoiceNo.trim()),
        ),
      )
      .limit(1);

    if (existing) {
      throw new DuplicateSupplierInvoiceError(input.supplierInvoiceNo, existing.invoiceNo);
    }
  } else if (!input.duplicateApprovalReason || input.duplicateApprovalReason.trim().length === 0) {
    throw new Error(
      'A duplicate supplier invoice number is accepted only with a reason (§15). ' +
        'Say why the same number is genuinely a second charge.',
    );
  }

  let order: typeof purchaseOrder.$inferSelect | undefined;
  if (input.purchaseOrderId) {
    [order] = await tx
      .select()
      .from(purchaseOrder)
      .where(eq(purchaseOrder.id, input.purchaseOrderId))
      .limit(1);
    if (!order) throw new Error(`No purchase order with id '${input.purchaseOrderId}'.`);
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.invoiceDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(apInvoice)
    .values({
      invoiceNo: allocated.documentNo,
      supplierInvoiceNo: input.supplierInvoiceNo.trim(),
      supplierId: input.supplierId,
      purchaseOrderId: input.purchaseOrderId ?? null,
      branchCode: input.branchCode,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      currency: input.currency ?? 'IQD',
      note: input.note ?? null,
      // The route this invoice took, recorded on the header so the §15 CHECK
      // can read one field rather than trust the application to have looked at
      // the lines.
      receivesOwnStock: receivesItsOwnStock,
      nonPoJustification: input.nonPoJustification?.trim() ?? null,
      nonPoApprovedBy: input.nonPoApprovedBy ?? null,
      nonPoApprovedAt: input.nonPoApprovedBy ? new Date() : null,
      duplicateApprovedBy: input.duplicateApprovedBy ?? null,
      duplicateApprovedAt: input.duplicateApprovedBy ? new Date() : null,
      duplicateApprovalReason: input.duplicateApprovalReason?.trim() ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: apInvoice.id });

  for (const [index, line] of input.lines.entries()) {
    let ordered: typeof purchaseOrderLine.$inferSelect | undefined;

    if (line.purchaseOrderLineId) {
      [ordered] = await tx
        .select()
        .from(purchaseOrderLine)
        .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
        .limit(1);

      if (!ordered || ordered.purchaseOrderId !== input.purchaseOrderId) {
        throw new Error(
          `That line does not belong to purchase order ${order?.orderNo ?? '(none)'}. An invoice covers one order.`,
        );
      }
    }

    const isInventory = ordered
      ? ordered.lineType === 'inventory_item'
      : (line.isInventory ?? false);

    const received = ordered
      ? await receivedQuantityFor(tx, ordered.id, isInventory)
      : 0n;

    if (ordered && received <= 0n) {
      throw new NothingReceivedError(order!.orderNo, ordered.lineNo, isInventory);
    }

    await tx.insert(apInvoiceLine).values({
      apInvoiceId: created!.id,
      lineNo: index + 1,
      purchaseOrderLineId: ordered?.id ?? null,
      itemCode: line.itemCode ?? ordered?.itemCode ?? null,
      description: line.description ?? ordered?.description ?? 'Charge',
      quantity: formatQuantity(line.quantity),
      uomCode: line.uomCode ?? ordered?.uomCode ?? 'EA',
      unitPrice: toDecimalString(line.unitPriceIqd, 4n),
      isInventory,
      costCentreCode: line.costCentreCode ?? ordered?.costCentreCode ?? null,
      warehouseCode: line.warehouseCode ?? null,
      discountIqd: toDecimalString(line.discountIqd ?? 0n, 4n),
      receivedQuantity: formatQuantity(received),
    });
  }

  const match = await rematch(tx, created!.id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      invoiceNo: allocated.documentNo,
      supplierInvoiceNo: input.supplierInvoiceNo,
      orderNo: order?.orderNo ?? null,
      lines: input.lines.length,
      matchStatus: match.status,
    },
    outcome: 'success',
  });

  return { id: created!.id, invoiceNo: allocated.documentNo, matchStatus: match.status };
}

/**
 * Runs the three-way match and records what it found.
 *
 * Open exceptions are replaced rather than added to, so re-matching a corrected
 * invoice clears what it fixed. Resolved ones are kept: they are the record of
 * a decision somebody made (§5.4), and a supplier whose invoices raise the same
 * exception every month is worth being able to see.
 */
export async function rematch(
  tx: Tx,
  id: string,
): Promise<{ status: MatchStatus; varianceValueIqd: bigint; exceptions: number }> {
  const { invoice, lines } = await load(tx, id);
  const tolerance = await toleranceFor(tx, invoice.supplierId);

  // §15's non-PO invoice has nothing to match against. It is not "matched" by
  // luck — it took the stronger route instead, and that is what stands in for
  // the match.
  if (!invoice.purchaseOrderId) {
    await tx
      .update(apInvoice)
      .set({ matchStatus: 'matched', varianceValueIqd: '0', updatedAt: new Date() })
      .where(eq(apInvoice.id, id));
    return { status: 'matched', varianceValueIqd: 0n, exceptions: 0 };
  }

  await tx
    .delete(apMatchException)
    .where(and(eq(apMatchException.apInvoiceId, id), isNull(apMatchException.resolvedAt)));

  const results: MatchResult[] = [];

  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue;

    const [ordered] = await tx
      .select()
      .from(purchaseOrderLine)
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
      .limit(1);
    if (!ordered) continue;

    const received = await receivedQuantityFor(tx, ordered.id, line.isInventory);

    const result = matchLine({
      ordered: {
        quantity: parseQuantity(ordered.quantity),
        unitPriceIqd: parseDecimal(ordered.unitPrice, 4n),
      },
      received: { quantity: received },
      invoiced: {
        quantity: parseQuantity(line.quantity),
        unitPriceIqd: parseDecimal(line.unitPrice, 4n),
      },
      // What earlier *posted* invoices already charged for this ordered line.
      // Three invoices of 40 against a delivery of 100 each look innocent and
      // together over-bill by 20.
      alreadyInvoiced: parseQuantity(ordered.invoicedQuantity),
      tolerance,
    });

    results.push(result);

    await tx
      .update(apInvoiceLine)
      .set({
        matchStatus: result.status,
        receivedQuantity: formatQuantity(received),
        varianceValueIqd: toDecimalString(result.varianceValueIqd, 4n),
      })
      .where(eq(apInvoiceLine.id, line.id));

    for (const variance of result.variances) {
      await tx.insert(apMatchException).values({
        apInvoiceId: id,
        apInvoiceLineId: line.id,
        kind: variance.kind,
        // Quantities and money are both stored at six places here so one column
        // can carry either; the kind says how to read it.
        expected: toDecimalString(variance.expected, variance.kind === 'quantity' ? 6n : 4n),
        actual: toDecimalString(variance.actual, variance.kind === 'quantity' ? 6n : 4n),
        difference: toDecimalString(variance.difference, variance.kind === 'quantity' ? 6n : 4n),
        reason: describeVariance(variance),
      });
    }
  }

  const document = matchDocument(results);

  await tx
    .update(apInvoice)
    .set({
      matchStatus: document.status,
      varianceValueIqd: toDecimalString(document.varianceValueIqd, 4n),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));

  return {
    status: document.status,
    varianceValueIqd: document.varianceValueIqd,
    exceptions: document.exceptionCount,
  };
}

/** §8.4 — the exception queue, with the reason. */
export async function exceptionQueue(tx: Tx, options: { includeResolved?: boolean } = {}) {
  const rows = await tx
    .select({
      id: apMatchException.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      kind: apMatchException.kind,
      expected: apMatchException.expected,
      actual: apMatchException.actual,
      difference: apMatchException.difference,
      reason: apMatchException.reason,
      raisedAt: apMatchException.raisedAt,
      resolution: apMatchException.resolution,
      resolutionReason: apMatchException.resolutionReason,
    })
    .from(apMatchException)
    .innerJoin(apInvoice, eq(apInvoice.id, apMatchException.apInvoiceId))
    .where(options.includeResolved ? undefined : isNull(apMatchException.resolvedAt))
    .orderBy(apMatchException.raisedAt);

  return rows;
}

/**
 * §8.4 — a manager accepts a variance, in writing.
 *
 * The reason is mandatory and stored. This is the whole of what "allowed only
 * after manager approval" means in practice: not that the system asked, but
 * that a named person said yes and said why, and it can be read back a year
 * later when the supplier disputes it.
 */
export async function approveVariance(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const { invoice } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (reason.trim().length === 0) {
    throw new Error(
      'Accepting a match variance needs a reason (§8.4, §5.4). ' +
        'Say what was agreed with the supplier, or why the difference is acceptable.',
    );
  }

  if (invoice.createdBy === ctx.principal.userId) {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'the person who entered an invoice cannot approve its variance — that is the separation the control depends on (§5.2).',
    );
  }

  const open = await tx
    .select({ id: apMatchException.id })
    .from(apMatchException)
    .where(and(eq(apMatchException.apInvoiceId, id), isNull(apMatchException.resolvedAt)));

  for (const exception of open) {
    await tx
      .update(apMatchException)
      .set({
        resolvedBy: ctx.principal.userId,
        resolvedAt: new Date(),
        resolution: 'approved',
        resolutionReason: reason.trim(),
      })
      .where(eq(apMatchException.id, exception.id));
  }

  await tx
    .update(apInvoice)
    .set({
      varianceApprovedBy: ctx.principal.userId,
      varianceApprovedAt: new Date(),
      varianceApprovalReason: reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.variance_approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    after: {
      exceptions: open.length,
      varianceValueIqd: invoice.varianceValueIqd,
    },
    reason: reason.trim(),
    outcome: 'success',
  });
}

export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { invoice } = await load(tx, id);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (invoice.status !== 'draft') {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'only a draft invoice can be submitted.',
    );
  }

  // Re-matched at submission: the receipts may have moved since the invoice was
  // keyed, and what is submitted for approval must be judged on what is true
  // now rather than on what was true then.
  await rematch(tx, id);

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'submitted');

  await tx
    .update(apInvoice)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(apInvoice.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
  });
}

/**
 * Posts the invoice — Appendix C.
 *
 * *"A/P Invoice – inventory | GRNI and approved variances | Supplier A/P."*
 * *"A/P Invoice – service/expense | Expense / Service Cost | Supplier A/P."*
 *
 * The debit side is deliberately split by line type and variance, because those
 * are three different accounts answering three different questions: GRNI is the
 * liability the receipt raised, expense is a cost, and the variance account is
 * the difference between what was agreed and what was charged. Rolling them
 * together would make the GRNI clearance approximate, and 05.5's gate asks for
 * it to be exact.
 */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string; varianceValueIqd: bigint }> {
  const { invoice, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (invoice.status !== 'submitted') {
    throw new ApInvoiceStateError(
      invoice.invoiceNo,
      invoice.status,
      'an invoice posts from submitted — it is entered, matched, then posted.',
    );
  }

  const open = await tx
    .select({ id: apMatchException.id })
    .from(apMatchException)
    .where(and(eq(apMatchException.apInvoiceId, id), isNull(apMatchException.resolvedAt)));

  if (open.length > 0) {
    throw new VarianceNotApprovedError(invoice.invoiceNo, open.length);
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, invoice.supplierId))
    .limit(1);

  const amount = (value: bigint) => toDecimalString(value < 0n ? -value : value, 4n);
  const criteria = { branchCode: invoice.branchCode };
  const base = { branch: invoice.branchCode, business_partner: supplier?.code ?? null };

  // Posted line by line rather than rolled up.
  //
  // §4.2 makes dimensions a property of the account *and* the line: an expense
  // account may require a department, and the department of a service is the
  // one that confirmed it (§8.6). Aggregating the debits would force one
  // department onto lines belonging to several, and the choice of which would
  // be arbitrary. It also makes the ledger readable — an entry that says which
  // line each figure came from.
  const postingLines: PostingLineRequest[] = [];
  let grniIqd = 0n;
  let expenseIqd = 0n;
  let varianceIqd = 0n;
  let payableIqd = 0n;

  for (const line of lines) {
    const invoicedValue = lineValue(line);
    payableIqd += invoicedValue;

    // What the receipt supports, at the ordered price — the figure the goods
    // receipt already put into GRNI, or the cost the service confirmation
    // evidenced. Anything above or below it is variance.
    // On the direct route there is nothing to vary from — see below.
    const supported = line.warehouseCode ? invoicedValue : await supportedValue(tx, line);
    const variance = invoicedValue - supported;
    varianceIqd += variance;

    const dimensions = {
      ...base,
      // The department that confirmed the service. Null for goods, which are
      // received by a warehouse rather than confirmed by a department.
      department: line.isInventory ? null : await confirmingDepartment(tx, line),
    };

    // ── The direct route (Operations block 4) ──────────────────────────
    //
    // A line that names a warehouse brings the goods in itself: no purchase
    // order, no goods receipt, nothing in GRNI to clear. The stock arrives at
    // what the invoice says it cost, and the debit goes to the item's own
    // inventory account — named on the item because two lines of one invoice
    // can belong to different stock accounts.
    //
    // There is no variance on this route, because there is nothing to vary
    // from: the invoice *is* the evidence. Falling through to the code below
    // would post the whole line to the purchase variance account, which is
    // what happened before this branch existed.
    if (line.warehouseCode) {
      const account = await inventoryAccountFor(tx, line);
      await inventory.receive(tx, ctx, {
        itemCode: line.itemCode!,
        warehouseCode: line.warehouseCode,
        branchCode: invoice.branchCode,
        quantity: parseQuantity(line.quantity),
        // A *unit* cost, and the discount is part of it: stock is worth what
        // was paid for it, not what was asked. The posted debit below is the
        // same money, so the warehouse and the ledger agree by construction
        // rather than by coincidence — see the rounding note in `unitCostOf`.
        unitCostIqd: unitCostOf(line, invoicedValue),
        // Whose stock this is. A sale that names this supplier will consume
        // these layers and no others — Operations block 5.
        supplierId: invoice.supplierId,
        movementDate: invoice.invoiceDate,
        kind: 'goods_receipt',
        sourceDocumentType: DOCUMENT_TYPE,
        sourceDocumentId: id,
        sourceLineId: line.id,
        ...(await batchFor(tx, line, invoice.invoiceNo)),
      });
      postingLines.push({
        role: 'inventory',
        accountId: account,
        debit: amount(invoicedValue),
        criteria: { ...criteria, warehouseCode: line.warehouseCode },
        dimensions,
      });
      continue;
    }

    if (supported !== 0n) {
      if (line.isInventory) {
        grniIqd += supported;
        postingLines.push({ role: 'grni', debit: amount(supported), criteria, dimensions });
      } else {
        expenseIqd += supported;
        postingLines.push({ role: 'expense', debit: amount(supported), criteria, dimensions });
      }
    }

    if (variance !== 0n) {
      // §8.4 — the variance posts to its own account, never into inventory. A
      // credit variance (the supplier charged less) debits nothing; it credits
      // the same account, which is why the sign is tested rather than assumed.
      postingLines.push(
        variance > 0n
          ? { role: 'purchase_variance', debit: amount(variance), criteria, dimensions }
          : { role: 'purchase_variance', credit: amount(variance), criteria, dimensions },
      );
    }
  }

  postingLines.push({
    role: 'supplier_payable',
    credit: amount(payableIqd),
    criteria,
    dimensions: base,
  });

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.ap_invoice',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'posted' },
    branchCode: invoice.branchCode,
    documentDate: invoice.invoiceDate,
    postingDate: invoice.invoiceDate,
    description: `A/P invoice ${invoice.invoiceNo} — ${supplier?.code ?? 'supplier'} ${invoice.supplierInvoiceNo}`,
    lines: postingLines,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, invoice.status, 'posted');

  // Goods that landed in the In Process warehouse are in process — Operations
  // block 8. Tracking opens by itself, because whether a shipment is tracked
  // is not a flag somebody sets and forgets: it is where the goods went. An
  // invoice whose goods went anywhere else arrived by other means and has
  // nothing to follow.
  await shipments.openForInvoice(tx, ctx, id);

  await tx
    .update(apInvoice)
    .set({
      status: 'posted',
      // Fixed here, with the lines, because everything downstream measures
      // against it: the ageing, the payment run, and what an advance may settle
      // (§8.5). A total that could drift from the lines would make all three
      // disagree about the same debt.
      totalIqd: toDecimalString(payableIqd, 4n),
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, id));

  // The ordered lines carry what has been invoiced, so 05.7's returns and
  // credit memos have something to reduce.
  for (const line of lines) {
    if (!line.purchaseOrderLineId) continue;
    await tx
      .update(purchaseOrderLine)
      .set({
        invoicedQuantity: sql`${purchaseOrderLine.invoicedQuantity} + ${line.quantity}`,
      })
      .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: invoice.branchCode,
    before: { status: 'submitted' },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      grniIqd: toDecimalString(grniIqd, 4n),
      expenseIqd: toDecimalString(expenseIqd, 4n),
      varianceIqd: toDecimalString(varianceIqd, 4n),
      payableIqd: toDecimalString(payableIqd, 4n),
    },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId, varianceValueIqd: varianceIqd };
}

/**
 * §8.6 — the department that confirmed this service line.
 *
 * The benefiting department is the meaningful analytical dimension for a
 * service cost: it is the department that asked for the work, said it was
 * delivered, and whose budget it belongs against. Read from the confirmation
 * rather than stated on the invoice, so Finance cannot key it differently from
 * the department that actually signed.
 */
async function confirmingDepartment(
  tx: Tx,
  line: typeof apInvoiceLine.$inferSelect,
): Promise<string | null> {
  if (!line.purchaseOrderLineId) return null;

  const [row] = await tx
    .select({ departmentCode: serviceReceipt.departmentCode })
    .from(serviceReceiptLine)
    .innerJoin(serviceReceipt, eq(serviceReceipt.id, serviceReceiptLine.serviceReceiptId))
    .where(
      and(
        eq(serviceReceiptLine.purchaseOrderLineId, line.purchaseOrderLineId),
        eq(serviceReceipt.status, 'approved'),
      ),
    )
    .limit(1);

  return row?.departmentCode ?? null;
}

/** The line's own money: invoiced quantity at the invoiced price. */
/**
 * What the line comes to: quantity x unit price, less the discount.
 *
 * Not stored. A stored total is one more thing that can disagree with its own
 * parts, and the parts are what the supplier and the company agreed.
 */
/**
 * The stock account this line's goods are held in — the item's own.
 *
 * §3.3 exists so "which account does a sale's revenue go to?" is
 * configuration; this is not that kind of question. Two lines of one invoice
 * can be different items in different stock accounts, and a posting rule
 * keyed on the warehouse would give both the same answer.
 */
async function inventoryAccountFor(
  tx: Tx,
  line: typeof apInvoiceLine.$inferSelect,
): Promise<string> {
  if (!line.itemCode) {
    throw new ApInvoiceLineError(line.lineNo, 'names a warehouse but no item, so nothing can be received into it.');
  }
  const [row] = await tx
    .select({ account: item.inventoryAccountId })
    .from(item)
    .where(eq(item.code, line.itemCode))
    .limit(1);
  if (!row?.account) {
    throw new ApInvoiceLineError(
      line.lineNo,
      `item ${line.itemCode} names no inventory account, so its stock has nowhere to be held. Set one on the item.`,
    );
  }
  return row.account;
}

/**
 * How stock arriving on an invoice is identified.
 *
 * §9.3 tracks every stock item, by batch or by serial, and the sponsor's
 * Purchase Invoice line carries neither — quantity, price, discount and a
 * warehouse, and that is all.
 *
 * For a batch, the invoice number *is* the batch. One delivery from one
 * supplier on one document is one batch in every sense that matters, and it
 * makes the stock traceable back to the paper that brought it in, which is
 * what tracking is for.
 *
 * A serial cannot be invented the same way. Ten panels need ten serials, and
 * nothing on the invoice says what they are. Those goods come in through a
 * Goods Receipt, where each one is read off the box.
 */
async function batchFor(
  tx: Tx,
  line: typeof apInvoiceLine.$inferSelect,
  invoiceNo: string,
): Promise<{ batchNumber?: string }> {
  const [row] = await tx
    .select({ tracking: item.tracking })
    .from(item)
    .where(eq(item.code, line.itemCode!))
    .limit(1);

  if (row?.tracking === 'serial' || row?.tracking === 'serial_and_batch') {
    throw new ApInvoiceLineError(
      line.lineNo,
      `item ${line.itemCode} is tracked by serial number, which an invoice does not carry. Receive it on a Goods Receipt, where each serial is recorded.`,
    );
  }
  return row?.tracking === 'batch' ? { batchNumber: invoiceNo } : {};
}

/**
 * What one unit of this line costs, net of its discount.
 *
 * Rounding is the thing to be careful of. Three units at a line value of ten
 * is 3.3333 each, and three layers of 3.3333 are worth 9.9999 — a dinar less
 * than the ledger was told. The layer is therefore valued at the quotient and
 * the statement is what it is: for the quantities and prices this document
 * deals in, held to four decimal places, the difference is below the smallest
 * unit the ledger records. `ops04` asserts the two agree on a line that does
 * not divide evenly, which is what would catch it if that ever stopped being
 * true.
 */
function unitCostOf(line: typeof apInvoiceLine.$inferSelect, value: bigint): bigint {
  const quantity = parseQuantity(line.quantity);
  if (quantity === 0n) return 0n;
  // Quantities carry six decimal places, money four.
  return (value * 1_000_000n) / quantity;
}

function lineValue(line: typeof apInvoiceLine.$inferSelect): bigint {
  const gross = (parseQuantity(line.quantity) * parseDecimal(line.unitPrice, 4n)) / 1_000_000n;
  return gross - parseDecimal(line.discountIqd ?? '0', 4n);
}

/**
 * What the receipt evidence supports for this line, at the *ordered* price.
 *
 * For an inventory line this is exactly what the goods receipt debited to
 * inventory and credited to GRNI, which is what makes the GRNI clearance exact
 * rather than approximate — 05.5's gate.
 *
 * Capped at the invoiced quantity: invoicing 40 of 100 received clears 40 units
 * of GRNI, not 100. The rest waits for the next invoice.
 */
async function supportedValue(tx: Tx, line: typeof apInvoiceLine.$inferSelect): Promise<bigint> {
  if (!line.purchaseOrderLineId) return lineValue(line);

  const [ordered] = await tx
    .select()
    .from(purchaseOrderLine)
    .where(eq(purchaseOrderLine.id, line.purchaseOrderLineId))
    .limit(1);
  if (!ordered) return lineValue(line);

  // What this invoice is entitled to clear: what it bills, capped by what is
  // still uninvoiced of what arrived. The same figure the domain calls
  // `entitled`, and it has to be the same or the ledger and the match would
  // disagree about the size of the variance.
  const received = parseQuantity(line.receivedQuantity);
  const already = parseQuantity(ordered.invoicedQuantity);
  const uninvoiced = received - already > 0n ? received - already : 0n;
  const invoiced = parseQuantity(line.quantity);
  const clearing = invoiced < uninvoiced ? invoiced : uninvoiced;

  return (clearing * parseDecimal(ordered.unitPrice, 4n)) / 1_000_000n;
}

/**
 * The register — Operations block 4's list of Purchase Invoices.
 *
 * The supplier's name is joined rather than stored on the invoice, so a
 * supplier renamed today reads correctly on an invoice raised last year. Row
 * level security decides which branches are in the list; this does not filter
 * by branch itself, because doing it in two places is how the two answers
 * start to differ.
 */
export async function list(tx: Tx) {
  return tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
      invoiceDate: apInvoice.invoiceDate,
      dueDate: apInvoice.dueDate,
      totalIqd: apInvoice.totalIqd,
      status: apInvoice.status,
      branchCode: apInvoice.branchCode,
    })
    .from(apInvoice)
    .leftJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .orderBy(desc(apInvoice.invoiceDate), desc(apInvoice.invoiceNo));
}

/**
 * The invoice a person is looking at, found by the number on it.
 *
 * The screens address an invoice by its number rather than its id, because the
 * number is what the document says and what somebody would read out over the
 * phone.
 */
export async function viewByNo(tx: Tx, invoiceNo: string) {
  const [row] = await tx
    .select({ id: apInvoice.id })
    .from(apInvoice)
    .where(eq(apInvoice.invoiceNo, invoiceNo))
    .limit(1);
  if (!row) return null;
  return load(tx, row.id);
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/** §8.4 — match status, for the screen that must show it at all times. */
export async function matchStatusOf(tx: Tx, id: string) {
  const { invoice, lines } = await load(tx, id);
  return {
    status: invoice.matchStatus,
    varianceValueIqd: parseDecimal(invoice.varianceValueIqd, 4n),
    approvedBy: invoice.varianceApprovedBy,
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      status: line.matchStatus,
      receivedQuantity: parseQuantity(line.receivedQuantity),
      invoicedQuantity: parseQuantity(line.quantity),
      varianceValueIqd: parseDecimal(line.varianceValueIqd, 4n),
    })),
  };
}

/** §8.4 — configure the match tolerance. Finance's decision, not the clerk's. */
export async function setTolerance(
  tx: Tx,
  ctx: ActorContext,
  input: {
    supplierId?: string | null;
    quantityPercent?: string;
    pricePercent?: string;
    valuePercent?: string;
    note?: string | null;
  },
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const supplierId = input.supplierId ?? null;
  const values = {
    quantityPercent: input.quantityPercent ?? '0',
    pricePercent: input.pricePercent ?? '0',
    valuePercent: input.valuePercent ?? '0',
    note: input.note ?? null,
    updatedBy: ctx.principal.userId,
    updatedAt: new Date(),
  };

  const existing = supplierId
    ? await tx
        .select({ id: apMatchTolerance.id })
        .from(apMatchTolerance)
        .where(eq(apMatchTolerance.supplierId, supplierId))
        .limit(1)
    : await tx
        .select({ id: apMatchTolerance.id })
        .from(apMatchTolerance)
        .where(isNull(apMatchTolerance.supplierId))
        .limit(1);

  if (existing[0]) {
    await tx.update(apMatchTolerance).set(values).where(eq(apMatchTolerance.id, existing[0].id));
  } else {
    await tx.insert(apMatchTolerance).values({ supplierId, ...values });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.tolerance_set',
    objectType: PERMISSION_OBJECT,
    objectId: existing[0]?.id ?? null,
    branchCode: ctx.branchCode,
    after: { supplierId, ...values, updatedAt: undefined },
    outcome: 'success',
  });
}
