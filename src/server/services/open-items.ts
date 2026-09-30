import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { AGEING_BUCKETS, bucketFor, daysBetween, type AgeingBucket } from '../domain/ageing';
import { assertCan, type Principal } from '../domain/permissions';

/**
 * Open items — what is owed to us and what we owe, invoice by invoice.
 *
 * ── One shape, two sides ──────────────────────────────────────────────────
 * Receivables and payables are the same report in a mirror: an invoice, a due
 * date the payment terms decided, what has been paid against it, what is left,
 * and how late that remainder is. Written once and pointed at either side, so
 * the two can never drift into disagreeing about what "overdue" means — which
 * is exactly what happens when a company grows an A/R ageing and an A/P ageing
 * as separate screens six months apart.
 *
 * ── Where the figures come from ───────────────────────────────────────────
 * The invoice's own columns. `ar_invoice.allocated_iqd` and
 * `ap_invoice.settled_amount_iqd` are maintained by the allocation services in
 * the same transaction that records the allocation, so "paid" here is the same
 * number the invoice's own page shows and the same one the payment screen
 * decremented. Nothing is re-added from the receipt side; a second sum would
 * be a second answer.
 *
 * The payment *history* is read from the allocation rows, which is what makes
 * partial payment legible rather than merely permitted: three payments against
 * one invoice are three rows, each with its date and amount, and the invoice
 * keeps all of them.
 *
 * ── Ageing is counted from the due date ───────────────────────────────────
 * Not the invoice date. An invoice on 60-day terms is not overdue on day 30,
 * and a report that said so would have somebody telephoning a customer who has
 * done nothing wrong. `domain/ageing.ts` owns that rule and this asks it,
 * rather than writing a second `CASE WHEN` that has to be kept in step.
 */

export type Side = 'customer' | 'supplier';

/** Which object authorises each side — the same one its invoice screen asks. */
export const PERMISSION_OBJECT: Readonly<Record<Side, string>> = {
  customer: 'ar_invoice',
  supplier: 'ap_invoice',
};

export interface Payment {
  readonly paidOn: string;
  readonly amountIqd: string;
  /** The receipt or payment that settled it, so the history can be opened. */
  readonly documentNo: string | null;
}

export interface OpenItem {
  readonly side: Side;
  readonly partyCode: string;
  readonly partyName: string;
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  /** What decided the due date. Null on an invoice raised before terms existed. */
  readonly paymentTermsCode: string | null;
  readonly paymentTermsName: string | null;
  readonly status: string;
  readonly totalIqd: string;
  readonly paidIqd: string;
  readonly outstandingIqd: string;
  /** Days remaining until it falls due. Negative once it has passed. */
  readonly daysUntilDue: number;
  /** 0 until the due date has passed, then how far past it is. */
  readonly daysOverdue: number;
  readonly bucket: AgeingBucket;
  /** When money last arrived against it, and how late that was. */
  readonly lastPaymentDate: string | null;
  readonly daysLateAtLastPayment: number | null;
  readonly payments: readonly Payment[];
}

const SIDES = {
  customer: {
    invoice: sql`ar_invoice`,
    partyColumn: sql`customer_id`,
    total: sql`net_iqd`,
    paid: sql`allocated_iqd`,
    number: sql`invoice_no`,
    date: sql`invoice_date`,
    allocation: sql`customer_receipt_allocation`,
    allocationInvoice: sql`ar_invoice_id`,
    allocationDocument: sql`customer_receipt`,
    allocationDocumentId: sql`customer_receipt_id`,
    allocationDocumentNo: sql`receipt_no`,
    /*
     * A sales invoice records the terms it was raised on, so it keeps saying
     * "Net 7" even after the customer is moved to Net 30 — which is what makes
     * an old invoice's due date defensible. Falls back to the customer's
     * standing terms for invoices raised before the column existed.
     */
    terms: sql`coalesce(i.payment_terms_code, p.payment_terms_code)`,
    reversible: false,
  },
  supplier: {
    invoice: sql`ap_invoice`,
    partyColumn: sql`supplier_id`,
    total: sql`total_iqd`,
    paid: sql`settled_amount_iqd`,
    number: sql`invoice_no`,
    date: sql`invoice_date`,
    allocation: sql`supplier_payment_allocation`,
    allocationInvoice: sql`ap_invoice_id`,
    allocationDocument: sql`supplier_payment`,
    allocationDocumentId: sql`supplier_payment_id`,
    allocationDocumentNo: sql`payment_no`,
    /*
     * A purchase invoice stores its due date but not the terms behind it, so
     * the supplier's standing terms are the only answer available. That is a
     * real gap rather than a choice: move a supplier to different terms and an
     * old invoice will describe itself with the new ones, while its due date —
     * which is stored — stays correct. Worth an `ap_invoice.payment_terms_code`
     * of its own, mirroring the sales side.
     */
    terms: sql`p.payment_terms_code`,
    // A supplier allocation can be undone; a reversed one is not a payment.
    reversible: true,
  },
} as const;

