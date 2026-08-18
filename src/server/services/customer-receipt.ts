/**
 * Customer Receipt and allocation — Phase 06.10, §16. And the mechanism a cash
 * sale settles through (06.8).
 *
 * > §16: *"Receipt allocation cannot exceed invoice or available receipt
 * > balance."*
 * > §16: *"Unidentified receipts remain in a clearing account until resolved."*
 * > §16 acceptance 1: *"Invoice and receipt update the customer subledger and
 * > G/L in the same posting."*
 *
 * **Two documents, one mechanism.** Appendix B names the type *"Customer Receipt
 * / Cash Sale Receipt"*, so a cash sale is a receipt posted in the same
 * transaction as its invoice rather than a second kind of document. §24 is
 * explicit about why that matters: a duplicated mechanism is a control that
 * drifts, and the control here is the one that stops a customer being
 * over-credited.
 *
 * **Where the money goes.** The debit is always the bank or cash account —
 * money arriving is a fact whatever else is unknown. The *credit* is what moves:
 * Customer A/R when the payer is known, a clearing account when they are not. So
 * an unidentified receipt is fully recorded, fully reconciled to the bank, and
 * visibly unresolved, which is what §16 asks for.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  bankCashAccount,
  businessPartner,
  customerReceipt,
  customerReceiptAllocation,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { assertWithinBalance, openBalance } from '../domain/ar-invoicing';
import {
  assertWithinReceipt,
  creditRoleFor,
  proposeAllocation,
  receiptStatusFor,
  unapplied,
  UnidentifiedReceiptError,
} from '../domain/receipt-allocation';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as arInvoiceService from './ar-invoice';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'customer_receipt';
export const DOCUMENT_TYPE = 'customer_receipt';
const SEQUENCE_KEY = 'CUSTOMER_RECEIPT';

export class ReceiptNotPostedError extends Error {
  readonly code = 'RECEIPT_NOT_POSTED';

  constructor(
    readonly receiptNo: string,
    readonly status: string,
  ) {
    super(
      `Receipt ${receiptNo} is '${status}'. Money is allocated to invoices once it has been posted — ` +
        'before that it is a document, not a payment.',
    );
    this.name = 'ReceiptNotPostedError';
  }
}

export class WrongCustomerError extends Error {
  readonly code = 'RECEIPT_WRONG_CUSTOMER';

  constructor(
    readonly receiptNo: string,
    readonly invoiceNo: string,
  ) {
    super(
      `Receipt ${receiptNo} is from a different customer than invoice ${invoiceNo}. ` +
        'One customer’s money does not settle another’s debt — if this is a group arrangement, ' +
        'it is a transfer between the two accounts and then an allocation (§16).',
    );
    this.name = 'WrongCustomerError';
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateReceiptInput {
  /** §16 — omitted for money whose payer is not yet known. */
  readonly customerId?: string | null;
  readonly branchCode: string;
  readonly receiptDate: string;
  readonly bankCashAccountId: string;
  readonly amountIqd: bigint;
  readonly bankReference?: string | null;
  readonly currency?: string;
  readonly note?: string | null;
  /** Set by the cash-sale path (06.8). Not for general use. */
  readonly cashSaleInvoiceId?: string | null;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateReceiptInput,
): Promise<{ id: string; receiptNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.amountIqd <= 0n) {
    throw new RangeError(
      'A receipt records money that arrived, so its amount is positive. Money going out is a payment or a refund.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.receiptDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(customerReceipt)
    .values({
      receiptNo: allocated.documentNo,
      customerId: input.customerId ?? null,
      branchCode: input.branchCode,
      receiptDate: input.receiptDate,
      bankCashAccountId: input.bankCashAccountId,
      currency: input.currency ?? 'IQD',
      bankReference: input.bankReference ?? null,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      cashSaleInvoiceId: input.cashSaleInvoiceId ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: customerReceipt.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_receipt.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    outcome: 'success',
    after: {
      receiptNo: allocated.documentNo,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      identified: Boolean(input.customerId),
      bankReference: input.bankReference ?? null,
    },
  });

  return { id: created!.id, receiptNo: allocated.documentNo };
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const receipt = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'approved');

  await tx
    .update(customerReceipt)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_receipt.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    outcome: 'success',
    before: { status: receipt.status },
    after: { status: 'approved' },
  });
}

