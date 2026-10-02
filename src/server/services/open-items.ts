import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { AGEING_BUCKETS, bucketFor, daysBetween, type AgeingBucket } from '../domain/ageing';
import { assertCan, type Principal } from '../domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';

/**
 * Open items — invoice balances, kept separate from the partner's other balances.
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
 * A/R payment totals come only from receipt allocations that name this invoice.
 * Credit memos and write-offs are shown as their own invoice applications.
 * Unallocated receipt and credit balances stay on the partner account and do
 * not reduce or age an invoice.
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
  /** Receipt allocations posted against this invoice. */
  readonly paidIqd: string;
  /** Credit memos / returns allocated against this invoice. */
  readonly creditsAppliedIqd: string;
  /** Other explicit invoice adjustments, such as an approved write-off. */
  readonly otherAppliedIqd: string;
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
  const live = s.reversible ? sql`and a.reversed_at is null` : sql`and d.reversed_at is null`;
  const allocatedPayments =
    side === 'customer'
      ? sql`coalesce((
          select sum(a.amount_iqd)
            from customer_receipt_allocation a
            join customer_receipt r on r.id = a.customer_receipt_id
           where a.ar_invoice_id = i.id
             and r.reversed_at is null
        ), 0)`
      : sql`i.${s.paid}`;
  const creditsApplied =
    side === 'customer'
      ? sql`coalesce((
          select sum(m.allocated_iqd)
            from customer_credit_memo m
           where m.ar_invoice_id = i.id
             and m.reversed_at is null
        ), 0)`
      : sql`0::numeric`;
  const otherApplied =
    side === 'customer'
      ? sql`i.${s.paid} - (${allocatedPayments}) - (${creditsApplied})`
      : sql`0::numeric`;

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
           (${allocatedPayments})::text              as "paidIqd",
           (${creditsApplied})::text                 as "creditsAppliedIqd",
           (${otherApplied})::text                   as "otherAppliedIqd",
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

/** Invoice-only totals. Non-invoice debits and credits never enter these figures. */
export interface InvoicePositionTotals {
  readonly grossIqd: string;
  readonly notYetDueIqd: string;
  readonly overdueIqd: string;
}