/** Statuses that mean the invoice is a real debt. A draft is not one. */
const OPEN_STATUSES = sql`('posted', 'partially_executed', 'settled')`;

/**
 * How far ahead "due soon" reaches.
 *
 * A week: long enough to do something about, short enough that the same
 * invoice is not called imminent for a month. The report and the morning
 * sweep share it, so a screen saying "falling due soon" and a notification
 * saying the same thing are talking about the same invoices.
 */
export const DUE_SOON_DAYS = 7;

export interface OpenItemFilter {
  readonly branchCode?: string | null;
  readonly partyCode?: string | null;
  /** Only what is still owed. Off by default, so a paid invoice keeps its history. */
  readonly outstandingOnly?: boolean;
  readonly overdueOnly?: boolean;
  /**
   * Only what falls due within this many days and has not fallen due yet.
   * "Coming up", which is a different question from "already late".
   */
  readonly dueWithinDays?: number | null;
  /** Narrow to particular document statuses — part paid, untouched, and so on. */
  readonly statuses?: readonly string[] | null;
}

/**
 * The five questions a reader actually asks of an account, named.
 *
 * Kept here rather than in the screen because the printed copy has to answer
 * the same question the screen was showing when Print was pressed. A statement
 * headed "Overdue" that lists everything is worse than no statement.
 */
export const OPEN_ITEM_VIEWS = ['all', 'soon', 'overdue', 'unpaid', 'part_paid'] as const;
export type OpenItemView = (typeof OPEN_ITEM_VIEWS)[number];

/** Whatever arrived in the query string, as one of the five. Unknown reads as all. */
export function viewFrom(value: unknown): OpenItemView {
  return (OPEN_ITEM_VIEWS as readonly string[]).includes(value as string)
    ? (value as OpenItemView)
    : 'all';
}

/** One view, as this service's filter. */
export function viewFilter(view: OpenItemView): OpenItemFilter {
  switch (view) {
    case 'soon':
      return { dueWithinDays: DUE_SOON_DAYS };
    case 'overdue':
      return { overdueOnly: true };
    // Posted with nothing allocated against it yet. `partially_executed` is
    // what the allocation services move an invoice to on the first payment,
    // so the two together are every invoice that still owes something.
    case 'unpaid':
      return { statuses: ['posted'] };
    case 'part_paid':
      return { statuses: ['partially_executed'] };
    default:
      return {};
  }
}

/**
 * Every invoice on one side, with what is left on it and how late that is.
 *
 * Settled invoices are included unless `outstandingOnly` asks otherwise: the
 * sponsor asked for *"days late after payment"*, and an invoice paid eleven
 * days late is exactly the row that answers it. Dropping it the moment the
 * balance hits zero would delete the only evidence of how the account is
 * actually being paid.
 */
