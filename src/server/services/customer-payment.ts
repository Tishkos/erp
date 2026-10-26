/**
 * Customer Payment — money paid out to a customer (0428, 2026-10-26).
 *
 * By direction: "a customer account … the only transactions should be receipts and payments …
 * for payments I don't want to use bank transfers or material returns". The Customer Receipt's
 * mirror: Dr the customer's receivable, naming the customer (the receipt's own posting rule, copied
 * by 0428 and constrained to the customer control account in POSTING_MAP) / Cr the bank or cash
 * account the money left, in that account's own currency. So the customer's statement shows a
 * receipt as a credit and a payment as a debit, and nothing else needs to touch it.
 *
 * Draft → Approved (by somebody other than whoever wrote it; a super user alone excepted, as 0278
 * lets every approval) → Posted → Reversed (through the journal's own reversal, with a reason, dated
 * the day it is made); Draft or Approved → Cancelled with a reason. The database holds the road,
 * the four eyes and the frozen fields (0428); this service says the same in words first.
 */
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/client';
import { appUser, bankCashAccount, businessPartner, customerPayment, journalEntry } from '../db/schema';
import type { DocumentStatus } from '../domain/statuses';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as journal from './journal';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';
import { MoneyOutError, assertAmount, assertMethod, bankLine, decimal, dinarsOf, payingAccount, scaled } from './money-out';

export const DOCUMENT_TYPE = 'customer_payment';
export const PERMISSION_OBJECT = 'customer_payment';
const SEQUENCE_KEY = 'CUSTOMER_PAYMENT';
export const POSTING_EVENT = 'sales.customer_payment';

export class CustomerPaymentNotFoundError extends Error {
  readonly code = 'CUSTOMER_PAYMENT_NOT_FOUND';
  constructor(ref: string) {
    super(`No customer payment '${ref}'.`);
    this.name = 'CustomerPaymentNotFoundError';
  }
}

export interface CreateCustomerPaymentInput {
  readonly customerId: string;
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly paymentDate: string;
  /** In the account's own currency. */
  readonly amount: bigint;
  readonly paymentMethodCode?: string | null;
  readonly purpose: string;
  readonly reference?: string | null;
  readonly note?: string | null;
}

