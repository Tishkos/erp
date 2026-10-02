import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { daysBetween } from '../domain/ageing';
import { parseDecimal, toDecimalString } from '../domain/money';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';

/**
 * Treasury and Banking reporting — every bank and cash account, and what its
 * balance is made of.
 *
 * ── Where the figures come from ───────────────────────────────────────────
 * The general ledger, and nothing else. There is no balance stored on a bank
 * account and none computed in a page: `bank_cash_account` carries the *link*
 * to a G/L account and the ledger carries the money. That is the 07.1 gate —
 * *"each bank/cash account's ledger balance equals its mapped G/L account
 * balance"* — and it holds here because this report reads that account rather
 * than agreeing with it. A second store of balances would be a second answer
 * to a question that has one, and the day the two differ is the day neither is
 * believed.
 *
 * `treasury.balances()` already answers "what is in this account now". What it
 * does not answer, and what a treasurer actually asks, is *how it got there*:
 * what opened the period, what came in, what went out, and how much of that
 * movement was merely money changing pockets.
 *
 * ── Why transfers are counted apart ───────────────────────────────────────
 * A transfer between two of the company's own accounts is not income to one
 * and expense to the other — it is the same money in a different place. Summed
 * into "money in" it would inflate both sides of every report that used them,
 * and a treasury that moved a million between its own accounts each morning
 * would appear to earn a million a day.
 *
 * They are told apart by the journal, not by a guess about the description:
 * a transfer is the journal a `bank_transfer` document posted
 * (`bank_transfer.journal_entry_id`), so a line on a bank account in that
 * journal is one half of a transfer and every other line is real money
 * entering or leaving the company. That is a fact recorded at posting time by
 * the code that made the movement, which is the only kind of classification
 * worth trusting.
 *
 * REQ-FIX-001 FIX-1: it used to be `source_module = 'treasury'`, which every
 * treasury document posts with — so an other receipt, a loan drawn or repaid,
 * its commission, a cash advance and a reconciliation adjustment all read as
 * transfers between the company's own accounts, and none of them as money in
 * or out. Found by the bank-deposit test.
 */

export const PERMISSION_OBJECT = 'bank_account';

const MONEY = 4n;

/** The day before an ISO date — where an opening balance is measured. */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

export interface AccountPosition {
  readonly accountCode: string;
  readonly accountName: string;
  readonly kind: 'bank' | 'cash';
  readonly currency: string;
  readonly glAccountCode: string;
  readonly glAccountName: string;
  /** What the account held at the start of the window. */
  readonly openingIqd: string;
  /** Real money in and out — transfers excluded. */
  readonly moneyInIqd: string;
  readonly moneyOutIqd: string;
  /** The company's own money arriving from, or leaving to, another account. */
  readonly transfersInIqd: string;
  readonly transfersOutIqd: string;
  /** Opening plus everything above. Equals the G/L balance as at `to`. */
  readonly closingIqd: string;
  /** The last day anything moved, at any time — not only within the window. */
  readonly lastMovementDate: string | null;
  readonly movements: number;
}

/**
 * Every account's position over a window.
 *
 * One query rather than one per account: a treasury with forty accounts should
 * not cost forty round trips, and the arithmetic is the same either way.
 *
 * An account whose G/L account has been deleted is still listed, with zeroes
 * and a null ledger code. Hiding it would remove the one screen from which the
 * link can be seen to be broken — the same lesson `listOfKind`'s left join
 * records (2026-09-27).
 */
