/**
 * Customer Credit Notes and Debit Notes — Receivables, 2026-10-04.
 *
 * > "Credit Note — reduces what the customer owes. Invoice 100,000, Credit
 * > Note 10,000, Outstanding 90,000. Debit Note — increases what the customer
 * > owes where appropriate. Both must preserve audit history, post through the
 * > existing accounting mapping, appear on the customer statement, affect
 * > ageing appropriately, remain traceable to the source invoice/document."
 *
 * A note is raised, approved, posted — the life every money document here
 * has — and a posted note is reversed, never edited. It posts through the
 * posting engine like any other document:
 *
 *   Credit   Dr Sales Returns & Allowances   Cr Customer A/R
 *   Debit    Dr Customer A/R                 Cr Revenue
 *
 * The A/R line carries the customer as its business partner, which is what
 * puts the note on the subledger — the statement reads it from there, the
 * ageing's net position reads it from there, and the reconciliation finds it
 * on the control account beside it. Nothing reads the note's own amount as a
 * balance.
 *
 * **A credit note against an invoice settles that invoice when it posts**, up
 * to what the invoice still owes, through the same application every credit
 * uses; anything beyond stays on the account as the customer's credit, which
 * Customer Credits & Advances lists and can put against another debt. **A
 * debit note is owed** from its due date and ages like an invoice, until a
 * receipt or a credit is applied to it there.
 *
 * Governed by the Credit Memo's permission object: the people who may credit
 * a customer for returned goods are the people who may credit or charge them
 * for anything else, and D-HD-5's second factor already applies to them.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  arInvoice,
  businessPartner,
  customerCreditMemo,
  customerNote,
  journalEntry,
  salesOrder,
  salesReturn,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { assertResultAccount, assertStatementAccount } from '../domain/posting-map';
import {
  creditOnPosting,
  noteEvent,
  noteSequenceKey,
  type NoteKind,
} from '../domain/customer-credits';
import type { PostingLineRequest } from '../domain/posting';
import type { DocumentStatus } from '../domain/statuses';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as coa from './chart-of-accounts';
import * as credits from './customer-credits';
import * as journal from './journal';
import * as posting from './posting';
import * as statuses from './statuses';
import * as terms from './payment-terms';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'customer_credit_memo';
/** What the note's files are filed under — the table, not the permission it shares. */
export const ATTACHMENT_OBJECT = 'customer_note';
export const DOCUMENT_TYPE = credits.NOTE_DOCUMENT_TYPE;

