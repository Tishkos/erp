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

/* -------------------------------------------------------------------------
 * Tying the ageing to the ledger
 *
 * An ageing that does not add up to the statement is worse than no ageing:
 * both look authoritative, and the reader has no way to tell which one is
 * lying. They disagree for one structural reason — the ageing is built from
 * invoice documents, and the statement is built from the subledger the
 * posting engine writes. Anything reaching a party's control account without
 * an invoice behind it therefore shows on one and not the other:
 *
 *   · an opening balance journalled in when the books were loaded;
 *   · a write-off, an interest charge or a correction posted by journal;
 *   · and — until the posting map was constrained — a receipt whose credit
 *     was mapped to a cash account instead of Trade Receivables, so the
 *     invoice said Paid while the ledger still said owed.
 *
 * The answer is not to guess which of the two is right. It is to state both
 * and name the difference, so the ageing's total *is* the statement's closing
 * balance by construction: the invoices, plus whatever else reached the
 * account, equals the ledger. A difference becomes a thing to look at rather
 * than a silent disagreement between two screens.
 * ---------------------------------------------------------------------- */

/** Which subledger each side reconciles to (§1.2). */
const SUBLEDGER: Readonly<Record<Side, string>> = { customer: 'customer', supplier: 'supplier' };

/** What the subledger says one party owes as at a date — the statement's figure. */
export interface LedgerBalance {
  readonly partyCode: string;
  readonly partyName: string;
  /** Owed *to* us on the customer side, owed *by* us on the supplier side. */
  readonly balanceIqd: string;
  /**
   * What was charged to the account, and what came off it.
   *
   * Both, not merely the net, because the reader is looking for an invoice:
   * "1,200,000 raised, 500,000 paid, 700,000 left" is a line somebody
   * recognises, and a bare 700,000 is a number they have to take on trust.
   */
  readonly chargedIqd: string;
  readonly paidIqd: string;
  /** The oldest entry on the account, for ageing what no invoice explains. */
  readonly oldestDate: string | null;
}

/**
 * Every party's control-account balance, read exactly as the statement reads
 * it — same table, same sign convention, same date rule.
 *
 * Deliberately the same source rather than a second query over journal lines:
 * two ways of computing one balance is how the two reports came to disagree
 * in the first place.
 */
export async function ledgerBalances(
  tx: Tx,
  principal: Principal,
  side: Side,
  asOf: string,
  filter: { readonly branchCode?: string | null; readonly partyCode?: string | null } = {},
): Promise<LedgerBalance[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT[side]);
  const branch = filter.branchCode ?? null;
  const party = filter.partyCode ?? null;

  // Debit-normal for a customer, credit-normal for a supplier — so either ends
  // positive when something is outstanding, exactly as the statement does.
  const owed =
    side === 'customer'
      ? sql`sum(s.debit_iqd - s.credit_iqd)`
      : sql`sum(s.credit_iqd - s.debit_iqd)`;

  // "Charged" is the side that increases the debt, which is the debit for a
  // customer and the credit for a supplier — the mirror the statement uses.
  const charged = side === 'customer' ? sql`sum(s.debit_iqd)` : sql`sum(s.credit_iqd)`;
  const paid = side === 'customer' ? sql`sum(s.credit_iqd)` : sql`sum(s.debit_iqd)`;

  const result = await tx.execute(sql`
    select s.party_code                         as "partyCode",
           coalesce(p.legal_name, s.party_code) as "partyName",
           coalesce(${owed}, 0)::text           as "balanceIqd",
           coalesce(${charged}, 0)::text        as "chargedIqd",
           coalesce(${paid}, 0)::text           as "paidIqd",
           min(s.posting_date)::text            as "oldestDate"
      from subledger_entry s
      left join business_partner p on p.code = s.party_code
     where s.subledger_type::text = ${SUBLEDGER[side]}
       and s.posting_date <= ${asOf}::date
       and (${branch}::text is null or s.branch_code = ${branch})
       and (${party}::text is null or s.party_code = ${party})
     group by s.party_code, p.legal_name
  `);

  return result.rows as unknown as LedgerBalance[];
}

/** One party, reconciled: what the ledger says, what the invoices say, the gap. */
export interface Reconciliation {
  readonly partyCode: string;
  readonly partyName: string;
  /** The statement's closing balance for this party. */
  readonly ledgerIqd: string;
  /** What the open invoices on this report account for. */
  readonly documentsIqd: string;
  /** Everything else that reached the control account. May be negative. */
  readonly unexplainedIqd: string;
  /**
   * The unexplained part, as an invoice reads: raised, paid, left.
   *
   * Derived by taking what the invoices account for off the ledger's own
   * totals, so a journalled-in debt that was later part-paid shows both
   * halves rather than only its remainder.
   */
  readonly unexplainedChargedIqd: string;
  readonly unexplainedPaidIqd: string;
  /** When the account first moved — what the unexplained part is aged from. */
  readonly oldestDate: string | null;
  readonly bucket: AgeingBucket;
}

