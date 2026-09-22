/**
 * Customer Credit Memo — Phase 06.9, §7.5 and Appendix C.
 *
 * > Appendix C: *"Sales return and Credit Memo | Sales Returns; Inventory /
 * > Inspection | Customer A/R; COGS | Accepted return and source invoice
 * > required."*
 *
 * The stock and COGS half of that row belongs to the Sales Return's movement
 * (06.9's `accept`). This document is the money half: **Dr Sales Returns / Cr
 * Customer A/R**.
 *
 * **Sales Returns, not Revenue.** The debit goes to a contra-revenue account
 * rather than reversing the original sale, so gross sales and returns are both
 * visible on the P&L. Netting them at source would hide the return rate, which
 * is one of the few numbers that tells a company something is wrong with a
 * product rather than with a month.
 *
 * **Both sources are required, and both are NOT NULL.** Appendix C says
 * *"accepted return and source invoice required"*, so a memo that credited a
 * customer for goods nobody accepted, or against no invoice, is unrepresentable
 * rather than refused.
 *
 * **The price is the invoice's.** A customer returning goods they bought in
 * March is credited what March charged them, not what the price list says today.
 * That is also why the invoice is required at all.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  arInvoiceLine,
  bankCashAccount,
  businessPartner,
  customerCreditMemo,
  customerCreditMemoLine,
  salesOrder,
  salesReturn,
  salesReturnLine,
} from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { parseDecimal, toDecimalString } from '../domain/money';
import { creditAmountFor } from '../domain/sales-return';
import { settlementStatusFor } from '../domain/ar-invoicing';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as arInvoiceService from './ar-invoice';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'customer_credit_memo';
export const DOCUMENT_TYPE = 'customer_credit_memo';
const SEQUENCE_KEY = 'CUSTOMER_CREDIT_MEMO';

export class ReturnNotAcceptedError extends Error {
  readonly code = 'RETURN_NOT_ACCEPTED';

  constructor(
    readonly returnNo: string,
    readonly status: string,
  ) {
    super(
      `Sales Return ${returnNo} is '${status}'. Appendix C requires an **accepted** return before a ` +
        'credit memo: crediting a customer for goods nobody has inspected is agreeing to a claim ' +
        'sight unseen.',
    );
    this.name = 'ReturnNotAcceptedError';
  }
}

// ---------------------------------------------------------------------------
// Create — from an accepted return
// ---------------------------------------------------------------------------

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly salesReturnId: string; readonly memoDate: string; readonly note?: string | null },
): Promise<{ id: string; memoNo: string; amountIqd: bigint }> {
  const [returnDoc] = await tx
    .select()
    .from(salesReturn)
    .where(eq(salesReturn.id, input.salesReturnId))
    .limit(1);

  if (!returnDoc) throw new Error(`No sales return with id '${input.salesReturnId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: returnDoc.branchCode,
  });

  // Appendix C — *"accepted return … required."* In §3.2's vocabulary,
  // Appendix B's *Accepted* is `approved`.
  if (returnDoc.status !== 'approved' && returnDoc.status !== 'closed') {
    throw new ReturnNotAcceptedError(returnDoc.returnNo, returnDoc.status);
  }

  const lines = await tx
    .select()
    .from(salesReturnLine)
    .where(eq(salesReturnLine.salesReturnId, input.salesReturnId))
    .orderBy(salesReturnLine.lineNo);

  const creditable = lines.filter(
    (line) =>
      parseQuantity(line.acceptedQuantity ?? '0') - parseQuantity(line.creditedQuantity) > 0n,
  );

  if (creditable.length === 0) {
    throw new Error(
      `Sales Return ${returnDoc.returnNo} has nothing left to credit. ` +
        'Either nothing was accepted, or a credit memo has already been raised for all of it.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: returnDoc.branchCode, year: Number(input.memoDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(customerCreditMemo)
    .values({
      memoNo: allocated.documentNo,
      salesReturnId: input.salesReturnId,
      arInvoiceId: returnDoc.arInvoiceId,
      customerId: returnDoc.customerId,
      branchCode: returnDoc.branchCode,
      memoDate: input.memoDate,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: customerCreditMemo.id });

  let total = 0n;

  for (const [index, line] of creditable.entries()) {
    const quantity =
      parseQuantity(line.acceptedQuantity ?? '0') - parseQuantity(line.creditedQuantity);

    const [invoiceLine] = await tx
      .select()
      .from(arInvoiceLine)
      .where(eq(arInvoiceLine.id, line.arInvoiceLineId))
      .limit(1);

    // §7.5 — credited at what the customer paid. Pro-rated from the invoice
    // line's *net* so a discount the customer received is also returned.
    const amount = creditAmountFor({
      invoicedQuantity: parseQuantity(invoiceLine!.quantity),
      invoicedNetIqd: parseDecimal(invoiceLine!.netIqd, 4n),
      returningQuantity: quantity,
    });

    await tx.insert(customerCreditMemoLine).values({
      customerCreditMemoId: created!.id,
      lineNo: index + 1,
      salesReturnLineId: line.id,
      arInvoiceLineId: line.arInvoiceLineId,
      itemCode: line.itemCode,
      description: line.description,
      uomCode: line.uomCode,
      quantity: formatQuantity(quantity),
      unitPrice: invoiceLine!.unitPrice,
      amountIqd: toDecimalString(amount, 4n),
    });

    await tx
      .update(salesReturnLine)
      .set({
        creditedQuantity: formatQuantity(parseQuantity(line.creditedQuantity) + quantity),
      })
      .where(eq(salesReturnLine.id, line.id));

    total += amount;
  }

  await tx
    .update(customerCreditMemo)
    .set({ amountIqd: toDecimalString(total, 4n), updatedAt: new Date() })
    .where(eq(customerCreditMemo.id, created!.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_credit_memo.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: returnDoc.branchCode,
    outcome: 'success',
    after: {
      memoNo: allocated.documentNo,
      returnNo: returnDoc.returnNo,
      amountIqd: toDecimalString(total, 4n),
      lines: creditable.length,
    },
  });

  return { id: created!.id, memoNo: allocated.documentNo, amountIqd: total };
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const memo = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: memo.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, 'approved');

  await tx
    .update(customerCreditMemo)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerCreditMemo.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_credit_memo.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    outcome: 'success',
    before: { status: memo.status },
    after: { status: 'approved' },
  });
}

// ---------------------------------------------------------------------------
// Post — Dr Sales Returns / Cr Customer A/R (Appendix C)
// ---------------------------------------------------------------------------

/**
 * The G/L account a bank or cash position is carried in. A refund credits the
 * account the money actually left, so the cash the books show is the cash the
 * bank shows.
 */