async function load(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(customerPayment).where(eq(customerPayment.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new CustomerPaymentNotFoundError(id);
  return row;
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateCustomerPaymentInput): Promise<{ id: string; paymentNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: input.branchCode });
  assertAmount(input.amount);
  const purpose = input.purpose.trim();
  if (!purpose) throw new MoneyOutError('Say what the payment is for — a refund, an overpayment returned, a settlement.');

  const [customer] = await tx
    .select({ code: businessPartner.code, isCustomer: businessPartner.isCustomer, active: businessPartner.active })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.customerId))
    .limit(1);
  if (!customer) throw new MoneyOutError(`No business partner with id '${input.customerId}'.`);
  if (!customer.isCustomer) throw new MoneyOutError(`${customer.code} is not a customer, so a Customer Payment cannot pay it.`);
  if (!customer.active) throw new MoneyOutError(`${customer.code} is out of use.`);

  const account = await payingAccount(tx, input.bankCashAccountId);
  await assertMethod(tx, input.paymentMethodCode);
  const amountIqd = await dinarsOf(tx, input.amount, account.currency, input.paymentDate);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.paymentDate.slice(0, 4)) },
    ctx.principal.userId,
  );
  const [created] = await tx
    .insert(customerPayment)
    .values({
      paymentNo: allocated.documentNo,
      customerId: input.customerId,
      bankCashAccountId: account.id,
      branchCode: input.branchCode,
      paymentDate: input.paymentDate,
      currency: account.currency,
      amount: decimal(input.amount),
      amountIqd: decimal(amountIqd),
      paymentMethodCode: input.paymentMethodCode ?? null,
      purpose,
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: customerPayment.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_payment.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { paymentNo: allocated.documentNo, customer: customer.code, account: account.code, currency: account.currency, amount: decimal(input.amount), amountIqd: decimal(amountIqd), purpose },
    outcome: 'success',
  });
  return { id: created!.id, paymentNo: allocated.documentNo };
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const payment = await load(tx, id, true);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: payment.branchCode, objectId: id });
  if (payment.status !== 'draft') throw new MoneyOutError(`${payment.paymentNo} is ${payment.status}; only a draft is approved.`);
  if (payment.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new MoneyOutError(`${payment.paymentNo} was written by you; somebody else approves it.`);
  }
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status as DocumentStatus, 'approved');
  await tx
    .update(customerPayment)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(customerPayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_payment.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

/** Dr the customer's receivable / Cr the account the money left. */
export async function post(tx: Tx, ctx: ActorContext, id: string): Promise<{ journalEntryId: string; entryNo: string }> {
  const payment = await load(tx, id, true);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: payment.branchCode, objectId: id });
  if (payment.status !== 'approved') throw new MoneyOutError(`${payment.paymentNo} is ${payment.status}; a payment posts once it is approved.`);
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status as DocumentStatus, 'posted');

  const account = await payingAccount(tx, payment.bankCashAccountId);
  const [customer] = await tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, payment.customerId))
    .limit(1);
  // The dinars at the payment date's rate, as they stand when it posts — then fixed.
  const amountIqd = decimal(await dinarsOf(tx, scaled(payment.amount), payment.currency, payment.paymentDate));
  if (amountIqd !== decimal(scaled(payment.amountIqd))) {
    await tx.update(customerPayment).set({ amountIqd, updatedAt: new Date() }).where(eq(customerPayment.id, id));
  }
  const line = await bankLine(tx, { ...payment, amountIqd });
  const criteria = { branchCode: payment.branchCode };
  const dimensions = { branch: payment.branchCode, business_partner: customer!.code };

  const result = await posting.post(tx, ctx, {
    eventType: POSTING_EVENT,
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'sales', documentId: id, event: 'posted' },
    branchCode: payment.branchCode,
    documentDate: payment.paymentDate,
    postingDate: payment.paymentDate,
    description: `Customer payment ${payment.paymentNo} — ${customer!.code} — ${payment.purpose}`,
    lines: [
      { role: 'customer_receivable', debit: amountIqd, criteria, dimensions },
      {
        role: 'bank',
        accountId: account.glAccountId,
        ...(line.currency ? { currency: line.currency } : {}),
        credit: line.amount,
        criteria,
        dimensions,
        bankAccountCode: account.code,
        description: `Paid from ${account.code}`,
      },
    ],
  });

  await tx
    .update(customerPayment)
    .set({ status: 'posted', journalEntryId: result.journalEntryId, postedBy: ctx.principal.userId, postedAt: new Date(), updatedAt: new Date() })
    .where(eq(customerPayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_payment.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'posted', journalEntryNo: result.entryNo, amountIqd },
    outcome: 'success',
  });
  return { journalEntryId: result.journalEntryId, entryNo: result.entryNo };
}

/** Approve and post in one press — what the approver's button does. */
export async function approveAndPost(tx: Tx, ctx: ActorContext, id: string) {
  await approve(tx, ctx, id);
  return post(tx, ctx, id);
}

/** A draft or an approved payment that should not go out: cancelled with its reason. */
export async function cancel(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const payment = await load(tx, id, true);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: payment.branchCode, objectId: id });
  const why = reason.trim();
  if (!why) throw new MoneyOutError('Say why the payment is cancelled.');
  if (payment.status !== 'draft' && payment.status !== 'approved') {
    throw new MoneyOutError(`${payment.paymentNo} is ${payment.status}; a posted payment is reversed, not cancelled.`);
  }
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status as DocumentStatus, 'cancelled', why);
  await tx
    .update(customerPayment)
    .set({ status: 'cancelled', cancelReason: why, closedBy: ctx.principal.userId, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(customerPayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_payment.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'cancelled' },
    reason: why,
    outcome: 'success',
  });
}

