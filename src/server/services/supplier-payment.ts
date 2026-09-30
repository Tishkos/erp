/**
 * Supplier payment, A/P ageing and statements — Phase 05.9 and 05.10, §15.
 *
 * > Appendix C: *"Supplier payment | Supplier A/P | Bank/Cash | Allocated to
 * > approved open items."*
 *
 * The last step of procure-to-pay, and the one that lets the whole chain be
 * checked: §27's Release 4 acceptance is *"source documents, supplier ledger and
 * G/L reconcile"*, and until money leaves there is nothing to reconcile.
 *
 * **What is deliberately not here.** Payment proposal, payment batch,
 * maker-checker on the bank file, and bank reconciliation are Phase 07 (§17).
 * Building them now would mean building them twice, and the phase plan says so.
 *
 * **Three balances, kept apart on purpose** (§15: *"credit notes and advances
 * are allocated transparently; unapplied balances remain visible"*):
 *
 * | Balance | Question it answers |
 * |---|---|
 * | Invoice outstanding | What do we still owe on this bill? |
 * | Unapplied advance | What have we paid for and not yet received? |
 * | Unapplied credit | What has the supplier agreed to give back and we have not taken? |
 *
 * Netting them into one supplier balance would make each unanswerable, and it
 * is exactly the netting §15 forbids.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  bankCashAccount,
  businessPartner,
  supplierAdvance,
  supplierCreditMemo,
  supplierPayment,
  supplierPaymentAllocation,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { bucketFor, horizonFor } from '../domain/ageing';
import { oldestFirst, proposeAllocation } from '../domain/receipt-allocation';
export { AGEING_BUCKETS, bucketFor, horizonFor, type AgeingBucket } from '../domain/ageing';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as dueNotices from './due-notices';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'supplier_payment';
export const PERMISSION_OBJECT = 'supplier_payment';
const SEQUENCE_KEY = 'SUPPLIER_PAYMENT';

export class SupplierPaymentNotFoundError extends Error {
  readonly code = 'SUPPLIER_PAYMENT_NOT_FOUND';
  constructor(id: string) {
    super(`No supplier payment '${id}'.`);
    this.name = 'SupplierPaymentNotFoundError';
  }
}

export class SupplierPaymentStateError extends Error {
  readonly code = 'SUPPLIER_PAYMENT_STATE_INVALID';
  constructor(paymentNo: string, status: string, detail: string) {
    super(`Supplier payment ${paymentNo} is '${status}': ${detail}`);
    this.name = 'SupplierPaymentStateError';
  }
}

/** §15 — *"blocked suppliers cannot be paid without an authorised override."* */
export class SupplierBlockedError extends Error {
  readonly code = 'SUPPLIER_BLOCKED';
  constructor(
    readonly supplierCode: string,
    readonly status: string,
  ) {
    super(
      `${supplierCode} is ${status.replace('_', ' ')}, so it cannot be paid (§15). ` +
        'A manager may override the block with a reason — the block exists to make that a decision rather than an oversight.',
    );
    this.name = 'SupplierBlockedError';
  }
}

/** §15 — *"payment amount cannot exceed approved available invoice balance."* */
export class AllocationTooLargeError extends Error {
  readonly code = 'ALLOCATION_TOO_LARGE';
  constructor(
    readonly limit: 'payment' | 'invoice',
    available: bigint,
    requested: bigint,
  ) {
    const money = (v: bigint) => toDecimalString(v, 4n);
    super(
      `Allocating ${money(requested)} would exceed the ${limit} balance of ${money(available)} (§15). ` +
        (limit === 'payment'
          ? 'A payment cannot be spread further than the money that left the bank.'
          : 'An invoice can only be paid down to zero; the remainder of the payment goes to another invoice or stays unapplied.'),
    );
    this.name = 'AllocationTooLargeError';
  }
}

export class DuplicateAllocationError extends Error {
  readonly code = 'DUPLICATE_ALLOCATION';
  constructor(
    readonly paymentNo: string,
    readonly invoiceNo: string,
  ) {
    super(
      `Payment ${paymentNo} is already allocated to invoice ${invoiceNo} (§15). ` +
        'Reverse that allocation if it was wrong; applying the same money twice would clear a debt that is still owed.',
    );
    this.name = 'DuplicateAllocationError';
  }
}

export class NothingToAllocateError extends Error {
  readonly code = 'PAYMENT_NOTHING_TO_ALLOCATE';

  constructor(readonly paymentNo: string) {
    super(
      `Payment ${paymentNo} has nothing left to apply, or the supplier has no invoice still owing ` +
        'that this payment is not already against. Money with no debt to settle stays unallocated.',
    );
    this.name = 'NothingToAllocateError';
  }
}

export interface CreatePaymentInput {
  readonly supplierId: string;
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly paymentDate: string;
  readonly amountIqd: bigint;
  readonly currency?: string;
  readonly reference?: string | null;
  readonly note?: string | null;
  /** §15 — a manager's decision to pay a blocked supplier anyway, and why. */
  readonly blockedOverrideBy?: string | null;
  readonly blockedOverrideReason?: string | null;
}

