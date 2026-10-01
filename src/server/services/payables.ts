/**
 * Payables — REQ-AP-001 Stage 1, the record everything else hangs off.
 *
 * One record per thing the company has to pay, of a configured type. The
 * type's controls are enforced at creation (R1, §5.3): no goods without a
 * purchase order — the PI *is* the order, created and **submitted** through
 * the existing PO service in the same transaction; no service without the
 * benefiting department; one payable per supplier reference and type.
 *
 * ── Why the PO is submitted here and approved elsewhere ────────────────────
 * §14 of the requirement says "created … and approved"; §5.2 of the blueprint
 * says the person who raised a purchase order cannot approve it, and the PO
 * service enforces that. The blueprint wins: the payable's transaction
 * creates and submits the order, and approval stays a second person's act in
 * the approvals flow. Stage 1 needs the order to exist, not to be approved.
 *
 * ── The stage ───────────────────────────────────────────────────────────────
 * Derived, never typed (§6, R2). `recomputeStage` gathers the lane facts the
 * current build can know — Stage 1: the linked invoices — derives, and logs
 * `STAGE_CHANGED` when the answer moved. Later build stages extend the fact
 * gathering; the rails and rules do not change shape.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  branch,
  businessPartner,
  payable,
  payableHold,
  payableOrderLine,
  payableStage,
  payableType,
  warehouse,
} from '../db/schema';
import {
  NO_FACTS,
  PayableValidationError,
  deriveStage,
  referenceKey,
  type StageFacts,
  type StageRow,
} from '../domain/payables';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import { can } from '../domain/permissions';
import * as events from './payable-events';
import * as purchaseOrders from './purchase-order';
import * as rateService from './exchange-rates';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'payable';
export const SETTINGS_OBJECT = 'payables_settings';

export class PayableNotFoundError extends Error {
  readonly code = 'PAYABLE_NOT_FOUND';
  constructor(ref: string) {
    super(`No payable '${ref}', or it is outside the branches you may see.`);
    this.name = 'PayableNotFoundError';
  }
}

export class DuplicateReferenceError extends Error {
  readonly code = 'PAYABLE_DUPLICATE_REFERENCE';
  constructor(reference: string, existingNo: string) {
    super(
      `${reference} is already open as ${existingNo} for this supplier. One import, one record (R1) — ` +
        'open that payable and update it, or use a different reference for a genuinely different purchase.',
    );
    this.name = 'DuplicateReferenceError';
  }
}

export class PayableStateError extends Error {
  readonly code = 'PAYABLE_STATE';
  constructor(payableNo: string, detail: string) {
    super(`${payableNo}: ${detail}`);
    this.name = 'PayableStateError';
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function typeOf(tx: Tx, code: string) {
  const [row] = await tx
    .select()
    .from(payableType)
    .where(eq(payableType.code, code))
    .limit(1);
  if (!row) {
    throw new PayableValidationError('type', `'${code}' is not a payable type.`);
  }
  return row;
}

/** A type's rail, for derivation and for the stage rail on screen. */
export async function railFor(tx: Tx, typeCode: string): Promise<StageRow[]> {
  const rows = await tx
    .select({
      code: payableStage.code,
      sequence: payableStage.sequence,
      ruleName: payableStage.ruleName,
      active: payableStage.active,
      name: payableStage.name,
      isTerminalMark: payableStage.isTerminalMark,
    })
    .from(payableStage)
    .where(eq(payableStage.payableTypeCode, typeCode))
    .orderBy(asc(payableStage.sequence));
  return rows;
}

export async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(payable).where(eq(payable.id, id)).limit(1);
  if (!row) throw new PayableNotFoundError(id);
  return row;
}

export async function loadByNo(tx: Tx, payableNo: string) {
  const [row] = await tx
    .select()
    .from(payable)
    .where(eq(payable.payableNo, payableNo))
    .limit(1);
  if (!row) throw new PayableNotFoundError(payableNo);
  return row;
}

// ---------------------------------------------------------------------------
// §6 — the stage, recomputed in the transaction of every event
// ---------------------------------------------------------------------------

/**
 * The lane facts this build can know. Stage 1 reads the order lane — the
 * linked invoices; every later lane's facts stay at their empty value until
 * its build stage lands, which is R2 applied to the build itself.
 */