// ---------------------------------------------------------------------------
// Post — Dr Bank/Cash, Cr Customer A/R or Customer Clearing (§16)
// ---------------------------------------------------------------------------

export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const receipt = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'posted');

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, receipt.bankCashAccountId))
    .limit(1);

  const customerCode = receipt.customerId ? await codeOf(tx, receipt.customerId) : null;

  const amount = parseDecimal(receipt.amountIqd, 4n);
  const criteria = { branchCode: receipt.branchCode };
  const dimensions = { branch: receipt.branchCode, business_partner: customerCode };

  // §16 — the credit is what moves. An unidentified receipt is fully recorded
  // and visibly unresolved rather than guessed at.
  const creditRole = creditRoleFor(receipt.customerId);

  const lines: PostingLineRequest[] = [
    {
      role: 'bank_cash',
      // **The account the money actually landed in**, named by the receipt.
      //
      // Not a §3.3 mapping: with two bank accounts a mapped `bank_cash` role
      // would send every receipt to whichever one the rule pointed at, and the
      // other account's balance would never move. Which G/L account a bank
      // account sits in is already on the account master — one answer, not two.
      accountId: account!.glAccountId,
      debit: toDecimalString(amount, 4n),
      criteria,
      // The bank account is *not* a §4.2 dimension — the seven are branch,
      // department, business line, project, warehouse, business partner and
      // employee. Which account the money landed in is on the receipt and in
      // the bank subledger; putting it in the ledger as an eighth dimension
      // would create one no account can require and nothing can report on.
      dimensions,
      description: account?.code ? `Received into ${account.code}` : null,
    },
    {
      role: creditRole,
      credit: toDecimalString(amount, 4n),
      criteria,
      dimensions,
    },
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'sales.customer_receipt',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'sales', documentId: id, event: 'posted' },
    branchCode: receipt.branchCode,
    documentDate: receipt.receiptDate,
    postingDate: receipt.receiptDate,
    description: `Customer receipt ${receipt.receiptNo}${customerCode ? ` — ${customerCode}` : ' — unidentified'}`,
    lines,
  });

  await tx
    .update(customerReceipt)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customerReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_receipt.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    outcome: 'success',
    before: { status: receipt.status },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      creditRole,
      amountIqd: receipt.amountIqd,
    },
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// Allocation — §16
// ---------------------------------------------------------------------------

export interface AllocationInput {
  readonly arInvoiceId: string;
  readonly amountIqd: bigint;
  readonly note?: string | null;
}

/**
 * Applies a posted receipt to one or more invoices.
 *
 * Both ceilings are checked on every line: the invoice's remaining balance and
 * the receipt's unapplied amount. One without the other leaves either an
 * over-paid invoice or a receipt that paid out money nobody sent, and §16 names
 * both — *"cannot exceed invoice or available receipt balance."*
 *
 * A list rather than one at a time, because §16's one-to-many matching is one
 * act by one person: five allocations that half-succeeded would leave a clerk
 * reconciling the difference by hand.
 */
