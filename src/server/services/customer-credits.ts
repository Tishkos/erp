/**
 * Customer Credits & Advances — what a customer is owed back, and putting it
 * against what they owe (Receivables, 2026-10-04).
 *
 * > "Customer pays 5,000,000 IQD but there is no invoice yet. The system should
 * > show Customer Credit / Advance = 5,000,000 IQD. Do NOT create a fake
 * > invoice. Later, the credit can be allocated against a real invoice."
 *
 * **Nothing here is a balance of its own.** A customer's credit is read off
 * the documents that made it — a posted receipt's unapplied remainder, a
 * credit memo's or credit note's — and those documents already posted to the
 * customer subledger, so the statement and the ageing's net position say the
 * same thing in the ledger's words. There is no "advance" table to drift.
 *
 * **One place per settlement.** A receipt against an invoice is the receipt's
 * own allocation (`customer-receipt.allocate`, `customer_receipt_allocation`)
 * and a memo against the invoice it was raised for is the memo's own
 * (`customer-credit-memo.applyTo`) — both are called, not re-implemented.
 * Every other pairing (a receipt against a debit note, a credit note against
 * an invoice, a memo's remainder against another invoice) is one
 * `customer_credit_application` row, written beside the two running totals it
 * moves, in one transaction.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  businessPartner,
  customerCreditApplication,
  customerCreditMemo,
  customerNote,
  customerReceipt,
  salesReturn,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { settlementStatusFor } from '../domain/ar-invoicing';
import { receiptStatusFor, UnidentifiedReceiptError } from '../domain/receipt-allocation';
import { businessToday } from '../domain/business-date';
import type { DocumentStatus } from '../domain/statuses';
import {
  assertApplicable,
  CreditApplicationError,
  type CreditSourceKind,
  type DebtTargetKind,
} from '../domain/customer-credits';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as statuses from './statuses';
import * as arInvoiceService from './ar-invoice';
import * as receipts from './customer-receipt';
import * as creditMemos from './customer-credit-memo';

/** The object each source is authorised on — the one its own screen asks. */
const SOURCE_OBJECT: Readonly<Record<CreditSourceKind, string>> = {
  receipt: 'customer_receipt',
  credit_memo: 'customer_credit_memo',
  credit_note: 'customer_credit_memo',
};

/** Statuses at which a credit or a debt is real and still movable. */
const LIVE = ['posted', 'partially_executed', 'settled'] as const;

interface Source {
  readonly kind: CreditSourceKind;
  readonly id: string;
  readonly number: string;
  readonly customerId: string;
  readonly branchCode: string;
  readonly status: DocumentStatus;
  readonly amount: bigint;
  readonly allocated: bigint;
  /** A memo's own invoice, which its own `applyTo` settles. */
  readonly ownInvoiceId: string | null;
}

interface Target {
  readonly kind: DebtTargetKind;
  readonly id: string;
  readonly number: string;
  readonly customerId: string;
  readonly status: DocumentStatus;
  readonly total: bigint;
  readonly allocated: bigint;
}

const dec = (value: string) => parseDecimal(value, 4n);