export class CustomerNoteError extends Error {
  readonly code = 'CUSTOMER_NOTE_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'CustomerNoteError';
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateNoteInput {
  readonly kind: NoteKind;
  readonly customerId: string;
  readonly branchCode: string;
  readonly noteDate: string;
  /** Debit notes only. Defaults to the customer's payment terms from the note date. */
  readonly dueDate?: string | null;
  /** The invoice it corrects, when it corrects one. */
  readonly arInvoiceId?: string | null;
  readonly amountIqd: bigint;
  readonly reason: string;
  readonly description?: string | null;
  /** The other side of the entry, when the note names it. */
  readonly accountId?: string | null;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateNoteInput,
): Promise<{ id: string; noteNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: input.branchCode });

  if (input.kind !== 'credit' && input.kind !== 'debit') {
    throw new CustomerNoteError(`A note is a credit note or a debit note, not '${String(input.kind)}'.`);
  }
  if (input.amountIqd <= 0n) {
    throw new CustomerNoteError('A note is for a positive amount. Which way it moves the account is what credit and debit say.');
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new CustomerNoteError('A note says why the account is being adjusted (§5.4). Give a reason.');
  }

  const [customer] = await tx
    .select({
      id: businessPartner.id,
      code: businessPartner.code,
      isCustomer: businessPartner.isCustomer,
      paymentTermsCode: businessPartner.paymentTermsCode,
    })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.customerId))
    .limit(1);
  if (!customer) throw new CustomerNoteError(`No business partner with id '${input.customerId}'.`);
  if (!customer.isCustomer) {
    throw new CustomerNoteError(
      `${customer.code} does not hold the Customer role, so it has no customer account to adjust (§6).`,
    );
  }

  if (input.arInvoiceId) {
    const [invoice] = await tx.select().from(arInvoice).where(eq(arInvoice.id, input.arInvoiceId)).limit(1);
    if (!invoice) throw new CustomerNoteError(`No sales invoice with id '${input.arInvoiceId}'.`);
    if (invoice.customerId !== input.customerId) {
      throw new CustomerNoteError(
        `Invoice ${invoice.invoiceNo} belongs to a different customer. A note corrects its own customer's account.`,
      );
    }
    if (!['posted', 'partially_executed', 'settled'].includes(invoice.status)) {
      throw new CustomerNoteError(
        `Invoice ${invoice.invoiceNo} is '${invoice.status}'. A note corrects a posted invoice; a draft is corrected by editing it.`,
      );
    }
    if (input.kind === 'credit' && input.amountIqd > parseDecimal(invoice.netIqd, 4n)) {
      throw new CustomerNoteError(
        `Invoice ${invoice.invoiceNo} came to ${invoice.netIqd} IQD, and a credit note against it cannot be for more than the invoice.`,
      );
    }
  }

  if (input.accountId) {
    const account = await coa.loadAccount(tx, input.accountId);
    assertResultAccount('revenue', account);
  }

  const dueDate =
    input.kind === 'credit'
      ? input.noteDate
      : input.dueDate?.trim() || (await terms.dueDateOn(tx, customer.paymentTermsCode ?? null, input.noteDate));
  if (dueDate < input.noteDate) {
    throw new CustomerNoteError('A debit note cannot fall due before it is issued.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    noteSequenceKey(input.kind),
    { branchCode: input.branchCode, year: Number(input.noteDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(customerNote)
    .values({
      noteNo: allocated.documentNo,
      kind: input.kind,
      customerId: input.customerId,
      branchCode: input.branchCode,
      arInvoiceId: input.arInvoiceId ?? null,
      noteDate: input.noteDate,
      dueDate,
      paymentTermsCode: input.kind === 'debit' && !input.dueDate ? (customer.paymentTermsCode ?? null) : null,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      reason,
      description: input.description?.trim() || null,
      accountId: input.accountId ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: customerNote.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_note.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    outcome: 'success',
    after: {
      noteNo: allocated.documentNo,
      kind: input.kind,
      customerCode: customer.code,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      dueDate,
      arInvoiceId: input.arInvoiceId ?? null,
      reason,
    },
  });

  return { id: created!.id, noteNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// Approve, cancel
// ---------------------------------------------------------------------------

async function lock(tx: Tx, id: string) {
  await tx.execute(sql`select id from customer_note where id = ${id}::uuid for update`);
  const [note] = await tx.select().from(customerNote).where(eq(customerNote.id, id)).limit(1);
  if (!note) throw new CustomerNoteError(`No customer note with id '${id}'.`);
  return note;
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const note = await lock(tx, id);
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: note.branchCode, objectId: id });
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, note.status, 'approved');

  const now = new Date();
  await tx
    .update(customerNote)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: now, updatedAt: now })
    .where(eq(customerNote.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_note.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: note.branchCode,
    outcome: 'success',
    before: { status: note.status },
    after: { status: 'approved' },
  });
}

/** A draft that should never have been raised. Nothing posted, nothing to undo. */
export async function cancel(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const note = await lock(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: note.branchCode, objectId: id });
  const why = reason.trim();
  if (!why) throw new CustomerNoteError('Say why the draft is being cancelled.');
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, note.status, 'cancelled', why);

  await tx.update(customerNote).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(customerNote.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_note.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: note.branchCode,
    outcome: 'success',
    before: { status: note.status },
    after: { status: 'cancelled' },
    reason: why,
  });
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

