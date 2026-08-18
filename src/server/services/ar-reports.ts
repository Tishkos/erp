/**
 * A/R subledger reporting — Phase 06.11, §16 and §22.
 *
 * > §16 acceptance 4: *"Customer statements reconcile to A/R ageing and G/L
 * > control."*
 * > §16: *"Customer statements show transaction currency and base-currency
 * > equivalent."*
 * > §22: *"Operational reports reconcile to subledger controls; financial
 * > reports reconcile to the G/L."*
 *
 * **One source, three shapes.** The ageing, the statement and the control-account
 * balance are the same open items looked at three ways, and the gate is that they
 * agree. The way they agree here is that they are all derived from the same
 * rows — `ar_invoice` for what is owed, `customer_receipt_allocation` and
 * `customer_credit_memo` for what has settled it — rather than from three
 * queries that each decide for themselves what "outstanding" means.
 *
 * That is the whole reason `reconcile()` exists below and returns a difference
 * rather than a boolean: a report that could only say *"they agree"* is a report
 * nobody can debug at 11pm on a closing day.
 *
 * **The ageing buckets are Phase 05's.** `domain/ageing.ts` was written for the
 * A/P ageing and is reused unchanged — §24's "call shared services" applied to a
 * definition rather than to code: if A/R and A/P disagreed about what "1–30 days
 * overdue" meant, one of the two reconciliations would be wrong and nobody would
 * know which.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assertCan, type Principal } from '../domain/permissions';
import { parseDecimal, toDecimalString } from '../domain/money';
import { daysSalesOutstanding, formatDays, DsoUncomputableError } from '../domain/dso';

export const PERMISSION_OBJECT = 'ar_invoice';

export interface AgeingRow {
  readonly customerCode: string;
  readonly customerName: string;
  readonly current: string;
  readonly days1to30: string;
  readonly days31to60: string;
  readonly days61to90: string;
  readonly over90: string;
  readonly total: string;
}

/**
 * §16 — the A/R ageing, by customer and bucket.
 *
 * Buckets come from the **due date**, not the invoice date: an invoice on 60-day
 * terms is not overdue on day 30, and an ageing that said otherwise would put a
 * collections clerk on the phone to a customer who has done nothing wrong. That
 * is the same rule `domain/ageing.ts` encodes for A/P, and the day an invoice
 * falls due is `current`, not `1-30`.
 *
 * Only posted invoices count. A draft is not a debt.
 */
export async function ageing(
  tx: Tx,
  principal: Principal,
  asOf: string,
  filter: { branchCode?: string | null } = {},
): Promise<AgeingRow[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const result = await tx.execute(sql`
    with open_items as (
      select i.customer_id,
             i.due_date,
             (i.net_iqd - i.allocated_iqd) as outstanding
        from ar_invoice i
       where i.status in ('posted', 'partially_executed')
         and i.invoice_date <= ${asOf}::date
         and (i.net_iqd - i.allocated_iqd) > 0
         and (${filter.branchCode ?? null}::text is null or i.branch_code = ${filter.branchCode ?? null})
    )
    select p.code                                          as "customerCode",
           p.legal_name                                    as "customerName",
           coalesce(sum(o.outstanding) filter (
             where o.due_date >= ${asOf}::date), 0::numeric(19,4))::text   as "current",
           coalesce(sum(o.outstanding) filter (
             where o.due_date <  ${asOf}::date
               and o.due_date >= ${asOf}::date - 30), 0::numeric(19,4))::text as "days1to30",
           coalesce(sum(o.outstanding) filter (
             where o.due_date <  ${asOf}::date - 30
               and o.due_date >= ${asOf}::date - 60), 0::numeric(19,4))::text as "days31to60",
           coalesce(sum(o.outstanding) filter (
             where o.due_date <  ${asOf}::date - 60
               and o.due_date >= ${asOf}::date - 90), 0::numeric(19,4))::text as "days61to90",
           coalesce(sum(o.outstanding) filter (
             where o.due_date <  ${asOf}::date - 90), 0::numeric(19,4))::text  as "over90",
           coalesce(sum(o.outstanding), 0::numeric(19,4))::text           as "total"
      from open_items o
      join business_partner p on p.id = o.customer_id
     group by p.code, p.legal_name
    having coalesce(sum(o.outstanding), 0) <> 0
     order by p.code
  `);

  return (result as unknown as { rows: AgeingRow[] }).rows;
}

export interface StatementLine {
  readonly documentType: string;
  readonly documentNo: string;
  readonly documentDate: string;
  readonly dueDate: string | null;
  /** §16 — the transaction currency and its amount, as the customer saw it. */
  readonly currency: string;
  readonly amount: string;
  /** …and the base-currency equivalent, at the historical rate. */
  readonly amountIqd: string;
  readonly amountUsd: string;
  readonly runningBalanceIqd: string;
}

/**
 * §16 — the customer statement.
 *
 * *"Customer statements show transaction currency and base-currency
 * equivalent."* Both, on every line: the customer reads the currency they were
 * billed in, and Finance reads the one the ledger is kept in. The USD figure is
 * the historical-rate equivalent stored on the journal line when it posted
 * (§2.3), never a conversion done at report time — which is what lets a
 * statement re-run next year reproduce this year's numbers.
 */