export async function gatherFacts(tx: Tx, payableId: string): Promise<StageFacts> {
  const [invoices] = await tx
    .select({
      posted: sql<number>`count(*) filter (where ${apInvoice.status} in ('posted','partially_executed','settled'))::int`,
      approved: sql<number>`count(*) filter (where ${apInvoice.status} in ('approved','posted','partially_executed','settled'))::int`,
    })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), isNull(apInvoice.reversedAt)));

  return {
    ...NO_FACTS,
    postedInvoiceCount: invoices?.posted ?? 0,
    approvedInvoiceCount: invoices?.approved ?? 0,
  };
}

/** Recomputes the stage; logs `STAGE_CHANGED` when it moved. */
export async function recomputeStage(
  tx: Tx,
  payableId: string,
  actorUserId: string | null,
): Promise<{ stageCode: string; changed: boolean }> {
  const row = await load(tx, payableId);
  const rail = await railFor(tx, row.payableTypeCode);
  const facts = await gatherFacts(tx, payableId);
  const next = deriveStage(rail, facts);

  if (next === row.stageCode) return { stageCode: next, changed: false };

  const from = rail.find((s) => s.code === row.stageCode);
  const to = rail.find((s) => s.code === next);

  await tx
    .update(payable)
    .set({ stageCode: next, stageSince: new Date(), updatedAt: new Date() })
    .where(eq(payable.id, payableId));

  await events.record(tx, {
    payableId,
    eventCode: 'STAGE_CHANGED',
    summary: `Stage: ${(from as { name?: string })?.name ?? row.stageCode} → ${(to as { name?: string })?.name ?? next}`,
    before: { stage: row.stageCode },
    after: { stage: next },
    actorUserId,
  });

  return { stageCode: next, changed: true };
}

// ---------------------------------------------------------------------------
// §19.1 — the lane guard: a pending-reason hold blocks its lane
// ---------------------------------------------------------------------------

export class LaneHeldError extends Error {
  readonly code = 'PAYABLE_LANE_HELD';
  constructor(payableNo: string, laneCode: string) {
    super(
      `${payableNo} is over its time limit in the ${laneCode} lane and the stop has no reason yet. ` +
        'Complete the hold — reason, owner, next action — before changing anything in this lane. ' +
        'A manager may override with a reason.',
    );
    this.name = 'LaneHeldError';
  }
}

/**
 * §19.1 — while an automatic hold waits for its reason, the lane is
 * read-only. A manager (the reverse_cancel grant, the module's strongest)
 * may override with a reason, and the override is an event.
 */
export async function assertLaneEditable(
  tx: Tx,
  ctx: ActorContext,
  row: { id: string; payableNo: string },
  laneCode: string,
  override?: { reason: string } | null,
): Promise<void> {
  const [pending] = await tx
    .select({ id: payableHold.id })
    .from(payableHold)
    .where(
      and(
        eq(payableHold.payableId, row.id),
        eq(payableHold.status, 'open'),
        eq(payableHold.reasonCode, 'PENDING_REASON'),
        eq(payableHold.laneCode, laneCode),
      ),
    )
    .limit(1);

  if (!pending) return;

  const isManager = can(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT);
  if (override?.reason?.trim() && isManager) {
    await events.record(tx, {
      payableId: row.id,
      eventCode: 'HOLD_UPDATED',
      summary: `Lane ${laneCode} edited under override: ${override.reason.trim()}`,
      holdId: pending.id,
      actorUserId: ctx.principal.userId,
    });
    return;
  }

  throw new LaneHeldError(row.payableNo, laneCode);
}

// ---------------------------------------------------------------------------
// Creation (§5.1, §14)
// ---------------------------------------------------------------------------

export interface PayableLineInput {
  readonly itemCode?: string | null;
  readonly expenseCategoryCode?: string | null;
  readonly description: string;
  /** Decimal strings, as typed. */
  readonly quantity?: string | null;
  readonly uomCode?: string | null;
  readonly unitPrice?: string | null;
}