export async function post(tx: Tx, ctx: ActorContext, id: string): Promise<{ journalEntryId: string; appliedIqd: bigint }> {
  const note = await lock(tx, id);
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: note.branchCode, objectId: id });
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, note.status, 'posted');

  const [customer] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, note.customerId))
    .limit(1);

  // The invoice it corrects lends the note its receivable account and its
  // dimensions, so the correction lands on the same control account and the
  // same P&L line the sale did — otherwise both would be wrong.
  const [invoice] = note.arInvoiceId
    ? await tx.select().from(arInvoice).where(eq(arInvoice.id, note.arInvoiceId)).limit(1)
    : [];
  const [order] = invoice?.salesOrderId
    ? await tx
        .select({ departmentCode: salesOrder.departmentCode, businessLineCode: salesOrder.businessLineCode })
        .from(salesOrder)
        .where(eq(salesOrder.id, invoice.salesOrderId))
        .limit(1)
    : [];

  if (invoice?.receivableAccountId) {
    assertStatementAccount('customer', await coa.loadAccount(tx, invoice.receivableAccountId));
  }

  const amount = note.amountIqd;
  const criteria = { branchCode: note.branchCode };
  const dimensions = {
    branch: note.branchCode,
    business_partner: customer?.code ?? null,
    business_line: order?.businessLineCode ?? invoice?.businessLineCode ?? null,
    department: order?.departmentCode ?? invoice?.departmentCode ?? null,
  };
  const receivable: PostingLineRequest = {
    role: 'customer_receivable',
    ...(invoice?.receivableAccountId ? { accountId: invoice.receivableAccountId } : {}),
    criteria,
    dimensions,
    description: invoice ? `${note.noteNo} — ${invoice.invoiceNo}` : note.noteNo,
  };
  const other: PostingLineRequest = {
    role: note.kind === 'credit' ? 'sales_returns' : 'sales_revenue',
    ...(note.accountId ? { accountId: note.accountId } : {}),
    criteria,
    dimensions,
    description: note.reason,
  };

  const lines: PostingLineRequest[] =
    note.kind === 'credit'
      ? [{ ...other, debit: amount }, { ...receivable, credit: amount }]
      : [{ ...receivable, debit: amount }, { ...other, credit: amount }];

  const result = await posting.post(tx, ctx, {
    eventType: noteEvent(note.kind),
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'sales', documentId: id, event: 'posted' },
    branchCode: note.branchCode,
    documentDate: note.noteDate,
    postingDate: note.noteDate,
    description: `Customer ${note.kind} note ${note.noteNo} — ${customer?.code ?? 'customer'}`,
    lines,
  });

  const now = new Date();
  await tx
    .update(customerNote)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: now,
      updatedAt: now,
    })
    .where(eq(customerNote.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_note.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: note.branchCode,
    outcome: 'success',
    before: { status: note.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId, amountIqd: note.amountIqd },
  });

  // A credit note against an invoice settles it as far as it still owes.
  let appliedIqd = 0n;
  if (note.kind === 'credit' && invoice) {
    const outstanding = parseDecimal(invoice.netIqd, 4n) - parseDecimal(invoice.allocatedIqd, 4n);
    appliedIqd = creditOnPosting(parseDecimal(note.amountIqd, 4n), outstanding);
    if (appliedIqd > 0n && ['posted', 'partially_executed'].includes(invoice.status)) {
      await credits.apply(tx, ctx, {
        source: { kind: 'credit_note', id },
        target: { kind: 'invoice', id: invoice.id },
        amountIqd: appliedIqd,
        appliedOn: note.noteDate,
        note: `Applied on posting to the invoice it corrects.`,
      });
    } else {
      appliedIqd = 0n;
    }
  }

  return { journalEntryId: result.journalEntryId, appliedIqd };
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

