/**
 * Sales Return — Phase 06.9, §7.5.
 *
 * > *"A/R Invoice → Sales Return / Goods Return from Customer → Inspection →
 * > Saleable Warehouse, Quarantine Warehouse or Damaged Goods Warehouse →
 * > Customer Credit Memo."*
 *
 * **There is no exchange in this file, and that is the point.** §7.5:
 * *"Product exchange is not supported. Replacement requires a new Sales
 * Order."* So there is no `exchange`, no `replace`, and no input anywhere that
 * names a replacement item. A function that refused exchanges would be a
 * function somebody could work around; a capability that was never built cannot
 * be reached by any route, which is the same reasoning that keeps a unit price
 * off the Sales Order (§7.3).
 *
 * **Where the stock movement happens: at acceptance, not at receipt.**
 *
 * A customer's carton arriving at the gate is not yet company stock — it is
 * goods on an inspection bench that the company has not agreed to take back. So
 * *Received* records that they arrived and moves nothing, and *Accepted* makes
 * the single movement into whichever warehouse the inspection routed them to.
 *
 * The alternative — a movement at receipt into a returns location, then a
 * transfer at inspection — is defensible and worse in one specific way: a
 * **rejected** return would then need a reversing movement to undo stock the
 * company never accepted, and reversals of things that should not have happened
 * are exactly the entries that confuse a ledger years later. Here a rejected
 * return never touches the ledger at all.
 *
 * **Valued at the original cost.** Appendix C values a return at what the goods
 * left at, and the Delivery Note recorded that. Valuing at today's cost would
 * move the difference into gross margin, where nobody would look for it.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  arInvoiceLine,
  bankCashAccount,
  businessPartner,
  deliveryNoteLine,
  inventoryMovement,
  deliveryNoteLineUnit,
  salesOrder,
  salesReturn,
  salesReturnLine,
  warehouse,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertDestinationMatches,
  assertWithinInvoiced,
  originalUnitCost,
  returnCostFor,
  type ReturnDisposition,
} from '../domain/sales-return';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'sales_return';
export const DOCUMENT_TYPE = 'sales_return';
const SEQUENCE_KEY = 'SALES_RETURN';

export class InvoiceNotReturnableError extends Error {
  readonly code = 'INVOICE_NOT_RETURNABLE';

  constructor(
    readonly invoiceNo: string,
    readonly status: string,
  ) {
    super(
      `Invoice ${invoiceNo} is '${status}'. Appendix C requires an accepted return to name a source ` +
        'invoice, and an invoice that has not posted has not yet billed the customer for anything ' +
        'to send back.',
    );
    this.name = 'InvoiceNotReturnableError';
  }
}

// ---------------------------------------------------------------------------
// Request — Appendix B's *Requested*
// ---------------------------------------------------------------------------

/**
 * Which side the credit lands on. `'receivable'` reduces what the customer
 * owes; `'bank'` hands the money back out of a named bank or cash account.
 */
export type OffsetKind = 'receivable' | 'bank';

export class OffsetAccountError extends Error {
  readonly code = 'OFFSET_ACCOUNT_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'OffsetAccountError';
  }
}

export interface RequestReturnInput {
  readonly arInvoiceId: string;
  readonly requestedOn: string;
  readonly reason: string;
  /**
   * The sponsor's *"Offset Account (Accounts Receivable or Bank — one must be
   * selected)"*. No default: the two settle differently and guessing leaves
   * either a receivable the customer does not owe or cash the company still
   * has.
   */
  readonly offsetKind: OffsetKind;
  /** Required when `offsetKind` is 'bank', refused otherwise. */
  readonly offsetBankAccountId?: string | null;
  readonly note?: string | null;
  readonly lines: readonly {
    readonly arInvoiceLineId: string;
    readonly quantity: bigint;
  }[];
}

/**
 * Reads the offset choice, and refuses the two shapes the CHECK would refuse
 * anyway — here, so the person gets a sentence instead of a constraint name.
 */
