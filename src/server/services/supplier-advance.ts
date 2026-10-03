/**
 * Supplier advances — Phase 05.6, §8.5.
 *
 * Money paid before delivery. Until it is consumed it is an **asset**: the
 * supplier owes goods or a refund. Appendix C sends it to a Supplier Advance
 * account rather than reducing payables, and the distinction is not cosmetic —
 * netting a debt the company is *owed* against debts it *owes* would leave the
 * supplier statement and the ledger permanently disagreeing, and neither party
 * able to say by how much.
 *
 * Three movements, and each is a different act:
 *
 * | Act | Posting | When |
 * |---|---|---|
 * | **Payment** | Dr Supplier Advance / Cr Bank | Appendix C, verbatim |
 * | **Settlement** | Dr Supplier A/P / Cr Supplier Advance | When an invoice consumes it |
 * | **Refund** | Dr Bank / Cr Supplier Advance | When the money comes back instead |
 *
 * Appendix C lists only the first. The other two are not the implementation
 * team choosing an accounting treatment: they are the arithmetic that the first
 * one forces. An advance account that could be debited and never credited would
 * grow without limit and never reconcile, and §8.5 asks in terms for settlement
 * and refund. There is no second treatment to choose between.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  appUser,
  bankCashAccount,
  businessPartner,
  purchaseOrder,
  supplierAdvance,
  supplierAdvanceSettlement,
  payable,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as payables from './payables';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'supplier_advance';
export const PERMISSION_OBJECT = 'supplier_advance';
const SEQUENCE_KEY = 'SUPPLIER_ADVANCE';

export class SupplierAdvanceNotFoundError extends Error {
  readonly code = 'SUPPLIER_ADVANCE_NOT_FOUND';
  constructor(id: string) {
    super(`No supplier advance '${id}'.`);
    this.name = 'SupplierAdvanceNotFoundError';
  }
}

export class SupplierAdvanceStateError extends Error {
  readonly code = 'SUPPLIER_ADVANCE_STATE_INVALID';
  constructor(advanceNo: string, status: string, detail: string) {
    super(`Supplier advance ${advanceNo} is '${status}': ${detail}`);
    this.name = 'SupplierAdvanceStateError';
  }
}

/** §8.5 — settlement may not exceed either balance. */
export class SettlementTooLargeError extends Error {
  readonly code = 'SETTLEMENT_TOO_LARGE';
  constructor(
    readonly limit: 'advance' | 'invoice',
    available: bigint,
    requested: bigint,
  ) {
    const money = (v: bigint) => toDecimalString(v, 4n);
    super(
      `Settling ${money(requested)} would exceed the ${limit} balance of ${money(available)} (§8.5). ` +
        (limit === 'advance'
          ? 'An advance can only be consumed once; settle the remainder against another invoice, or refund it.'
          : 'An invoice can only be settled down to zero; the rest of the advance stays available.'),
    );
    this.name = 'SettlementTooLargeError';
  }
}

/** §8.5 — *"prevention of duplicate settlement"*. */
export class DuplicateSettlementError extends Error {
  readonly code = 'DUPLICATE_SETTLEMENT';
  constructor(
    readonly advanceNo: string,
    readonly invoiceNo: string,
  ) {
    super(
      `Advance ${advanceNo} has already been settled against invoice ${invoiceNo} (§8.5). ` +
        'Reverse that settlement if it was wrong; applying the same money twice would clear a debt that is still owed.',
    );
    this.name = 'DuplicateSettlementError';
  }
}

export interface CreateAdvanceInput {
  /** §8.5 — required. An advance with no order is money out against nothing. */
  readonly purchaseOrderId: string;
  readonly branchCode: string;
  readonly requestDate: string;
  readonly amountIqd: bigint;
  readonly currency?: string;
  readonly reason?: string | null;
}