export function invoicePositionTotals(items: readonly OpenItem[]): InvoicePositionTotals {
  let gross = 0;
  let notYetDue = 0;
  let overdue = 0;
  for (const item of items) {
    const outstanding = Math.max(0, Number(item.outstandingIqd));
    if (outstanding === 0) continue;
    gross += outstanding;
    if (item.daysOverdue > 0) overdue += outstanding;
    else notYetDue += outstanding;
  }
  return {
    grossIqd: String(gross),
    notYetDueIqd: String(notYetDue),
    overdueIqd: String(overdue),
  };
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
 *   · a receipt or credit memo that has not been allocated to an invoice.
 *
 * The report shows invoice balances, non-invoice debits and credits, and the
 * ledger's net position. Only invoices are assigned due dates or ageing
 * buckets.
 * ---------------------------------------------------------------------- */

/** Which subledger each side reconciles to (§1.2). */
const SUBLEDGER: Readonly<Record<Side, string>> = { customer: 'customer', supplier: 'supplier' };

/** What the subledger says one party's net position is as at a date. */
export interface LedgerBalance {
  readonly partyCode: string;
  readonly partyName: string;
  /** Owed *to* us on the customer side, owed *by* us on the supplier side. */
  readonly balanceIqd: string;
  /** The oldest entry on the account, for following up an unallocated balance. */
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

  const result = await tx.execute(sql`
    select s.party_code                         as "partyCode",
           coalesce(p.legal_name, s.party_code) as "partyName",
           coalesce(${owed}, 0)::text           as "balanceIqd",
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

/** One party's invoice balance and the separate non-invoice position. */
export interface Reconciliation {
  readonly partyCode: string;
  readonly partyName: string;
  readonly ledgerIqd: string;
  readonly documentsIqd: string;
  /** Ledger balance less open invoice balances; positive is a debit balance. */
  readonly unexplainedIqd: string;
  readonly unappliedCreditsIqd: string;
  readonly otherNonInvoiceDebitIqd: string;
  /** Follow-up date only; non-invoice balances are never aged. */
  readonly oldestDate: string | null;
}

/** Invoice balances and control-account balances, reconciled per party. */
export function reconcile(
  items: readonly OpenItem[],
  balances: readonly LedgerBalance[],
): Reconciliation[] {
  // HD8 — every figure here is money, summed as scaled integers; a double
  // subtraction re-stringified as money is how a statement grows a fils.
  const dec = (value: string) => parseDecimal(value, MONEY_SCALE);
  const str = (value: bigint) => toDecimalString(value, MONEY_SCALE);
  const positive = (value: bigint) => (value > 0n ? value : 0n);
  const documents = new Map<string, bigint>();
  const names = new Map<string, string>();
  for (const item of items) {
    names.set(item.partyCode, item.partyName);
    documents.set(item.partyCode, (documents.get(item.partyCode) ?? 0n) + positive(dec(item.outstandingIqd)));
  }

  const parties = new Map<string, { name: string; ledger: bigint; oldest: string | null }>();
  for (const balance of balances) {
    parties.set(balance.partyCode, {
      name: balance.partyName,
      ledger: dec(balance.balanceIqd),
      oldest: balance.oldestDate,
    });
  }
  for (const [partyCode, name] of names) {
    if (!parties.has(partyCode)) parties.set(partyCode, { name, ledger: 0n, oldest: null });
  }

  return [...parties]
    .map(([partyCode, held]) => {
      const documentsIqd = documents.get(partyCode) ?? 0n;
      const unexplained = held.ledger - documentsIqd;
      return {
        partyCode,
        partyName: held.name,
        ledgerIqd: str(held.ledger),
        documentsIqd: str(documentsIqd),
        unexplainedIqd: str(unexplained),
        unappliedCreditsIqd: str(positive(-unexplained)),
        otherNonInvoiceDebitIqd: str(positive(unexplained)),
        oldestDate: held.oldest,
        _ledger: held.ledger,
        _documents: documentsIqd,
      };
    })
    .filter((row) => row._ledger !== 0n || row._documents !== 0n)
    .sort((a, b) => (b._ledger > a._ledger ? 1 : b._ledger < a._ledger ? -1 : 0))
    .map(({ _ledger: _l, _documents: _d, ...row }) => row);
}

export interface ReconciliationTotals {
  readonly ledgerIqd: string;
  readonly documentsIqd: string;
  readonly unexplainedIqd: string;
  readonly unappliedCreditsIqd: string;
  readonly otherNonInvoiceDebitsIqd: string;
  readonly ties: boolean;
}

export function reconciliationTotals(rows: readonly Reconciliation[]): ReconciliationTotals {
  // HD8 / B4 — integers tie exactly or they do not; no epsilon.
  const sum = (pick: (row: Reconciliation) => string) =>
    rows.reduce((total, row) => total + parseDecimal(pick(row), MONEY_SCALE), 0n);
  const unexplained = sum((row) => row.unexplainedIqd);
  const ledger = sum((row) => row.ledgerIqd);
  const documents = sum((row) => row.documentsIqd);
  const debits = sum((row) => row.otherNonInvoiceDebitIqd);
  const credits = sum((row) => row.unappliedCreditsIqd);
  const str = (value: bigint) => toDecimalString(value, MONEY_SCALE);
  return {
    ledgerIqd: str(ledger),
    documentsIqd: str(documents),
    unexplainedIqd: str(unexplained),
    unappliedCreditsIqd: str(credits),
    otherNonInvoiceDebitsIqd: str(debits),
    ties: documents + debits - credits - ledger === 0n,
  };
}
