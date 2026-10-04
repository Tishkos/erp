/**
 * Supplier Credits and Supplier Reconciliation — REQ-PAY-001 PAY10 / PAY11.
 *
 * Both are read-only and both read the documents themselves — no balance
 * table, nothing stored that could drift from what it summarises.
 *
 * **Supplier Credits** (PAY10, D-PAY-6: authorised on `supplier_payment`) is
 * what the company holds against its suppliers: money paid and not put against
 * an invoice (an overpayment, a payment on account), advances paid and not yet
 * applied, and posted credit notes not yet applied. The same three figures
 * `supplier-payment.supplierAccount` keeps apart, for every supplier at once.
 *
 * **Supplier Reconciliation** (PAY11, D-PAY-5: authorised on `ap_invoice`) is
 * `subledger.reconciliation` — the comparison the nightly close check runs —
 * narrowed to the supplier control accounts, with the journal lines that make
 * any difference beside it (the investigation path). It never repairs
 * anything: a difference is fixed by somebody who opened the entry and decided.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assertCan, type Principal } from '../domain/permissions';
import { parseDecimal } from '../domain/money';
import * as subledger from './subledger';

export const CREDITS_OBJECT = 'supplier_payment';
export const RECONCILIATION_OBJECT = 'ap_invoice';

export type CreditKind = 'payment' | 'advance' | 'credit_note';

export interface CreditRow {
  readonly kind: CreditKind;
  readonly documentNo: string;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly branchCode: string;
  readonly documentDate: string;
  readonly amountIqd: string;
  readonly appliedIqd: string;
  readonly unappliedIqd: string;
}

/**
 * Every credit a supplier holds with the company, oldest first. Only posted
 * documents: a draft payment has not left the bank, an advance not yet paid is
 * a plan, and a draft credit note promises nothing.
 */
export async function credits(
  tx: Tx,
  principal: Principal,
  filter: { readonly supplierCode?: string | null; readonly kind?: CreditKind | null } = {},
): Promise<CreditRow[]> {
  assertCan(principal, 'view', CREDITS_OBJECT);
  const supplier = filter.supplierCode ?? null;
  const result = await tx.execute(sql`
    select * from (
      select 'payment'::text                      as "kind",
             sp.payment_no                        as "documentNo",
             p.code                               as "supplierCode",
             p.legal_name                         as "supplierName",
             sp.branch_code                       as "branchCode",
             sp.payment_date::text                as "documentDate",
             sp.amount_iqd::text                  as "amountIqd",
             sp.allocated_amount_iqd::text        as "appliedIqd",
             (sp.amount_iqd - sp.allocated_amount_iqd)::text as "unappliedIqd"
        from supplier_payment sp
        join business_partner p on p.id = sp.supplier_id
       where sp.status = 'posted'
         and sp.amount_iqd - sp.allocated_amount_iqd > 0
      union all
      select 'advance', a.advance_no, p.code, p.legal_name, a.branch_code, a.paid_date::text,
             a.amount_iqd::text, (a.settled_amount_iqd + a.refunded_amount_iqd)::text,
             (a.amount_iqd - a.settled_amount_iqd - a.refunded_amount_iqd)::text
        from supplier_advance a
        join business_partner p on p.id = a.supplier_id
       where a.paid_date is not null
         and a.amount_iqd - a.settled_amount_iqd - a.refunded_amount_iqd > 0
      union all
      select 'credit_note', m.memo_no, p.code, p.legal_name, m.branch_code, m.memo_date::text,
             m.amount_iqd::text, m.allocated_amount_iqd::text,
             (m.amount_iqd - m.allocated_amount_iqd)::text
        from supplier_credit_memo m
        join business_partner p on p.id = m.supplier_id
       where m.status = 'posted'
         and m.amount_iqd - m.allocated_amount_iqd > 0
    ) c
     where (${supplier}::text is null or c."supplierCode" = ${supplier})
       and (${filter.kind ?? null}::text is null or c."kind" = ${filter.kind ?? null})
     order by c."documentDate", c."documentNo"
  `);
  return result.rows as unknown as CreditRow[];
}

/** Per supplier: the three kinds, and what they come to together. */
export interface CreditTotals {
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly paymentIqd: bigint;
  readonly advanceIqd: bigint;
  readonly creditNoteIqd: bigint;
  readonly totalIqd: bigint;
}

export function creditTotals(rows: readonly CreditRow[]): CreditTotals[] {
  const by = new Map<string, CreditTotals>();
  for (const row of rows) {
    const held = by.get(row.supplierCode) ?? {
      supplierCode: row.supplierCode,
      supplierName: row.supplierName,
      paymentIqd: 0n,
      advanceIqd: 0n,
      creditNoteIqd: 0n,
      totalIqd: 0n,
    };
    const amount = parseDecimal(row.unappliedIqd, 4n);
    by.set(row.supplierCode, {
      ...held,
      paymentIqd: held.paymentIqd + (row.kind === 'payment' ? amount : 0n),
      advanceIqd: held.advanceIqd + (row.kind === 'advance' ? amount : 0n),
      creditNoteIqd: held.creditNoteIqd + (row.kind === 'credit_note' ? amount : 0n),
      totalIqd: held.totalIqd + amount,
    });
  }
  return [...by.values()].sort((a, b) => (b.totalIqd > a.totalIqd ? 1 : b.totalIqd < a.totalIqd ? -1 : 0));
}