async function load(tx: Tx, id: string) {
  const [payment] = await tx
    .select()
    .from(supplierPayment)
    .where(eq(supplierPayment.id, id))
    .limit(1);
  if (!payment) throw new SupplierPaymentNotFoundError(id);
  return payment;
}

/** What is still owed on an invoice — total, less advances, credits and payments. */
export function outstandingOn(invoice: typeof apInvoice.$inferSelect): bigint {
  return parseDecimal(invoice.totalIqd, 4n) - parseDecimal(invoice.settledAmountIqd, 4n);
}

/** How much of a payment has not been put against anything yet. */
export function unallocatedOn(payment: typeof supplierPayment.$inferSelect): bigint {
  return parseDecimal(payment.amountIqd, 4n) - parseDecimal(payment.allocatedAmountIqd, 4n);
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreatePaymentInput,
): Promise<{ id: string; paymentNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.amountIqd <= 0n) {
    throw new Error('A payment of nothing pays nothing. State the amount leaving the bank.');
  }

  const [supplier] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, input.supplierId))
    .limit(1);

  if (!supplier) throw new Error(`No business partner with id '${input.supplierId}'.`);
  if (!supplier.isSupplier) {
    throw new Error(`${supplier.code} is not a supplier, so nothing is owed to them (§6).`);
  }

  // §15 — the block, and the override that §15 itself allows.
  if (supplier.status === 'blocked' || supplier.status === 'on_hold') {
    if (!input.blockedOverrideBy) {
      throw new SupplierBlockedError(supplier.code, supplier.status);
    }
    if (!input.blockedOverrideReason || input.blockedOverrideReason.trim().length === 0) {
      throw new Error(
        `Paying ${supplier.code} while they are ${supplier.status.replace('_', ' ')} needs a reason (§15, §5.4). ` +
          'Say what makes this payment necessary despite the block.',
      );
    }
    if (input.blockedOverrideBy === ctx.principal.userId) {
      throw new Error(
        'An override is somebody else authorising the exception (§5.2). ' +
          'The person raising the payment cannot also be the one who waives the block.',
      );
    }
  }

  // §17 — the bank account's currency is the payment's currency.
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${input.bankCashAccountId}'.`);
  if (account.currency !== (input.currency ?? 'IQD')) {
    throw new Error(
      `${account.code} holds ${account.currency} and this payment is in ${input.currency ?? 'IQD'} (§17). ` +
        'Pay from an account in the payment currency.',
    );
  }
  if (!account.active) {
    throw new Error(`${account.code} is closed, so no payment can leave it.`);
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.paymentDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(supplierPayment)
    .values({
      paymentNo: allocated.documentNo,
      supplierId: input.supplierId,
      bankCashAccountId: input.bankCashAccountId,
      branchCode: input.branchCode,
      paymentDate: input.paymentDate,
      currency: input.currency ?? 'IQD',
      amountIqd: toDecimalString(input.amountIqd, 4n),
      reference: input.reference ?? null,
      note: input.note ?? null,
      blockedOverrideBy: input.blockedOverrideBy ?? null,
      blockedOverrideAt: input.blockedOverrideBy ? new Date() : null,
      blockedOverrideReason: input.blockedOverrideReason?.trim() ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: supplierPayment.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_payment.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      paymentNo: allocated.documentNo,
      supplier: supplier.code,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      blockedOverride: Boolean(input.blockedOverrideBy),
      supplierStatus: supplier.status,
    },
    reason: input.blockedOverrideReason?.trim() ?? null,
    outcome: 'success',
  });

  return { id: created!.id, paymentNo: allocated.documentNo };
}

/**
 * §15 — puts part of a payment against one invoice.
 *
 * Bounded on both sides: never more than the payment still holds, never more
 * than the invoice still owes. Either alone would let money go missing — the
 * first spreads a payment further than the bank actually sent, the second
 * creates a credit balance on a debt, which is a credit memo and a different
 * document.
 */
