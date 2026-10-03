/**
 * Bank deposits — REQ-FIX-001 FIX-1 (D-FX-2).
 *
 * Money put into a bank account by hand. There are two ways it arrives and
 * each already has its document, its approval and its posting:
 *
 *   · from one of the company's cash accounts — a **bank transfer**
 *     (`treasury.createTransfer`, Dr the bank, Cr the cash, one journal);
 *   · from anywhere else (an owner's capital, a refund, a sale outside the
 *     ledgers) — an **other receipt** (`other-receipt.create`, Dr the bank,
 *     Cr the account it was for, never a control account).
 *
 * This is the register over both, limited to what landed in a *bank*
 * account (a transfer from one bank to another is a transfer, not a
 * deposit), and the one place they are raised, approved and posted from.
 * It invents no third document: a deposit is one of those two rows.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as treasury from './treasury';
import * as otherReceipt from './other-receipt';
import { AdminNotFoundError } from './administration';
import { registerPage, searchOf, type RegisterPaging } from './register-page';

/** The screen's own object: the treasury accounts' (each action checks its document's). */
export const PERMISSION_OBJECT = 'bank_cash_account';
export const RECEIPT_PERMISSION_OBJECT = otherReceipt.PERMISSION_OBJECT;

export type DepositSource = 'cash' | 'bank' | 'transfer';

export interface DepositRow {
  readonly id: string;
  readonly no: string;
  readonly source: DepositSource;
  readonly depositDate: string;
  readonly status: string;
  readonly intoCode: string;
  readonly intoName: string;
  readonly currency: string;
  readonly amount: string;
  /** The cash account it came from, or the account it was credited to. */
  readonly fromCode: string;
  readonly fromName: string;
  /** Who paid it in — an other receipt's payer; null for a cash deposit. */
  readonly payer: string | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly branchCode: string;
  readonly createdBy: string;
  /** The posting's journal, once posted. */
  readonly journalEntryNo: string | null;
}

export const DEPOSIT_VIEWS = ['open', 'posted'] as const;
export type DepositView = (typeof DEPOSIT_VIEWS)[number];

/** Both documents, as one relation the register reads. */
const DEPOSITS = sql`(
  select t.id, t.transfer_no as no, 'transfer'::text as source, t.transfer_date::text as deposit_date,
         t.status::text as status, ta.code as into_code, ta.name as into_name, t.to_currency as currency,
         t.received_amount::text as amount, fa.code as from_code, fa.name as from_name, null::text as payer,
         t.bank_reference as reference, t.note, t.branch_code, t.created_by::text as created_by,
         je.entry_no as journal_entry_no, t.created_at
    from bank_transfer t
    left join journal_entry je on je.id = t.journal_entry_id
    join bank_cash_account ta on ta.id = t.to_account_id
    join bank_cash_account fa on fa.id = t.from_account_id
   where ta.account_type = 'bank' and fa.account_type = 'cash'
  union all
  -- A receipt is told apart by the account that received it: into the cash it
  -- is a cash deposit, into the bank a bank deposit (2026-10-04).
  select r.id, r.receipt_no, a.account_type::text, r.receipt_date::text,
         r.status::text, a.code, a.name, r.currency,
         r.amount_iqd::text, c.code, c.name, r.payer,
         r.reference, r.note, r.branch_code, r.created_by::text,
         je.entry_no, r.created_at
    from other_receipt r
    left join journal_entry je on je.id = r.journal_entry_id
    join bank_cash_account a on a.id = r.bank_cash_account_id
    join chart_of_account c on c.id = r.credit_account_id
) d`;

const toRow = (row: Record<string, unknown>): DepositRow => ({
  id: String(row.id),
  no: String(row.no),
  source: row.source === 'cash' ? 'cash' : row.source === 'transfer' ? 'transfer' : 'bank',
  depositDate: String(row.deposit_date),
  status: String(row.status),
  intoCode: String(row.into_code),
  intoName: String(row.into_name),
  currency: String(row.currency),
  amount: String(row.amount),
  fromCode: String(row.from_code),
  fromName: String(row.from_name),
  payer: (row.payer as string | null) ?? null,
  reference: (row.reference as string | null) ?? null,
  note: (row.note as string | null) ?? null,
  branchCode: String(row.branch_code),
  createdBy: String(row.created_by),
  journalEntryNo: (row.journal_entry_no as string | null) ?? null,
});

export interface DepositFilter extends RegisterPaging {
  readonly view?: DepositView | null;
  readonly search?: string | null;
}