// ---------------------------------------------------------------------------
// PAY11 — the reconciliation
// ---------------------------------------------------------------------------

export interface ControlRow {
  readonly accountCode: string;
  readonly accountName: string;
  /** Credit-normal, as the supplier statement reads it: positive is owed. */
  readonly subledgerIqd: bigint;
  readonly generalLedgerIqd: bigint;
  readonly differenceIqd: bigint;
}

/** Every supplier control account: its subledger, its G/L balance, the difference. */
export async function controlAccounts(tx: Tx, principal: Principal, asOf: string): Promise<ControlRow[]> {
  assertCan(principal, 'view', RECONCILIATION_OBJECT);
  const rows = await subledger.reconciliation(tx, asOf);
  // `reconciliation` is debit-normal; a supplier balance is read the other way.
  return rows
    .filter((row) => row.subledgerType === 'supplier')
    .map((row) => ({
      accountCode: row.accountCode,
      accountName: row.accountName,
      subledgerIqd: -parseDecimal(row.subledgerBalance, 4n),
      generalLedgerIqd: -parseDecimal(row.generalLedgerBalance, 4n),
      differenceIqd: -parseDecimal(row.difference, 4n),
    }));
}

export type ExceptionReason = 'no_subledger' | 'amount' | 'account' | 'not_posted';

export interface ExceptionRow {
  readonly reason: ExceptionReason;
  readonly entryNo: string;
  readonly postingDate: string;
  readonly journalStatus: string;
  readonly accountCode: string;
  readonly partyCode: string | null;
  readonly sourceModule: string | null;
  readonly description: string | null;
  readonly lineDebitIqd: string;
  readonly lineCreditIqd: string;
  readonly subledgerDebitIqd: string | null;
  readonly subledgerCreditIqd: string | null;
}

/**
 * The lines that make a difference, oldest first — the investigation path.
 *
 *   no_subledger  a line on a supplier control account with no subledger
 *                 entry (a manual journal that named no supplier);
 *   amount        a subledger entry whose amount is not its line's;
 *   account       a subledger entry filed under another control account;
 *   not_posted    a subledger entry whose journal is not posted.
 */
export async function exceptions(tx: Tx, principal: Principal, asOf: string): Promise<ExceptionRow[]> {
  assertCan(principal, 'view', RECONCILIATION_OBJECT);
  const result = await tx.execute(sql`
    select * from (
      select case when s.id is null then 'no_subledger'
                  when s.control_account_id <> l.account_id then 'account'
                  else 'amount' end                       as "reason",
             e.entry_no                                   as "entryNo",
             e.posting_date::text                         as "postingDate",
             e.status::text                               as "journalStatus",
             a.code                                       as "accountCode",
             coalesce(s.party_code, l.business_partner_code) as "partyCode",
             e.source_module                              as "sourceModule",
             coalesce(l.line_description, e.description)  as "description",
             l.debit_iqd::text                            as "lineDebitIqd",
             l.credit_iqd::text                           as "lineCreditIqd",
             s.debit_iqd::text                            as "subledgerDebitIqd",
             s.credit_iqd::text                           as "subledgerCreditIqd"
        from journal_line l
        join journal_entry e      on e.id = l.journal_entry_id
        join chart_of_account a   on a.id = l.account_id
        left join subledger_entry s on s.journal_line_id = l.id
       where a.control_account = 'supplier'
         and e.status in ('posted', 'reversed')
         and e.posting_date <= ${asOf}::date
         and (l.debit_iqd <> 0 or l.credit_iqd <> 0)
         and (s.id is null
              or s.control_account_id <> l.account_id
              or s.debit_iqd <> l.debit_iqd
              or s.credit_iqd <> l.credit_iqd)
      union all
      select 'not_posted', e.entry_no, s.posting_date::text, e.status::text, a.code, s.party_code,
             e.source_module, coalesce(l.line_description, e.description),
             l.debit_iqd::text, l.credit_iqd::text, s.debit_iqd::text, s.credit_iqd::text
        from subledger_entry s
        join journal_line l     on l.id = s.journal_line_id
        join journal_entry e    on e.id = s.journal_entry_id
        join chart_of_account a on a.id = s.control_account_id
       where s.subledger_type = 'supplier'
         and s.posting_date <= ${asOf}::date
         and e.status not in ('posted', 'reversed')
    ) x
     order by x."postingDate", x."entryNo"
  `);
  return result.rows as unknown as ExceptionRow[];
}