/**
 * The two figures side by side, party by party.
 *
 * Every party with a ledger balance appears, including those with no open
 * invoice at all — which is precisely the case the report used to be blind
 * to, and the one the sponsor found: a customer whose whole debt had been
 * journalled in showed nothing owing.
 */
export function reconcile(
  items: readonly OpenItem[],
  balances: readonly LedgerBalance[],
  asOf: string,
): Reconciliation[] {
  const documents = new Map<string, { open: number; charged: number; paid: number }>();
  const names = new Map<string, string>();
  for (const item of items) {
    names.set(item.partyCode, item.partyName);
    const held = documents.get(item.partyCode) ?? { open: 0, charged: 0, paid: 0 };
    documents.set(item.partyCode, {
      open: held.open + Math.max(0, Number(item.outstandingIqd)),
      // Every invoice's own totals, settled ones included: they are movement
      // on the control account whether or not anything is left on them, and
      // leaving them out would attribute their charge to the journals.
      charged: held.charged + Number(item.totalIqd),
      paid: held.paid + Number(item.paidIqd),
    });
  }

  const parties = new Map<
    string,
    { name: string; ledger: number; charged: number; paid: number; oldest: string | null }
  >();
  for (const balance of balances) {
    parties.set(balance.partyCode, {
      name: balance.partyName,
      ledger: Number(balance.balanceIqd),
      charged: Number(balance.chargedIqd),
      paid: Number(balance.paidIqd),
      oldest: balance.oldestDate,
    });
  }
  // A party the invoices know about but the subledger does not is still worth
  // a row: its ledger side is nought, and the difference then says so.
  for (const [partyCode, name] of names) {
    if (!parties.has(partyCode)) {
      parties.set(partyCode, { name, ledger: 0, charged: 0, paid: 0, oldest: null });
    }
  }

  return [...parties]
    .map(([partyCode, held]) => {
      const documented = documents.get(partyCode) ?? { open: 0, charged: 0, paid: 0 };
      return {
        partyCode,
        partyName: held.name,
        ledgerIqd: String(held.ledger),
        documentsIqd: String(documented.open),
        unexplainedIqd: String(held.ledger - documented.open),
        unexplainedChargedIqd: String(held.charged - documented.charged),
        unexplainedPaidIqd: String(held.paid - documented.paid),
        oldestDate: held.oldest,
        // No invoice means no due date, so it is due from the day it was
        // raised. An opening balance journalled in last year is a year old,
        // and an ageing that called it current would be flattering it.
        bucket: held.oldest ? bucketFor(held.oldest, asOf) : 'current',
      };
    })
    .filter((row) => Number(row.ledgerIqd) !== 0 || Number(row.documentsIqd) !== 0)
    .sort((a, b) => Number(b.ledgerIqd) - Number(a.ledgerIqd));
}

/** What the whole report ties to — every figure a reader might add up by hand. */
export interface ReconciliationTotals {
  readonly ledgerIqd: string;
  readonly documentsIqd: string;
  readonly unexplainedIqd: string;
  /** True when the invoices and the ledger agree to the dinar. */
  readonly ties: boolean;
}

export function reconciliationTotals(rows: readonly Reconciliation[]): ReconciliationTotals {
  const sum = (pick: (row: Reconciliation) => string) =>
    rows.reduce((total, row) => total + Number(pick(row)), 0);
  const unexplained = sum((row) => row.unexplainedIqd);
  return {
    ledgerIqd: String(sum((row) => row.ledgerIqd)),
    documentsIqd: String(sum((row) => row.documentsIqd)),
    unexplainedIqd: String(unexplained),
    ties: unexplained === 0,
  };
}

/**
 * The ageing, with what no invoice explains folded into the same bands.
 *
 * So the bucket row adds up to the ledger too, not merely the grand total —
 * otherwise "1–30 days late" would still quietly be a different report from
 * the statement sitting next to it.
 */
export function ageingWith(
  items: readonly OpenItem[],
  rows: readonly Reconciliation[],
): BucketTotal[] {
  const totals = new Map<AgeingBucket, { amount: number; invoices: number }>();
  const add = (bucket: AgeingBucket, amount: number, documents: number) => {
    if (amount === 0) return;
    const held = totals.get(bucket) ?? { amount: 0, invoices: 0 };
    totals.set(bucket, { amount: held.amount + amount, invoices: held.invoices + documents });
  };

  for (const item of items) {
    const outstanding = Number(item.outstandingIqd);
    if (outstanding > 0) add(item.bucket, outstanding, 1);
  }
  for (const row of rows) add(row.bucket, Number(row.unexplainedIqd), 0);

  return AGEING_BUCKETS.filter((bucket) => totals.has(bucket)).map((bucket) => ({
    bucket,
    amountIqd: String(totals.get(bucket)!.amount),
    invoices: totals.get(bucket)!.invoices,
  }));
}