export interface CreatePayableInput {
  readonly payableTypeCode: string;
  readonly supplierReference: string;
  readonly supplierId: string;
  readonly branchCode: string;
  readonly departmentCode?: string | null;
  readonly currency: string;
  readonly documentDate: string;
  readonly description: string;
  readonly paymentTermsText?: string | null;
  readonly expenseCategoryCode?: string | null;
  /** Typed when there are no lines (a quote, a contract amount). */
  readonly amountTxn?: string | null;
  readonly dueDate?: string | null;
  readonly lines?: readonly PayableLineInput[];
  /** Link an existing approved order instead of creating one from the lines. */
  readonly purchaseOrderId?: string | null;
  /** Where goods-type order lines are ordered to; defaults to the branch's first main warehouse. */
  readonly defaultWarehouseCode?: string | null;
}

async function defaultWarehouse(tx: Tx, branchCode: string): Promise<string> {
  const [row] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(
      and(
        eq(warehouse.branchCode, branchCode),
        eq(warehouse.active, true),
        eq(warehouse.warehouseType, 'main'),
      ),
    )
    .orderBy(asc(warehouse.code))
    .limit(1);
  if (!row) {
    throw new PayableValidationError(
      'warehouse',
      `branch ${branchCode} has no active main warehouse to order goods to. ` +
        'Create one under Master Data → Warehouses first.',
    );
  }
  return row.code;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreatePayableInput,
): Promise<{ id: string; payableNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const type = await typeOf(tx, input.payableTypeCode);
  if (!type.active) {
    throw new PayableValidationError('type', `${type.name} is deactivated.`);
  }

  if (type.requiresDepartment && !input.departmentCode) {
    throw new PayableValidationError(
      'department',
      `a ${type.name} payable names the benefiting department — the people who confirm it was delivered (§5.3).`,
    );
  }

  const key = referenceKey(input.supplierReference);

  const [existing] = await tx
    .select({ payableNo: payable.payableNo })
    .from(payable)
    .where(
      and(
        eq(payable.supplierId, input.supplierId),
        eq(payable.payableTypeCode, type.code),
        eq(payable.supplierReferenceKey, key),
      ),
    )
    .limit(1);
  if (existing) throw new DuplicateReferenceError(input.supplierReference, existing.payableNo);

  const [supplier] = await tx
    .select({ id: businessPartner.id, name: businessPartner.legalName, isSupplier: businessPartner.isSupplier })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.supplierId))
    .limit(1);
  if (!supplier) throw new PayableValidationError('supplier', 'no such business partner.');
  if (!supplier.isSupplier) {
    throw new PayableValidationError(
      'supplier',
      `${supplier.name} does not hold the Supplier role. Grant it on the partner record first.`,
    );
  }

  const lines = input.lines ?? [];

  // The amount: the lines when they carry prices, the typed figure otherwise.
  let amountTxn = 0n;
  let quantity = 0n;
  let hasQuantity = false;
  for (const line of lines) {
    if (line.quantity) {
      quantity += parseQuantity(line.quantity);
      hasQuantity = true;
      if (line.unitPrice) {
        // quantity × price at MONEY_SCALE — the same arithmetic the PI shows.
        const q = parseQuantity(line.quantity);
        const p = parseDecimal(line.unitPrice, MONEY_SCALE);
        amountTxn += (q * p) / 10n ** 6n;
      }
    }
  }
  if (amountTxn === 0n && input.amountTxn) {
    amountTxn = parseDecimal(input.amountTxn, MONEY_SCALE);
  }

  const converted = await rateService.convertOn(tx, amountTxn, input.currency, input.documentDate);

  // ── The order control (§5.3, §14) ─────────────────────────────────────────
  let purchaseOrderId = input.purchaseOrderId ?? null;
  let orderNo: string | null = null;
  if (type.requiresPo) {
    if (purchaseOrderId) {
      const order = await purchaseOrders.view(tx, purchaseOrderId);
      if (!order) throw new PayableValidationError('purchase_order', 'no such purchase order.');
      if (order.order.supplierId !== input.supplierId) {
        throw new PayableValidationError(
          'purchase_order',
          `${order.order.orderNo} belongs to a different supplier. The payable and its order name one supplier (R1).`,
        );
      }
      orderNo = order.order.orderNo;
    } else {
      if (lines.length === 0) {
        throw new PayableValidationError(
          'lines',
          `a ${type.name} payable needs the PI's model lines — they become the purchase order (§14).`,
        );
      }
      const warehouseCode = input.defaultWarehouseCode ?? (await defaultWarehouse(tx, input.branchCode));
      const orderLines = [];
      for (const line of lines) {
        const unitPriceIqd = line.unitPrice
          ? (
              await rateService.convertOn(
                tx,
                parseDecimal(line.unitPrice, MONEY_SCALE),
                input.currency,
                input.documentDate,
              )
            ).amountIqd
          : 0n;
        orderLines.push({
          lineType: line.itemCode ? ('inventory_item' as const) : ('service' as const),
          itemCode: line.itemCode ?? null,
          description: line.description,
          quantity: line.quantity ? parseQuantity(line.quantity) : 1_000_000n,
          uomCode: line.uomCode ?? 'EA',
          unitPriceIqd,
          branchCode: input.branchCode,
          warehouseCode: line.itemCode ? warehouseCode : null,
        });
      }
      const created = await purchaseOrders.create(tx, ctx, {
        supplierId: input.supplierId,
        branchCode: input.branchCode,
        orderDate: input.documentDate,
        currency: input.currency,
        reference: input.supplierReference,
        note: `Raised from payable (${type.name}) — the PI is the company's order (REQ-AP-001 §14).`,
        lines: orderLines,
      });
      // §5.2 — submitted here; approved by a second person in the approvals
      // flow. Stage 1 needs the order to exist, not to be approved.
      await purchaseOrders.submit(tx, ctx, created.id);
      purchaseOrderId = created.id;
      orderNo = created.orderNo;
    }
  }

  const year = Number(input.documentDate.slice(0, 4));
  const allocated = await allocateDocumentNumber(
    tx,
    type.numberSeriesKey,
    { branchCode: input.branchCode, year },
    ctx.principal.userId,
  );

  const rail = await railFor(tx, type.code);
  const stageCode = deriveStage(rail, NO_FACTS);

  const [created] = await tx
    .insert(payable)
    .values({
      payableNo: allocated.documentNo,
      payableTypeCode: type.code,
      supplierReference: input.supplierReference.trim(),
      supplierReferenceKey: key,
      supplierId: input.supplierId,
      branchCode: input.branchCode,
      departmentCode: input.departmentCode ?? null,
      currency: input.currency,
      amountTxn: toDecimalString(amountTxn),
      amountIqd: toDecimalString(converted.amountIqd),
      quantity: hasQuantity ? formatQuantity(quantity) : null,
      documentDate: input.documentDate,
      description: input.description.trim(),
      paymentTermsText: input.paymentTermsText?.trim() || null,
      purchaseOrderId,
      expenseCategoryCode: input.expenseCategoryCode ?? null,
      dueDate: input.dueDate ?? null,
      stageCode,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: payable.id });

  const payableId = created!.id;

  for (const [index, line] of lines.entries()) {
    await tx.insert(payableOrderLine).values({
      payableId,
      lineNo: index + 1,
      itemCode: line.itemCode ?? null,
      expenseCategoryCode: line.expenseCategoryCode ?? null,
      description: line.description,
      quantity: line.quantity ? formatQuantity(parseQuantity(line.quantity)) : null,
      uomCode: line.uomCode ?? null,
      unitPrice: line.unitPrice ? toDecimalString(parseDecimal(line.unitPrice, MONEY_SCALE)) : null,
      amountTxn:
        line.quantity && line.unitPrice
          ? toDecimalString(
              (parseQuantity(line.quantity) * parseDecimal(line.unitPrice, MONEY_SCALE)) /
                10n ** 6n,
            )
          : null,
    });
  }

  await events.record(tx, {
    payableId,
    eventCode: 'PAYABLE_OPENED',
    summary: `${type.name} opened — ${input.supplierReference.trim()}, ${supplier.name}, ${input.currency} ${toDecimalString(amountTxn)}`,
    after: { payableNo: allocated.documentNo, reference: input.supplierReference.trim() },
    actorUserId: ctx.principal.userId,
  });

  if (lines.length > 0) {
    await events.record(tx, {
      payableId,
      eventCode: 'PI_RECORDED',
      summary: `${lines.length} line(s) recorded${hasQuantity ? `, quantity ${formatQuantity(quantity)}` : ''}`,
      actorUserId: ctx.principal.userId,
    });
  }

  if (purchaseOrderId) {
    await events.record(tx, {
      payableId,
      eventCode: 'PO_LINKED',
      summary: input.purchaseOrderId
        ? `Purchase order ${orderNo} linked`
        : `Purchase order ${orderNo} created from the PI lines and submitted for approval`,
      sourceType: 'purchase_order',
      sourceId: purchaseOrderId,
      sourceNo: orderNo,
      actorUserId: ctx.principal.userId,
    });
  }

  if (input.paymentTermsText?.trim()) {
    await events.record(tx, {
      payableId,
      eventCode: 'TERMS_SET',
      summary: `Terms: ${input.paymentTermsText.trim()}`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.created',
    objectType: PERMISSION_OBJECT,
    objectId: payableId,
    branchCode: input.branchCode,
    after: { payableNo: allocated.documentNo, type: type.code, reference: key },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: payableId, payableNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// The order lane after creation
// ---------------------------------------------------------------------------

/** Links an existing invoice of the same supplier (§14 "Purchase invoice"). */
export async function linkInvoice(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; apInvoiceId: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  await assertLaneEditable(tx, ctx, row, 'order');
  assertOpen(row);

  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);
  if (!invoice) throw new PayableValidationError('invoice', 'no such purchase invoice.');
  if (invoice.supplierId !== row.supplierId) {
    throw new PayableValidationError(
      'invoice',
      `${invoice.invoiceNo} belongs to a different supplier than ${row.payableNo}.`,
    );
  }
  if (invoice.payableId && invoice.payableId !== row.id) {
    throw new PayableValidationError(
      'invoice',
      `${invoice.invoiceNo} already belongs to another payable — one invoice, one payable (§5.1).`,
    );
  }

  await tx
    .update(apInvoice)
    .set({ payableId: row.id, updatedAt: new Date() })
    .where(eq(apInvoice.id, invoice.id));

  const posted = ['posted', 'partially_executed', 'settled'].includes(invoice.status);
  await events.record(tx, {
    payableId: row.id,
    eventCode: posted ? 'INVOICE_POSTED' : 'FIELD_CHANGED',
    summary: posted
      ? `Purchase invoice ${invoice.invoiceNo} linked — ${invoice.currency} ${invoice.totalIqd} IQD posted`
      : `Purchase invoice ${invoice.invoiceNo} (${invoice.status}) linked`,
    sourceType: 'ap_invoice',
    sourceId: invoice.id,
    sourceNo: invoice.invoiceNo,
    actorUserId: ctx.principal.userId,
  });

  await refreshFromInvoices(tx, row.id);
  await recomputeStage(tx, row.id, ctx.principal.userId);
}

/**
 * Called by the invoice service when a linked invoice posts, approves or
 * reverses — the order lane's share of "records everything" (§7.2).
 */
export async function onInvoiceEvent(
  tx: Tx,
  input: {
    payableId: string;
    eventCode: 'INVOICE_POSTED' | 'INVOICE_APPROVED' | 'INVOICE_REVERSED';
    invoiceId: string;
    invoiceNo: string;
    summary: string;
    actorUserId: string | null;
  },
): Promise<void> {
  await events.record(tx, {
    payableId: input.payableId,
    eventCode: input.eventCode,
    summary: input.summary,
    sourceType: 'ap_invoice',
    sourceId: input.invoiceId,
    sourceNo: input.invoiceNo,
    actorUserId: input.actorUserId,
  });
  await refreshFromInvoices(tx, input.payableId);
  await recomputeStage(tx, input.payableId, input.actorUserId);
}

/** §5.1 — once invoices post, the payable's amount is their sum. */
async function refreshFromInvoices(tx: Tx, payableId: string): Promise<void> {
  const [sums] = await tx
    .select({
      posted: sql<number>`count(*) filter (where ${apInvoice.status} in ('posted','partially_executed','settled'))::int`,
      totalIqd: sql<string>`coalesce(sum(${apInvoice.totalIqd}) filter (where ${apInvoice.status} in ('posted','partially_executed','settled')), 0)::text`,
    })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), isNull(apInvoice.reversedAt)));

  if ((sums?.posted ?? 0) > 0) {
    await tx
      .update(payable)
      .set({ amountIqd: sums!.totalIqd, updatedAt: new Date() })
      .where(eq(payable.id, payableId));
  }
}