/**
 * Undoes a posted note — its journal mirrored by the journal service, the
 * note marked reversed with the reason. Refused once anything has been
 * applied from or to it: an application is a fact about two documents, and
 * pulling one of them out from under it would leave the other wrong.
 */
export async function reverse(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { readonly reason: string },
): Promise<{ reversalEntryNo: string }> {
  const note = await lock(tx, id);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, { branchCode: note.branchCode, objectId: id });

  const reason = input.reason.trim();
  if (!reason) throw new CustomerNoteError('A reversal records why the note was wrong (§14.3). Give a reason.');
  if (parseDecimal(note.allocatedIqd, 4n) !== 0n) {
    throw new CustomerNoteError(
      note.kind === 'credit'
        ? `${note.allocatedIqd} IQD of ${note.noteNo} has been applied to what the customer owes. A credit that has been used is not withdrawn; raise a debit note for the correction.`
        : `${note.allocatedIqd} IQD has been received against ${note.noteNo}. A charge that has been paid is not withdrawn; raise a credit note for the correction.`,
    );
  }
  if (!note.journalEntryId) throw new CustomerNoteError(`${note.noteNo} has no journal to reverse.`);
  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, note.status, 'reversed', reason);

  const reversal = await journal.reverse(tx, ctx, note.journalEntryId, { reason });

  const now = new Date();
  await tx
    .update(customerNote)
    .set({
      status: 'reversed',
      reversedBy: ctx.principal.userId,
      reversedAt: now,
      reversalReason: reason,
      reversalJournalEntryId: reversal.id,
      updatedAt: now,
    })
    .where(eq(customerNote.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_note.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: note.branchCode,
    outcome: 'success',
    before: { status: note.status, journalEntryId: note.journalEntryId },
    after: { status: 'reversed', reversalEntryNo: reversal.entryNo },
    reason,
    relatedObjectId: reversal.id,
  });

  return { reversalEntryNo: reversal.entryNo };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type RegisterKind = 'credit_note' | 'debit_note' | 'credit_memo';

export interface RegisterRow {
  readonly kind: RegisterKind;
  readonly id: string;
  readonly documentNo: string;
  readonly documentDate: string;
  readonly dueDate: string;
  readonly branchCode: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly invoiceNo: string | null;
  readonly amountIqd: string;
  readonly allocatedIqd: string;
  readonly status: string;
  readonly reason: string | null;
}

/**
 * The register — every note, and every credit memo beside them.
 *
 * The memos are not this module's documents (the Sales Return raises them),
 * but a reader asking "what credits and debits has this customer had?" is
 * asking about both, so they are listed together and told apart by kind.
 */
export async function list(tx: Tx): Promise<RegisterRow[]> {
  const result = await tx.execute(sql`
    select * from (
      select case when n.kind = 'credit' then 'credit_note' else 'debit_note' end as "kind",
             n.id::text as "id", n.note_no as "documentNo", n.note_date::text as "documentDate",
             n.due_date::text as "dueDate", n.branch_code as "branchCode",
             p.code as "customerCode", p.legal_name as "customerName", i.invoice_no as "invoiceNo",
             n.amount_iqd::text as "amountIqd", n.allocated_iqd::text as "allocatedIqd",
             n.status::text as "status", n.reason as "reason"
        from customer_note n
        join business_partner p on p.id = n.customer_id
        left join ar_invoice i on i.id = n.ar_invoice_id
      union all
      select 'credit_memo', m.id::text, m.memo_no, m.memo_date::text, m.memo_date::text, m.branch_code,
             p.code, p.legal_name, i.invoice_no, m.amount_iqd::text, m.allocated_iqd::text,
             m.status::text, sr.return_no
        from customer_credit_memo m
        join business_partner p on p.id = m.customer_id
        join sales_return sr on sr.id = m.sales_return_id
        left join ar_invoice i on i.id = m.ar_invoice_id
    ) r
     order by r."documentDate" desc, r."documentNo" desc
  `);
  return result.rows as unknown as RegisterRow[];
}