export async function positions(
  tx: Tx,
  ctx: ActorContext,
  window: { readonly from: string; readonly to: string },
  filter: {
    readonly branchCode?: string | null;
    readonly kind?: 'bank' | 'cash' | null;
    /** One account, by code. The screen's picker is typed into by name. */
    readonly accountCode?: string | null;
  } = {},
): Promise<AccountPosition[]> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const branch = filter.branchCode ?? null;
  const kind = filter.kind ?? null;
  const only = filter.accountCode?.trim() || null;
  const opensAt = dayBefore(window.from);

  const result = await tx.execute(sql`
    with movement as (
      select b.id                          as account_id,
             e.posting_date                as posting_date,
             exists (select 1 from bank_transfer t where t.journal_entry_id = e.id) as is_transfer,
             l.debit_iqd                   as debit,
             l.credit_iqd                  as credit
        from bank_cash_account b
        join journal_line l    on l.account_id = b.gl_account_id
        join journal_entry e   on e.id = l.journal_entry_id
       where e.status in ('posted', 'reversed')
         and (${branch}::text is null or e.branch_code = ${branch})
    )
    select b.code                                                 as "accountCode",
           b.name                                                 as "accountName",
           b.account_type::text                                   as "kind",
           b.currency                                             as "currency",
           coalesce(a.code, '')                                   as "glAccountCode",
           coalesce(a.name, '')                                   as "glAccountName",
           coalesce(sum(m.debit - m.credit) filter (
             where m.posting_date <= ${opensAt}::date), 0)::text   as "openingIqd",
           -- Money the company actually received: a debit that is not a transfer.
           coalesce(sum(m.debit) filter (
             where m.posting_date between ${window.from}::date and ${window.to}::date
               and not m.is_transfer), 0)::text as "moneyInIqd",
           coalesce(sum(m.credit) filter (
             where m.posting_date between ${window.from}::date and ${window.to}::date
               and not m.is_transfer), 0)::text as "moneyOutIqd",
           -- The same money arriving from, or leaving to, another own account.
           coalesce(sum(m.debit) filter (
             where m.posting_date between ${window.from}::date and ${window.to}::date
               and m.is_transfer), 0)::text         as "transfersInIqd",
           coalesce(sum(m.credit) filter (
             where m.posting_date between ${window.from}::date and ${window.to}::date
               and m.is_transfer), 0)::text         as "transfersOutIqd",
           coalesce(sum(m.debit - m.credit) filter (
             where m.posting_date <= ${window.to}::date), 0)::text as "closingIqd",
           max(m.posting_date)::text                               as "lastMovementDate",
           count(m.posting_date) filter (
             where m.posting_date between ${window.from}::date and ${window.to}::date)::int as "movements"
      from bank_cash_account b
      left join chart_of_account a on a.id = b.gl_account_id
      left join movement m         on m.account_id = b.id
     where b.active
       and (${kind}::text is null or b.account_type::text = ${kind})
       and (${only}::text is null or b.code = ${only})
     group by b.code, b.name, b.account_type, b.currency, a.code, a.name
     order by b.account_type, b.code
  `);

  return (result as unknown as { rows: AccountPosition[] }).rows;
}

/** What a line on a bank account actually is. */
export type MovementKind = 'receipt' | 'payment' | 'transfer_in' | 'transfer_out' | 'other';

export interface LedgerLine {
  readonly postingDate: string;
  readonly entryNo: string;
  /** So every row can be opened in the Journal — §22's traceability. */
  readonly journalEntryId: string;
  readonly description: string | null;
  readonly kind: MovementKind;
  readonly reference: string | null;
  readonly partyCode: string | null;
  readonly partyName: string | null;
  readonly sourceModule: string | null;
  /** The journal a bank transfer posted — one half of money moved between own accounts. */
  readonly isTransfer: boolean;
  readonly sourceDocId: string | null;
  /**
   * Who raised the entry, and who approved it.
   *
   * §14.4's maker-checker is only a control if it can be read afterwards. A
   * treasury line showing money leaving without naming the two people behind
   * it is a line nobody can question — and the question "who authorised this"
   * is the first one asked about any payment.
   *
   * Null on an entry the posting engine raised from an approved document: the
   * approval happened on the document, not on the journal, and inventing a
   * name here would claim an approval nobody gave.
   */
  readonly raisedBy: string | null;
  readonly approvedBy: string | null;
  readonly debitIqd: string;
  readonly creditIqd: string;
  readonly balanceIqd: string;
}

export interface AccountLedger {
  readonly accountCode: string;
  readonly accountName: string;
  readonly kind: 'bank' | 'cash';
  readonly currency: string;
  readonly glAccountCode: string | null;
  readonly from: string;
  readonly to: string;
  readonly openingIqd: string;
  readonly lines: readonly LedgerLine[];
  readonly totalInIqd: string;
  readonly totalOutIqd: string;
  readonly closingIqd: string;
}

/**
 * One account's transactions, oldest first, with the balance carried down.
 *
 * Every line names its journal entry and its source document, so a figure on
 * this screen can be followed to the posting that made it and from there to
 * the document that caused the posting. A treasury report whose rows cannot be
 * traced is a report nobody can defend in an audit.
 *
 * The running balance opens at the account's balance on the day before `from`,
 * so a window is a window onto a continuing account rather than a fresh start:
 * the closing figure is the same whatever window is chosen.
 */