async function lockSource(tx: Tx, kind: CreditSourceKind, id: string): Promise<Source> {
  if (kind === 'receipt') {
    await tx.execute(sql`select id from customer_receipt where id = ${id}::uuid for update`);
    const [row] = await tx.select().from(customerReceipt).where(eq(customerReceipt.id, id)).limit(1);
    if (!row) throw new CreditApplicationError(`No customer receipt with id '${id}'.`);
    if (!row.customerId) throw new UnidentifiedReceiptError(row.receiptNo);
    return {
      kind,
      id,
      number: row.receiptNo,
      customerId: row.customerId,
      branchCode: row.branchCode,
      status: row.status,
      amount: dec(row.amountIqd),
      allocated: dec(row.allocatedIqd),
      ownInvoiceId: null,
    };
  }

  if (kind === 'credit_memo') {
    await tx.execute(sql`select id from customer_credit_memo where id = ${id}::uuid for update`);
    const [row] = await tx
      .select({ memo: customerCreditMemo, offsetKind: salesReturn.offsetKind })
      .from(customerCreditMemo)
      .innerJoin(salesReturn, eq(salesReturn.id, customerCreditMemo.salesReturnId))
      .where(eq(customerCreditMemo.id, id))
      .limit(1);
    if (!row) throw new CreditApplicationError(`No customer credit memo with id '${id}'.`);
    // A memo settled at the till never reached the account: the customer was
    // paid back, so there is nothing of theirs left on it to apply.
    if (row.offsetKind === 'bank') {
      throw new CreditApplicationError(
        `Credit memo ${row.memo.memoNo} was refunded from the bank, so it never reached the customer's account and has nothing to apply.`,
      );
    }
    return {
      kind,
      id,
      number: row.memo.memoNo,
      customerId: row.memo.customerId,
      branchCode: row.memo.branchCode,
      status: row.memo.status,
      amount: dec(row.memo.amountIqd),
      allocated: dec(row.memo.allocatedIqd),
      ownInvoiceId: row.memo.arInvoiceId,
    };
  }

  await tx.execute(sql`select id from customer_note where id = ${id}::uuid for update`);
  const [row] = await tx.select().from(customerNote).where(eq(customerNote.id, id)).limit(1);
  if (!row) throw new CreditApplicationError(`No customer note with id '${id}'.`);
  if (row.kind !== 'credit') {
    throw new CreditApplicationError(
      `${row.noteNo} is a debit note — it is something the customer owes, not a credit they hold.`,
    );
  }
  return {
    kind,
    id,
    number: row.noteNo,
    customerId: row.customerId,
    branchCode: row.branchCode,
    status: row.status,
    amount: dec(row.amountIqd),
    allocated: dec(row.allocatedIqd),
    ownInvoiceId: null,
  };
}

async function lockTarget(tx: Tx, kind: DebtTargetKind, id: string): Promise<Target> {
  if (kind === 'invoice') {
    await tx.execute(sql`select id from ar_invoice where id = ${id}::uuid for update`);
    const [row] = await tx.select().from(arInvoice).where(eq(arInvoice.id, id)).limit(1);
    if (!row) throw new CreditApplicationError(`No sales invoice with id '${id}'.`);
    return {
      kind,
      id,
      number: row.invoiceNo,
      customerId: row.customerId,
      status: row.status,
      total: dec(row.netIqd),
      allocated: dec(row.allocatedIqd),
    };
  }

  await tx.execute(sql`select id from customer_note where id = ${id}::uuid for update`);
  const [row] = await tx.select().from(customerNote).where(eq(customerNote.id, id)).limit(1);
  if (!row) throw new CreditApplicationError(`No customer note with id '${id}'.`);
  if (row.kind !== 'debit') {
    throw new CreditApplicationError(`${row.noteNo} is a credit note; a credit is applied to an invoice or a debit note.`);
  }
  return {
    kind,
    id,
    number: row.noteNo,
    customerId: row.customerId,
    status: row.status,
    total: dec(row.amountIqd),
    allocated: dec(row.allocatedIqd),
  };
}

export interface ApplyCreditInput {
  readonly source: { readonly kind: CreditSourceKind; readonly id: string };
  readonly target: { readonly kind: DebtTargetKind; readonly id: string };
  readonly amountIqd: bigint;
  /** Defaults to the business day it is done. */
  readonly appliedOn?: string;
  readonly note?: string | null;
}

/**
 * Puts a customer's credit against something they owe.
 *
 * The specific refusals come before anything moves: the credit and the debt
 * belong to one customer, both are posted, neither ceiling is crossed. Then
 * the two running totals move and the row that explains them is written, in
 * the one transaction the caller holds.
 */
