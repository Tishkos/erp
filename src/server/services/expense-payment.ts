/**
 * Expense Payment — a general expense paid straight from a bank or cash account (0428, 2026-10-26).
 *
 * By direction: "… and general expenses like things for that can you add them nicely". Rent, a
 * fuel receipt, a courier, a government fee — money out with no supplier invoice behind it. The
 * Other Receipt's mirror: Dr the expense account somebody names, with the dimensions that account
 * requires / Cr the bank or cash account the money left, in that account's own currency. It can
 * never debit a subledger control account (the service says so, 0428's trigger holds it): a customer
 * is paid by a Customer Payment, a supplier by a Supplier Payment.
 *
 * Draft → Approved (four eyes; a super user alone excepted) → Posted → Reversed; Draft or Approved
 * → Cancelled with a reason. Never deleted.
 */
import { and, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '../db/client';
import { appUser, bankCashAccount, chartOfAccount, expensePayment, journalEntry } from '../db/schema';
import type { DocumentStatus } from '../domain/statuses';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as journal from './journal';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';
import { MoneyOutError, assertAmount, assertMethod, bankLine, decimal, dinarsOf, payingAccount, scaled } from './money-out';

export const DOCUMENT_TYPE = 'expense_payment';
export const PERMISSION_OBJECT = 'expense_payment';
const SEQUENCE_KEY = 'EXPENSE_PAYMENT';
export const POSTING_EVENT = 'treasury.expense_payment';

export class ExpensePaymentNotFoundError extends Error {
  readonly code = 'EXPENSE_PAYMENT_NOT_FOUND';
  constructor(ref: string) {
    super(`No expense payment '${ref}'.`);
    this.name = 'ExpensePaymentNotFoundError';
  }
}

export interface CreateExpensePaymentInput {
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly paymentDate: string;
  /** In the account's own currency. */
  readonly amount: bigint;
  readonly expenseAccountId: string;
  readonly departmentCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly paymentMethodCode?: string | null;
  readonly payee: string;
  readonly purpose: string;
  readonly reference?: string | null;
  readonly note?: string | null;
}

async function load(tx: Tx, id: string, lock = false) {
  const query = tx.select().from(expensePayment).where(eq(expensePayment.id, id)).limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw new ExpensePaymentNotFoundError(id);
  return row;
}

/** The account an expense is charged to: postable, approved, in use, and not a control account. */
async function expenseAccount(tx: Tx, id: string) {
  const [account] = await tx.select().from(chartOfAccount).where(eq(chartOfAccount.id, id)).limit(1);
  if (!account) throw new MoneyOutError(`No account with id '${id}'.`);
  if (account.isGroup) throw new MoneyOutError(`${account.code} is a group heading; choose an account under it.`);
  if (!account.isActive || account.approvalStatus !== 'approved') throw new MoneyOutError(`${account.code} is not an approved account in use.`);
  if (account.controlAccount) {
    throw new MoneyOutError(
      `${account.code} is the control account for the ${account.controlAccount} subledger, and an Expense Payment cannot debit one. ` +
        'A customer is paid by a Customer Payment, a supplier by a Supplier Payment.',
    );
  }
  return account;
}

export async function create(tx: Tx, ctx: ActorContext, input: CreateExpensePaymentInput): Promise<{ id: string; paymentNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: input.branchCode });
  assertAmount(input.amount);
  const payee = input.payee.trim();
  const purpose = input.purpose.trim();
  if (!payee) throw new MoneyOutError('Say who was paid — a person, a shop, an office.');
  if (!purpose) throw new MoneyOutError('Say what the expense is for.');
  const charged = await expenseAccount(tx, input.expenseAccountId);
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
    .insert(expensePayment)
    .values({
      paymentNo: allocated.documentNo,
      bankCashAccountId: account.id,
      branchCode: input.branchCode,
      paymentDate: input.paymentDate,
      currency: account.currency,
      amount: decimal(input.amount),
      amountIqd: decimal(amountIqd),
      expenseAccountId: charged.id,
      departmentCode: input.departmentCode || null,
      businessLineCode: input.businessLineCode || null,
      paymentMethodCode: input.paymentMethodCode || null,
      payee,
      purpose,
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: expensePayment.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'expense_payment.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { paymentNo: allocated.documentNo, expenseAccount: charged.code, account: account.code, currency: account.currency, amount: decimal(input.amount), amountIqd: decimal(amountIqd), payee, purpose },
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
    .update(expensePayment)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(expensePayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'expense_payment.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

/** Dr the expense account named / Cr the account the money left. */
export async function post(tx: Tx, ctx: ActorContext, id: string): Promise<{ journalEntryId: string; entryNo: string }> {
  const payment = await load(tx, id, true);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: payment.branchCode, objectId: id });
  if (payment.status !== 'approved') throw new MoneyOutError(`${payment.paymentNo} is ${payment.status}; a payment posts once it is approved.`);
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, payment.status as DocumentStatus, 'posted');

  const charged = await expenseAccount(tx, payment.expenseAccountId);
  const account = await payingAccount(tx, payment.bankCashAccountId);
  const amountIqd = decimal(await dinarsOf(tx, scaled(payment.amount), payment.currency, payment.paymentDate));
  if (amountIqd !== decimal(scaled(payment.amountIqd))) {
    await tx.update(expensePayment).set({ amountIqd, updatedAt: new Date() }).where(eq(expensePayment.id, id));
  }
  const line = await bankLine(tx, { ...payment, amountIqd });
  const criteria = { branchCode: payment.branchCode };

  const result = await posting.post(tx, ctx, {
    eventType: POSTING_EVENT,
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'treasury', documentId: id, event: 'posted' },
    branchCode: payment.branchCode,
    documentDate: payment.paymentDate,
    postingDate: payment.paymentDate,
    description: `Expense payment ${payment.paymentNo} — ${payment.payee} — ${payment.purpose}`,
    lines: [
      {
        role: 'expense',
        accountId: charged.id,
        debit: amountIqd,
        criteria,
        dimensions: { branch: payment.branchCode, department: payment.departmentCode, business_line: payment.businessLineCode },
        description: payment.purpose,
      },
      {
        role: 'bank',
        accountId: account.glAccountId,
        ...(line.currency ? { currency: line.currency } : {}),
        credit: line.amount,
        criteria,
        dimensions: { branch: payment.branchCode },
        bankAccountCode: account.code,
        description: `Paid from ${account.code} to ${payment.payee}`,
      },
    ],
  });

  await tx
    .update(expensePayment)
    .set({ status: 'posted', journalEntryId: result.journalEntryId, postedBy: ctx.principal.userId, postedAt: new Date(), updatedAt: new Date() })
    .where(eq(expensePayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'expense_payment.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'posted', journalEntryNo: result.entryNo, amountIqd },
    outcome: 'success',
  });
  return { journalEntryId: result.journalEntryId, entryNo: result.entryNo };
}

