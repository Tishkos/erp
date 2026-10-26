import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { daysBetween } from '../domain/ageing';
import { parseDecimal, toDecimalString } from '../domain/money';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

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

// ---------------------------------------------------------------------------
// Payments & Receipts — REQ-ACC-001 Part D-4 (2026-10-04)
//
// One treasury view of the money that actually moved: every posted line on a
// bank or cash account's G/L account, across all of them, with the document
// that moved it. Nothing here pays or receives — a customer receipt stays
// Receivables', a supplier payment Payables', a transfer Treasury's; this
// reads what their postings left on the bank and cash accounts, so it cannot
// disagree with Bank and Cash Reporting (the same lines) or the G/L.
// ---------------------------------------------------------------------------

export const MONEY_VIEWS = ['receipts', 'payments', 'transfers'] as const;
export type MoneyView = (typeof MONEY_VIEWS)[number];

/** The documents a money movement is traced back to, and their record pages. */
export const MONEY_DOCUMENT_TYPES = [
  'customer_receipt',
  'supplier_payment',
  'supplier_advance',
  'bank_transfer',
  'other_receipt',
  // 0428.
  'customer_payment',
  'expense_payment',
  'bank_loan',
  'payroll_run',
  'employee_request',
  'employee_advance',
  'cash_advance',
  'bank_reconciliation',
] as const;
export type MoneyDocumentType = (typeof MONEY_DOCUMENT_TYPES)[number];

export interface MoneyMovement {
  readonly journalLineId: string;
  readonly postingDate: string;
  readonly entryNo: string;
  readonly description: string | null;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountKind: 'bank' | 'cash';
  readonly currency: string;
  readonly direction: 'in' | 'out';
  readonly kind: MovementKind;
  readonly amountIqd: string;
  /** The line in the account's own currency, when it was entered in one. */
  readonly amountTxn: string;
  readonly txnCurrency: string;
  readonly partyCode: string | null;
  readonly partyName: string | null;
  readonly partyIsCustomer: boolean;
  readonly partyIsSupplier: boolean;
  readonly documentType: MoneyDocumentType | null;
  readonly documentNo: string | null;
  /** This line is a reversal's mirror of an earlier movement. */
  readonly isReversal: boolean;
}

export interface MoneyFilter extends RegisterPaging {
  readonly from: string;
  readonly to: string;
  readonly view?: MoneyView | null;
  readonly accountCode?: string | null;
  readonly search?: string | null;
}

/**
 * The lines, each with its account, its party and its document. The
 * document is found by the journal it posted (a reversal by the journal it
 * mirrors), from the documents that move money — never by guessing from a
 * description.
 */
const MOVEMENTS = (from: string, to: string) => sql`(
  select l.id::text as journal_line_id, e.posting_date::text as posting_date, e.entry_no,
         coalesce(l.line_description, e.description) as description,
         b.code as account_code, b.name as account_name, b.account_type::text as account_kind, b.currency,
         case when l.debit_iqd > 0 then 'in' else 'out' end as direction,
         greatest(l.debit_iqd, l.credit_iqd)::text as amount_iqd,
         greatest(l.debit_txn, l.credit_txn)::text as amount_txn, l.currency as txn_currency,
         l.debit_iqd as debit, l.credit_iqd as credit,
         exists (select 1 from bank_transfer t where t.journal_entry_id = coalesce(e.reverses_id, e.id)) as is_transfer,
         e.source_module, e.reverses_id is not null as is_reversal, coalesce(e.reverses_id, e.id) as source_entry_id,
         e.source_doc_id,
         coalesce(l.business_partner_code,
                  (select min(x.business_partner_code) from journal_line x
                    where x.journal_entry_id = e.id and x.business_partner_code is not null)) as party_code
    from journal_line l
    join journal_entry e on e.id = l.journal_entry_id
    join bank_cash_account b on b.gl_account_id = l.account_id
   where e.status in ('posted', 'reversed')
     and e.posting_date between ${from}::date and ${to}::date
) m`;