/** One note by the number printed on it, with the names a page shows. */
export async function viewByNo(tx: Tx, noteNo: string) {
  const [row] = await tx
    .select({ note: customerNote, customerCode: businessPartner.code, customerName: businessPartner.legalName })
    .from(customerNote)
    .innerJoin(businessPartner, eq(businessPartner.id, customerNote.customerId))
    .where(eq(customerNote.noteNo, noteNo))
    .limit(1);
  if (!row) return null;
  const note = row.note;

  const [invoice] = note.arInvoiceId
    ? await tx
        .select({ invoiceNo: arInvoice.invoiceNo, netIqd: arInvoice.netIqd, allocatedIqd: arInvoice.allocatedIqd })
        .from(arInvoice)
        .where(eq(arInvoice.id, note.arInvoiceId))
        .limit(1)
    : [];

  const entryNo = async (journalId: string | null) =>
    journalId
      ? ((
          await tx
            .select({ entryNo: journalEntry.entryNo })
            .from(journalEntry)
            .where(eq(journalEntry.id, journalId))
            .limit(1)
        )[0]?.entryNo ?? null)
      : null;

  const ids = [note.createdBy, note.approvedBy, note.postedBy, note.reversedBy].filter((id): id is string => Boolean(id));
  const people = ids.length
    ? await tx.select({ id: appUser.id, displayName: appUser.displayName }).from(appUser).where(inArray(appUser.id, ids))
    : [];
  const name = (id: string | null) => (id ? (people.find((person) => person.id === id)?.displayName ?? null) : null);

  const account = note.accountId ? await coa.loadAccount(tx, note.accountId).catch(() => null) : null;

  const applications =
    note.kind === 'credit'
      ? await credits.applicationsOfSource(tx, 'credit_note', note.id)
      : await credits.applicationsToTarget(tx, 'debit_note', note.id);

  return {
    ...note,
    customerCode: row.customerCode,
    customerName: row.customerName,
    invoiceNo: invoice?.invoiceNo ?? null,
    invoiceOutstandingIqd: invoice
      ? toDecimalString(parseDecimal(invoice.netIqd, 4n) - parseDecimal(invoice.allocatedIqd, 4n), 4n)
      : null,
    journalEntryNo: await entryNo(note.journalEntryId),
    reversalEntryNo: await entryNo(note.reversalJournalEntryId),
    raisedBy: name(note.createdBy),
    approvedByName: name(note.approvedBy),
    postedByName: name(note.postedBy),
    reversedByName: name(note.reversedBy),
    accountCode: account?.code ?? null,
    accountName: account?.name ?? null,
    outstandingIqd: toDecimalString(parseDecimal(note.amountIqd, 4n) - parseDecimal(note.allocatedIqd, 4n), 4n),
    applications,
  };
}

/** A credit memo by its number — read-only; the Sales Return raises and posts it. */
export async function memoByNo(tx: Tx, memoNo: string) {
  const result = await tx.execute(sql`
    select m.id::text as "id", m.memo_no as "memoNo", m.memo_date::text as "memoDate",
           m.status::text as "status", m.branch_code as "branchCode",
           m.amount_iqd::text as "amountIqd", m.allocated_iqd::text as "allocatedIqd",
           p.code as "customerCode", p.legal_name as "customerName",
           i.invoice_no as "invoiceNo", sr.return_no as "returnNo", sr.offset_kind as "offsetKind",
           j.entry_no as "journalEntryNo"
      from customer_credit_memo m
      join business_partner p on p.id = m.customer_id
      join sales_return sr on sr.id = m.sales_return_id
      left join ar_invoice i on i.id = m.ar_invoice_id
      left join journal_entry j on j.id = m.journal_entry_id
     where m.memo_no = ${memoNo}
     limit 1
  `);
  const memo = (result.rows as unknown as MemoView[])[0];
  if (!memo) return null;
  const elsewhere = await credits.applicationsOfSource(tx, 'credit_memo', memo.id);
  // What the memo put against its own invoice is held on the memo's running
  // total rather than as a row (`customer-credit-memo.applyTo`), so it is
  // worked out here and shown first — it is where the memo went.
  const own =
    parseDecimal(memo.allocatedIqd, 4n) -
    elsewhere.reduce((sum, row) => sum + parseDecimal(row.amountIqd, 4n), 0n);
  const applications: credits.ApplicationRow[] = [
    ...(own > 0n && memo.invoiceNo
      ? [
          {
            id: `${memo.id}-own`,
            appliedOn: memo.memoDate,
            amountIqd: toDecimalString(own, 4n),
            sourceKind: 'credit_memo' as const,
            sourceNo: memo.memoNo,
            targetKind: 'invoice' as const,
            targetNo: memo.invoiceNo,
            note: null,
          },
        ]
      : []),
    ...elsewhere,
  ];
  return { ...memo, applications };
}