async function resolveOffset(
  tx: Tx,
  input: Pick<RequestReturnInput, 'offsetKind' | 'offsetBankAccountId'>,
): Promise<{ offsetKind: OffsetKind; offsetBankAccountId: string | null }> {
  if (input.offsetKind === 'receivable') {
    if (input.offsetBankAccountId) {
      throw new OffsetAccountError(
        'A return offset to Accounts Receivable credits the customer, not a bank account. ' +
          'Choose Bank if the money is going back to them.',
      );
    }
    return { offsetKind: 'receivable', offsetBankAccountId: null };
  }

  if (!input.offsetBankAccountId) {
    throw new OffsetAccountError(
      'A return offset to Bank must name which bank or cash account the refund comes out of.',
    );
  }

  const [account] = await tx
    .select({ id: bankCashAccount.id, active: bankCashAccount.active })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.offsetBankAccountId))
    .limit(1);

  if (!account) {
    throw new OffsetAccountError(
      `No bank or cash account with id '${input.offsetBankAccountId}'.`,
    );
  }
  if (!account.active) {
    throw new OffsetAccountError(
      'That bank or cash account is closed. A refund cannot be paid out of it.',
    );
  }

  return { offsetKind: 'bank', offsetBankAccountId: account.id };
}

export async function request(
  tx: Tx,
  ctx: ActorContext,
  input: RequestReturnInput,
): Promise<{ id: string; returnNo: string }> {
  const [invoice] = await tx
    .select()
    .from(arInvoice)
    .where(eq(arInvoice.id, input.arInvoiceId))
    .limit(1);

  if (!invoice) throw new Error(`No A/R invoice with id '${input.arInvoiceId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: invoice.branchCode,
  });

  if (!['posted', 'partially_executed', 'settled'].includes(invoice.status)) {
    throw new InvoiceNotReturnableError(invoice.invoiceNo, invoice.status);
  }

  if (input.lines.length === 0) {
    throw new Error(
      'A sales return with no lines records nothing coming back. Say what is being returned, or do not raise it.',
    );
  }

  if (!input.reason.trim()) {
    throw new Error(
      'A sales return states why the customer is returning the goods. It decides whether the ' +
        'company accepts it, and it is the only record of the reason a year later (§5.4).',
    );
  }

  const offset = await resolveOffset(tx, input);

  const returnedSoFar = await returnedAgainst(
    tx,
    input.lines.map((line) => line.arInvoiceLineId),
  );

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: invoice.branchCode, year: Number(input.requestedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(salesReturn)
    .values({
      returnNo: allocated.documentNo,
      arInvoiceId: input.arInvoiceId,
      customerId: invoice.customerId,
      branchCode: invoice.branchCode,
      requestedOn: input.requestedOn,
      reason: input.reason.trim(),
      offsetKind: offset.offsetKind,
      offsetBankAccountId: offset.offsetBankAccountId,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: salesReturn.id });

  for (const [index, line] of input.lines.entries()) {
    const [invoiceLine] = await tx
      .select()
      .from(arInvoiceLine)
      .where(eq(arInvoiceLine.id, line.arInvoiceLineId))
      .limit(1);

    if (!invoiceLine || invoiceLine.arInvoiceId !== input.arInvoiceId) {
      throw new Error(
        `Line '${line.arInvoiceLineId}' is not on invoice ${invoice.invoiceNo}. ` +
          'A return reconciles to the invoice it names (§7.5).',
      );
    }

    // §7.5 — *"return quantity cannot exceed invoiced quantity less previous
    // accepted returns."*
    assertWithinInvoiced(
      invoiceLine.itemCode,
      {
        invoiced: parseQuantity(invoiceLine.quantity),
        alreadyReturned: returnedSoFar.get(line.arInvoiceLineId) ?? 0n,
      },
      line.quantity,
    );

    await tx.insert(salesReturnLine).values({
      salesReturnId: created!.id,
      lineNo: index + 1,
      arInvoiceLineId: line.arInvoiceLineId,
      // Null when the invoice sold the stock itself — Operations block 5.
      deliveryNoteLineId: invoiceLine.deliveryNoteLineId ?? null,
      itemCode: invoiceLine.itemCode,
      description: invoiceLine.description,
      uomCode: invoiceLine.uomCode,
      requestedQuantity: formatQuantity(line.quantity),
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_return.requested',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: invoice.branchCode,
    outcome: 'success',
    after: {
      returnNo: allocated.documentNo,
      invoiceNo: invoice.invoiceNo,
      reason: input.reason.trim(),
      lines: input.lines.length,
    },
  });

  return { id: created!.id, returnNo: allocated.documentNo };
}

/**
 * How much of each invoice line earlier returns have already **accepted**.
 *
 * Rejected returns do not count: those goods went back to the customer, so they
 * are still the customer's to return again. Counting them would let one refused
 * claim block a legitimate second attempt at the same units.
 */
async function returnedAgainst(tx: Tx, arInvoiceLineIds: readonly string[]) {
  if (arInvoiceLineIds.length === 0) return new Map<string, bigint>();

  const rows = await tx
    .select({
      arInvoiceLineId: salesReturnLine.arInvoiceLineId,
      accepted: sql<string>`sum(coalesce(${salesReturnLine.acceptedQuantity}, ${salesReturnLine.requestedQuantity}))`,
    })
    .from(salesReturnLine)
    .innerJoin(salesReturn, eq(salesReturn.id, salesReturnLine.salesReturnId))
    .where(
      and(
        inArray(salesReturnLine.arInvoiceLineId, [...arInvoiceLineIds]),
        ne(salesReturn.status, 'rejected'),
      ),
    )
    .groupBy(salesReturnLine.arInvoiceLineId);

  return new Map(rows.map((r) => [r.arInvoiceLineId, parseQuantity(r.accepted ?? '0')]));
}

// ---------------------------------------------------------------------------
// Receive — Appendix B's *Received*. Nothing moves yet; see the file note.
// ---------------------------------------------------------------------------

/** What a line cost when it shipped on a Delivery Note. */
async function deliveredUnitCost(
  tx: Tx,
  line: { itemCode: string; deliveryNoteLineId: string | null },
): Promise<bigint> {
  const [delivered] = await tx
    .select()
    .from(deliveryNoteLine)
    .where(eq(deliveryNoteLine.id, line.deliveryNoteLineId!))
    .limit(1);

  return originalUnitCost({
    itemCode: line.itemCode,
    deliveredQuantity: parseQuantity(delivered!.quantity),
    deliveredCogsIqd: parseDecimal(delivered!.cogsIqd, 4n),
  });
}

/**
 * What a line cost when the invoice sold it directly.
 *
 * Read from the layers that invoice's own issue consumed, which is the same
 * FIFO cost it charged to COGS — so a return credits exactly what the sale
 * charged, and the two cancel to nothing when everything comes back.
 */
async function invoicedUnitCost(
  tx: Tx,
  line: { itemCode: string; arInvoiceLineId: string },
): Promise<bigint> {
  const [movement] = await tx
    .select({ id: inventoryMovement.id })
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.sourceDocumentType, 'ar_invoice'),
        eq(inventoryMovement.sourceLineId, line.arInvoiceLineId),
      ),
    )
    .limit(1);

  if (!movement) {
    throw new Error(
      `Invoice line ${line.arInvoiceLineId} moved no stock, so a return of ${line.itemCode} has no cost to take.`,
    );
  }

  const consumed = await inventory.consumptionsOf(tx, movement.id);
  const quantity = consumed.reduce((total, row) => total + parseQuantity(row.quantity), 0n);
  const cost = consumed.reduce((total, row) => total + parseDecimal(row.costIqd, 4n), 0n);
  return quantity === 0n ? 0n : (cost * 1_000_000n) / quantity;
}

export async function receiveGoods(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    readonly receivedOn: string;
    readonly lines: readonly { readonly salesReturnLineId: string; readonly quantity: bigint }[];
  },
): Promise<void> {
  const returnDoc = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: returnDoc.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, returnDoc.status, 'partially_executed');

  const reported = new Map(input.lines.map((line) => [line.salesReturnLineId, line.quantity]));

  const lines = await tx
    .select()
    .from(salesReturnLine)
    .where(eq(salesReturnLine.salesReturnId, id))
    .orderBy(salesReturnLine.lineNo);

  for (const line of lines) {
    // A line the customer did not actually send is received as zero, not left
    // null: null means "not yet looked at", and the warehouse has now looked.
    const quantity = reported.get(line.id) ?? 0n;

    await tx
      .update(salesReturnLine)
      .set({ receivedQuantity: formatQuantity(quantity) })
      .where(eq(salesReturnLine.id, line.id));
  }

  await tx
    .update(salesReturn)
    .set({
      status: 'partially_executed',
      receivedOn: input.receivedOn,
      receivedBy: ctx.principal.userId,
      receivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(salesReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_return.received',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: returnDoc.branchCode,
    outcome: 'success',
    before: { status: returnDoc.status },
    after: { status: 'partially_executed', receivedOn: input.receivedOn },
  });
}

// ---------------------------------------------------------------------------
// Inspect — Appendix B's *Inspected*. §7.5's three destinations.
// ---------------------------------------------------------------------------

export interface InspectionInput {
  readonly salesReturnLineId: string;
  readonly acceptedQuantity: bigint;
  readonly disposition: ReturnDisposition;
  readonly destinationWarehouseCode: string;
  readonly note?: string | null;
  /**
   * §9.9 — which units came back, where the delivery carried more than one
   * identity. Left out, the delivery's own single identity is used.
   */
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
}

/**
 * Records what the inspection found, and where the goods are going.
 *
 * Still no movement — the routing is decided here and acted on at acceptance,
 * so an inspection that is later overruled has moved nothing.
 */
export async function inspect(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  inspections: readonly InspectionInput[],
): Promise<void> {
  const returnDoc = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: returnDoc.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, returnDoc.status, 'executed');

  for (const inspection of inspections) {
    const [line] = await tx
      .select()
      .from(salesReturnLine)
      .where(eq(salesReturnLine.id, inspection.salesReturnLineId))
      .limit(1);

    if (!line || line.salesReturnId !== id) {
      throw new Error(
        `Line '${inspection.salesReturnLineId}' is not on return ${returnDoc.returnNo}.`,
      );
    }

    const [store] = await tx
      .select({ code: warehouse.code, type: warehouse.warehouseType })
      .from(warehouse)
      .where(eq(warehouse.code, inspection.destinationWarehouseCode))
      .limit(1);

    if (!store) throw new Error(`No warehouse '${inspection.destinationWarehouseCode}'.`);

    // §7.5 and §9.8 — damaged goods must land somewhere they cannot be sold
    // from, and that guarantee is worth exactly as much as this check.
    assertDestinationMatches(inspection.disposition, store.code, store.type);

    // The cost the goods left at — Appendix C's original FIFO cost.
    //
    // Two ways in, because there are two ways out. Goods that shipped on a
    // Delivery Note carry their cost on that line. An invoice that sold the
    // stock itself (Operations block 5) has no delivery, and the sponsor says
    // where to look instead: "the Inventory and COGS amounts for each returned
    // item are taken from the original Sales Invoice item cost" — which is
    // what its own issue consumed.
    const unitCost = line.deliveryNoteLineId
      ? await deliveredUnitCost(tx, line)
      : await invoicedUnitCost(tx, line);

    // §9.9 — which units came back. Taken from what the delivery said left,
    // because that is the chain: a return that invented its own serial would
    // break the trace at its last link, and a tracked item cannot move without
    // one at all (§9.3). On a direct sale nothing was scanned, and the identity
    // comes from the stock the invoice consumed.
    const identity = await identityFor(
      tx,
      line.deliveryNoteLineId,
      line.arInvoiceLineId,
      inspection,
    );

    await tx
      .update(salesReturnLine)
      .set({
        acceptedQuantity: formatQuantity(inspection.acceptedQuantity),
        serialNumber: identity.serialNumber,
        batchNumber: identity.batchNumber,
        disposition: inspection.disposition,
        destinationWarehouseCode: inspection.destinationWarehouseCode,
        inspectionNote: inspection.note ?? null,
        originalUnitCostIqd: toDecimalString(unitCost, 4n),
      })
      .where(eq(salesReturnLine.id, line.id));
  }

  await tx
    .update(salesReturn)
    .set({
      status: 'executed',
      inspectedBy: ctx.principal.userId,
      inspectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(salesReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_return.inspected',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: returnDoc.branchCode,
    outcome: 'success',
    before: { status: returnDoc.status },
    after: {
      status: 'executed',
      dispositions: inspections.map((i) => ({
        line: i.salesReturnLineId,
        disposition: i.disposition,
        warehouse: i.destinationWarehouseCode,
        accepted: formatQuantity(i.acceptedQuantity),
      })),
    },
  });
}

/**
 * Which units came back — §9.9.
 *
 * Read from the source Delivery Note's identified units rather than taken from
 * the inspector, because those are the units the chain says left. Where the
 * delivery carried exactly one identity the answer is unambiguous and is used;
 * where it carried several the inspector must say which came back, and is asked
 * rather than guessed at. A wrong batch on a return is a wrong batch in a recall.
 */
/**
 * The units a direct Sales Invoice took out of stock, read from the layers it
 * consumed back to the receipts that created them.
 *
 * One batch is the ordinary case and is used. Several means the sale drew on
 * more than one receipt, and then nobody can say which of them came back — the
 * inspector is asked, exactly as they are when a delivery carried several.
 */
async function identityFromInvoice(
  tx: Tx,
  arInvoiceLineId: string,
): Promise<{ serialNumber: string | null; batchNumber: string | null }> {
  const [movement] = await tx
    .select({ id: inventoryMovement.id })
    .from(inventoryMovement)
    .where(
      and(
        eq(inventoryMovement.sourceDocumentType, 'ar_invoice'),
        eq(inventoryMovement.sourceLineId, arInvoiceLineId),
      ),
    )
    .limit(1);

  if (!movement) return { serialNumber: null, batchNumber: null };

  const consumed = await inventory.consumptionsOf(tx, movement.id);
  if (consumed.length === 0) return { serialNumber: null, batchNumber: null };

  const origins = await tx
    .select({
      serialNumber: inventoryMovement.serialNumber,
      batchNumber: inventoryMovement.batchNumber,
    })
    .from(inventoryMovement)
    .where(
      inArray(
        inventoryMovement.id,
        consumed.map((row) => row.createdByMovementId),
      ),
    );

  const serials = new Set(origins.map((o) => o.serialNumber).filter(Boolean));
  const batches = new Set(origins.map((o) => o.batchNumber).filter(Boolean));

  if (serials.size > 1 || batches.size > 1) {
    throw new Error(
      'The invoice sold stock from more than one batch, so the inspection must say which units ' +
        'came back. Guessing would put the wrong identity on a return, and the wrong units in a ' +
        'recall (§9.9).',
    );
  }

  return { serialNumber: [...serials][0] ?? null, batchNumber: [...batches][0] ?? null };
}

async function identityFor(
  tx: Tx,
  /** Null when the invoice sold the stock itself and nothing was scanned out. */
  deliveryNoteLineId: string | null,
  arInvoiceLineId: string,
  inspection: InspectionInput,
): Promise<{ serialNumber: string | null; batchNumber: string | null }> {
  if (inspection.serialNumber || inspection.batchNumber) {
    return {
      serialNumber: inspection.serialNumber ?? null,
      batchNumber: inspection.batchNumber ?? null,
    };
  }

  // On a direct sale nothing was scanned out — Operations block 5 — so the
  // identity comes from the stock the invoice actually consumed. Same source as
  // the cost, and for the same reason: a return follows its original invoice
  // rather than asking somebody to retype what the invoice already recorded.
  // Block 9's lines are item, quantity, price and warehouse; a batch the
  // sponsor never asked for must not be what stops a return from being taken.
  if (!deliveryNoteLineId) return identityFromInvoice(tx, arInvoiceLineId);

  const units = await tx
    .select()
    .from(deliveryNoteLineUnit)
    .where(eq(deliveryNoteLineUnit.deliveryNoteLineId, deliveryNoteLineId));

  if (units.length === 0) return { serialNumber: null, batchNumber: null };

  const serials = new Set(units.map((u) => u.serialNumber).filter(Boolean));
  const batches = new Set(units.map((u) => u.batchNumber).filter(Boolean));

  if (serials.size > 1 || batches.size > 1) {
    throw new Error(
      'The delivery carried more than one serial or batch, so the inspection must say which units ' +
        'came back. Guessing would put the wrong identity on a return, and the wrong units in a ' +
        'recall (§9.9).',
    );
  }

  return {
    serialNumber: [...serials][0] ?? null,
    batchNumber: [...batches][0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Accept — Appendix B's *Accepted*. The stock moves and Dr Inventory / Cr COGS.
// ---------------------------------------------------------------------------

export async function accept(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ movementIds: string[]; valueIqd: bigint }> {
  const returnDoc = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: returnDoc.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, returnDoc.status, 'approved');

  const lines = await tx
    .select()
    .from(salesReturnLine)
    .where(eq(salesReturnLine.salesReturnId, id))
    .orderBy(salesReturnLine.lineNo);

  // §4.2 — the dimensions the sale carried, so the return reports beside it.
  const [sale] = await tx
    .select({
      departmentCode: salesOrder.departmentCode,
      businessLineCode: salesOrder.businessLineCode,
    })
    .from(salesOrder)
    .innerJoin(arInvoice, eq(arInvoice.salesOrderId, salesOrder.id))
    .where(eq(arInvoice.id, returnDoc.arInvoiceId))
    .limit(1);

  const movementIds: string[] = [];
  let valueIqd = 0n;

  for (const line of lines) {
    const accepted = parseQuantity(line.acceptedQuantity ?? '0');
    if (accepted <= 0n) continue;

    if (!line.destinationWarehouseCode || !line.disposition) {
      throw new Error(
        `Line ${line.lineNo} of ${returnDoc.returnNo} was accepted without an inspection. ` +
          '§7.5 routes goods to a saleable, quarantine or damaged location, and nobody has said which.',
      );
    }

    const unitCost = parseDecimal(line.originalUnitCostIqd ?? '0', 4n);
    const lineValue = returnCostFor({ unitCostIqd: unitCost, quantity: accepted });

    // Appendix C's stock half: Dr Inventory / Cr COGS, at the original cost.
    // The posting effect is configured in `services/inventory.ts` under the
    // `sales_return` kind, so the accounts come from the §3.3 mappings like
    // every other movement's.
    const movement = await inventory.receive(
      tx,
      { principal: ctx.principal, branchCode: returnDoc.branchCode },
      {
        itemCode: line.itemCode,
        warehouseCode: line.destinationWarehouseCode,
        branchCode: returnDoc.branchCode,
        quantity: accepted,
        unitCostIqd: unitCost,
        movementDate: returnDoc.receivedOn ?? returnDoc.requestedOn,
        kind: 'sales_return',
        serialNumber: line.serialNumber,
        batchNumber: line.batchNumber,
        sourceDocumentType: DOCUMENT_TYPE,
        sourceDocumentId: id,
        sourceLineId: line.id,
        post: true,
        // §4.2 — the sale's own dimensions, so the credit lands in the same
        // P&L line the revenue and the cost did. Read from the order behind the
        // invoice rather than chosen here: a return reported under a different
        // business line would leave both lines wrong.
        dimensions: {
          branch: returnDoc.branchCode,
          department: sale?.departmentCode ?? null,
          business_line: sale?.businessLineCode ?? null,
        },
      },
    );

    movementIds.push(movement.movementId);
    valueIqd += lineValue;

    await tx
      .update(salesReturnLine)
      .set({ inventoryMovementId: movement.movementId })
      .where(eq(salesReturnLine.id, line.id));
  }

  await tx
    .update(salesReturn)
    .set({
      status: 'approved',
      acceptedBy: ctx.principal.userId,
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(salesReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_return.accepted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: returnDoc.branchCode,
    outcome: 'success',
    before: { status: returnDoc.status },
    after: {
      status: 'approved',
      movements: movementIds.length,
      valueIqd: toDecimalString(valueIqd, 4n),
    },
  });

  return { movementIds, valueIqd };
}

/**
 * Refuses a return — Appendix B's *Rejected*.
 *
 * Nothing has moved, so nothing is undone: the goods were never company stock.
 * That is the whole reason the movement waits for acceptance.
 */
export async function reject(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const returnDoc = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: returnDoc.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, returnDoc.status, 'rejected', reason);

  await tx
    .update(salesReturn)
    .set({
      status: 'rejected',
      rejectedBy: ctx.principal.userId,
      rejectedAt: new Date(),
      rejectionReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(salesReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_return.rejected',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: returnDoc.branchCode,
    outcome: 'success',
    reason,
    before: { status: returnDoc.status },
    after: { status: 'rejected' },
  });
}

export async function close(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const returnDoc = await load(tx, id);

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, returnDoc.status, 'closed');

  await tx
    .update(salesReturn)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(salesReturn.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'sales_return.closed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: returnDoc.branchCode,
    outcome: 'success',
    before: { status: returnDoc.status },
    after: { status: 'closed' },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [returnDoc] = await tx
    .select()
    .from(salesReturn)
    .where(eq(salesReturn.id, id))
    .limit(1);
  if (!returnDoc) throw new Error(`No sales return with id '${id}'.`);
  return returnDoc;
}

/** The register — Operations block 9's list of Sales Returns. */
export async function list(tx: Tx) {
  return tx
    .select({
      id: salesReturn.id,
      returnNo: salesReturn.returnNo,
      customerName: businessPartner.legalName,
      customerCode: businessPartner.code,
      invoiceNo: arInvoice.invoiceNo,
      requestedOn: salesReturn.requestedOn,
      offsetKind: salesReturn.offsetKind,
      status: salesReturn.status,
      branchCode: salesReturn.branchCode,
    })
    .from(salesReturn)
    .leftJoin(businessPartner, eq(businessPartner.id, salesReturn.customerId))
    .leftJoin(arInvoice, eq(arInvoice.id, salesReturn.arInvoiceId))
    .orderBy(desc(salesReturn.requestedOn), desc(salesReturn.returnNo));
}

/** The return a person is looking at, found by the number printed on it. */
export async function viewByNo(tx: Tx, returnNo: string) {
  const [row] = await tx
    .select({ id: salesReturn.id })
    .from(salesReturn)
    .where(eq(salesReturn.returnNo, returnNo))
    .limit(1);
  if (!row) return null;
  return view(tx, row.id);
}

/** Posted invoices a return can be raised against, newest first. */
export async function returnableInvoices(tx: Tx) {
  return tx
    .select({
      id: arInvoice.id,
      invoiceNo: arInvoice.invoiceNo,
      invoiceDate: arInvoice.invoiceDate,
      customerName: businessPartner.legalName,
      customerCode: businessPartner.code,
    })
    .from(arInvoice)
    .leftJoin(businessPartner, eq(businessPartner.id, arInvoice.customerId))
    .where(inArray(arInvoice.status, ['posted', 'partially_executed', 'settled']))
    .orderBy(desc(arInvoice.invoiceDate));
}

export async function view(tx: Tx, id: string) {
  const returnDoc = await load(tx, id);
  const lines = await tx
    .select()
    .from(salesReturnLine)
    .where(eq(salesReturnLine.salesReturnId, id))
    .orderBy(salesReturnLine.lineNo);

  return { ...returnDoc, lines };
}

/** What is still returnable on an invoice — for the return screen. */
export async function returnableFor(tx: Tx, arInvoiceId: string) {
  const result = await tx.execute(sql`
    select l.id::text                                     as "arInvoiceLineId",
           l.line_no                                      as "lineNo",
           l.item_code                                    as "itemCode",
           l.quantity::text                               as "invoiced",
           coalesce((select sum(coalesce(rl.accepted_quantity, rl.requested_quantity))
                       from sales_return_line rl
                       join sales_return r on r.id = rl.sales_return_id
                      where rl.ar_invoice_line_id = l.id
                        and r.status <> 'rejected'), 0)::text as "returned",
           greatest(l.quantity - coalesce((select sum(coalesce(rl.accepted_quantity, rl.requested_quantity))
                       from sales_return_line rl
                       join sales_return r on r.id = rl.sales_return_id
                      where rl.ar_invoice_line_id = l.id
                        and r.status <> 'rejected'), 0), 0)::text as "returnable"
      from ar_invoice_line l
     where l.ar_invoice_id = ${arInvoiceId}
     order by l.line_no
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}