function assertOpen(row: { payableNo: string; closedAt: Date | null; cancelledAt: Date | null }) {
  if (row.cancelledAt) {
    throw new PayableStateError(row.payableNo, 'a cancelled payable is read-only.');
  }
  if (row.closedAt) {
    throw new PayableStateError(
      row.payableNo,
      'a closed payable is read-only except for attachments and notes (§20.1).',
    );
  }
}

/** Terms after creation — §14: `TERMS_SET` first, `TERMS_CHANGED` after, with before/after. */
export async function setTerms(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; paymentTermsText: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  await assertLaneEditable(tx, ctx, row, 'order');
  assertOpen(row);

  const next = input.paymentTermsText.trim();
  if (next === (row.paymentTermsText ?? '')) return;

  await tx
    .update(payable)
    .set({ paymentTermsText: next, updatedAt: new Date() })
    .where(eq(payable.id, row.id));

  await events.record(tx, {
    payableId: row.id,
    eventCode: row.paymentTermsText ? 'TERMS_CHANGED' : 'TERMS_SET',
    summary: row.paymentTermsText ? `Terms: ${row.paymentTermsText} → ${next}` : `Terms: ${next}`,
    before: row.paymentTermsText ? { terms: row.paymentTermsText } : null,
    after: { terms: next },
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.terms_set',
    objectType: PERMISSION_OBJECT,
    objectId: row.id,
    branchCode: row.branchCode,
    before: { terms: row.paymentTermsText },
    after: { terms: next },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** A note is the lightest event — §7.2 `NOTE_ADDED`. Allowed even when closed. */
export async function addNote(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; note: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  const note = input.note.trim();
  if (!note) throw new PayableValidationError('note', 'an empty note says nothing.');

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'NOTE_ADDED',
    summary: note,
    actorUserId: ctx.principal.userId,
  });
}

/** §5.1 — the only end state besides closed, and it states its reason (R3). */
export async function cancel(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; reason: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  assertOpen(row);

  const reason = input.reason.trim();
  if (!reason) {
    throw new PayableValidationError('reason', 'a cancellation without a reason is not a record of a decision.');
  }

  const [posted] = await tx
    .select({ invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.payableId, row.id),
        inArray(apInvoice.status, ['posted', 'partially_executed', 'settled']),
        isNull(apInvoice.reversedAt),
      ),
    )
    .limit(1);
  if (posted) {
    throw new PayableStateError(
      row.payableNo,
      `invoice ${posted.invoiceNo} is posted against it. Reverse the invoice first — cancelling the record would not cancel the debt.`,
    );
  }

  await tx
    .update(payable)
    .set({
      cancelledAt: new Date(),
      cancelledBy: ctx.principal.userId,
      cancelReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(payable.id, row.id));

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'CANCELLED',
    summary: `Cancelled: ${reason}`,
    after: { reason },
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: row.id,
    branchCode: row.branchCode,
    after: { cancelled: true },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// The workbench (§21.2) and the page (§21.3)
// ---------------------------------------------------------------------------

export interface WorkbenchFilter {
  readonly typeCode?: string | null;
  readonly stageCode?: string | null;
  readonly stopped?: 'yes' | 'no' | 'needs_reason' | null;
  readonly supplierId?: string | null;
  readonly search?: string | null;
  readonly includeCancelled?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * The one list for everything owed. Stopped-without-reason first, then days
 * stopped, then due date (§21.2) — the sort is the triage order.
 */
export async function workbench(tx: Tx, filter: WorkbenchFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));

  const needsReason = sql<boolean>`exists (
    select 1 from payable_hold h
     where h.payable_id = ${payable.id}
       and h.status = 'open' and h.reason_code = 'PENDING_REASON')`;

  const where = and(
    filter.typeCode ? eq(payable.payableTypeCode, filter.typeCode) : undefined,
    filter.stageCode ? eq(payable.stageCode, filter.stageCode) : undefined,
    filter.supplierId ? eq(payable.supplierId, filter.supplierId) : undefined,
    filter.stopped === 'yes' ? eq(payable.onHold, true) : undefined,
    filter.stopped === 'no' ? eq(payable.onHold, false) : undefined,
    filter.stopped === 'needs_reason' ? needsReason : undefined,
    filter.includeCancelled ? undefined : isNull(payable.cancelledAt),
    filter.search
      ? or(
          ilike(payable.supplierReference, `%${filter.search}%`),
          ilike(payable.payableNo, `%${filter.search}%`),
          ilike(payable.description, `%${filter.search}%`),
          sql`${payable.supplierReferenceKey} like ${'%' + filter.search.toUpperCase().replace(/[^A-Z0-9]/g, '') + '%'}`,
        )
      : undefined,
  );

  const rows = await tx
    .select({
      id: payable.id,
      payableNo: payable.payableNo,
      typeCode: payable.payableTypeCode,
      typeName: payableType.name,
      reference: payable.supplierReference,
      supplierName: businessPartner.legalName,
      departmentCode: payable.departmentCode,
      description: payable.description,
      currency: payable.currency,
      amountTxn: payable.amountTxn,
      amountIqd: payable.amountIqd,
      stageCode: payable.stageCode,
      stageName: payableStage.name,
      stageSequence: payableStage.sequence,
      stageSince: payable.stageSince,
      onHold: payable.onHold,
      needsReason,
      dueDate: payable.dueDate,
      documentDate: payable.documentDate,
      branchCode: payable.branchCode,
      cancelledAt: payable.cancelledAt,
      closedAt: payable.closedAt,
      hold: {
        reasonCode: payableHold.reasonCode,
        ownerUserId: payableHold.ownerUserId,
        startedAt: payableHold.startedAt,
        nextAction: payableHold.nextAction,
        nextActionDue: payableHold.nextActionDue,
      },
    })
    .from(payable)
    .innerJoin(payableType, eq(payableType.code, payable.payableTypeCode))
    .innerJoin(
      payableStage,
      and(
        eq(payableStage.payableTypeCode, payable.payableTypeCode),
        eq(payableStage.code, payable.stageCode),
      ),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .leftJoin(
      payableHold,
      and(
        eq(payableHold.payableId, payable.id),
        eq(payableHold.status, 'open'),
        sql`${payableHold.startedAt} = (
          select min(h2.started_at) from payable_hold h2
           where h2.payable_id = ${payable.id} and h2.status = 'open')`,
      ),
    )
    .where(where)
    .orderBy(
      desc(needsReason),
      sql`case when ${payable.onHold} then 0 else 1 end`,
      asc(payableHold.startedAt),
      asc(payable.dueDate),
      desc(payable.createdAt),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ total }] = (await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(payable)
    .where(where)) as [{ total: number }];

  return { rows, total, page, pageSize };
}

/** The page's header: the record, its type, rail, lanes, lines, open holds. */
export async function view(tx: Tx, payableNo: string) {
  const row = await loadByNo(tx, payableNo);
  const type = await typeOf(tx, row.payableTypeCode);
  const rail = await railFor(tx, row.payableTypeCode);

  const lanes = await tx.execute(sql`
    select l.code, l.name, l.sort_order
      from payable_type_lane tl
      join payable_lane l on l.code = tl.lane_code
     where tl.payable_type_code = ${row.payableTypeCode}
     order by l.sort_order
  `);

  const lines = await tx
    .select()
    .from(payableOrderLine)
    .where(eq(payableOrderLine.payableId, row.id))
    .orderBy(asc(payableOrderLine.lineNo));

  const invoices = await tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      status: apInvoice.status,
      invoiceDate: apInvoice.invoiceDate,
      totalIqd: apInvoice.totalIqd,
      settledAmountIqd: apInvoice.settledAmountIqd,
    })
    .from(apInvoice)
    .where(eq(apInvoice.payableId, row.id))
    .orderBy(asc(apInvoice.invoiceDate));

  const holds = await tx
    .select()
    .from(payableHold)
    .where(and(eq(payableHold.payableId, row.id), eq(payableHold.status, 'open')))
    .orderBy(asc(payableHold.startedAt));

  const [supplier] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, row.supplierId))
    .limit(1);

  const [branchRow] = await tx
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.code, row.branchCode))
    .limit(1);

  return {
    payable: row,
    type,
    rail,
    lanes: lanes.rows as { code: string; name: string; sort_order: number }[],
    lines,
    invoices,
    holds,
    supplier: supplier ?? null,
    branchName: branchRow?.name ?? row.branchCode,
  };
}
