/**
 * Supplier Credit / Debit Notes — REQ-PAY-001 PAY8 and PAY9 (2026-10-04).
 *
 * > "Credit notes must exist without a goods return, and debit notes must exist
 * > at all, both on statements and in the ageing."
 *
 * **A credit note is a `supplier_credit_memo` with no goods return** (D-PAY-2).
 * It is raised against an invoice of the supplier's, as a draft; approved by
 * somebody other than whoever raised it (the super user excepted — 0278,
 * decided by default 5); and posted:
 *
 *   Dr Supplier A/P (the invoice's own payable account, else the mapping)
 *   Cr the account the note names, purchase variance when it names none
 *      (D-PAY-3 — the role `purchasing.ap_invoice` already maps)
 *
 * On posting it is applied to its invoice up to what the invoice still owes;
 * whatever is left stays on the supplier's account as an unapplied credit and
 * is applied later (`apply`) to another of the same supplier's invoices. A
 * posted note is reversed, never edited (0295 `supplier_credit_memo_posted_is_final`).
 *
 * **Every application is a row** in `supplier_credit_application`, and the
 * memo's `allocated_amount_iqd` is their sum. That is the fix for the bug the
 * return route had: `goods-return.creditMemo` raised the invoice's settled
 * amount and left the memo's allocated amount at 0, so the supplier's account
 * counted the same money twice. It now records through `recordApplication`
 * here, and 0295 corrected the memos it had already written.
 *
 * **A debit note is a purchase invoice** (D-PAY-2): one non-stock line through
 * `ap.create`, naming the invoice it adjusts (`adjusts_invoice_id`). It is then
 * submitted, approved and posted, aged, stated and paid like any bill — the AP
 * engine is not copied.
 *
 * Governed by `supplier_credit_memo` (the credit note) and `ap_invoice` (the
 * debit note): the people who may credit a supplier for returned goods are the
 * people who may credit them for anything else.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  appUser,
  businessPartner,
  chartOfAccount,
  goodsReturn,
  supplierCreditApplication,
  supplierCreditMemo,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { assertResultAccount } from '../domain/posting-map';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as ap from './ap-invoice';
import * as coa from './chart-of-accounts';
import * as journal from './journal';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'supplier_credit_memo';
export const DOCUMENT_TYPE = 'supplier_credit_memo';
const SEQUENCE_KEY = 'SUPPLIER_CREDIT_MEMO';
/** Statuses in which an invoice is a debt a credit can be put against. */
const OPEN_INVOICE = ['posted', 'partially_executed'] as const;

export class SupplierNoteError extends Error {
  readonly code = 'SUPPLIER_NOTE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'SupplierNoteError';
  }
}

const money = (value: bigint) => toDecimalString(value, 4n);
const dec = (value: string) => parseDecimal(value, 4n);

// ---------------------------------------------------------------------------
// Applying a credit to an invoice — the one writer of both sides
// ---------------------------------------------------------------------------

/**
 * Puts `amount` of a credit memo against an invoice: the application row, the
 * memo's allocated total, the invoice's settled total and its status, in one
 * place. The caller has authorised the act and checked both balances.
 *
 * Exported for `goods-return.creditMemo`, whose memo is applied whole to its
 * invoice when it posts.
 */
export async function recordApplication(
  tx: Tx,
  ctx: ActorContext,
  input: { memoId: string; apInvoiceId: string; branchCode: string; amountIqd: bigint },
): Promise<{ invoiceOutstanding: bigint }> {
  const amount = money(input.amountIqd);
  await tx.insert(supplierCreditApplication).values({
    supplierCreditMemoId: input.memoId,
    apInvoiceId: input.apInvoiceId,
    branchCode: input.branchCode,
    amountIqd: amount,
    appliedBy: ctx.principal.userId,
  });
  await tx
    .update(supplierCreditMemo)
    .set({ allocatedAmountIqd: sql`${supplierCreditMemo.allocatedAmountIqd} + ${amount}`, updatedAt: new Date() })
    .where(eq(supplierCreditMemo.id, input.memoId));
  await tx
    .update(apInvoice)
    .set({ settledAmountIqd: sql`${apInvoice.settledAmountIqd} + ${amount}`, updatedAt: new Date() })
    .where(eq(apInvoice.id, input.apInvoiceId));

  const [after] = await tx
    .select({ totalIqd: apInvoice.totalIqd, settledAmountIqd: apInvoice.settledAmountIqd })
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);
  const owed = dec(after!.totalIqd) - dec(after!.settledAmountIqd);
  await tx
    .update(apInvoice)
    .set({ status: owed === 0n ? 'settled' : 'partially_executed', updatedAt: new Date() })
    .where(eq(apInvoice.id, input.apInvoiceId));
  return { invoiceOutstanding: owed };
}