export async function allocate(
  tx: Tx,
  ctx: ActorContext,
  input: { supplierPaymentId: string; apInvoiceId: string; amountIqd: bigint },
): Promise<{ allocationId: string; paymentUnallocated: bigint; invoiceOutstanding: bigint }> {
  const payment = await load(tx, input.supplierPaymentId);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: payment.branchCode,
  });

  if (payment.status !== 'draft' && payment.status !== 'approved' && payment.status !== 'posted') {
    throw new SupplierPaymentStateError(
      payment.paymentNo,
      payment.status,
      'a reversed or cancelled payment allocates nothing.',
    );
  }

  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);

  if (!invoice) throw new Error(`No A/P invoice with id '${input.apInvoiceId}'.`);

  if (invoice.supplierId !== payment.supplierId) {
    throw new Error(
      `Payment ${payment.paymentNo} was made to a different supplier from invoice ${invoice.invoiceNo}. ` +
        'A payment settles only the debts of the supplier it was paid to.',
    );
  }

  // §15 — "approved open items". An invoice that has not posted is not yet a
  // debt, and paying it would put money against something nobody approved.
  if (invoice.status !== 'posted' && invoice.status !== 'partially_executed') {
    throw new Error(
      `Invoice ${invoice.invoiceNo} is '${invoice.status}'. A payment is allocated to approved open items (Appendix C).`,
    );
  }

  const [existing] = await tx
    .select({ id: supplierPaymentAllocation.id })
    .from(supplierPaymentAllocation)
    .where(
      and(
        eq(supplierPaymentAllocation.supplierPaymentId, input.supplierPaymentId),
        eq(supplierPaymentAllocation.apInvoiceId, input.apInvoiceId),
        isNull(supplierPaymentAllocation.reversedAt),
      ),
    )
    .limit(1);

  if (existing) throw new DuplicateAllocationError(payment.paymentNo, invoice.invoiceNo);

  const unallocated = unallocatedOn(payment);
  if (input.amountIqd <= 0n || input.amountIqd > unallocated) {
    throw new AllocationTooLargeError('payment', unallocated, input.amountIqd);
  }

  const owed = outstandingOn(invoice);
  if (input.amountIqd > owed) {
    throw new AllocationTooLargeError('invoice', owed, input.amountIqd);
  }

  const amount = toDecimalString(input.amountIqd, 4n);

  const [allocation] = await tx
    .insert(supplierPaymentAllocation)
    .values({
      supplierPaymentId: input.supplierPaymentId,
      apInvoiceId: input.apInvoiceId,
      amountIqd: amount,
      allocatedBy: ctx.principal.userId,
    })
    .returning({ id: supplierPaymentAllocation.id });

  await tx
    .update(supplierPayment)
    .set({
      allocatedAmountIqd: sql`${supplierPayment.allocatedAmountIqd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(supplierPayment.id, input.supplierPaymentId));

  await tx
    .update(apInvoice)
    .set({
      settledAmountIqd: sql`${apInvoice.settledAmountIqd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, input.apInvoiceId));

  const [invoiceAfter] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);

  const remaining = outstandingOn(invoiceAfter!);

  // §15 acceptance criterion 3 — "payment allocates to specific invoices and
  // updates ageing immediately". The ageing reads this status and this
  // balance, so it moves in the same transaction the allocation does.
  await tx
    .update(apInvoice)
    .set({ status: remaining === 0n ? 'settled' : 'partially_executed', updatedAt: new Date() })
    .where(eq(apInvoice.id, input.apInvoiceId));

  // §21 — an invoice settled after its due date, said once, when it settles.
  // Not a chase: the money is in. It is the record of how an account actually
  // behaves, which a list of what is *currently* overdue cannot give — a
  // supplier always paid eleven days late never stays on that list long
  // enough to notice.
  if (remaining === 0n) {
    const [supplier] = await tx
      .select({ name: businessPartner.legalName })
      .from(businessPartner)
      .where(eq(businessPartner.id, payment.supplierId))
      .limit(1);
    await dueNotices.announcePaidLate(tx, {
      side: 'supplier',
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      partyName: supplier?.name ?? null,
      dueDate: invoice.dueDate,
      paidOn: payment.paymentDate,
      branchCode: payment.branchCode,
      link: `/purchasing/ap-invoices/${invoice.invoiceNo}`,
    });
  }

  const paymentAfter = await load(tx, input.supplierPaymentId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_payment.allocated',
    objectType: PERMISSION_OBJECT,
    objectId: input.supplierPaymentId,
    branchCode: payment.branchCode,
    after: {
      invoiceNo: invoice.invoiceNo,
      amountIqd: amount,
      invoiceOutstanding: toDecimalString(remaining, 4n),
      paymentUnallocated: toDecimalString(unallocatedOn(paymentAfter), 4n),
    },
    outcome: 'success',
  });

  return {
    allocationId: allocation!.id,
    paymentUnallocated: unallocatedOn(paymentAfter),
    invoiceOutstanding: remaining,
  };
}