export async function allocate(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  allocations: readonly AllocationInput[],
): Promise<{ allocatedIqd: bigint; status: string }> {
  const receipt = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
    objectId: id,
  });

  if (receipt.status !== 'posted') {
    throw new ReceiptNotPostedError(receipt.receiptNo, receipt.status);
  }

  // §16 — money whose payer is unknown cannot settle anybody's debt. The check
  // is here as well as in the CHECK constraint so the message explains itself.
  if (!receipt.customerId) {
    throw new UnidentifiedReceiptError(receipt.receiptNo);
  }

  let applied = parseDecimal(receipt.allocatedIqd, 4n);
  const amount = parseDecimal(receipt.amountIqd, 4n);

  for (const allocation of allocations) {
    const [invoice] = await tx
      .select()
      .from(arInvoice)
      .where(eq(arInvoice.id, allocation.arInvoiceId))
      .limit(1);

    if (!invoice) throw new Error(`No A/R invoice with id '${allocation.arInvoiceId}'.`);

    if (invoice.customerId !== receipt.customerId) {
      throw new WrongCustomerError(receipt.receiptNo, invoice.invoiceNo);
    }

    // The receipt's side of the ceiling…
    assertWithinReceipt(
      receipt.receiptNo,
      { amountIqd: amount, allocatedIqd: applied },
      allocation.amountIqd,
    );

    // …and the invoice's.
    assertWithinBalance(
      invoice.invoiceNo,
      {
        totalIqd: parseDecimal(invoice.netIqd, 4n),
        allocatedIqd: parseDecimal(invoice.allocatedIqd, 4n),
      },
      allocation.amountIqd,
    );

    await tx.insert(customerReceiptAllocation).values({
      customerReceiptId: id,
      arInvoiceId: allocation.arInvoiceId,
      amountIqd: toDecimalString(allocation.amountIqd, 4n),
      allocatedBy: ctx.principal.userId,
      note: allocation.note ?? null,
    });

    // The invoice's own rule — Appendix B's Partially Paid and Paid — lives in
    // `ar-invoice.applyAllocation`, so a credit memo (06.9) moves an invoice
    // exactly the way a receipt does.
    await arInvoiceService.applyAllocation(tx, ctx, allocation.arInvoiceId, allocation.amountIqd);

    applied += allocation.amountIqd;
  }

  const status = receiptStatusFor({ amountIqd: amount, allocatedIqd: applied });

  if (status !== receipt.status) {
    await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, status);
  }

  await tx
    .update(customerReceipt)
    .set({
      allocatedIqd: toDecimalString(applied, 4n),
      status,
      updatedAt: new Date(),
    })
    .where(eq(customerReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_receipt.allocated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    outcome: 'success',
    before: { status: receipt.status, allocatedIqd: receipt.allocatedIqd },
    after: {
      status,
      allocatedIqd: toDecimalString(applied, 4n),
      invoices: allocations.length,
    },
  });

  return { allocatedIqd: applied, status };
}

/**
 * §16 — identifies a receipt that arrived without a payer, and moves the credit
 * out of the clearing account.
 *
 * The move is a journal, not an edit: the clearing balance was posted and is
 * reconciled, so it is cleared by a posting that says so. *"Resolved"* is an
 * accounting event, and an updated column would leave the trial balance
 * unchanged while the story changed.
 */
export async function identify(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  customerId: string,
): Promise<{ journalEntryId: string | null }> {
  const receipt = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
    objectId: id,
  });

  if (receipt.customerId) {
    throw new Error(
      `Receipt ${receipt.receiptNo} already names a customer. Money credited to the wrong ` +
        'customer is corrected by reversing the receipt, not by re-pointing it (§3.2).',
    );
  }

  const customerCode = await codeOf(tx, customerId);
  const amount = parseDecimal(receipt.amountIqd, 4n);
  const criteria = { branchCode: receipt.branchCode };

  let journalEntryId: string | null = null;

  // Nothing to move if the receipt has not posted yet — it simply gains a
  // customer, and posting will credit A/R directly.
  if (receipt.status === 'posted') {
    const result = await posting.post(tx, ctx, {
      eventType: 'sales.customer_receipt_identified',
      documentTypeCode: DOCUMENT_TYPE,
      source: { module: 'sales', documentId: id, event: 'identified' },
      branchCode: receipt.branchCode,
      documentDate: receipt.receiptDate,
      postingDate: receipt.receiptDate,
      description: `Customer receipt ${receipt.receiptNo} identified — ${customerCode}`,
      lines: [
        {
          role: 'customer_clearing',
          debit: toDecimalString(amount, 4n),
          criteria,
          dimensions: { branch: receipt.branchCode, business_partner: customerCode },
        },
        {
          role: 'customer_receivable',
          credit: toDecimalString(amount, 4n),
          criteria,
          dimensions: { branch: receipt.branchCode, business_partner: customerCode },
        },
      ],
    });
    journalEntryId = result.journalEntryId;
  }

  await tx
    .update(customerReceipt)
    .set({ customerId, updatedAt: new Date() })
    .where(eq(customerReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_receipt.identified',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    outcome: 'success',
    before: { customerId: null },
    after: { customerId, customerCode, journalEntryId },
  });

  return { journalEntryId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string) {
  const [receipt] = await tx
    .select()
    .from(customerReceipt)
    .where(eq(customerReceipt.id, id))
    .limit(1);
  if (!receipt) throw new Error(`No customer receipt with id '${id}'.`);
  return receipt;
}