const DOCUMENT_OF = sql`left join lateral (
  select d.type, d.no from (
    select 'customer_receipt' as type, r.receipt_no as no from customer_receipt r where r.journal_entry_id = m.source_entry_id
    union all select 'supplier_payment', p.payment_no from supplier_payment p where p.journal_entry_id = m.source_entry_id
    union all select 'supplier_advance', a.advance_no from supplier_advance a where a.journal_entry_id = m.source_entry_id
    union all select 'bank_transfer', t.transfer_no from bank_transfer t where t.journal_entry_id = m.source_entry_id
    union all select 'other_receipt', o.receipt_no from other_receipt o where o.journal_entry_id = m.source_entry_id
    union all select 'customer_payment', cp.payment_no from customer_payment cp where cp.journal_entry_id = m.source_entry_id
    union all select 'expense_payment', ep.payment_no from expense_payment ep where ep.journal_entry_id = m.source_entry_id
    union all select 'bank_loan', bl.loan_no from bank_loan bl
               where bl.disbursement_journal_entry_id = m.source_entry_id or bl.commission_journal_entry_id = m.source_entry_id
    union all select 'bank_loan', bl.loan_no from bank_loan_repayment rp join bank_loan bl on bl.id = rp.loan_id
               where rp.journal_entry_id = m.source_entry_id
    union all select 'payroll_run', pr.run_no from payroll_payment pp join payroll_run pr on pr.id = pp.run_id
               where pp.journal_entry_id = m.source_entry_id
    union all select 'employee_request', q.request_no from employee_request q where q.journal_entry_id = m.source_entry_id
    union all select 'employee_advance', ea.advance_no from employee_advance ea where ea.journal_entry_id = m.source_entry_id
    union all select 'cash_advance', ca.advance_no from cash_advance ca where ca.journal_entry_id = m.source_entry_id
    union all select 'bank_reconciliation', s.statement_no from bank_reconciliation br join bank_statement s on s.id = br.statement_id
               where m.source_module = 'treasury' and br.id::text = m.source_doc_id
  ) d limit 1
) doc on true
left join business_partner bp on bp.code = m.party_code`;

function moneyWhere(filter: MoneyFilter) {
  const account = filter.accountCode?.trim() || null;
  return whereOf([
    filter.view === 'receipts' ? sql`m.direction = 'in' and not m.is_transfer` : null,
    filter.view === 'payments' ? sql`m.direction = 'out' and not m.is_transfer` : null,
    filter.view === 'transfers' ? sql`m.is_transfer` : null,
    account ? sql`m.account_code = ${account}` : null,
    searchOf(
      [sql`m.entry_no`, sql`m.description`, sql`m.account_code`, sql`m.account_name`, sql`m.party_code`, sql`bp.legal_name`, sql`doc.no`],
      filter.search,
    ),
  ]);
}

/**
 * The register: fifty to a page, a true count, and the totals in and out
 * over every page of what the filters chose — in dinars, the ledger's figure.
 */
export async function moneyRegister(tx: Tx, ctx: ActorContext, filter: MoneyFilter) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const where = moneyWhere(filter);
  const from = sql`from ${MOVEMENTS(filter.from, filter.to)} ${DOCUMENT_OF} ${where}`;
  const [totals] = (
    await tx.execute(sql`select coalesce(sum(m.debit), 0)::text as "inIqd", coalesce(sum(m.credit), 0)::text as "outIqd" ${from}`)
  ).rows as unknown as { inIqd: string; outIqd: string }[];
  const page = await registerPage<MoneyMovement>({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select m.*, doc.type as document_type, doc.no as document_no, bp.legal_name as party_name,
               coalesce(bp.is_customer, false) as party_is_customer, coalesce(bp.is_supplier, false) as party_is_supplier
          ${from}
         order by m.posting_date desc, m.entry_no desc, m.journal_line_id
         limit ${limit} offset ${offset}`);
      return (result as unknown as { rows: Record<string, unknown>[] }).rows.map(movementRow);
    },
  });
  return { ...page, totalInIqd: totals?.inIqd ?? '0', totalOutIqd: totals?.outIqd ?? '0' };
}

function movementRow(row: Record<string, unknown>): MoneyMovement {
  const transfer = Boolean(row.is_transfer);
  const direction = row.direction === 'in' ? 'in' : 'out';
  return {
    journalLineId: String(row.journal_line_id),
    postingDate: String(row.posting_date),
    entryNo: String(row.entry_no),
    description: (row.description as string | null) ?? null,
    accountCode: String(row.account_code),
    accountName: String(row.account_name),
    accountKind: row.account_kind === 'cash' ? 'cash' : 'bank',
    currency: String(row.currency),
    direction,
    kind: transfer ? (direction === 'in' ? 'transfer_in' : 'transfer_out') : direction === 'in' ? 'receipt' : 'payment',
    amountIqd: String(row.amount_iqd),
    amountTxn: String(row.amount_txn),
    txnCurrency: String(row.txn_currency),
    partyCode: (row.party_code as string | null) ?? null,
    partyName: (row.party_name as string | null) ?? null,
    partyIsCustomer: Boolean(row.party_is_customer),
    partyIsSupplier: Boolean(row.party_is_supplier),
    documentType: ((row.document_type as string | null) ?? null) as MoneyDocumentType | null,
    documentNo: (row.document_no as string | null) ?? null,
    isReversal: Boolean(row.is_reversal),
  };
}