/**
 * Posts the payment — Appendix C: *Dr Supplier A/P / Cr Bank or Cash*.
 *
 * The whole payment posts, allocated or not. Money that has left the bank has
 * left it, and an unallocated remainder is a real credit sitting on the
 * supplier's account — §15 asks for exactly that to stay visible rather than
 * being held back until somebody decides where it belongs.
 */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const payment = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: payment.branchCode,
  });

  if (payment.status !== 'draft' && payment.status !== 'approved') {
    throw new SupplierPaymentStateError(
      payment.paymentNo,
      payment.status,
      'it has already posted.',
    );
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, payment.supplierId))
    .limit(1);

  const criteria = { branchCode: payment.branchCode };
  const dimensions = { branch: payment.branchCode, business_partner: supplier?.code ?? null };

  // §17 — the credit goes to the account the money actually left, not to
  // whichever account the `bank` mapping names. With one bank account the two
  // are the same and the distinction looks academic; with two, a mapping would
  // credit the wrong account on every payment and 07.1's identity — an account's
  // ledger balance *is* its G/L balance — would quietly stop holding.
  const [account] = await tx
    // The code as well as the id: the bank subledger's party is the account
    // code, and without it a G/L account flagged as a bank control account
    // refuses the whole posting (§1.2).
    .select({ glAccountId: bankCashAccount.glAccountId, code: bankCashAccount.code })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, payment.bankCashAccountId))
    .limit(1);

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_payment',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'paid' },
    branchCode: payment.branchCode,
    documentDate: payment.paymentDate,
    postingDate: payment.paymentDate,
    description: `Supplier payment ${payment.paymentNo} — ${supplier?.code ?? 'supplier'}`,
    lines: [
      { role: 'supplier_payable', debit: payment.amountIqd, criteria, dimensions },
      {
        role: 'bank',
        accountId: account!.glAccountId,
        credit: payment.amountIqd,
        criteria,
        dimensions,
        bankAccountCode: account!.code,
      },
    ],
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status, 'posted');

  await tx
    .update(supplierPayment)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(supplierPayment.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_payment.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId },
    outcome: 'success',
  });

  // §21 — the other side of the same coin: money leaving is news to the
  // person who approved it.
  const parties = await partiesOf(tx, id);
  await dueNotices.announceSettlement(tx, {
    side: 'supplier',
    documentId: id,
    documentNo: payment.paymentNo,
    partyName: parties.supplierName,
    amountIqd: payment.amountIqd,
    branchCode: payment.branchCode,
    link: `/purchasing/supplier-payments/${payment.paymentNo}`,
  });

  return { journalEntryId: result.journalEntryId };
}

/**
 * §14.3 and §17 — a posted payment that has to be undone.
 *
 * The case that makes this necessary is Phase 07.2's returned payment: the bank
 * sent the money back, so the debt is open again and the journal must say so.
 *
 * Three things move together and none of them is optional. A **counter-entry is
 * posted** — §3.2 keeps automatic journals out of the generic reversal, because
 * a journal that belongs to a document is corrected through that document, and
 * this is that document doing it. Every live allocation is reversed, which puts
 * the invoices back to what they owed and their status back to open. And the
 * payment itself is marked reversed with the reason, so the supplier account
 * stops showing an unallocated credit that no longer exists.
 *
 * Doing any two of the three would leave the ledger and the subledger
 * disagreeing, which is the failure §27's Release 4 acceptance is written to
 * catch.
 */
export async function reverse(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { reversalDate: string; reason: string },
): Promise<{ reversalEntryId: string }> {
  const payment = await load(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: payment.branchCode,
  });

  if (payment.status !== 'posted') {
    throw new SupplierPaymentStateError(
      payment.paymentNo,
      payment.status,
      'only a posted payment can be reversed.',
    );
  }
  if (!payment.journalEntryId) {
    throw new Error(`${payment.paymentNo} is posted but has no journal entry to reverse.`);
  }
  if (!input.reason.trim()) {
    throw new Error(
      `Reversing ${payment.paymentNo} needs a reason (§14.3). ` +
        'A reversal with no reason records that money came back without recording why.',
    );
  }

  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, payment.supplierId))
    .limit(1);

  const [account] = await tx
    // The code as well as the id: the bank subledger's party is the account
    // code, and without it a G/L account flagged as a bank control account
    // refuses the whole posting (§1.2).
    .select({ glAccountId: bankCashAccount.glAccountId, code: bankCashAccount.code })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, payment.bankCashAccountId))
    .limit(1);

  const criteria = { branchCode: payment.branchCode };
  const dimensions = { branch: payment.branchCode, business_partner: supplier?.code ?? null };

  // The same two accounts, the other way round. Not a re-derived entry: the
  // amounts are the payment's own, so what comes back is exactly what left.
  const reversal = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_payment',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'reversed' },
    branchCode: payment.branchCode,
    documentDate: input.reversalDate,
    postingDate: input.reversalDate,
    description: `Supplier payment ${payment.paymentNo} reversed — ${input.reason.trim()}`,
    lines: [
      {
        role: 'bank',
        accountId: account!.glAccountId,
        debit: payment.amountIqd,
        criteria,
        dimensions,
        bankAccountCode: account!.code,
      },
      { role: 'supplier_payable', credit: payment.amountIqd, criteria, dimensions },
    ],
  });

  const live = await tx
    .select()
    .from(supplierPaymentAllocation)
    .where(
      and(
        eq(supplierPaymentAllocation.supplierPaymentId, id),
        isNull(supplierPaymentAllocation.reversedAt),
      ),
    );

  for (const allocation of live) {
    await tx
      .update(supplierPaymentAllocation)
      .set({
        reversedBy: ctx.principal.userId,
        reversedAt: new Date(),
        reversalReason: input.reason.trim(),
      })
      .where(eq(supplierPaymentAllocation.id, allocation.id));

    await tx
      .update(apInvoice)
      .set({
        settledAmountIqd: sql`${apInvoice.settledAmountIqd} - ${allocation.amountIqd}`,
        updatedAt: new Date(),
      })
      .where(eq(apInvoice.id, allocation.apInvoiceId));

    const [invoiceAfter] = await tx
      .select()
      .from(apInvoice)
      .where(eq(apInvoice.id, allocation.apInvoiceId))
      .limit(1);

    // Back to open, and to the right kind of open: an invoice that still has
    // another payment against it is partly executed, not untouched.
    const settled = parseDecimal(invoiceAfter!.settledAmountIqd, 4n);
    await tx
      .update(apInvoice)
      .set({ status: settled > 0n ? 'partially_executed' : 'posted', updatedAt: new Date() })
      .where(eq(apInvoice.id, allocation.apInvoiceId));
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status, 'reversed', input.reason.trim());

  await tx
    .update(supplierPayment)
    .set({
      status: 'reversed',
      allocatedAmountIqd: '0',
      reversedBy: ctx.principal.userId,
      reversedAt: new Date(),
      reversalReason: input.reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(supplierPayment.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_payment.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status, allocations: live.length },
    after: { status: 'reversed', reversalEntryId: reversal.journalEntryId },
    reason: input.reason.trim(),
    outcome: 'success',
  });

  return { reversalEntryId: reversal.journalEntryId };
}