export async function statement(
  tx: Tx,
  principal: Principal,
  customerCode: string,
  period: { from: string; to: string },
): Promise<StatementLine[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const result = await tx.execute(sql`
    with entries as (
      select 'ar_invoice'                     as document_type,
             i.invoice_no                     as document_no,
             i.invoice_date                   as document_date,
             i.due_date                       as due_date,
             i.currency                       as currency,
             i.net_iqd                        as amount_iqd,
             i.journal_entry_id               as journal_entry_id,
             1                                as sort_order
        from ar_invoice i
        join business_partner p on p.id = i.customer_id
       where p.code = ${customerCode}
         and i.status in ('posted', 'partially_executed', 'settled')
         and i.invoice_date between ${period.from}::date and ${period.to}::date
      union all
      select 'customer_receipt',
             r.receipt_no,
             r.receipt_date,
             null,
             r.currency,
             -r.amount_iqd,
             r.journal_entry_id,
             2
        from customer_receipt r
        join business_partner p on p.id = r.customer_id
       where p.code = ${customerCode}
         and r.status in ('posted', 'settled')
         and r.receipt_date between ${period.from}::date and ${period.to}::date
      union all
      select 'customer_credit_memo',
             m.memo_no,
             m.memo_date,
             null,
             'IQD',
             -m.amount_iqd,
             m.journal_entry_id,
             3
        from customer_credit_memo m
        join business_partner p on p.id = m.customer_id
       where p.code = ${customerCode}
         and m.status in ('posted', 'partially_executed', 'settled')
         and m.memo_date between ${period.from}::date and ${period.to}::date
    )
    select e.document_type                as "documentType",
           e.document_no                  as "documentNo",
           e.document_date::text          as "documentDate",
           e.due_date::text               as "dueDate",
           e.currency                     as "currency",
           e.amount_iqd::text             as "amount",
           e.amount_iqd::text             as "amountIqd",
           -- §2.3 — the historical-rate equivalent the journal recorded, signed
           -- the same way the IQD amount is.
           -- The **receivable line only**. Every line of the journal carries the
           -- customer as a §4.2 dimension — the revenue line does too — so
           -- summing them all would double the figure the customer is shown.
           coalesce((
             select case when e.amount_iqd < 0 then -1 else 1 end
                    * sum(abs(l.debit_usd - l.credit_usd))
               from journal_line l
               join chart_of_account a on a.id = l.account_id
              where l.journal_entry_id = e.journal_entry_id
                and a.control_account = 'customer'
           ), 0::numeric(19,4))::text                    as "amountUsd",
           sum(e.amount_iqd) over (
             order by e.document_date, e.sort_order, e.document_no
             rows between unbounded preceding and current row
           )::text                        as "runningBalanceIqd"
      from entries e
     order by e.document_date, e.sort_order, e.document_no
  `);

  return (result as unknown as { rows: StatementLine[] }).rows;
}

export interface ReconciliationResult {
  readonly ageingTotalIqd: string;
  readonly subledgerTotalIqd: string;
  readonly controlAccountIqd: string;
  readonly ageingVsSubledgerIqd: string;
  readonly subledgerVsControlIqd: string;
  readonly reconciles: boolean;
}

/**
 * §16 acceptance 4 and §22 — the three figures that must agree, and by how much
 * they do not.
 *
 *   **Ageing** — the sum of what customers owe, from the invoices.
 *   **Subledger** — the same, from the customer subledger entries.
 *   **Control account** — the same, from the G/L.
 *
 * Returns the differences rather than a verdict. A reconciliation that could only
 * say *"they agree"* is one nobody can debug at 11pm on a closing day, and the
 * first question when they do not agree is always *"by how much, and which
 * pair?"*
 */
export async function reconcile(
  tx: Tx,
  principal: Principal,
  asOf: string,
  controlAccountCode: string,
): Promise<ReconciliationResult> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const result = await tx.execute(sql`
    select
      coalesce((
        select sum(i.net_iqd - i.allocated_iqd)
          from ar_invoice i
         where i.status in ('posted', 'partially_executed')
           and i.invoice_date <= ${asOf}::date
      ), 0::numeric(19,4))::text as "ageingTotalIqd",
      coalesce((
        select sum(s.debit_iqd - s.credit_iqd)
          from subledger_entry s
          join journal_entry e on e.id = s.journal_entry_id
         where s.subledger_type = 'customer'
           and e.posting_date <= ${asOf}::date
           and e.status in ('posted', 'reversed')
      ), 0::numeric(19,4))::text as "subledgerTotalIqd",
      coalesce((
        select sum(l.debit_iqd - l.credit_iqd)
          from journal_line l
          join journal_entry e on e.id = l.journal_entry_id
          join chart_of_account a on a.id = l.account_id
         where a.code = ${controlAccountCode}
           and e.posting_date <= ${asOf}::date
           and e.status in ('posted', 'reversed')
      ), 0::numeric(19,4))::text as "controlAccountIqd"
  `);

  const row = (result as unknown as { rows: Record<string, string>[] }).rows[0]!;

  const ageing = parseDecimal(row.ageingTotalIqd!, 4n);
  const subledger = parseDecimal(row.subledgerTotalIqd!, 4n);
  const control = parseDecimal(row.controlAccountIqd!, 4n);

  return {
    ageingTotalIqd: row.ageingTotalIqd!,
    subledgerTotalIqd: row.subledgerTotalIqd!,
    controlAccountIqd: row.controlAccountIqd!,
    ageingVsSubledgerIqd: toDecimalString(ageing - subledger, 4n),
    subledgerVsControlIqd: toDecimalString(subledger - control, 4n),
    reconciles: ageing === subledger && subledger === control,
  };
}