async function codeOf(tx: Tx, businessPartnerId: string): Promise<string | null> {
  const [partner] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, businessPartnerId))
    .limit(1);
  return partner?.code ?? null;
}

export async function view(tx: Tx, id: string) {
  const receipt = await load(tx, id);
  const allocations = await tx
    .select()
    .from(customerReceiptAllocation)
    .where(eq(customerReceiptAllocation.customerReceiptId, id))
    .orderBy(customerReceiptAllocation.allocatedAt);

  return {
    ...receipt,
    allocations,
    unappliedIqd: unapplied({
      amountIqd: parseDecimal(receipt.amountIqd, 4n),
      allocatedIqd: parseDecimal(receipt.allocatedIqd, 4n),
    }),
  };
}

/**
 * §16 — the unapplied report. Two kinds of money sit here:
 *
 *   *Unidentified* — nobody knows whose it is, and the credit is in clearing.
 *   *Identified but unapplied* — the customer is known and the money has not
 *   been matched to an invoice yet.
 *
 * Both are open items and both belong on the same list, because the question a
 * collections clerk asks is *"what money is not doing its job?"*
 */
export async function unappliedReceipts(tx: Tx, branchCode?: string) {
  const result = await tx.execute(sql`
    select r.receipt_no                              as "receiptNo",
           r.receipt_date::text                      as "receiptDate",
           r.branch_code                             as "branchCode",
           p.code                                    as "customerCode",
           r.bank_reference                          as "bankReference",
           r.amount_iqd::text                        as "amountIqd",
           r.allocated_iqd::text                     as "allocatedIqd",
           (r.amount_iqd - r.allocated_iqd)::text    as "unappliedIqd",
           (r.customer_id is null)                   as "unidentified"
      from customer_receipt r
      left join business_partner p on p.id = r.customer_id
     where r.status in ('posted', 'approved')
       and r.amount_iqd > r.allocated_iqd
       and (${branchCode ?? null}::text is null or r.branch_code = ${branchCode ?? null})
     order by r.receipt_date, r.receipt_no
  `);

  return (result as unknown as { rows: Record<string, string | boolean>[] }).rows;
}

/**
 * A suggested allocation for a receipt — oldest invoice first.
 *
 * A proposal, not an action: §16 supports matching a payment to the invoice the
 * customer says it is for, and oldest-first is only the default a clerk starts
 * from.
 */
export async function proposeFor(tx: Tx, id: string) {
  const receipt = await load(tx, id);
  if (!receipt.customerId) throw new UnidentifiedReceiptError(receipt.receiptNo);

  const open = await tx
    .select()
    .from(arInvoice)
    .where(
      and(
        eq(arInvoice.customerId, receipt.customerId),
        sql`${arInvoice.status} in ('posted', 'partially_executed')`,
      ),
    );

  return proposeAllocation(
    {
      amountIqd: parseDecimal(receipt.amountIqd, 4n),
      allocatedIqd: parseDecimal(receipt.allocatedIqd, 4n),
    },
    open.map((invoice) => ({
      id: invoice.id,
      dueDate: invoice.dueDate,
      openIqd: openBalance({
        totalIqd: parseDecimal(invoice.netIqd, 4n),
        allocatedIqd: parseDecimal(invoice.allocatedIqd, 4n),
      }),
    })),
  );
}