/** Appendix C — the allocation history for one payment. */
export async function allocationHistory(tx: Tx, supplierPaymentId: string) {
  return tx
    .select({
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      amountIqd: supplierPaymentAllocation.amountIqd,
      allocatedAt: supplierPaymentAllocation.allocatedAt,
      reversedAt: supplierPaymentAllocation.reversedAt,
    })
    .from(supplierPaymentAllocation)
    .innerJoin(apInvoice, eq(apInvoice.id, supplierPaymentAllocation.apInvoiceId))
    .where(eq(supplierPaymentAllocation.supplierPaymentId, supplierPaymentId))
    .orderBy(supplierPaymentAllocation.allocatedAt);
}

/** Which payments settled one invoice — the same history from the other end. */
export async function paymentsFor(tx: Tx, apInvoiceId: string) {
  return tx
    .select({
      paymentNo: supplierPayment.paymentNo,
      paymentDate: supplierPayment.paymentDate,
      amountIqd: supplierPaymentAllocation.amountIqd,
      reference: supplierPayment.reference,
    })
    .from(supplierPaymentAllocation)
    .innerJoin(supplierPayment, eq(supplierPayment.id, supplierPaymentAllocation.supplierPaymentId))
    .where(
      and(
        eq(supplierPaymentAllocation.apInvoiceId, apInvoiceId),
        isNull(supplierPaymentAllocation.reversedAt),
      ),
    )
    .orderBy(supplierPayment.paymentDate);
}

// ---------------------------------------------------------------------------
// 05.9 — A/P ageing and the supplier account (§15)
// ---------------------------------------------------------------------------

/**
 * §15 — A/P ageing by supplier, currency, branch and due bucket.
 *
 * Reads the invoices themselves rather than a maintained summary, so it cannot
 * drift from them: the 05.9 gate asks that the ageing *tie to the G/L control
 * account*, and a cached total is exactly how those two come apart.
 */
export async function ageing(tx: Tx, asOf: string) {
  const rows = await tx
    .select({
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      branchCode: apInvoice.branchCode,
      currency: apInvoice.currency,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      invoiceDate: apInvoice.invoiceDate,
      dueDate: apInvoice.dueDate,
      totalIqd: apInvoice.totalIqd,
      settledIqd: apInvoice.settledAmountIqd,
      outstandingIqd: sql<string>`(${apInvoice.totalIqd} - ${apInvoice.settledAmountIqd})`,
    })
    .from(apInvoice)
    .innerJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .where(
      and(
        sql`${apInvoice.status} in ('posted', 'partially_executed')`,
        sql`${apInvoice.totalIqd} - ${apInvoice.settledAmountIqd} > 0`,
      ),
    )
    .orderBy(businessPartner.code, apInvoice.dueDate);

  return rows.map((row) => ({ ...row, bucket: bucketFor(row.dueDate, asOf) }));
}

/**
 * §15 — the supplier account: what is owed, and what is held against it.
 *
 * The three balances stay separate. A single netted figure would be the number
 * most people ask for and the one nobody can act on: it cannot tell you whether
 * to chase a credit note, apply an advance, or pay.
 */
