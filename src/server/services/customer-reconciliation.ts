/**
 * Customer Reconciliation — the customer subledger against the A/R control
 * account in the G/L (Receivables, 2026-10-04).
 *
 * > "Customer subledger 12,500,000 IQD, AR control account 12,500,000 IQD,
 * > Difference 0 IQD. If there is a difference, show the investigation
 * > path/source transactions. Do not automatically repair reconciliation
 * > differences."
 *
 * Read-only by design. The comparison itself is `subledger.reconciliation` —
 * the one the nightly closing check runs — narrowed to the customer control
 * accounts, so this screen and the close agree. What this module adds is the
 * investigation: the individual lines that make a difference, each with the
 * journal it belongs to, so a reader can open the entry and decide. Nothing
 * here writes.
 *
 * A difference has only a few possible shapes, and each is listed as itself:
 *
 *   no_subledger   a line on a customer control account with no customer
 *                  subledger entry — a manual journal that named no customer;
 *   amount         a subledger entry whose amount is not its line's;
 *   account        a subledger entry filed under a different control account
 *                  from the one its line hit;
 *   not_posted     a subledger entry whose journal is not posted — the G/L
 *                  does not count it and the subledger does.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { assertCan, type Principal } from '../domain/permissions';
import * as subledger from './subledger';

export const PERMISSION_OBJECT = 'ar_invoice';

export type ExceptionReason = 'no_subledger' | 'amount' | 'account' | 'not_posted';

export interface ControlRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly subledgerIqd: string;
  readonly generalLedgerIqd: string;
  readonly differenceIqd: string;
}

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

/** Every customer control account: its subledger total, its G/L balance, the difference. */
export async function controlAccounts(tx: Tx, principal: Principal, asOf: string): Promise<ControlRow[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);
  const rows = await subledger.reconciliation(tx, asOf);
  return rows
    .filter((row) => row.subledgerType === 'customer')
    .map((row) => ({
      accountCode: row.accountCode,
      accountName: row.accountName,
      subledgerIqd: row.subledgerBalance,
      generalLedgerIqd: row.generalLedgerBalance,
      differenceIqd: row.difference,
    }));
}

/** The lines that make the difference, oldest first — the investigation path. */
export async function exceptions(tx: Tx, principal: Principal, asOf: string): Promise<ExceptionRow[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);
  const result = await tx.execute(sql`
    select * from (
      select case when s.id is null then 'no_subledger'
                  when s.control_account_id <> l.account_id then 'account'
                  else 'amount' end                  as "reason",
             e.entry_no                              as "entryNo",
             e.posting_date::text                    as "postingDate",
             e.status::text                          as "journalStatus",
             a.code                                  as "accountCode",
             coalesce(s.party_code, l.business_partner_code) as "partyCode",
             e.source_module                         as "sourceModule",
             coalesce(l.line_description, e.description) as "description",
             l.debit_iqd::text                       as "lineDebitIqd",
             l.credit_iqd::text                      as "lineCreditIqd",
             s.debit_iqd::text                       as "subledgerDebitIqd",
             s.credit_iqd::text                      as "subledgerCreditIqd"
        from journal_line l
        join journal_entry e      on e.id = l.journal_entry_id
        join chart_of_account a   on a.id = l.account_id
        left join subledger_entry s on s.journal_line_id = l.id
       where a.control_account = 'customer'
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
       where s.subledger_type = 'customer'
         and s.posting_date <= ${asOf}::date
         and e.status not in ('posted', 'reversed')
    ) x
     order by x."postingDate", x."entryNo"
  `);
  return result.rows as unknown as ExceptionRow[];
}