export async function apply(
  tx: Tx,
  ctx: ActorContext,
  input: ApplyCreditInput,
): Promise<{ sourceStatus: string; targetStatus: string }> {
  const source = await lockSource(tx, input.source.kind, input.source.id);

  await authz.authorize(ctx.principal, 'execute', SOURCE_OBJECT[source.kind], {
    branchCode: source.branchCode,
    objectId: source.id,
  });

  if (!(LIVE as readonly string[]).includes(source.status)) {
    throw new CreditApplicationError(
      `${source.number} is '${source.status}'. A credit is applied once it has been posted.`,
    );
  }

  const target = await lockTarget(tx, input.target.kind, input.target.id);
  if (!(LIVE as readonly string[]).includes(target.status)) {
    throw new CreditApplicationError(`${target.number} is '${target.status}', and only a posted document is owed.`);
  }

  assertApplicable({
    sourceNo: source.number,
    remainingIqd: source.amount - source.allocated,
    targetNo: target.number,
    outstandingIqd: target.total - target.allocated,
    amountIqd: input.amountIqd,
    sameCustomer: source.customerId === target.customerId,
  });

  // The two pairings that already have their own home are sent there.
  if (source.kind === 'receipt' && target.kind === 'invoice') {
    const outcome = await receipts.allocate(tx, ctx, source.id, [
      { arInvoiceId: target.id, amountIqd: input.amountIqd, note: input.note ?? null },
    ]);
    const [after] = await tx.select({ status: arInvoice.status }).from(arInvoice).where(eq(arInvoice.id, target.id));
    return { sourceStatus: outcome.status, targetStatus: after!.status };
  }
  if (source.kind === 'credit_memo' && target.kind === 'invoice' && source.ownInvoiceId === target.id) {
    const outcome = await creditMemos.applyTo(tx, ctx, source.id, target.id, input.amountIqd);
    const [after] = await tx.select({ status: arInvoice.status }).from(arInvoice).where(eq(arInvoice.id, target.id));
    return { sourceStatus: outcome.status, targetStatus: after!.status };
  }

  // 1. The credit's running total.
  const sourceAllocated = source.allocated + input.amountIqd;
  let sourceStatus: DocumentStatus;
  if (source.kind === 'receipt') {
    sourceStatus = receiptStatusFor({ amountIqd: source.amount, allocatedIqd: sourceAllocated });
    if (sourceStatus !== source.status) {
      await statuses.assertTransitionAllowed(tx, receipts.DOCUMENT_TYPE, source.status, sourceStatus);
    }
    await tx
      .update(customerReceipt)
      .set({ allocatedIqd: toDecimalString(sourceAllocated, 4n), status: sourceStatus, updatedAt: new Date() })
      .where(eq(customerReceipt.id, source.id));
  } else if (source.kind === 'credit_memo') {
    sourceStatus = settlementStatusFor({ totalIqd: source.amount, allocatedIqd: sourceAllocated });
    if (sourceStatus !== source.status) {
      await statuses.assertTransitionAllowed(tx, creditMemos.DOCUMENT_TYPE, source.status, sourceStatus);
    }
    await tx
      .update(customerCreditMemo)
      .set({ allocatedIqd: toDecimalString(sourceAllocated, 4n), status: sourceStatus, updatedAt: new Date() })
      .where(eq(customerCreditMemo.id, source.id));
  } else {
    sourceStatus = settlementStatusFor({ totalIqd: source.amount, allocatedIqd: sourceAllocated });
    if (sourceStatus !== source.status) {
      await statuses.assertTransitionAllowed(tx, NOTE_DOCUMENT_TYPE, source.status, sourceStatus);
    }
    await tx
      .update(customerNote)
      .set({ allocatedIqd: toDecimalString(sourceAllocated, 4n), status: sourceStatus, updatedAt: new Date() })
      .where(eq(customerNote.id, source.id));
  }

  // 2. The row that explains both movements. The database checks both
  //    ceilings and the customer again, whatever route wrote it.
  const appliedOn = input.appliedOn ?? businessToday();
  const [row] = await tx
    .insert(customerCreditApplication)
    .values({
      customerId: source.customerId,
      branchCode: source.branchCode,
      customerReceiptId: source.kind === 'receipt' ? source.id : null,
      customerCreditMemoId: source.kind === 'credit_memo' ? source.id : null,
      creditNoteId: source.kind === 'credit_note' ? source.id : null,
      arInvoiceId: target.kind === 'invoice' ? target.id : null,
      debitNoteId: target.kind === 'debit_note' ? target.id : null,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      appliedOn,
      appliedBy: ctx.principal.userId,
      note: input.note ?? null,
    })
    .returning({ id: customerCreditApplication.id });

  // 3. The debt's running total — through the invoice's own rule, so an
  //    invoice reaches Paid the same way whatever settled it.
  let targetStatus: DocumentStatus;
  if (target.kind === 'invoice') {
    targetStatus = (await arInvoiceService.applyAllocation(tx, ctx, target.id, input.amountIqd)).status as DocumentStatus;
  } else {
    const targetAllocated = target.allocated + input.amountIqd;
    targetStatus = settlementStatusFor({ totalIqd: target.total, allocatedIqd: targetAllocated });
    if (targetStatus !== target.status) {
      await statuses.assertTransitionAllowed(tx, NOTE_DOCUMENT_TYPE, target.status, targetStatus);
    }
    await tx
      .update(customerNote)
      .set({ allocatedIqd: toDecimalString(targetAllocated, 4n), status: targetStatus, updatedAt: new Date() })
      .where(eq(customerNote.id, target.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'customer_credit.applied',
    objectType: SOURCE_OBJECT[source.kind],
    objectId: source.id,
    branchCode: source.branchCode,
    outcome: 'success',
    before: { allocatedIqd: toDecimalString(source.allocated, 4n), status: source.status },
    after: {
      applicationId: row!.id,
      source: `${source.kind}:${source.number}`,
      target: `${target.kind}:${target.number}`,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      allocatedIqd: toDecimalString(sourceAllocated, 4n),
      status: sourceStatus,
      targetStatus,
      appliedOn,
    },
    relatedObjectId: target.id,
  });

  return { sourceStatus, targetStatus };
}

/** The document type the notes' statuses run under (migration 0280). */
export const NOTE_DOCUMENT_TYPE = 'customer_note';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CreditRow {
  readonly kind: CreditSourceKind;
  readonly id: string;
  readonly documentNo: string;
  readonly documentDate: string;
  readonly branchCode: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly status: string;
  readonly amountIqd: string;
  readonly appliedIqd: string;
  readonly unappliedIqd: string;
  /** The invoice a memo or note was raised against, when there is one. */
  readonly sourceInvoiceNo: string | null;
  readonly reference: string | null;
}

/**
 * Every credit a customer holds — the register the screen lists.
 *
 * Three sources, one shape: a posted receipt's remainder (an advance when
 * nothing was owed, an overpayment when more came than was owed), a credit
 * memo's remainder (a return credited beyond what the invoice still owed),
 * and a credit note's. A memo refunded from the bank never reached the
 * account, so it is not here. An unidentified receipt is nobody's credit yet;
 * it sits in clearing and on the receipts' own register until identified.
 */
export async function register(
  tx: Tx,
  filter: { readonly customerId?: string | null; readonly branchCode?: string | null; readonly openOnly?: boolean } = {},
): Promise<CreditRow[]> {
  const customer = filter.customerId ?? null;
  const branch = filter.branchCode ?? null;
  const result = await tx.execute(sql`
    select * from (
      select 'receipt'::text                       as "kind",
             r.id::text                            as "id",
             r.receipt_no                          as "documentNo",
             r.receipt_date::text                  as "documentDate",
             r.branch_code                         as "branchCode",
             p.id::text                            as "customerId",
             p.code                                as "customerCode",
             p.legal_name                          as "customerName",
             r.status::text                        as "status",
             r.amount_iqd::text                    as "amountIqd",
             r.allocated_iqd::text                 as "appliedIqd",
             (r.amount_iqd - r.allocated_iqd)::text as "unappliedIqd",
             null::text                            as "sourceInvoiceNo",
             r.bank_reference                      as "reference"
        from customer_receipt r
        join business_partner p on p.id = r.customer_id
       where r.status in ('posted', 'settled')
      union all
      select 'credit_memo', m.id::text, m.memo_no, m.memo_date::text, m.branch_code,
             p.id::text, p.code, p.legal_name, m.status::text,
             m.amount_iqd::text, m.allocated_iqd::text, (m.amount_iqd - m.allocated_iqd)::text,
             i.invoice_no, sr.return_no
        from customer_credit_memo m
        join sales_return sr on sr.id = m.sales_return_id
        join business_partner p on p.id = m.customer_id
        left join ar_invoice i on i.id = m.ar_invoice_id
       where m.status in ('posted', 'partially_executed', 'settled')
         and sr.offset_kind <> 'bank'
      union all
      select 'credit_note', n.id::text, n.note_no, n.note_date::text, n.branch_code,
             p.id::text, p.code, p.legal_name, n.status::text,
             n.amount_iqd::text, n.allocated_iqd::text, (n.amount_iqd - n.allocated_iqd)::text,
             i.invoice_no, n.reason
        from customer_note n
        join business_partner p on p.id = n.customer_id
        left join ar_invoice i on i.id = n.ar_invoice_id
       where n.kind = 'credit'
         and n.status in ('posted', 'partially_executed', 'settled')
    ) c
     where (${customer}::uuid is null or c."customerId"::uuid = ${customer}::uuid)
       and (${branch}::text is null or c."branchCode" = ${branch})
       and (${filter.openOnly ?? true} = false or c."unappliedIqd"::numeric > 0)
     order by c."documentDate", c."documentNo"
  `);
  return result.rows as unknown as CreditRow[];
}

export interface OpenDebt {
  readonly kind: DebtTargetKind;
  readonly id: string;
  readonly documentNo: string;
  readonly documentDate: string;
  readonly dueDate: string;
  readonly totalIqd: string;
  readonly outstandingIqd: string;
}

/**
 * What one customer still owes, document by document, oldest due first — the
 * choices a credit can be applied to.
 */
export async function openDebtsFor(tx: Tx, customerId: string): Promise<OpenDebt[]> {
  const result = await tx.execute(sql`
    select * from (
      select 'invoice'::text as "kind", i.id::text as "id", i.invoice_no as "documentNo",
             i.invoice_date::text as "documentDate", i.due_date::text as "dueDate",
             i.net_iqd::text as "totalIqd", (i.net_iqd - i.allocated_iqd)::text as "outstandingIqd"
        from ar_invoice i
       where i.customer_id = ${customerId}::uuid
         and i.status in ('posted', 'partially_executed')
         and i.net_iqd > i.allocated_iqd
      union all
      select 'debit_note', n.id::text, n.note_no, n.note_date::text, n.due_date::text,
             n.amount_iqd::text, (n.amount_iqd - n.allocated_iqd)::text
        from customer_note n
       where n.customer_id = ${customerId}::uuid
         and n.kind = 'debit'
         and n.status in ('posted', 'partially_executed')
         and n.amount_iqd > n.allocated_iqd
    ) d
     order by d."dueDate", d."documentDate", d."documentNo"
  `);
  return result.rows as unknown as OpenDebt[];
}

export interface ReceiptTotals {
  readonly customerId: string;
  readonly receivedIqd: string;
  readonly appliedIqd: string;
}

/** Per customer: what has been received, and how much of it is doing its job. */
export async function receiptTotals(
  tx: Tx,
  filter: { readonly branchCode?: string | null } = {},
): Promise<ReceiptTotals[]> {
  const branch = filter.branchCode ?? null;
  const result = await tx.execute(sql`
    select r.customer_id::text               as "customerId",
           sum(r.amount_iqd)::text           as "receivedIqd",
           sum(r.allocated_iqd)::text        as "appliedIqd"
      from customer_receipt r
     where r.customer_id is not null
       and r.status in ('posted', 'settled')
       and (${branch}::text is null or r.branch_code = ${branch})
     group by r.customer_id
  `);
  return result.rows as unknown as ReceiptTotals[];
}

export interface ApplicationRow {
  readonly id: string;
  readonly appliedOn: string;
  readonly amountIqd: string;
  readonly sourceKind: CreditSourceKind;
  readonly sourceNo: string;
  readonly targetKind: DebtTargetKind;
  readonly targetNo: string;
  readonly note: string | null;
}

const APPLICATION_ROWS = sql`
  select a.id::text                                   as "id",
         a.applied_on::text                           as "appliedOn",
         a.amount_iqd::text                           as "amountIqd",
         case when a.customer_receipt_id is not null then 'receipt'
              when a.customer_credit_memo_id is not null then 'credit_memo'
              else 'credit_note' end                  as "sourceKind",
         coalesce(r.receipt_no, m.memo_no, cn.note_no) as "sourceNo",
         case when a.ar_invoice_id is not null then 'invoice' else 'debit_note' end as "targetKind",
         coalesce(i.invoice_no, dn.note_no)           as "targetNo",
         a.note                                       as "note"
    from customer_credit_application a
    left join customer_receipt r      on r.id = a.customer_receipt_id
    left join customer_credit_memo m  on m.id = a.customer_credit_memo_id
    left join customer_note cn        on cn.id = a.credit_note_id
    left join ar_invoice i            on i.id = a.ar_invoice_id
    left join customer_note dn        on dn.id = a.debit_note_id
`;

/** The applications a credit has made, oldest first. */
export async function applicationsOfSource(
  tx: Tx,
  kind: CreditSourceKind,
  id: string,
): Promise<ApplicationRow[]> {
  const column =
    kind === 'receipt'
      ? sql`a.customer_receipt_id`
      : kind === 'credit_memo'
        ? sql`a.customer_credit_memo_id`
        : sql`a.credit_note_id`;
  const result = await tx.execute(sql`${APPLICATION_ROWS} where ${column} = ${id}::uuid order by a.applied_at`);
  return result.rows as unknown as ApplicationRow[];
}

/** The applications a debt has received, oldest first. */
export async function applicationsToTarget(
  tx: Tx,
  kind: DebtTargetKind,
  id: string,
): Promise<ApplicationRow[]> {
  const column = kind === 'invoice' ? sql`a.ar_invoice_id` : sql`a.debit_note_id`;
  const result = await tx.execute(sql`${APPLICATION_ROWS} where ${column} = ${id}::uuid order by a.applied_at`);
  return result.rows as unknown as ApplicationRow[];
}

/** One credit, found by the number printed on it — for the Apply dialog. */
export async function creditByNo(tx: Tx, documentNo: string): Promise<CreditRow | null> {
  const rows = await register(tx, { openOnly: false });
  return rows.find((row) => row.documentNo === documentNo) ?? null;
}

/** The customers named on a set of credits, for the filter. */
export async function customersWithCredit(tx: Tx) {
  const rows = await register(tx);
  const ids = [...new Set(rows.map((row) => row.customerId))];
  if (ids.length === 0) return [];
  return tx
    .select({ id: businessPartner.id, code: businessPartner.code, legalName: businessPartner.legalName })
    .from(businessPartner)
    .where(and(inArray(businessPartner.id, ids)))
    .orderBy(asc(businessPartner.code));
}