export async function supplierAccount(tx: Tx, supplierId: string, asOf: string) {
  const invoices = (await ageing(tx, asOf)).filter(
    (row) => row.supplierCode !== undefined,
  );

  const [partner] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, supplierId))
    .limit(1);

  const mine = invoices.filter((row) => row.supplierCode === partner?.code);

  const advances = await tx
    .select({
      advanceNo: supplierAdvance.advanceNo,
      unappliedIqd: sql<string>`(${supplierAdvance.amountIqd}
        - ${supplierAdvance.settledAmountIqd}
        - ${supplierAdvance.refundedAmountIqd})`,
    })
    .from(supplierAdvance)
    .where(
      and(
        eq(supplierAdvance.supplierId, supplierId),
        sql`${supplierAdvance.paidDate} is not null`,
        sql`${supplierAdvance.amountIqd} - ${supplierAdvance.settledAmountIqd} - ${supplierAdvance.refundedAmountIqd} > 0`,
      ),
    );

  const credits = await tx
    .select({
      memoNo: supplierCreditMemo.memoNo,
      unappliedIqd: sql<string>`(${supplierCreditMemo.amountIqd} - ${supplierCreditMemo.allocatedAmountIqd})`,
    })
    .from(supplierCreditMemo)
    .where(
      and(
        eq(supplierCreditMemo.supplierId, supplierId),
        sql`${supplierCreditMemo.amountIqd} - ${supplierCreditMemo.allocatedAmountIqd} > 0`,
      ),
    );

  const unallocatedPayments = await tx
    .select({
      paymentNo: supplierPayment.paymentNo,
      unallocatedIqd: sql<string>`(${supplierPayment.amountIqd} - ${supplierPayment.allocatedAmountIqd})`,
    })
    .from(supplierPayment)
    .where(
      and(
        eq(supplierPayment.supplierId, supplierId),
        eq(supplierPayment.status, 'posted'),
        sql`${supplierPayment.amountIqd} - ${supplierPayment.allocatedAmountIqd} > 0`,
      ),
    );

  const sum = (rows: { unappliedIqd?: string; unallocatedIqd?: string }[]) =>
    rows.reduce(
      (total, row) => total + parseDecimal(row.unappliedIqd ?? row.unallocatedIqd ?? '0', 4n),
      0n,
    );

  return {
    supplierCode: partner?.code ?? null,
    status: partner?.status ?? null,
    openInvoices: mine,
    outstandingIqd: mine.reduce((total, row) => total + parseDecimal(row.outstandingIqd, 4n), 0n),
    unappliedAdvanceIqd: sum(advances),
    unappliedCreditIqd: sum(credits),
    unallocatedPaymentIqd: sum(unallocatedPayments),
    advances,
    credits,
    unallocatedPayments,
  };
}

/**
 * §15 — the cash requirement forecast.
 *
 * What has to be paid, and when, from the due dates already recorded. Grouped
 * into the same buckets the ageing uses, forwards rather than backwards: the
 * ageing asks how late we are, this asks how much is about to be needed.
 */
export async function cashRequirement(tx: Tx, asOf: string) {
  const open = await ageing(tx, asOf);
  const horizon: Record<string, bigint> = { overdue: 0n, '0-30': 0n, '31-60': 0n, '61+': 0n };

  for (const row of open) {
    horizon[horizonFor(row.dueDate, asOf)]! += parseDecimal(row.outstandingIqd, 4n);
  }

  return horizon;
}

/**
 * §15 — *"Due Invoice and Payment Proposal"*, and criterion 2: *"payment
 * proposal includes only eligible approved items."*
 *
 * Three things make an item ineligible, and each is a different kind of
 * ineligible:
 *
 * | Reason | Why it is excluded |
 * |---|---|
 * | Not yet due | Paying early is a decision, not a default |
 * | Not posted | It is not a debt until it has been approved and posted |
 * | Supplier blocked or on hold | §15 — paying needs an authorised override, which a proposal cannot grant |
 *
 * The blocked ones are **returned separately rather than dropped**. A proposal
 * that silently omitted them would leave Finance wondering why a supplier they
 * expected to pay was missing, and the answer — that somebody blocked them — is
 * the most useful thing on the report.
 *
 * Payment *batching*, maker-checker and the bank file are Phase 07 (§17). This
 * is the list; approving and executing it is that phase's work.
 */
export async function paymentProposal(tx: Tx, asOf: string) {
  const open = await ageing(tx, asOf);

  const statuses = await tx
    .select({ code: businessPartner.code, status: businessPartner.status })
    .from(businessPartner);
  const statusByCode = new Map(statuses.map((row) => [row.code, row.status]));

  const eligible: typeof open = [];
  const blocked: (typeof open[number] & { supplierStatus: string })[] = [];

  for (const row of open) {
    // Not due yet: `current` means the due date has not passed.
    if (row.bucket === 'current') continue;

    const status = statusByCode.get(row.supplierCode) ?? 'active';
    if (status === 'blocked' || status === 'on_hold') {
      blocked.push({ ...row, supplierStatus: status });
      continue;
    }
    eligible.push(row);
  }

  return {
    eligible,
    blocked,
    eligibleTotalIqd: eligible.reduce(
      (total, row) => total + parseDecimal(row.outstandingIqd, 4n),
      0n,
    ),
    blockedTotalIqd: blocked.reduce(
      (total, row) => total + parseDecimal(row.outstandingIqd, 4n),
      0n,
    ),
  };
}