async function bankGlAccount(tx: Tx, bankCashAccountId: string): Promise<string> {
  const [account] = await tx
    .select({ glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, bankCashAccountId))
    .limit(1);

  if (!account) {
    throw new Error(
      `No bank or cash account with id '${bankCashAccountId}'. The return names it as the ` +
        'offset, so the refund has nowhere to come from.',
    );
  }
  return account.glAccountId;
}

export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const memo = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: memo.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, 'posted');

  const lines = await tx
    .select()
    .from(customerCreditMemoLine)
    .where(eq(customerCreditMemoLine.customerCreditMemoId, id))
    .orderBy(customerCreditMemoLine.lineNo);

  const [customer] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, memo.customerId))
    .limit(1);

  // §4.2 — the same dimensions the original sale carried, so the return lands in
  // the same P&L line the revenue did. Read from the invoice's order rather than
  // chosen here: a credit that reported under a different business line would
  // leave both lines wrong.
  const [invoice] = await tx
    .select()
    .from(arInvoice)
    .where(eq(arInvoice.id, memo.arInvoiceId))
    .limit(1);

  // An invoice raised directly has no order behind it — Operations block 5 —
  // and then the dimensions below are whatever the accounts require of the
  // memo's own lines.
  const [order] = invoice!.salesOrderId
    ? await tx
        .select({
          departmentCode: salesOrder.departmentCode,
          businessLineCode: salesOrder.businessLineCode,
        })
        .from(salesOrder)
        .where(eq(salesOrder.id, invoice!.salesOrderId))
        .limit(1)
    : [];

  const criteria = { branchCode: memo.branchCode };
  const dimensions = {
    branch: memo.branchCode,
    business_partner: customer?.code ?? null,
    business_line: order?.businessLineCode ?? invoice!.businessLineCode ?? null,
    department: order?.departmentCode ?? invoice!.departmentCode ?? null,
  };

  const amount = parseDecimal(memo.amountIqd, 4n);

  // Operations block 9 — *"Offset Account (Accounts Receivable or Bank — one
  // must be selected)"*. The return says which, because whoever took the goods
  // back is the one who knows whether the customer was refunded on the spot.
  // Read here rather than re-asked: the memo is the accounting half of a
  // decision already made, not a second chance to make it.
  const [returnDoc] = await tx
    .select({
      offsetKind: salesReturn.offsetKind,
      offsetBankAccountId: salesReturn.offsetBankAccountId,
    })
    .from(salesReturn)
    .where(eq(salesReturn.id, memo.salesReturnId))
    .limit(1);

  const offsetLine: PostingLineRequest =
    returnDoc?.offsetKind === 'bank'
      ? {
          // The account is named outright rather than mapped: which bank the
          // money left is a fact about this refund, and no posting rule can
          // know it. The role stays 'bank' so the line reads as what it is.
          role: 'bank',
          accountId: await bankGlAccount(tx, returnDoc.offsetBankAccountId!),
          credit: toDecimalString(amount, 4n),
          criteria,
          dimensions,
        }
      : { role: 'customer_receivable', credit: toDecimalString(amount, 4n), criteria, dimensions };

  const postingLines: PostingLineRequest[] = [
    ...lines.map((line) => ({
      role: 'sales_returns',
      debit: line.amountIqd,
      criteria,
      dimensions,
      sourceLineId: line.id,
    })),
    offsetLine,
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'sales.customer_credit_memo',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'sales', documentId: id, event: 'posted' },
    branchCode: memo.branchCode,
    documentDate: memo.memoDate,
    postingDate: memo.memoDate,
    description: `Customer credit memo ${memo.memoNo} — ${customer?.code ?? 'customer'}`,
    lines: postingLines,
  });

  await tx
    .update(customerCreditMemo)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerCreditMemo.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_credit_memo.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    outcome: 'success',
    before: { status: memo.status },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      amountIqd: memo.amountIqd,
    },
  });

  return { journalEntryId: result.journalEntryId };
}