export interface DsoResult {
  readonly from: string;
  readonly to: string;
  readonly closingReceivableIqd: string;
  readonly creditSalesIqd: string;
  /** Null when the period has no answer — see `domain/dso.ts`. */
  readonly days: string | null;
  readonly note: string | null;
}

/**
 * §22's Days Sales Outstanding.
 *
 * The **formula is D12's**, not this function's: the components are gathered
 * here and the arithmetic lives in `domain/dso.ts`, so if the Business Process
 * Owner prefers a countback or an average-balance variant, one small pure
 * function changes and this query does not.
 *
 * Credit sales exclude cash sales — a sale settled the day it was made says
 * nothing about how long credit takes to collect. D12 asks the owner to confirm
 * that reading.
 */
export async function daysSalesOutstandingFor(
  tx: Tx,
  principal: Principal,
  period: { from: string; to: string },
  filter: { branchCode?: string | null } = {},
): Promise<DsoResult> {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const result = await tx.execute(sql`
    select
      coalesce((
        select sum(i.net_iqd - i.allocated_iqd)
          from ar_invoice i
         where i.status in ('posted', 'partially_executed')
           and i.invoice_date <= ${period.to}::date
           and (${filter.branchCode ?? null}::text is null or i.branch_code = ${filter.branchCode ?? null})
      ), 0::numeric(19,4))::text as "closingReceivableIqd",
      coalesce((
        select sum(i.net_iqd)
          from ar_invoice i
          left join customer_receipt r on r.cash_sale_invoice_id = i.id
         where i.status in ('posted', 'partially_executed', 'settled')
           and i.invoice_date between ${period.from}::date and ${period.to}::date
           and r.id is null
           and (${filter.branchCode ?? null}::text is null or i.branch_code = ${filter.branchCode ?? null})
      ), 0::numeric(19,4))::text as "creditSalesIqd"
  `);

  const row = (result as unknown as { rows: Record<string, string>[] }).rows[0]!;

  try {
    const days = daysSalesOutstanding({
      closingReceivableIqd: parseDecimal(row.closingReceivableIqd!, 4n),
      creditSalesIqd: parseDecimal(row.creditSalesIqd!, 4n),
      from: period.from,
      to: period.to,
    });

    return {
      from: period.from,
      to: period.to,
      closingReceivableIqd: row.closingReceivableIqd!,
      creditSalesIqd: row.creditSalesIqd!,
      days: formatDays(days),
      note: null,
    };
  } catch (error) {
    if (!(error instanceof DsoUncomputableError)) throw error;

    // A period with no answer reports that it has none. Returning zero would
    // say the company collects instantly, which is the opposite of the truth.
    return {
      from: period.from,
      to: period.to,
      closingReceivableIqd: row.closingReceivableIqd!,
      creditSalesIqd: row.creditSalesIqd!,
      days: null,
      note: error.message,
    };
  }
}

/**
 * §16 — the collections worklist.
 *
 * Overdue open items, oldest first, with what has already been promised against
 * them. A collections clerk's screen, and the reason `promise_to_pay` exists as
 * a row rather than a note: *"they said they would pay on the 15th"* is a fact
 * somebody should be held to, and a free-text note cannot be reported on.
 */
export async function collectionsWorklist(
  tx: Tx,
  principal: Principal,
  asOf: string,
  filter: { branchCode?: string | null } = {},
) {
  assertCan(principal, 'view', PERMISSION_OBJECT);

  const result = await tx.execute(sql`
    select p.code                                as "customerCode",
           p.legal_name                          as "customerName",
           i.invoice_no                          as "invoiceNo",
           i.invoice_date::text                  as "invoiceDate",
           i.due_date::text                      as "dueDate",
           (${asOf}::date - i.due_date)          as "daysOverdue",
           (i.net_iqd - i.allocated_iqd)::text   as "outstandingIqd",
           (select max(pr.promised_on)::text
              from promise_to_pay pr
             where pr.ar_invoice_id = i.id
               and pr.status = 'open')           as "promisedOn"
      from ar_invoice i
      join business_partner p on p.id = i.customer_id
     where i.status in ('posted', 'partially_executed')
       and (i.net_iqd - i.allocated_iqd) > 0
       and i.due_date < ${asOf}::date
       and (${filter.branchCode ?? null}::text is null or i.branch_code = ${filter.branchCode ?? null})
     order by i.due_date, p.code
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows;
}