interface MemoView {
  readonly id: string;
  readonly memoNo: string;
  readonly memoDate: string;
  readonly status: string;
  readonly branchCode: string;
  readonly amountIqd: string;
  readonly allocatedIqd: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly invoiceNo: string | null;
  readonly returnNo: string;
  readonly offsetKind: string;
  readonly journalEntryNo: string | null;
}

/**
 * Everything raised against one invoice that is not a receipt — its credit
 * notes, debit notes, credit memos and sales returns — for the invoice's own
 * page.
 */
export async function againstInvoice(tx: Tx, arInvoiceId: string) {
  const notes = await tx
    .select({
      kind: customerNote.kind,
      noteNo: customerNote.noteNo,
      noteDate: customerNote.noteDate,
      amountIqd: customerNote.amountIqd,
      status: customerNote.status,
    })
    .from(customerNote)
    .where(eq(customerNote.arInvoiceId, arInvoiceId))
    .orderBy(desc(customerNote.noteDate));
  const memos = await tx
    .select({
      memoNo: customerCreditMemo.memoNo,
      memoDate: customerCreditMemo.memoDate,
      amountIqd: customerCreditMemo.amountIqd,
      status: customerCreditMemo.status,
    })
    .from(customerCreditMemo)
    .where(and(eq(customerCreditMemo.arInvoiceId, arInvoiceId)))
    .orderBy(desc(customerCreditMemo.memoDate));
  const returns = await tx
    .select({ returnNo: salesReturn.returnNo, requestedOn: salesReturn.requestedOn, status: salesReturn.status })
    .from(salesReturn)
    .where(eq(salesReturn.arInvoiceId, arInvoiceId))
    .orderBy(desc(salesReturn.requestedOn));
  return { notes, memos, returns };
}

/** A posted note's status as the document type's own vocabulary. */
export function isOpen(status: DocumentStatus | string): boolean {
  return status === 'posted' || status === 'partially_executed';
}

/**
 * The invoices a note can be raised against for one customer — posted ones,
 * newest first, with what each still owes. A draft is corrected by editing it,
 * and a reversed one is not there to correct.
 */
export async function invoicesFor(tx: Tx, customerId: string) {
  const rows = await tx
    .select({
      id: arInvoice.id,
      invoiceNo: arInvoice.invoiceNo,
      invoiceDate: arInvoice.invoiceDate,
      netIqd: arInvoice.netIqd,
      allocatedIqd: arInvoice.allocatedIqd,
      status: arInvoice.status,
    })
    .from(arInvoice)
    .where(
      and(
        eq(arInvoice.customerId, customerId),
        inArray(arInvoice.status, ['posted', 'partially_executed', 'settled']),
      ),
    )
    .orderBy(desc(arInvoice.invoiceDate), desc(arInvoice.invoiceNo));
  return rows.map((row) => ({
    ...row,
    outstandingIqd: toDecimalString(parseDecimal(row.netIqd, 4n) - parseDecimal(row.allocatedIqd, 4n), 4n),
  }));
}