/**
 * §15 acceptance criterion 4 — supplier statement reconciliation.
 *
 * The supplier sends a list of what they think is open. This says what is on
 * *our* books, what is on *theirs*, and what appears on one and not the other —
 * which is the only part anybody actually works on.
 */
export interface StatementLine {
  readonly supplierInvoiceNo: string;
  readonly amountIqd: bigint;
}

export async function reconcileStatement(
  tx: Tx,
  supplierId: string,
  statement: readonly StatementLine[],
  asOf: string,
) {
  const account = await supplierAccount(tx, supplierId, asOf);
  const ours = new Map(
    account.openInvoices.map((row) => [
      row.supplierInvoiceNo,
      parseDecimal(row.outstandingIqd, 4n),
    ]),
  );
  const theirs = new Map(statement.map((line) => [line.supplierInvoiceNo, line.amountIqd]));

  const matched: { supplierInvoiceNo: string; amountIqd: bigint }[] = [];
  const differing: { supplierInvoiceNo: string; oursIqd: bigint; theirsIqd: bigint }[] = [];
  const onlyOnOurs: { supplierInvoiceNo: string; amountIqd: bigint }[] = [];
  const onlyOnTheirs: { supplierInvoiceNo: string; amountIqd: bigint }[] = [];

  for (const [number, amount] of ours) {
    const other = theirs.get(number);
    if (other === undefined) onlyOnOurs.push({ supplierInvoiceNo: number, amountIqd: amount });
    else if (other === amount) matched.push({ supplierInvoiceNo: number, amountIqd: amount });
    else differing.push({ supplierInvoiceNo: number, oursIqd: amount, theirsIqd: other });
  }

  for (const [number, amount] of theirs) {
    if (!ours.has(number)) onlyOnTheirs.push({ supplierInvoiceNo: number, amountIqd: amount });
  }

  return { matched, differing, onlyOnOurs, onlyOnTheirs };
}

/**
 * The register — Operations block 6's list of Payments.
 *
 *   Payments   Supplier Name; Supplier Code; Date; Bank/Cash Name;
 *              Bank/Cash Code; Amount; Reference; Supplier Invoice.
 *
 * Every column the sponsor names except the invoice, which is not one value:
 * a payment can be spread across several, including partly, so it belongs on
 * the payment's own page rather than squeezed into a cell here.
 */
export async function list(tx: Tx) {
  return tx
    .select({
      id: supplierPayment.id,
      paymentNo: supplierPayment.paymentNo,
      supplierName: businessPartner.legalName,
      supplierCode: businessPartner.code,
      bankName: bankCashAccount.name,
      bankCode: bankCashAccount.code,
      paymentDate: supplierPayment.paymentDate,
      amountIqd: supplierPayment.amountIqd,
      allocatedAmountIqd: supplierPayment.allocatedAmountIqd,
      reference: supplierPayment.reference,
      status: supplierPayment.status,
      branchCode: supplierPayment.branchCode,
    })
    .from(supplierPayment)
    .leftJoin(businessPartner, eq(businessPartner.id, supplierPayment.supplierId))
    .leftJoin(bankCashAccount, eq(bankCashAccount.id, supplierPayment.bankCashAccountId))
    .orderBy(desc(supplierPayment.paymentDate), desc(supplierPayment.paymentNo));
}

/**
 * Who was paid and from which account — the build's Supplier Name and Code
 * and Bank/Cash Name and Code, which the payment carries as references.
 */
export async function partiesOf(tx: Tx, supplierPaymentId: string) {
  const [row] = await tx
    .select({
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      bankCode: bankCashAccount.code,
      bankName: bankCashAccount.name,
    })
    .from(supplierPayment)
    .leftJoin(businessPartner, eq(businessPartner.id, supplierPayment.supplierId))
    .leftJoin(bankCashAccount, eq(bankCashAccount.id, supplierPayment.bankCashAccountId))
    .where(eq(supplierPayment.id, supplierPaymentId))
    .limit(1);
  return row ?? { supplierCode: null, supplierName: null, bankCode: null, bankName: null };
}

/** The invoices this payment settles, with what it put against each. Live allocations only. */
export async function allocationsOf(tx: Tx, supplierPaymentId: string) {
  return tx
    .select({
      invoiceNo: apInvoice.invoiceNo,
      dueDate: apInvoice.dueDate,
      amountIqd: supplierPaymentAllocation.amountIqd,
      allocatedAt: supplierPaymentAllocation.allocatedAt,
    })
    .from(supplierPaymentAllocation)
    .innerJoin(apInvoice, eq(apInvoice.id, supplierPaymentAllocation.apInvoiceId))
    .where(
      and(
        eq(supplierPaymentAllocation.supplierPaymentId, supplierPaymentId),
        isNull(supplierPaymentAllocation.reversedAt),
      ),
    )
    .orderBy(supplierPaymentAllocation.allocatedAt);
}