async function lockMemo(tx: Tx, id: string) {
  await tx.execute(sql`select id from supplier_credit_memo where id = ${id}::uuid for update`);
  const [memo] = await tx.select().from(supplierCreditMemo).where(eq(supplierCreditMemo.id, id)).limit(1);
  if (!memo) throw new SupplierNoteError(`No supplier credit note with id '${id}'.`);
  return memo;
}

async function lockInvoice(tx: Tx, id: string) {
  await tx.execute(sql`select id from ap_invoice where id = ${id}::uuid for update`);
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, id)).limit(1);
  if (!invoice) throw new SupplierNoteError(`No purchase invoice with id '${id}'.`);
  return invoice;
}

// ---------------------------------------------------------------------------
// The credit note: create → approve → post → (apply) → reverse
// ---------------------------------------------------------------------------

export interface CreateCreditNoteInput {
  /** The invoice it credits. Required: a credit note is against an invoice. */
  readonly apInvoiceId: string;
  /** The supplier's own credit note number; ours when the supplier sent none. */
  readonly supplierMemoNo?: string | null;
  readonly memoDate: string;
  readonly amountIqd: bigint;
  /** Why the supplier is crediting — a price, a rebate, a damaged delivery. */
  readonly reason: string;
  /** The other side of the entry; purchase variance when left out. */
  readonly creditAccountId?: string | null;
}