async function load(tx: Tx, id: string) {
  const [advance] = await tx
    .select()
    .from(supplierAdvance)
    .where(eq(supplierAdvance.id, id))
    .limit(1);
  if (!advance) throw new SupplierAdvanceNotFoundError(id);
  return advance;
}

/** §8.5, §15 — what is left of an advance: paid, less settled, less refunded. */
export function availableBalance(advance: typeof supplierAdvance.$inferSelect): bigint {
  return (
    parseDecimal(advance.amountIqd, 4n) -
    parseDecimal(advance.settledAmountIqd, 4n) -
    parseDecimal(advance.refundedAmountIqd, 4n)
  );
}

/** What is still owed on an invoice after the advances applied to it. */
export function invoiceBalance(invoice: typeof apInvoice.$inferSelect): bigint {
  return parseDecimal(invoice.totalIqd, 4n) - parseDecimal(invoice.settledAmountIqd, 4n);
}

/**
 * Raises the Supplier Advance Request (§8.5).
 *
 * The order is read here so the supplier comes from it rather than from the
 * person keying the request: an advance paid to a different supplier from the
 * one on the order is the exact failure the PO link exists to prevent, and
 * asking for the supplier separately would make it possible again.
 */
export async function request(
  tx: Tx,
  ctx: ActorContext,
  input: CreateAdvanceInput,
): Promise<{ id: string; advanceNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const [order] = await tx
    .select()
    .from(purchaseOrder)
    .where(eq(purchaseOrder.id, input.purchaseOrderId))
    .limit(1);

  if (!order) throw new Error(`No purchase order with id '${input.purchaseOrderId}'.`);

  if (order.status === 'draft' || order.status === 'cancelled') {
    throw new Error(
      `Purchase order ${order.orderNo} is '${order.status}', so no advance can be paid against it (§8.5). ` +
        'An advance is paid against a commitment the company has actually made.',
    );
  }

  if (input.amountIqd <= 0n) {
    throw new Error('An advance of nothing is not an advance. State the amount to be paid.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.requestDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(supplierAdvance)
    .values({
      advanceNo: allocated.documentNo,
      purchaseOrderId: order.id,
      // From the order, never from the request.
      supplierId: order.supplierId,
      branchCode: input.branchCode,
      requestDate: input.requestDate,
      currency: input.currency ?? 'IQD',
      amountIqd: toDecimalString(input.amountIqd, 4n),
      reason: input.reason ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: supplierAdvance.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_advance.requested',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      advanceNo: allocated.documentNo,
      orderNo: order.orderNo,
      amountIqd: toDecimalString(input.amountIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, advanceNo: allocated.documentNo };
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const advance = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  if (advance.status !== 'draft') {
    throw new SupplierAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'only a draft advance request can be approved.',
    );
  }

  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (advance.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new SupplierAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'the person who requested an advance cannot approve it — approving it releases company money (§5.2).',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, advance.status, 'approved');

  await tx
    .update(supplierAdvance)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(supplierAdvance.id, id));

  // §12 — an approved advance can move its payable's rail.
  if (advance.payableId) {
    await payables.onAdvanceEvent(tx, {
      payableId: advance.payableId,
      eventCode: 'FIELD_CHANGED',
      advanceId: advance.id,
      advanceNo: advance.advanceNo,
      summary: `Advance ${advance.advanceNo} approved`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_advance.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: advance.branchCode,
    before: { status: 'draft' },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

/**
 * Supplier Advance Payment — Appendix C: *Dr Supplier Advance / Cr Bank or Cash*.
 *
 * The company now holds a claim on the supplier rather than cash, and that is
 * what the entry says. Nothing about payables moves: the invoice has not
 * arrived and there is no debt yet to reduce.
 */
export async function pay(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  paidDate: string,
  /**
   * §17 — which account the money left, when the caller knows. Phase 07.2's
   * payment batch does; a hand-paid advance falls back to the `bank` mapping.
   */
  bankCashAccountId?: string | null,
): Promise<{ journalEntryId: string }> {
  const advance = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  if (advance.status !== 'approved') {
    throw new SupplierAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'an advance is paid once it has been approved.',
    );
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, advance.supplierId))
    .limit(1);

  const criteria = { branchCode: advance.branchCode };
  const dimensions = { branch: advance.branchCode, business_partner: supplier?.code ?? null };

  let bankGlAccountId: string | null = null;
  if (bankCashAccountId) {
    const [account] = await tx
      .select({ glAccountId: bankCashAccount.glAccountId })
      .from(bankCashAccount)
      .where(eq(bankCashAccount.id, bankCashAccountId))
      .limit(1);
    if (!account) throw new Error(`No bank or cash account with id '${bankCashAccountId}'.`);
    bankGlAccountId = account.glAccountId;
  }

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_advance_payment',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'paid' },
    branchCode: advance.branchCode,
    documentDate: paidDate,
    postingDate: paidDate,
    description: `Supplier advance ${advance.advanceNo} — ${supplier?.code ?? 'supplier'}`,
    lines: [
      { role: 'supplier_advance', debit: advance.amountIqd, criteria, dimensions },
      bankGlAccountId
        ? {
            role: 'bank',
            accountId: bankGlAccountId,
            credit: advance.amountIqd,
            criteria,
            dimensions,
          }
        : { role: 'bank', credit: advance.amountIqd, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, advance.status, 'posted');

  await tx
    .update(supplierAdvance)
    .set({
      status: 'posted',
      paidDate,
      paidBy: ctx.principal.userId,
      paidAt: new Date(),
      journalEntryId: result.journalEntryId,
      updatedAt: new Date(),
    })
    .where(eq(supplierAdvance.id, id));

  // §12 — a deposit paid on a linked payable is the bank lane's news.
  if (advance.payableId) {
    await payables.onAdvanceEvent(tx, {
      payableId: advance.payableId,
      eventCode: 'DEPOSIT_RECORDED',
      advanceId: advance.id,
      advanceNo: advance.advanceNo,
      summary: `Deposit paid — advance ${advance.advanceNo}, ${toDecimalString(parseDecimal(advance.amountIqd, 4n), 4n)} IQD on ${paidDate}`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_advance.paid',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: advance.branchCode,
    before: { status: 'approved' },
    after: { status: 'posted', journalEntryId: result.journalEntryId },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId };
}

/**
 * §12 — ties an advance to the payable it funds, so the payable's bank lane
 * can see it. The link is set once; the same-supplier rule is §5.1's.
 */
export async function linkToPayable(
  tx: Tx,
  ctx: ActorContext,
  input: { supplierAdvanceId: string; payableId: string },
): Promise<void> {
  const advance = await load(tx, input.supplierAdvanceId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  const [target] = await tx
    .select({
      id: payable.id,
      payableNo: payable.payableNo,
      supplierId: payable.supplierId,
      cancelledAt: payable.cancelledAt,
      closedAt: payable.closedAt,
    })
    .from(payable)
    .where(eq(payable.id, input.payableId))
    .limit(1);
  if (!target) throw new Error('No such payable to link this advance to.');
  if (target.supplierId !== advance.supplierId) {
    throw new Error(
      `${target.payableNo} belongs to a different supplier than ${advance.advanceNo}.`,
    );
  }
  if (target.cancelledAt || target.closedAt) {
    throw new Error(`${target.payableNo} is closed — it takes no further advances.`);
  }
  if (advance.payableId && advance.payableId !== target.id) {
    throw new Error(
      `${advance.advanceNo} already funds another payable — one advance, one payable.`,
    );
  }

  await tx
    .update(supplierAdvance)
    .set({ payableId: target.id, updatedAt: new Date() })
    .where(eq(supplierAdvance.id, advance.id));

  await payables.onAdvanceEvent(tx, {
    payableId: target.id,
    eventCode: 'FIELD_CHANGED',
    advanceId: advance.id,
    advanceNo: advance.advanceNo,
    summary: `Advance ${advance.advanceNo} linked — ${toDecimalString(parseDecimal(advance.amountIqd, 4n), 4n)} IQD (${advance.status})`,
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_advance.linked',
    objectType: PERMISSION_OBJECT,
    objectId: advance.id,
    branchCode: advance.branchCode,
    after: { payableNo: target.payableNo },
    outcome: 'success',
  });
}

/**
 * §8.5 — settles an advance against an A/P invoice.
 *
 * *Dr Supplier A/P / Cr Supplier Advance*: the debt the invoice created is
 * discharged by the money already paid, and the claim on the supplier shrinks
 * by the same amount. Both balances move together or neither does, which is the
 * gate's own wording.
 */
export async function settle(
  tx: Tx,
  ctx: ActorContext,
  input: {
    supplierAdvanceId: string;
    apInvoiceId: string;
    amountIqd: bigint;
    settlementDate: string;
    automatic?: boolean;
  },
): Promise<{ settlementId: string; journalEntryId: string; advanceBalance: bigint }> {
  const advance = await load(tx, input.supplierAdvanceId);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });
  return settleChecked(tx, ctx, advance, input);
}

/** The settlement itself, once the caller's right to it is established. */
async function settleChecked(
  tx: Tx,
  ctx: ActorContext,
  advance: Awaited<ReturnType<typeof load>>,
  input: {
    supplierAdvanceId: string;
    apInvoiceId: string;
    amountIqd: bigint;
    settlementDate: string;
    automatic?: boolean;
  },
): Promise<{ settlementId: string; journalEntryId: string; advanceBalance: bigint }> {

  if (advance.status !== 'posted' && advance.status !== 'partially_executed') {
    throw new SupplierAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'only an advance that has actually been paid can settle an invoice.',
    );
  }

  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);

  if (!invoice) throw new Error(`No A/P invoice with id '${input.apInvoiceId}'.`);

  if (invoice.supplierId !== advance.supplierId) {
    throw new Error(
      `Advance ${advance.advanceNo} was paid to a different supplier from invoice ${invoice.invoiceNo}. ` +
        'An advance settles only the debts of the supplier who holds it.',
    );
  }

  if (invoice.status !== 'posted' && invoice.status !== 'partially_executed') {
    throw new Error(
      `Invoice ${invoice.invoiceNo} is '${invoice.status}'. An advance settles a posted invoice — ` +
        'until it posts there is no debt to discharge.',
    );
  }

  if (input.amountIqd <= 0n) {
    throw new Error('A settlement of nothing settles nothing. State the amount to apply.');
  }

  // §8.5 — the same advance cannot be applied twice to the same invoice.
  // Checked here so the message names both documents; the partial unique index
  // refuses it by any other path, including two clerks at the same moment.
  const [existing] = await tx
    .select({ id: supplierAdvanceSettlement.id })
    .from(supplierAdvanceSettlement)
    .where(
      and(
        eq(supplierAdvanceSettlement.supplierAdvanceId, input.supplierAdvanceId),
        eq(supplierAdvanceSettlement.apInvoiceId, input.apInvoiceId),
        isNull(supplierAdvanceSettlement.reversedAt),
      ),
    )
    .limit(1);

  if (existing) throw new DuplicateSettlementError(advance.advanceNo, invoice.invoiceNo);

  const advanceAvailable = availableBalance(advance);
  if (input.amountIqd > advanceAvailable) {
    throw new SettlementTooLargeError('advance', advanceAvailable, input.amountIqd);
  }

  const owed = invoiceBalance(invoice);
  if (input.amountIqd > owed) {
    throw new SettlementTooLargeError('invoice', owed, input.amountIqd);
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, advance.supplierId))
    .limit(1);

  const criteria = { branchCode: advance.branchCode };
  const dimensions = { branch: advance.branchCode, business_partner: supplier?.code ?? null };
  const amount = toDecimalString(input.amountIqd, 4n);

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_advance_settlement',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: input.supplierAdvanceId, event: 'settled' },
    branchCode: advance.branchCode,
    documentDate: input.settlementDate,
    postingDate: input.settlementDate,
    description: `Advance ${advance.advanceNo} settled against ${invoice.invoiceNo}`,
    lines: [
      { role: 'supplier_payable', debit: amount, criteria, dimensions },
      { role: 'supplier_advance', credit: amount, criteria, dimensions },
    ],
  });

  const [settlement] = await tx
    .insert(supplierAdvanceSettlement)
    .values({
      supplierAdvanceId: input.supplierAdvanceId,
      apInvoiceId: input.apInvoiceId,
      amountIqd: amount,
      settlementDate: input.settlementDate,
      automatic: input.automatic ? 'automatic' : 'manual',
      journalEntryId: result.journalEntryId,
      settledBy: ctx.principal.userId,
    })
    .returning({ id: supplierAdvanceSettlement.id });

  // Both balances move by the same amount, in the same statement pair, in the
  // same transaction. The gate asks for exactly this.
  await tx
    .update(supplierAdvance)
    .set({
      settledAmountIqd: sql`${supplierAdvance.settledAmountIqd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(supplierAdvance.id, input.supplierAdvanceId));

  await tx
    .update(apInvoice)
    .set({
      settledAmountIqd: sql`${apInvoice.settledAmountIqd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, input.apInvoiceId));

  const refreshed = await load(tx, input.supplierAdvanceId);
  const balance = availableBalance(refreshed);

  await tx
    .update(supplierAdvance)
    .set({ status: balance === 0n ? 'settled' : 'partially_executed', updatedAt: new Date() })
    .where(eq(supplierAdvance.id, input.supplierAdvanceId));

  const [invoiceAfter] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);

  await tx
    .update(apInvoice)
    .set({
      status: invoiceBalance(invoiceAfter!) === 0n ? 'settled' : 'partially_executed',
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, input.apInvoiceId));

  // §12 — a settled advance moves the linked payable's rail too.
  if (advance.payableId) {
    await payables.onAdvanceEvent(tx, {
      payableId: advance.payableId,
      eventCode: 'FIELD_CHANGED',
      advanceId: advance.id,
      advanceNo: advance.advanceNo,
      summary: `Advance ${advance.advanceNo} settled against an invoice`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_advance.settled',
    objectType: PERMISSION_OBJECT,
    objectId: input.supplierAdvanceId,
    branchCode: advance.branchCode,
    after: {
      invoiceNo: invoice.invoiceNo,
      amountIqd: amount,
      advanceBalance: toDecimalString(balance, 4n),
      automatic: Boolean(input.automatic),
    },
    outcome: 'success',
  });

  return {
    settlementId: settlement!.id,
    journalEntryId: result.journalEntryId,
    advanceBalance: balance,
  };
}

/**
 * §8.5 — applies whatever is available, automatically.
 *
 * *"Automatic or manual partial settlement against A/P Invoice."* The automatic
 * form takes the smaller of the two balances, which is the only amount that can
 * be right: more than the advance holds does not exist, and more than the
 * invoice owes would create a credit nobody asked for.
 *
 * Returns null when there is nothing to do, rather than raising: an invoice with
 * no advance available is the ordinary case, and a routine that threw on it
 * could not be run over a day's invoices.
 */
export async function settleAutomatically(
  tx: Tx,
  ctx: ActorContext,
  input: { supplierAdvanceId: string; apInvoiceId: string; settlementDate: string },
): Promise<{ settlementId: string; amountIqd: bigint } | null> {
  const advance = await load(tx, input.supplierAdvanceId);
  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);
  if (!invoice) return null;

  const available = availableBalance(advance);
  const owed = invoiceBalance(invoice);
  const amountIqd = available < owed ? available : owed;

  if (amountIqd <= 0n) return null;

  const result = await settle(tx, ctx, {
    supplierAdvanceId: input.supplierAdvanceId,
    apInvoiceId: input.apInvoiceId,
    amountIqd,
    settlementDate: input.settlementDate,
    automatic: true,
  });

  return { settlementId: result.settlementId, amountIqd };
}

/**
 * REQ-FIX-001 FX6 — a deposit is applied to the invoice it was paid ahead of.
 *
 * Confirming a payment before the import's invoice posts pays a supplier
 * advance (§15.4), linked to the import; nothing applied it when the invoice arrived, so the import
 * read *Fully paid* while its invoice stayed part-owed and the supplier's
 * account showed the debt **and** the unapplied advance. Called by
 * `ap-invoice.post` in the posting transaction: every paid advance of the
 * same supplier held against this invoice's import is
 * applied, oldest first, until the invoice owes nothing or the advances are
 * spent — Dr Supplier A/P, Cr Supplier Advance, dated the invoice's day.
 *
 * Authorised by the posting it belongs to: whoever may post the invoice
 * posts the consequences of its posting, as confirming an application posts
 * the supplier payment it makes.
 */
export async function applyToPostedInvoice(
  tx: Tx,
  ctx: ActorContext,
  apInvoiceId: string,
): Promise<{ advanceNo: string; amountIqd: bigint }[]> {
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, apInvoiceId)).limit(1);
  if (!invoice || (invoice.status !== 'posted' && invoice.status !== 'partially_executed')) return [];
  // The deposits of the payable this invoice belongs to — an import's, paid
  // through its payment applications. An advance raised by hand against a
  // purchase order stays for the accountant to settle (§8.5, manual or
  // automatic, on the advance).
  if (!invoice.payableId) return [];

  const held = await tx
    .select()
    .from(supplierAdvance)
    .where(
      and(
        eq(supplierAdvance.supplierId, invoice.supplierId),
        inArray(supplierAdvance.status, ['posted', 'partially_executed']),
        eq(supplierAdvance.payableId, invoice.payableId),
      ),
    )
    .orderBy(asc(supplierAdvance.paidDate), asc(supplierAdvance.createdAt))
    .for('update');

  const applied: { advanceNo: string; amountIqd: bigint }[] = [];
  for (const advance of held) {
    const [current] = await tx.select().from(apInvoice).where(eq(apInvoice.id, apInvoiceId)).limit(1);
    const owed = invoiceBalance(current!);
    if (owed <= 0n) break;
    const available = availableBalance(advance);
    const amountIqd = available < owed ? available : owed;
    if (amountIqd <= 0n) continue;
    await settleChecked(tx, ctx, advance, {
      supplierAdvanceId: advance.id,
      apInvoiceId,
      amountIqd,
      settlementDate: invoice.invoiceDate,
      automatic: true,
    });
    applied.push({ advanceNo: advance.advanceNo, amountIqd });
  }
  return applied;
}