export async function approveAndPost(tx: Tx, ctx: ActorContext, id: string) {
  await approve(tx, ctx, id);
  return post(tx, ctx, id);
}

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
    .update(expensePayment)
    .set({ status: 'cancelled', cancelReason: why, closedBy: ctx.principal.userId, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(expensePayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'expense_payment.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: payment.branchCode,
    before: { status: payment.status },
    after: { status: 'cancelled' },
    reason: why,
    outcome: 'success',
  });
}

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
    .update(expensePayment)
    .set({ status: 'reversed', reversalJournalEntryId: reversal.id, reversalReason: why, closedBy: ctx.principal.userId, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(expensePayment.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'expense_payment.reversed',
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

const creator = alias(appUser, 'ep_creator');
const approver = alias(appUser, 'ep_approver');
const poster = alias(appUser, 'ep_poster');
const closer = alias(appUser, 'ep_closer');
const posted = alias(journalEntry, 'ep_journal');
const reversed = alias(journalEntry, 'ep_reversal');

const columns = {
  id: expensePayment.id,
  paymentNo: expensePayment.paymentNo,
  status: expensePayment.status,
  branchCode: expensePayment.branchCode,
  paymentDate: expensePayment.paymentDate,
  currency: expensePayment.currency,
  amount: expensePayment.amount,
  amountIqd: expensePayment.amountIqd,
  paymentMethodCode: expensePayment.paymentMethodCode,
  payee: expensePayment.payee,
  purpose: expensePayment.purpose,
  reference: expensePayment.reference,
  note: expensePayment.note,
  departmentCode: expensePayment.departmentCode,
  businessLineCode: expensePayment.businessLineCode,
  expenseAccountId: expensePayment.expenseAccountId,
  expenseAccountCode: chartOfAccount.code,
  expenseAccountName: chartOfAccount.name,
  bankCashAccountId: expensePayment.bankCashAccountId,
  accountCode: bankCashAccount.code,
  accountName: bankCashAccount.name,
  accountType: bankCashAccount.accountType,
  createdBy: expensePayment.createdBy,
  createdByName: creator.displayName,
  createdAt: expensePayment.createdAt,
  approvedByName: approver.displayName,
  approvedAt: expensePayment.approvedAt,
  postedByName: poster.displayName,
  postedAt: expensePayment.postedAt,
  closedByName: closer.displayName,
  closedAt: expensePayment.closedAt,
  journalEntryNo: posted.entryNo,
  reversalEntryNo: reversed.entryNo,
  reversalReason: expensePayment.reversalReason,
  cancelReason: expensePayment.cancelReason,
};

function joined(tx: Tx) {
  return tx
    .select(columns)
    .from(expensePayment)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, expensePayment.expenseAccountId))
    .innerJoin(bankCashAccount, eq(bankCashAccount.id, expensePayment.bankCashAccountId))
    .innerJoin(creator, eq(creator.id, expensePayment.createdBy))
    .leftJoin(approver, eq(approver.id, expensePayment.approvedBy))
    .leftJoin(poster, eq(poster.id, expensePayment.postedBy))
    .leftJoin(closer, eq(closer.id, expensePayment.closedBy))
    .leftJoin(posted, eq(posted.id, expensePayment.journalEntryId))
    .leftJoin(reversed, eq(reversed.id, expensePayment.reversalJournalEntryId));
}

export type ExpensePaymentRow = Awaited<ReturnType<typeof viewByNo>>;

export async function viewByNo(tx: Tx, paymentNo: string) {
  const [row] = await joined(tx).where(eq(expensePayment.paymentNo, paymentNo)).limit(1);
  return row ?? null;
}

export async function list(tx: Tx, filter: { readonly search?: string | null; readonly status?: string | null; readonly limit?: number } = {}) {
  const conditions: (SQL | undefined)[] = [];
  const words = (filter.search ?? '').trim();
  if (words) {
    const like = `%${words}%`;
    conditions.push(or(ilike(expensePayment.paymentNo, like), ilike(expensePayment.payee, like), ilike(expensePayment.purpose, like), ilike(chartOfAccount.code, like), ilike(chartOfAccount.name, like), ilike(expensePayment.reference, like)));
  }
  if (filter.status) conditions.push(sql`${expensePayment.status}::text = ${filter.status}`);
  return joined(tx)
    .where(and(...conditions))
    .orderBy(desc(expensePayment.paymentDate), desc(expensePayment.createdAt))
    .limit(filter.limit ?? 500);
}