/** A posted payment undone: its journal mirrored (in the currencies it went out in), dated today. */
export async function reverse(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<{ entryNo: string }> {
  const payment = await load(tx, id, true);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, { branchCode: payment.branchCode, objectId: id });
  const why = reason.trim();
  if (!why) throw new MoneyOutError('Say why the payment is reversed.');
  if (payment.status !== 'posted' || !payment.journalEntryId) {
    throw new MoneyOutError(`${payment.paymentNo} is ${payment.status}; only a posted payment is reversed.`);
  }
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status as DocumentStatus, 'reversed', why);
  const reversal = await journal.reverse(tx, ctx, payment.journalEntryId, { reason: `${payment.paymentNo}: ${why}` });
  await tx
    .update(customerPayment)
    .set({ status: 'reversed', reversalJournalEntryId: reversal.id, reversalReason: why, closedBy: ctx.principal.userId, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(customerPayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_payment.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'reversed', reversalEntryNo: reversal.entryNo },
    reason: why,
    outcome: 'success',
  });
  return { entryNo: reversal.entryNo };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const creator = alias(appUser, 'cp_creator');
const approver = alias(appUser, 'cp_approver');
const poster = alias(appUser, 'cp_poster');
const closer = alias(appUser, 'cp_closer');
const posted = alias(journalEntry, 'cp_journal');
const reversed = alias(journalEntry, 'cp_reversal');

const columns = {
  id: customerPayment.id,
  paymentNo: customerPayment.paymentNo,
  status: customerPayment.status,
  branchCode: customerPayment.branchCode,
  paymentDate: customerPayment.paymentDate,
  currency: customerPayment.currency,
  amount: customerPayment.amount,
  amountIqd: customerPayment.amountIqd,
  paymentMethodCode: customerPayment.paymentMethodCode,
  purpose: customerPayment.purpose,
  reference: customerPayment.reference,
  note: customerPayment.note,
  customerId: customerPayment.customerId,
  customerCode: businessPartner.code,
  customerName: businessPartner.legalName,
  bankCashAccountId: customerPayment.bankCashAccountId,
  accountCode: bankCashAccount.code,
  accountName: bankCashAccount.name,
  accountType: bankCashAccount.accountType,
  createdBy: customerPayment.createdBy,
  createdByName: creator.displayName,
  createdAt: customerPayment.createdAt,
  approvedByName: approver.displayName,
  approvedAt: customerPayment.approvedAt,
  postedByName: poster.displayName,
  postedAt: customerPayment.postedAt,
  closedByName: closer.displayName,
  closedAt: customerPayment.closedAt,
  journalEntryNo: posted.entryNo,
  reversalEntryNo: reversed.entryNo,
  reversalReason: customerPayment.reversalReason,
  cancelReason: customerPayment.cancelReason,
};

function joined(tx: Tx) {
  return tx
    .select(columns)
    .from(customerPayment)
    .innerJoin(businessPartner, eq(businessPartner.id, customerPayment.customerId))
    .innerJoin(bankCashAccount, eq(bankCashAccount.id, customerPayment.bankCashAccountId))
    .innerJoin(creator, eq(creator.id, customerPayment.createdBy))
    .leftJoin(approver, eq(approver.id, customerPayment.approvedBy))
    .leftJoin(poster, eq(poster.id, customerPayment.postedBy))
    .leftJoin(closer, eq(closer.id, customerPayment.closedBy))
    .leftJoin(posted, eq(posted.id, customerPayment.journalEntryId))
    .leftJoin(reversed, eq(reversed.id, customerPayment.reversalJournalEntryId));
}

export type CustomerPaymentRow = Awaited<ReturnType<typeof viewByNo>>;

export async function viewByNo(tx: Tx, paymentNo: string) {
  const [row] = await joined(tx).where(eq(customerPayment.paymentNo, paymentNo)).limit(1);
  return row ?? null;
}

export async function list(tx: Tx, filter: { readonly search?: string | null; readonly status?: string | null; readonly customerId?: string | null; readonly limit?: number } = {}) {
  const conditions: (SQL | undefined)[] = [];
  const words = (filter.search ?? '').trim();
  if (words) {
    const like = `%${words}%`;
    conditions.push(or(ilike(customerPayment.paymentNo, like), ilike(businessPartner.code, like), ilike(businessPartner.legalName, like), ilike(customerPayment.purpose, like), ilike(customerPayment.reference, like)));
  }
  if (filter.status) conditions.push(sql`${customerPayment.status}::text = ${filter.status}`);
  if (filter.customerId) conditions.push(eq(customerPayment.customerId, filter.customerId));
  return joined(tx)
    .where(and(...conditions))
    .orderBy(desc(customerPayment.paymentDate), desc(customerPayment.createdAt))
    .limit(filter.limit ?? 500);
}