/**
 * Applies a posted credit memo to an invoice — §15, §16.
 *
 * Goes through `ar-invoice.applyAllocation`, the same function a Customer
 * Receipt uses, so an invoice reaches Paid the same way whether the money came
 * from a bank or from a credit. Two implementations of "is this invoice settled"
 * is how one of them ends up wrong.
 */
export async function applyTo(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  arInvoiceId: string,
  amountIqd: bigint,
): Promise<{ allocatedIqd: bigint; status: string }> {
  const memo = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: memo.branchCode,
    objectId: id,
  });

  if (memo.status !== 'posted') {
    throw new Error(
      `Credit memo ${memo.memoNo} is '${memo.status}'. A credit is applied once it has been posted.`,
    );
  }

  const applied = parseDecimal(memo.allocatedIqd, 4n) + amountIqd;
  const total = parseDecimal(memo.amountIqd, 4n);

  if (applied > total) {
    throw new RangeError(
      `Credit memo ${memo.memoNo} is worth ${memo.amountIqd} and this would apply ` +
        `${toDecimalString(applied, 4n)}. A credit cannot give back more than it is for.`,
    );
  }

  await arInvoiceService.applyAllocation(tx, ctx, arInvoiceId, amountIqd);

  const status = settlementStatusFor({ totalIqd: total, allocatedIqd: applied });

  if (status !== memo.status) {
    await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, memo.status, status);
  }

  await tx
    .update(customerCreditMemo)
    .set({
      allocatedIqd: toDecimalString(applied, 4n),
      status,
      updatedAt: new Date(),
    })
    .where(eq(customerCreditMemo.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_credit_memo.applied',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: memo.branchCode,
    outcome: 'success',
    before: { status: memo.status, allocatedIqd: memo.allocatedIqd },
    after: { status, allocatedIqd: toDecimalString(applied, 4n), arInvoiceId },
  });

  return { allocatedIqd: applied, status };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [memo] = await tx
    .select()
    .from(customerCreditMemo)
    .where(eq(customerCreditMemo.id, id))
    .limit(1);
  if (!memo) throw new Error(`No customer credit memo with id '${id}'.`);
  return memo;
}

export async function view(tx: Tx, id: string) {
  const memo = await load(tx, id);
  const lines = await tx
    .select()
    .from(customerCreditMemoLine)
    .where(eq(customerCreditMemoLine.customerCreditMemoId, id))
    .orderBy(customerCreditMemoLine.lineNo);

  return { ...memo, lines };
}