export async function createCreditNote(
  tx: Tx,
  ctx: ActorContext,
  input: CreateCreditNoteInput,
): Promise<{ id: string; memoNo: string }> {
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, input.apInvoiceId)).limit(1);
  if (!invoice) throw new SupplierNoteError(`No purchase invoice with id '${input.apInvoiceId}'.`);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: invoice.branchCode });

  if (!['posted', 'partially_executed', 'settled'].includes(invoice.status)) {
    throw new SupplierNoteError(
      `Invoice ${invoice.invoiceNo} is '${invoice.status}'. A credit note corrects a posted invoice; a draft is corrected by editing it.`,
    );
  }
  if (input.amountIqd <= 0n) {
    throw new SupplierNoteError('A credit note is for a positive amount — what the supplier has agreed to credit.');
  }
  if (input.amountIqd > dec(invoice.totalIqd)) {
    throw new SupplierNoteError(
      `Invoice ${invoice.invoiceNo} came to ${invoice.totalIqd} IQD; a credit note against it cannot be for more than the invoice.`,
    );
  }
  const reason = input.reason.trim();
  if (!reason) throw new SupplierNoteError('A credit note says why the supplier is crediting. Give a reason.');
  if (input.creditAccountId) {
    assertResultAccount('expense', await coa.loadAccount(tx, input.creditAccountId));
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: invoice.branchCode, year: Number(input.memoDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(supplierCreditMemo)
    .values({
      memoNo: allocated.documentNo,
      supplierMemoNo: input.supplierMemoNo?.trim() || allocated.documentNo,
      status: 'draft',
      goodsReturnId: null,
      apInvoiceId: invoice.id,
      supplierId: invoice.supplierId,
      branchCode: invoice.branchCode,
      memoDate: input.memoDate,
      amountIqd: money(input.amountIqd),
      note: reason,
      creditAccountId: input.creditAccountId ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: supplierCreditMemo.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: invoice.branchCode,
    after: {
      memoNo: allocated.documentNo,
      invoiceNo: invoice.invoiceNo,
      amountIqd: money(input.amountIqd),
      reason,
      creditAccountId: input.creditAccountId ?? null,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { id: created!.id, memoNo: allocated.documentNo };
}

/** Approved by somebody other than its raiser; the super user approves alone (0278). */
export async function approveCreditNote(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const memo = await lockMemo(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: memo.branchCode, objectId: id });
  if (memo.status !== 'draft') {
    throw new SupplierNoteError(`Credit note ${memo.memoNo} is '${memo.status}'; only a draft is approved.`);
  }
  if (memo.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new SupplierNoteError(`${memo.memoNo} was raised by you; somebody else approves it.`);
  }
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, 'approved');
  const now = new Date();
  await tx
    .update(supplierCreditMemo)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: now, updatedAt: now })
    .where(eq(supplierCreditMemo.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    before: { status: memo.status },
    after: { status: 'approved' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** A draft that should never have been raised. Nothing posted, nothing to undo. */
export async function cancelCreditNote(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const memo = await lockMemo(tx, id);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: memo.branchCode, objectId: id });
  if (memo.status !== 'draft') {
    throw new SupplierNoteError(`Credit note ${memo.memoNo} is '${memo.status}'; only a draft is cancelled.`);
  }
  const why = reason.trim();
  if (!why) throw new SupplierNoteError('Say why the draft is being cancelled.');
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, 'cancelled');
  await tx
    .update(supplierCreditMemo)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(supplierCreditMemo.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    before: { status: 'draft' },
    after: { status: 'cancelled' },
    reason: why,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Posts the credit note: Dr Supplier A/P / Cr the named account (purchase
 * variance by default), and applies it to its invoice up to what is owed. The
 * rest stays on the supplier's account.
 */
export async function postCreditNote(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string; appliedIqd: bigint; unappliedIqd: bigint }> {
  const memo = await lockMemo(tx, id);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: memo.branchCode, objectId: id });
  if (memo.goodsReturnId) {
    throw new SupplierNoteError(`${memo.memoNo} credits a goods return and posted with it.`);
  }
  if (memo.status !== 'approved') {
    throw new SupplierNoteError(
      `Credit note ${memo.memoNo} is '${memo.status}'; a credit note posts once somebody has approved it.`,
    );
  }
  const invoice = await lockInvoice(tx, memo.apInvoiceId);
  const [supplier] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, memo.supplierId))
    .limit(1);

  const criteria = { branchCode: memo.branchCode };
  const dimensions = { branch: memo.branchCode, business_partner: supplier?.code ?? null };
  // The statement the invoice is kept on: the account it chose, or the
  // purchase-invoice mapping — the direct return's rule. The credit side is
  // the account the note names, or purchase variance (D-PAY-3).
  const payableAccount =
    invoice.payableAccountId ??
    (await posting.mappedAccountFor(tx, 'purchasing.ap_invoice', 'supplier_payable', memo.branchCode));
  const creditAccount =
    memo.creditAccountId ??
    (await posting.mappedAccountFor(tx, 'purchasing.ap_invoice', 'purchase_variance', memo.branchCode));
  for (const [role, account] of [
    ['supplier_payable', payableAccount],
    ['purchase_variance', creditAccount],
  ] as const) {
    if (!account) {
      throw new SupplierNoteError(
        `Nothing is mapped for purchasing.ap_invoice / ${role}, so ${memo.memoNo} has no account to post to. ` +
          'Map it in Posting Mappings, or name the account on the note.',
      );
    }
  }
  const lines: PostingLineRequest[] = [
    { role: 'supplier_payable', accountId: payableAccount!, debit: memo.amountIqd, criteria, dimensions },
    { role: 'purchase_variance', accountId: creditAccount!, credit: memo.amountIqd, criteria, dimensions },
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'purchasing.supplier_credit_memo',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'purchasing', documentId: id, event: 'posted' },
    branchCode: memo.branchCode,
    documentDate: memo.memoDate,
    postingDate: memo.memoDate,
    description: `Supplier credit note ${memo.memoNo} against ${invoice.invoiceNo} — ${memo.note ?? ''}`.trim(),
    lines,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, 'posted');
  const now = new Date();
  await tx
    .update(supplierCreditMemo)
    .set({ status: 'posted', journalEntryId: result.journalEntryId, postedBy: ctx.principal.userId, postedAt: now, updatedAt: now })
    .where(eq(supplierCreditMemo.id, id));

  // Applied to its own invoice up to what that still owes.
  const amount = dec(memo.amountIqd);
  const owed = OPEN_INVOICE.includes(invoice.status as (typeof OPEN_INVOICE)[number])
    ? dec(invoice.totalIqd) - dec(invoice.settledAmountIqd)
    : 0n;
  const applied = amount < owed ? amount : owed;
  if (applied > 0n) {
    await recordApplication(tx, ctx, {
      memoId: id,
      apInvoiceId: invoice.id,
      branchCode: memo.branchCode,
      amountIqd: applied,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    before: { status: 'approved' },
    after: {
      status: 'posted',
      memoNo: memo.memoNo,
      invoiceNo: invoice.invoiceNo,
      journalEntryId: result.journalEntryId,
      appliedIqd: money(applied),
      unappliedIqd: money(amount - applied),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { journalEntryId: result.journalEntryId, appliedIqd: applied, unappliedIqd: amount - applied };
}

/**
 * Puts what is left of a posted credit against another of the same
 * supplier's open invoices. Bounded both ways, like a payment's allocation.
 */
export async function applyCredit(
  tx: Tx,
  ctx: ActorContext,
  input: { memoId: string; apInvoiceId: string; amountIqd: bigint },
): Promise<{ memoUnapplied: bigint; invoiceOutstanding: bigint }> {
  const memo = await lockMemo(tx, input.memoId);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: memo.branchCode, objectId: memo.id });
  if (memo.status !== 'posted') {
    throw new SupplierNoteError(`Credit note ${memo.memoNo} is '${memo.status}'; only a posted credit is applied.`);
  }
  const invoice = await lockInvoice(tx, input.apInvoiceId);
  if (invoice.supplierId !== memo.supplierId) {
    throw new SupplierNoteError(
      `Invoice ${invoice.invoiceNo} is another supplier's. A credit settles only its own supplier's debts.`,
    );
  }
  if (invoice.branchCode !== memo.branchCode) {
    throw new SupplierNoteError(
      `Invoice ${invoice.invoiceNo} is ${invoice.branchCode}'s and the credit is ${memo.branchCode}'s; a credit is applied within its branch.`,
    );
  }
  if (!OPEN_INVOICE.includes(invoice.status as (typeof OPEN_INVOICE)[number])) {
    throw new SupplierNoteError(`Invoice ${invoice.invoiceNo} is '${invoice.status}', so there is nothing owed on it.`);
  }
  const unapplied = dec(memo.amountIqd) - dec(memo.allocatedAmountIqd);
  const owed = dec(invoice.totalIqd) - dec(invoice.settledAmountIqd);
  if (input.amountIqd <= 0n || input.amountIqd > unapplied) {
    throw new SupplierNoteError(`${memo.memoNo} has ${money(unapplied)} IQD left to apply; ${money(input.amountIqd)} was asked for.`);
  }
  if (input.amountIqd > owed) {
    throw new SupplierNoteError(`${invoice.invoiceNo} owes ${money(owed)} IQD; a credit settles a debt down to nothing and no further.`);
  }

  const { invoiceOutstanding } = await recordApplication(tx, ctx, {
    memoId: memo.id,
    apInvoiceId: invoice.id,
    branchCode: memo.branchCode,
    amountIqd: input.amountIqd,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.applied',
    objectType: PERMISSION_OBJECT,
    objectId: memo.id,
    branchCode: memo.branchCode,
    after: { invoiceNo: invoice.invoiceNo, amountIqd: money(input.amountIqd), invoiceOutstanding: money(invoiceOutstanding) },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { memoUnapplied: unapplied - input.amountIqd, invoiceOutstanding };
}

/**
 * A posted standalone credit note that should not have been: its journal
 * mirrored (`journal.reverse`), each application undone so its invoices owe
 * again, status → reversed with the reason. A return's memo is not reversed
 * here — it is the return's.
 */
export async function reverseCreditNote(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { reason: string },
): Promise<{ reversalEntryNo: string }> {
  const memo = await lockMemo(tx, id);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, { branchCode: memo.branchCode, objectId: id });
  const reason = input.reason.trim();
  if (!reason) throw new SupplierNoteError('A reversal records why the credit note was wrong. Give a reason.');
  if (memo.goodsReturnId) {
    throw new SupplierNoteError(`${memo.memoNo} credits a goods return; it is corrected through the return.`);
  }
  if (memo.status !== 'posted' || !memo.journalEntryId) {
    throw new SupplierNoteError(`Credit note ${memo.memoNo} is '${memo.status}'; only a posted note is reversed.`);
  }

  const reversal = await journal.reverse(tx, ctx, memo.journalEntryId, { reason });

  const live = await tx
    .select()
    .from(supplierCreditApplication)
    .where(and(eq(supplierCreditApplication.supplierCreditMemoId, id), isNull(supplierCreditApplication.reversedAt)));
  const now = new Date();
  for (const application of live) {
    await lockInvoice(tx, application.apInvoiceId);
    await tx
      .update(supplierCreditApplication)
      .set({ reversedBy: ctx.principal.userId, reversedAt: now, reversalReason: reason })
      .where(eq(supplierCreditApplication.id, application.id));
    await tx
      .update(apInvoice)
      .set({ settledAmountIqd: sql`${apInvoice.settledAmountIqd} - ${application.amountIqd}`, updatedAt: now })
      .where(eq(apInvoice.id, application.apInvoiceId));
    const [after] = await tx
      .select({ settled: apInvoice.settledAmountIqd })
      .from(apInvoice)
      .where(eq(apInvoice.id, application.apInvoiceId))
      .limit(1);
    await tx
      .update(apInvoice)
      .set({ status: dec(after!.settled) > 0n ? 'partially_executed' : 'posted', updatedAt: now })
      .where(eq(apInvoice.id, application.apInvoiceId));
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, 'reversed', reason);
  await tx
    .update(supplierCreditMemo)
    .set({
      status: 'reversed',
      allocatedAmountIqd: '0',
      reversedBy: ctx.principal.userId,
      reversedAt: now,
      reversalReason: reason,
      reversalJournalEntryId: reversal.id,
      updatedAt: now,
    })
    .where(eq(supplierCreditMemo.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'supplier_credit_memo.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    before: { status: 'posted', applications: live.length },
    after: { status: 'reversed', reversalEntryNo: reversal.entryNo },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { reversalEntryNo: reversal.entryNo };
}

// ---------------------------------------------------------------------------
// The debit note — a purchase invoice that names the invoice it adjusts
// ---------------------------------------------------------------------------

export interface CreateDebitNoteInput {
  readonly adjustsInvoiceId: string;
  readonly noteDate: string;
  readonly amountIqd: bigint;
  readonly reason: string;
  /** The supplier's own debit note number; ours when it sent none. */
  readonly supplierNoteNo?: string | null;
  /** Where the extra charge is a cost; the expense mapping when left out. */
  readonly expenseAccountId?: string | null;
  readonly dueDate?: string | null;
}

/**
 * Raises the debit note as a draft purchase invoice with one charge line. The
 * AP engine does the rest: submit, approve and post, then it ages, states and
 * is paid like any bill.
 */
export async function createDebitNote(
  tx: Tx,
  ctx: ActorContext,
  input: CreateDebitNoteInput,
): Promise<{ id: string; invoiceNo: string }> {
  const [adjusts] = await tx.select().from(apInvoice).where(eq(apInvoice.id, input.adjustsInvoiceId)).limit(1);
  if (!adjusts) throw new SupplierNoteError(`No purchase invoice with id '${input.adjustsInvoiceId}'.`);
  await authz.authorize(ctx.principal, 'create', ap.PERMISSION_OBJECT, { branchCode: adjusts.branchCode });
  if (!['posted', 'partially_executed', 'settled'].includes(adjusts.status)) {
    throw new SupplierNoteError(
      `Invoice ${adjusts.invoiceNo} is '${adjusts.status}'. A debit note adjusts a posted invoice; a draft is corrected by editing it.`,
    );
  }
  if (input.amountIqd <= 0n) throw new SupplierNoteError('A debit note is for a positive amount — what the supplier charges on top.');
  const reason = input.reason.trim();
  if (!reason) throw new SupplierNoteError('A debit note says why the supplier is charging more. Give a reason.');

  const made = await ap.create(tx, ctx, {
    supplierId: adjusts.supplierId,
    supplierInvoiceNo: input.supplierNoteNo?.trim() ?? '',
    branchCode: adjusts.branchCode,
    invoiceDate: input.noteDate,
    dueDate: input.dueDate?.trim() || undefined,
    currency: adjusts.currency,
    note: reason,
    // §15 — its evidence is the invoice it adjusts and the reason; its second
    // person is the one who posts it (0295's route on the CHECK).
    nonPoJustification: `Debit note on ${adjusts.invoiceNo} — ${reason}`,
    expenseAccountId: input.expenseAccountId ?? null,
    payableAccountId: adjusts.payableAccountId,
    adjustsInvoiceId: adjusts.id,
    lines: [
      {
        description: reason,
        quantity: 1_000_000n,
        unitPriceIqd: input.amountIqd,
        isInventory: false,
      },
    ],
  });
  return { id: made.id, invoiceNo: made.invoiceNo };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type NoteKind = 'credit' | 'debit';

export interface NoteRow {
  readonly kind: NoteKind;
  readonly id: string;
  readonly number: string;
  readonly supplierCode: string | null;
  readonly supplierName: string | null;
  readonly noteDate: string;
  readonly invoiceNo: string | null;
  readonly returnNo: string | null;
  readonly amountIqd: string;
  /** Credit: applied so far. Debit: paid or credited so far. */
  readonly settledIqd: string;
  readonly status: string;
  readonly branchCode: string;
}

/** The register: credit notes (with or without a return) and debit notes, newest first. */
export async function list(tx: Tx): Promise<NoteRow[]> {
  const credits = await tx
    .select({
      id: supplierCreditMemo.id,
      number: supplierCreditMemo.memoNo,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      noteDate: supplierCreditMemo.memoDate,
      invoiceNo: apInvoice.invoiceNo,
      returnNo: goodsReturn.returnNo,
      amountIqd: supplierCreditMemo.amountIqd,
      settledIqd: supplierCreditMemo.allocatedAmountIqd,
      status: supplierCreditMemo.status,
      branchCode: supplierCreditMemo.branchCode,
    })
    .from(supplierCreditMemo)
    .leftJoin(businessPartner, eq(businessPartner.id, supplierCreditMemo.supplierId))
    .leftJoin(apInvoice, eq(apInvoice.id, supplierCreditMemo.apInvoiceId))
    .leftJoin(goodsReturn, eq(goodsReturn.id, supplierCreditMemo.goodsReturnId));

  const adjusted = sql`(select a.invoice_no from ap_invoice a where a.id = ${apInvoice.adjustsInvoiceId})`;
  const debits = await tx
    .select({
      id: apInvoice.id,
      number: apInvoice.invoiceNo,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      noteDate: apInvoice.invoiceDate,
      invoiceNo: sql<string | null>`${adjusted}`,
      // Before posting the total is zero; the line is the amount.
      amountIqd: sql<string>`case when ${apInvoice.status} in ('draft','submitted','rejected','cancelled')
        then coalesce((select sum(l.quantity * l.unit_price - l.discount_iqd) from ap_invoice_line l where l.ap_invoice_id = ${apInvoice.id}), 0)::numeric(19,4)::text
        else ${apInvoice.totalIqd}::text end`,
      settledIqd: apInvoice.settledAmountIqd,
      status: apInvoice.status,
      branchCode: apInvoice.branchCode,
    })
    .from(apInvoice)
    .leftJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .where(sql`${apInvoice.adjustsInvoiceId} is not null`);

  return [
    ...credits.map((row) => ({ ...row, kind: 'credit' as const })),
    ...debits.map((row) => ({ ...row, kind: 'debit' as const, returnNo: null })),
  ].sort((a, b) => (a.noteDate === b.noteDate ? b.number.localeCompare(a.number) : b.noteDate.localeCompare(a.noteDate)));
}

/** One credit note as its page shows it. */
export async function viewCreditByNo(tx: Tx, memoNo: string) {
  const [memo] = await tx.select().from(supplierCreditMemo).where(eq(supplierCreditMemo.memoNo, memoNo)).limit(1);
  if (!memo) return null;
  const [invoice] = await tx
    .select({ id: apInvoice.id, invoiceNo: apInvoice.invoiceNo, totalIqd: apInvoice.totalIqd, settledAmountIqd: apInvoice.settledAmountIqd })
    .from(apInvoice)
    .where(eq(apInvoice.id, memo.apInvoiceId))
    .limit(1);
  const [supplier] = await tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, memo.supplierId))
    .limit(1);
  const [returned] = memo.goodsReturnId
    ? await tx.select({ returnNo: goodsReturn.returnNo }).from(goodsReturn).where(eq(goodsReturn.id, memo.goodsReturnId)).limit(1)
    : [];
  const [account] = memo.creditAccountId
    ? await tx
        .select({ code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(eq(chartOfAccount.id, memo.creditAccountId))
        .limit(1)
    : [];
  const people = [memo.createdBy, memo.approvedBy, memo.postedBy, memo.reversedBy].filter((id): id is string => Boolean(id));
  const names = new Map(
    (people.length > 0
      ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, people))
      : []
    ).map((row) => [row.id, row.name] as const),
  );
  const applications = await tx
    .select({
      id: supplierCreditApplication.id,
      invoiceNo: apInvoice.invoiceNo,
      amountIqd: supplierCreditApplication.amountIqd,
      appliedAt: sql<string>`${supplierCreditApplication.appliedAt}::date::text`,
      reversedAt: sql<string | null>`${supplierCreditApplication.reversedAt}::date::text`,
    })
    .from(supplierCreditApplication)
    .innerJoin(apInvoice, eq(apInvoice.id, supplierCreditApplication.apInvoiceId))
    .where(eq(supplierCreditApplication.supplierCreditMemoId, memo.id))
    .orderBy(supplierCreditApplication.appliedAt);
  return {
    memo,
    invoice: invoice ?? null,
    supplier: supplier ?? null,
    returnNo: returned?.returnNo ?? null,
    account: account ?? null,
    unappliedIqd: dec(memo.amountIqd) - dec(memo.allocatedAmountIqd),
    applications,
    raisedBy: names.get(memo.createdBy) ?? null,
    approvedBy: memo.approvedBy ? (names.get(memo.approvedBy) ?? null) : null,
    postedBy: memo.postedBy ? (names.get(memo.postedBy) ?? null) : null,
  };
}

/** The supplier's open invoices a credit can still be put against (same branch). */
export async function applicableInvoices(tx: Tx, memo: { supplierId: string; branchCode: string }) {
  const rows = await tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      dueDate: apInvoice.dueDate,
      outstandingIqd: sql<string>`(${apInvoice.totalIqd} - ${apInvoice.settledAmountIqd})::text`,
    })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.supplierId, memo.supplierId),
        eq(apInvoice.branchCode, memo.branchCode),
        inArray(apInvoice.status, [...OPEN_INVOICE]),
        sql`${apInvoice.totalIqd} > ${apInvoice.settledAmountIqd}`,
      ),
    )
    .orderBy(apInvoice.dueDate, apInvoice.invoiceNo);
  return rows;
}

/** Posted invoices a note can be raised against, newest first. */
export async function invoiceChoices(tx: Tx) {
  return tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      totalIqd: apInvoice.totalIqd,
    })
    .from(apInvoice)
    .innerJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .where(inArray(apInvoice.status, ['posted', 'partially_executed', 'settled']))
    .orderBy(desc(apInvoice.invoiceDate), desc(apInvoice.invoiceNo))
    .limit(500);
}

/** The debit notes raised on one invoice — shown on the invoice it adjusts. */
export async function debitNotesFor(tx: Tx, apInvoiceId: string) {
  return tx
    .select({ invoiceNo: apInvoice.invoiceNo, status: apInvoice.status, totalIqd: apInvoice.totalIqd })
    .from(apInvoice)
    .where(eq(apInvoice.adjustsInvoiceId, apInvoiceId))
    .orderBy(apInvoice.invoiceDate);
}