export async function viewByNo(tx: Tx, paymentNo: string) {
  const [row] = await tx
    .select({ id: supplierPayment.id })
    .from(supplierPayment)
    .where(eq(supplierPayment.paymentNo, paymentNo))
    .limit(1);
  if (!row) return null;
  return view(tx, row.id);
}

/** A supplier's invoices with something still owed on them, oldest first. */
export async function openInvoicesFor(tx: Tx, supplierId: string) {
  const rows = await tx
    .select()
    .from(apInvoice)
    .where(and(eq(apInvoice.supplierId, supplierId), // Part-paid invoices too: block 6 allocates partial payments, and the rest
      // of a part-paid invoice is still owed.
      inArray(apInvoice.status, ['posted', 'partially_executed', 'settled'])))
    .orderBy(asc(apInvoice.dueDate));

  const open = rows
    .map((invoice) => ({
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      supplierInvoiceNo: invoice.supplierInvoiceNo,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      totalIqd: invoice.totalIqd,
      outstanding: outstandingOn(invoice),
    }))
    .filter((invoice) => invoice.outstanding > 0n);

  // Read down the screen in the order the money would be applied in — the
  // same rule `proposeAllocation` follows, so the list and the plan agree.
  const order = new Map(
    oldestFirst(
      open.map((invoice) => ({
        id: invoice.id,
        dueDate: invoice.dueDate,
        invoiceDate: invoice.invoiceDate,
        invoiceNo: invoice.invoiceNo,
        openIqd: invoice.outstanding,
      })),
    ).map((invoice, index) => [invoice.id, index]),
  );

  return open.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * What oldest-first would do with what is left of this payment.
 *
 * The screen fills each invoice's box from this, so the amounts offered add up
 * to the payment instead of each offering the whole of it.
 */
export async function planFor(
  tx: Tx,
  payment: typeof supplierPayment.$inferSelect,
): Promise<Map<string, bigint>> {
  const open = await openInvoicesFor(tx, payment.supplierId);

  /*
   * Skip what this payment is already against.
   *
   * §15 allows one live allocation per payment and invoice — a second is
   * refused as a duplicate. So an invoice this payment has already part-paid
   * is not a candidate for the rest of it, however much it still owes; the
   * remainder goes to the next invoice down, and the clerk who wants to
   * increase the first one reverses that allocation and makes it again.
   */
  const already = new Set(
    (
      await tx
        .select({ apInvoiceId: supplierPaymentAllocation.apInvoiceId })
        .from(supplierPaymentAllocation)
        .where(
          and(
            eq(supplierPaymentAllocation.supplierPaymentId, payment.id),
            isNull(supplierPaymentAllocation.reversedAt),
          ),
        )
    ).map((row) => row.apInvoiceId),
  );

  const plan = proposeAllocation(
    {
      amountIqd: parseDecimal(payment.amountIqd, 4n),
      allocatedIqd: parseDecimal(payment.allocatedAmountIqd, 4n),
    },
    open
      .filter((invoice) => !already.has(invoice.id))
      .map((invoice) => ({
        id: invoice.id,
        dueDate: invoice.dueDate,
        invoiceDate: invoice.invoiceDate,
        invoiceNo: invoice.invoiceNo,
        openIqd: invoice.outstanding,
      })),
  );
  // `proposeAllocation` names its key for the receivable side; the plan itself
  // is the same arithmetic whichever way the money is going.
  return new Map(plan.map((line) => [line.arInvoiceId, line.amountIqd]));
}

/**
 * Put what is left of a payment against the oldest supplier invoices first.
 *
 * The whole plan in one transaction. A supplier who is paid 100,000 against a
 * 50,000 invoice from Monday and a 100,000 from Tuesday has settled Monday and
 * half of Tuesday, and the ageing has to say so.
 */
export async function allocateOldestFirst(
  tx: Tx,
  ctx: ActorContext,
  supplierPaymentId: string,
): Promise<{ invoices: number; paymentUnallocated: bigint }> {
  const payment = await load(tx, supplierPaymentId);
  const plan = [...(await planFor(tx, payment))];

  if (plan.length === 0) {
    throw new NothingToAllocateError(payment.paymentNo);
  }

  let unallocatedLeft = unallocatedOn(payment);
  for (const [apInvoiceId, amountIqd] of plan) {
    const outcome = await allocate(tx, ctx, { supplierPaymentId, apInvoiceId, amountIqd });
    unallocatedLeft = outcome.paymentUnallocated;
  }

  return { invoices: plan.length, paymentUnallocated: unallocatedLeft };
}

export async function view(tx: Tx, id: string) {
  const payment = await load(tx, id);
  return { payment, unallocated: unallocatedOn(payment) };
}