export async function openItems(
  tx: Tx,
  principal: Principal,
  side: Side,
  asOf: string,
  filter: OpenItemFilter = {},
): Promise<OpenItem[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT[side]);
  const s = SIDES[side];
  const branch = filter.branchCode ?? null;
  const party = filter.partyCode ?? null;

  // A reversed allocation is money that came back; it is not a payment and
  // must not appear in the history or the paid total.
  const live = s.reversible ? sql`and a.reversed_at is null` : sql``;

  const result = await tx.execute(sql`
    select p.code                                    as "partyCode",
           p.legal_name                              as "partyName",
           i.id::text                                as "invoiceId",
           i.${s.number}                             as "invoiceNo",
           i.${s.date}::text                         as "invoiceDate",
           i.due_date::text                          as "dueDate",
           ${s.terms}                                as "paymentTermsCode",
           t.name                                    as "paymentTermsName",
           i.status::text                            as "status",
           i.${s.total}::text                        as "totalIqd",
           i.${s.paid}::text                         as "paidIqd",
           (i.${s.total} - i.${s.paid})::text        as "outstandingIqd",
           coalesce((
             select json_agg(json_build_object(
                      'paidOn',     a.allocated_at::date::text,
                      'amountIqd',  a.amount_iqd::text,
                      'documentNo', d.${s.allocationDocumentNo}
                    ) order by a.allocated_at)
               from ${s.allocation} a
               join ${s.allocationDocument} d on d.id = a.${s.allocationDocumentId}
              where a.${s.allocationInvoice} = i.id ${live}
           ), '[]'::json)                            as "payments"
      from ${s.invoice} i
      join business_partner p on p.id = i.${s.partyColumn}
      left join payment_terms t on t.code = ${s.terms}
     where i.status::text in ${OPEN_STATUSES}
       and i.${s.date} <= ${asOf}::date
       and (${branch}::text is null or i.branch_code = ${branch})
       and (${party}::text is null or p.code = ${party})
     order by i.due_date, i.${s.number}
  `);

  const rows = result.rows as unknown as (Omit<
    OpenItem,
    'side' | 'daysUntilDue' | 'daysOverdue' | 'bucket' | 'lastPaymentDate' | 'daysLateAtLastPayment'
  > & { payments: Payment[] })[];

  return rows
    .map((row): OpenItem => {
      const untilDue = daysBetween(asOf, row.dueDate);
      const payments = row.payments ?? [];
      const last = payments.at(-1) ?? null;
      return {
        ...row,
        side,
        payments,
        daysUntilDue: untilDue,
        // Zero, not a negative number, while it is still in time: "overdue by
        // -6 days" is not a sentence anybody reads correctly.
        daysOverdue: untilDue < 0 ? -untilDue : 0,
        bucket: bucketFor(row.dueDate, asOf),
        lastPaymentDate: last?.paidOn ?? null,
        // How late the money actually was — the question a credit controller
        // asks about a customer who always pays, eventually.
        daysLateAtLastPayment: last ? Math.max(0, daysBetween(row.dueDate, last.paidOn)) : null,
      };
    })
    .filter((item) => {
      if (filter.outstandingOnly && Number(item.outstandingIqd) <= 0) return false;
      if (filter.overdueOnly && item.daysOverdue === 0) return false;
      // Coming up, not already gone: an invoice that fell due last week is
      // overdue, and answering "what falls due this week" with it is wrong.
      if (
        filter.dueWithinDays != null &&
        (item.daysUntilDue < 0 || item.daysUntilDue > filter.dueWithinDays)
      ) {
        return false;
      }
      if (filter.statuses && !filter.statuses.includes(item.status)) return false;
      return true;
    });
}

export interface BucketTotal {
  readonly bucket: AgeingBucket;
  readonly amountIqd: string;
  readonly invoices: number;
}

/**
 * The ageing, bucketed — computed from the items rather than queried again.
 *
 * Two queries over the same invoices is two chances to disagree, and the
 * disagreement would be discovered by somebody adding the columns up by hand
 * and finding they do not match the rows above them.
 */
export function ageing(items: readonly OpenItem[]): BucketTotal[] {
  const totals = new Map<AgeingBucket, { amount: number; invoices: number }>();
  for (const item of items) {
    const outstanding = Number(item.outstandingIqd);
    if (outstanding <= 0) continue;
    const held = totals.get(item.bucket) ?? { amount: 0, invoices: 0 };
    totals.set(item.bucket, { amount: held.amount + outstanding, invoices: held.invoices + 1 });
  }
  return AGEING_BUCKETS.filter((bucket) => totals.has(bucket)).map((bucket) => ({
    bucket,
    amountIqd: String(totals.get(bucket)!.amount),
    invoices: totals.get(bucket)!.invoices,
  }));
}

/** One party's position: what they owe in total, and how much of it is late. */
export interface PartyTotal {
  readonly partyCode: string;
  readonly partyName: string;
  readonly invoices: number;
  readonly outstandingIqd: string;
  readonly overdueIqd: string;
}

export function byParty(items: readonly OpenItem[]): PartyTotal[] {
  const totals = new Map<string, { name: string; invoices: number; outstanding: number; overdue: number }>();
  for (const item of items) {
    const outstanding = Number(item.outstandingIqd);
    if (outstanding <= 0) continue;
    const held = totals.get(item.partyCode) ?? {
      name: item.partyName,
      invoices: 0,
      outstanding: 0,
      overdue: 0,
    };
    totals.set(item.partyCode, {
      name: item.partyName,
      invoices: held.invoices + 1,
      outstanding: held.outstanding + outstanding,
      overdue: held.overdue + (item.daysOverdue > 0 ? outstanding : 0),
    });
  }
  return [...totals]
    .map(([partyCode, held]) => ({
      partyCode,
      partyName: held.name,
      invoices: held.invoices,
      outstandingIqd: String(held.outstanding),
      overdueIqd: String(held.overdue),
    }))
    .sort((a, b) => Number(b.outstandingIqd) - Number(a.outstandingIqd));
}