/** The register: one page of fifty, a true count, the view and the search in the SQL. */
export async function listForScreen(tx: Tx, filter: DepositFilter = {}) {
  const parts = [
    filter.view === 'open' ? sql`d.status in ('draft', 'submitted', 'approved')` : null,
    filter.view === 'posted' ? sql`d.status = 'posted'` : null,
    searchOf([sql`d.no`, sql`d.into_code`, sql`d.into_name`, sql`d.from_code`, sql`d.from_name`, sql`d.payer`, sql`d.reference`], filter.search),
  ].filter((part): part is NonNullable<typeof part> => part !== null);
  const where = parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``;
  return registerPage<DepositRow>({
    paging: filter,
    count: async () => {
      const result = await tx.execute(sql`select count(*)::int as n from ${DEPOSITS} ${where}`);
      return Number((result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
    },
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`select * from ${DEPOSITS} ${where} order by d.deposit_date desc, d.created_at desc, d.no desc limit ${limit} offset ${offset}`);
      return (result as unknown as { rows: Record<string, unknown>[] }).rows.map(toRow);
    },
  });
}

/** One deposit by its number — a transfer's or an other receipt's. */
export async function byNo(tx: Tx, no: string): Promise<DepositRow> {
  const result = await tx.execute(sql`select * from ${DEPOSITS} where d.no = ${no} limit 1`);
  const [row] = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  if (!row) throw new AdminNotFoundError('bank deposit', no);
  return toRow(row);
}

export interface CashDepositInput {
  readonly intoAccountId: string;
  readonly fromCashAccountId: string;
  readonly depositDate: string;
  readonly amount: bigint;
  readonly reference?: string | null;
  readonly note?: string | null;
}

/** Cash taken to the bank: a bank transfer from the cash account, same currency. */
/**
 * Money put into one of the company's **cash** accounts by hand (2026-10-04).
 *
 * The same document as a bank deposit — a receipt of money arriving, credited
 * where the chart says it came from — differing only in which kind of account
 * receives it. Only cash accounts are offered, and only a cash account is
 * accepted.
 */
export async function depositCash(tx: Tx, ctx: ActorContext, input: OtherDepositInput): Promise<{ no: string }> {
  const accounts = await accountKinds(tx, [input.intoAccountId]);
  if (accounts.get(input.intoAccountId) !== 'cash') {
    throw new Error('A cash deposit goes into a cash account; choose one.');
  }
  if (input.amount <= 0n) throw new Error('State the amount deposited.');
  const made = await otherReceipt.create(tx, ctx, {
    bankCashAccountId: input.intoAccountId,
    branchCode: ctx.branchCode,
    receiptDate: input.depositDate,
    amountIqd: input.amount,
    creditAccountId: input.creditAccountId,
    payer: input.payer,
    reference: input.reference ?? null,
    note: input.note ?? null,
  });
  return { no: made.receiptNo };
}

export interface OtherDepositInput {
  readonly intoAccountId: string;
  readonly creditAccountId: string;
  readonly payer: string;
  readonly depositDate: string;
  readonly amount: bigint;
  readonly reference?: string | null;
  readonly note?: string | null;
}

/** Money put into one of the company's **bank** accounts by hand. */
export async function depositOther(tx: Tx, ctx: ActorContext, input: OtherDepositInput): Promise<{ no: string }> {
  const accounts = await accountKinds(tx, [input.intoAccountId]);
  if (accounts.get(input.intoAccountId) !== 'bank') throw new Error('A deposit goes into a bank account; choose one.');
  const made = await otherReceipt.create(tx, ctx, {
    bankCashAccountId: input.intoAccountId,
    branchCode: ctx.branchCode,
    receiptDate: input.depositDate,
    amountIqd: input.amount,
    creditAccountId: input.creditAccountId,
    payer: input.payer,
    reference: input.reference ?? null,
    note: input.note ?? null,
  });
  return { no: made.receiptNo };
}

/**
 * Approve — by somebody other than whoever raised it, whichever document it
 * is: the money is counted by one person and accepted by another.
 */
export async function approve(tx: Tx, ctx: ActorContext, no: string): Promise<void> {
  const deposit = await byNo(tx, no);
  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (deposit.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new Error(`${deposit.no} was raised by you; somebody else approves it.`);
  }
  // Which document it is, rather than which label it wears: only the legacy
  // cash-to-bank transfer is a transfer (2026-10-04).
  if (deposit.source === 'transfer') await treasury.approveTransfer(tx, ctx, deposit.id);
  else await otherReceipt.approve(tx, ctx, deposit.id);
}

/** Post — the journal, through the document's own posting. */
export async function post(tx: Tx, ctx: ActorContext, no: string): Promise<{ journalEntryId: string }> {
  const deposit = await byNo(tx, no);
  return deposit.source === 'transfer'
    ? treasury.postTransfer(tx, ctx, deposit.id)
    : otherReceipt.post(tx, ctx, deposit.id);
}

async function accountKinds(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const result = await tx.execute(
    sql`select id::text, account_type::text from bank_cash_account where active and id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  return new Map((result as unknown as { rows: { id: string; account_type: string }[] }).rows.map((row) => [row.id, row.account_type]));
}