/**
 * §8.5 — the supplier gives the money back.
 *
 * *Dr Bank / Cr Supplier Advance.* A refund is not a settlement: nothing was
 * delivered and no debt was discharged, so payables do not move. Keeping the
 * two apart is what lets "how much of what we advanced was actually used?" be
 * answered at all.
 */
export async function refund(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { amountIqd: bigint; refundDate: string; reason: string },
): Promise<{ journalEntryId: string; advanceBalance: bigint }> {
  const advance = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  if (advance.status !== 'posted' && advance.status !== 'partially_executed') {
    throw new SupplierAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'only money that was actually paid out can come back.',
    );
  }

  if (input.reason.trim().length === 0) {
    throw new Error(
      'A refunded advance needs a reason (§5.4). Say why the order will not be delivered, or why the amount changed.',
    );
  }

  const available = availableBalance(advance);
  if (input.amountIqd <= 0n || input.amountIqd > available) {
    throw new SettlementTooLargeError('advance', available, input.amountIqd);
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, advance.supplierId))
    .limit(1);

  const criteria = { branchCode: advance.branchCode };
  const dimensions = { branch: advance.branchCode, business_partner: supplier?.code ?? null };
  const amount = toDecimalString(input.amountIqd, 4n);

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_advance_refund',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'refunded' },
    branchCode: advance.branchCode,
    documentDate: input.refundDate,
    postingDate: input.refundDate,
    description: `Supplier advance ${advance.advanceNo} refunded — ${input.reason.trim()}`,
    lines: [
      { role: 'bank', debit: amount, criteria, dimensions },
      { role: 'supplier_advance', credit: amount, criteria, dimensions },
    ],
  });

  await tx
    .update(supplierAdvance)
    .set({
      refundedAmountIqd: sql`${supplierAdvance.refundedAmountIqd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(supplierAdvance.id, id));

  const refreshed = await load(tx, id);
  const balance = availableBalance(refreshed);

  await tx
    .update(supplierAdvance)
    .set({ status: balance === 0n ? 'closed' : advance.status, updatedAt: new Date() })
    .where(eq(supplierAdvance.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_advance.refunded',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: advance.branchCode,
    after: { amountIqd: amount, advanceBalance: toDecimalString(balance, 4n) },
    reason: input.reason.trim(),
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId, advanceBalance: balance };
}

/**
 * §15 — *"unapplied advance balance is visible and reported."*
 *
 * The question a Finance manager actually asks at month end: how much have we
 * paid suppliers for things we have not received? Reported per advance, with
 * the order it belongs to, because the answer "300 million dinars" is useless
 * without knowing which orders it is waiting on.
 */
export async function unappliedBalances(tx: Tx, options: { supplierId?: string } = {}) {
  const rows = await tx
    .select({
      advanceNo: supplierAdvance.advanceNo,
      supplierCode: businessPartner.code,
      orderNo: purchaseOrder.orderNo,
      requestDate: supplierAdvance.requestDate,
      paidDate: supplierAdvance.paidDate,
      amountIqd: supplierAdvance.amountIqd,
      settledAmountIqd: supplierAdvance.settledAmountIqd,
      refundedAmountIqd: supplierAdvance.refundedAmountIqd,
      unappliedIqd: sql<string>`(${supplierAdvance.amountIqd}
        - ${supplierAdvance.settledAmountIqd}
        - ${supplierAdvance.refundedAmountIqd})`,
      status: supplierAdvance.status,
    })
    .from(supplierAdvance)
    .innerJoin(businessPartner, eq(businessPartner.id, supplierAdvance.supplierId))
    .innerJoin(purchaseOrder, eq(purchaseOrder.id, supplierAdvance.purchaseOrderId))
    .where(
      options.supplierId
        ? and(
            eq(supplierAdvance.supplierId, options.supplierId),
            sql`${supplierAdvance.amountIqd} - ${supplierAdvance.settledAmountIqd} - ${supplierAdvance.refundedAmountIqd} > 0`,
          )
        : sql`${supplierAdvance.amountIqd} - ${supplierAdvance.settledAmountIqd} - ${supplierAdvance.refundedAmountIqd} > 0`,
    )
    .orderBy(supplierAdvance.requestDate);

  // Paid advances only: a request nobody has paid is a plan, not an exposure.
  return rows.filter((row) => row.paidDate !== null);
}

/** The settlement history for one advance — Appendix C's own words. */
export async function settlementHistory(tx: Tx, supplierAdvanceId: string) {
  return tx
    .select({
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      amountIqd: supplierAdvanceSettlement.amountIqd,
      settlementDate: supplierAdvanceSettlement.settlementDate,
      automatic: supplierAdvanceSettlement.automatic,
      settledAt: supplierAdvanceSettlement.settledAt,
      reversedAt: supplierAdvanceSettlement.reversedAt,
      reversalReason: supplierAdvanceSettlement.reversalReason,
    })
    .from(supplierAdvanceSettlement)
    .innerJoin(apInvoice, eq(apInvoice.id, supplierAdvanceSettlement.apInvoiceId))
    .where(eq(supplierAdvanceSettlement.supplierAdvanceId, supplierAdvanceId))
    .orderBy(supplierAdvanceSettlement.settledAt);
}

export async function view(tx: Tx, id: string) {
  const advance = await load(tx, id);
  return { advance, balance: availableBalance(advance) };
}

// ---------------------------------------------------------------------------
// REQ-AP-001 Stage 3 (§21.1) — the Advances screen reads these.
// ---------------------------------------------------------------------------

/** The register: every advance, newest first, with its order, supplier and import. */
export async function listForScreen(tx: Tx) {
  return tx
    .select({
      id: supplierAdvance.id,
      advanceNo: supplierAdvance.advanceNo,
      status: supplierAdvance.status,
      orderNo: purchaseOrder.orderNo,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      payableNo: payable.payableNo,
      requestDate: sql<string>`${supplierAdvance.requestDate}::text`,
      paidDate: sql<string | null>`${supplierAdvance.paidDate}::text`,
      currency: supplierAdvance.currency,
      amountIqd: supplierAdvance.amountIqd,
      amountTxn: supplierAdvance.amountTxn,
      settledAmountIqd: supplierAdvance.settledAmountIqd,
      refundedAmountIqd: supplierAdvance.refundedAmountIqd,
      branchCode: supplierAdvance.branchCode,
    })
    .from(supplierAdvance)
    .innerJoin(businessPartner, eq(businessPartner.id, supplierAdvance.supplierId))
    .innerJoin(purchaseOrder, eq(purchaseOrder.id, supplierAdvance.purchaseOrderId))
    .leftJoin(payable, eq(payable.id, supplierAdvance.payableId))
    .orderBy(sql`${supplierAdvance.createdAt} desc`);
}

export async function viewByNo(tx: Tx, advanceNo: string) {
  const [row] = await tx
    .select({ id: supplierAdvance.id })
    .from(supplierAdvance)
    .where(eq(supplierAdvance.advanceNo, advanceNo))
    .limit(1);
  if (!row) throw new SupplierAdvanceNotFoundError(advanceNo);
  const advance = await load(tx, row.id);
  const [order] = await tx
    .select({ orderNo: purchaseOrder.orderNo })
    .from(purchaseOrder)
    .where(eq(purchaseOrder.id, advance.purchaseOrderId))
    .limit(1);
  const [supplier] = await tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, advance.supplierId))
    .limit(1);
  const [owner] = advance.payableId
    ? await tx
        .select({ payableNo: payable.payableNo })
        .from(payable)
        .where(eq(payable.id, advance.payableId))
        .limit(1)
    : [];
  const people = await tx
    .select({ id: appUser.id, name: appUser.displayName })
    .from(appUser)
    .where(
      inArray(
        appUser.id,
        [advance.createdBy, advance.approvedBy, advance.paidBy].filter((v): v is string => Boolean(v)),
      ),
    );
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  return {
    advance,
    balance: availableBalance(advance),
    orderNo: order?.orderNo ?? null,
    supplier: supplier ?? null,
    payableNo: owner?.payableNo ?? null,
    requestedBy: nameOf(advance.createdBy),
    approvedBy: nameOf(advance.approvedBy),
    paidBy: nameOf(advance.paidBy),
    settlements: await settlementHistory(tx, advance.id),
  };
}

/** Orders an advance may be paid against: committed, not cancelled (§8.5). */
export async function orderChoices(tx: Tx) {
  return tx
    .select({
      id: purchaseOrder.id,
      orderNo: purchaseOrder.orderNo,
      supplierName: businessPartner.legalName,
      branchCode: purchaseOrder.branchCode,
    })
    .from(purchaseOrder)
    .innerJoin(businessPartner, eq(businessPartner.id, purchaseOrder.supplierId))
    .where(sql`${purchaseOrder.status} not in ('draft', 'cancelled', 'closed', 'rejected')`)
    .orderBy(sql`${purchaseOrder.createdAt} desc`);
}