export async function ledger(
  tx: Tx,
  ctx: ActorContext,
  accountCode: string,
  window: { readonly from: string; readonly to: string },
  filter: { readonly branchCode?: string | null } = {},
): Promise<AccountLedger | null> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const branch = filter.branchCode ?? null;
  const opensAt = dayBefore(window.from);

  const [account] = (
    await tx.execute(sql`
      select b.code as "accountCode", b.name as "accountName",
             b.account_type::text as "kind", b.currency as "currency",
             a.code as "glAccountCode", b.gl_account_id as "glAccountId"
        from bank_cash_account b
        left join chart_of_account a on a.id = b.gl_account_id
       where b.code = ${accountCode}
       limit 1
    `)
  ).rows as unknown as {
    accountCode: string;
    accountName: string;
    kind: 'bank' | 'cash';
    currency: string;
    glAccountCode: string | null;
    glAccountId: string | null;
  }[];

  if (!account) return null;

  // No ledger account behind it: nothing has posted, and saying so is the
  // point of listing it at all.
  if (!account.glAccountId) {
    return {
      ...account,
      glAccountCode: null,
      from: window.from,
      to: window.to,
      openingIqd: '0.0000',
      lines: [],
      totalInIqd: '0.0000',
      totalOutIqd: '0.0000',
      closingIqd: '0.0000',
    };
  }

  const [openingRow] = (
    await tx.execute(sql`
      select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as opening
        from journal_line l
        join journal_entry e on e.id = l.journal_entry_id
       where l.account_id = ${account.glAccountId}
         and e.status in ('posted', 'reversed')
         and e.posting_date <= ${opensAt}::date
         and (${branch}::text is null or e.branch_code = ${branch})
    `)
  ).rows as unknown as { opening: string }[];

  // The party is read from the line's own dimension where the posting engine
  // set one, so a receipt says which customer it came from without this
  // report guessing from the description.
  const rows = (
    await tx.execute(sql`
      select e.posting_date::text        as "postingDate",
             e.entry_no                  as "entryNo",
             e.id::text                  as "journalEntryId",
             e.description               as "description",
             e.source_module             as "sourceModule",
             exists (select 1 from bank_transfer t where t.journal_entry_id = e.id) as "isTransfer",
             e.source_doc_id::text       as "sourceDocId",
             l.business_partner_code      as "partyCode",
             p.legal_name                as "partyName",
             raiser.display_name         as "raisedBy",
             approver.display_name       as "approvedBy",
             l.debit_iqd::text           as "debitIqd",
             l.credit_iqd::text          as "creditIqd"
        from journal_line l
        join journal_entry e on e.id = l.journal_entry_id
        left join business_partner p on p.code = l.business_partner_code
        left join app_user raiser    on raiser.id = e.created_by
        left join app_user approver  on approver.id = e.approved_by
       where l.account_id = ${account.glAccountId}
         and e.status in ('posted', 'reversed')
         and e.posting_date between ${window.from}::date and ${window.to}::date
         and (${branch}::text is null or e.branch_code = ${branch})
       order by e.posting_date, e.entry_no, l.line_no
    `)
  ).rows as unknown as Omit<LedgerLine, 'kind' | 'balanceIqd' | 'reference'>[];

  let balance = parseDecimal(openingRow?.opening ?? '0', MONEY);
  let totalIn = 0n;
  let totalOut = 0n;

  const lines: LedgerLine[] = rows.map((row) => {
    const debit = parseDecimal(row.debitIqd, MONEY);
    const credit = parseDecimal(row.creditIqd, MONEY);
    balance += debit - credit;
    totalIn += debit;
    totalOut += credit;

    // A transfer is known by the module that posted it, never by its wording.
    const transfer = row.isTransfer;
    const kind: MovementKind = transfer
      ? debit > 0n
        ? 'transfer_in'
        : 'transfer_out'
      : row.sourceModule === 'sales'
        ? 'receipt'
        : row.sourceModule === 'purchasing'
          ? 'payment'
          : 'other';

    return {
      ...row,
      kind,
      reference: row.entryNo,
      balanceIqd: toDecimalString(balance, MONEY),
    };
  });

  return {
    accountCode: account.accountCode,
    accountName: account.accountName,
    kind: account.kind,
    currency: account.currency,
    glAccountCode: account.glAccountCode,
    from: window.from,
    to: window.to,
    openingIqd: toDecimalString(parseDecimal(openingRow?.opening ?? '0', MONEY), MONEY),
    lines,
    totalInIqd: toDecimalString(totalIn, MONEY),
    totalOutIqd: toDecimalString(totalOut, MONEY),
    closingIqd: toDecimalString(balance, MONEY),
  };
}

/** Whole days since an account last moved, or null if it never has. */
export function daysSinceMovement(position: AccountPosition, asOf: string): number | null {
  return position.lastMovementDate ? daysBetween(position.lastMovementDate, asOf) : null;
}
