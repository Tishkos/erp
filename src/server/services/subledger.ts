/**
 * Subledger service — Phase 02.9.
 *
 * §1.2 requires customer, supplier, inventory, fixed-asset, bank, project and
 * service subledgers "that reconcile to the General Ledger".
 *
 * Reconciliation is not a report that runs afterwards; it is a property of how
 * the entries are written. Every subledger entry is created **from** a journal
 * line, **in the same transaction**, and only for lines that hit a control
 * account. The subledger therefore cannot contain a movement the G/L does not,
 * and the totals agree by construction rather than by reconciliation.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ControlAccountKind } from '../domain/chart-of-accounts';
import type { DimensionType } from '../domain/dimensions';
import { chartOfAccount, journalEntry, journalLine, subledgerEntry } from '../db/schema';
import type { Tx } from '../db/client';

/**
 * Where the party code comes from, per subledger.
 *
 * Customer and supplier both read the Business Partner dimension: which of the
 * two it is comes from the control account, not from the code. Inventory reads
 * the warehouse; bank reads the bank account on the line.
 *
 * Fixed asset and service have no dimension yet — their masters arrive in
 * Phases 12 and 03. A line posting to one of those control accounts must carry
 * an explicit party, and is refused if it does not.
 */
const PARTY_SOURCE: Readonly<Record<ControlAccountKind, DimensionType | 'bank_account' | 'loan' | null>> = {
  customer: 'business_partner',
  supplier: 'business_partner',
  inventory: 'warehouse',
  bank: 'bank_account',
  project: 'project',
  fixed_asset: null,
  service: null,
  // REQ-AP-001 §15.7 — the loan the line is against (journal_line.loan_no).
  loan: 'loan',
};

export class MissingSubledgerPartyError extends Error {
  readonly code = 'SUBLEDGER_PARTY_MISSING';

  constructor(
    readonly accountCode: string,
    readonly subledgerType: ControlAccountKind,
  ) {
    super(
      `Account ${accountCode} is the ${subledgerType} control account, so the posting must say which ` +
        `${subledgerType} it is against. Without it the subledger cannot reconcile to the account (§1.2).`,
    );
    this.name = 'MissingSubledgerPartyError';
  }
}

/**
 * Writes the subledger entries for a journal that has just posted.
 *
 * Called at the single moment a journal becomes posted — from the manual
 * approval path, from the posting engine, and from reversal — so all three
 * produce subledgers the same way. §24: one mechanism, not one per module.
 *
 * Idempotent: a unique index on the journal line means a second call adds
 * nothing, so a retry cannot double the subledger.
 */
export async function writeForJournal(tx: Tx, journalEntryId: string): Promise<number> {
  const [entry] = await tx
    .select()
    .from(journalEntry)
    .where(eq(journalEntry.id, journalEntryId))
    .limit(1);

  if (!entry) return 0;

  const lines = await tx
    .select({
      line: journalLine,
      controlAccount: chartOfAccount.controlAccount,
      accountCode: chartOfAccount.code,
    })
    .from(journalLine)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, journalLine.accountId))
    .where(eq(journalLine.journalEntryId, journalEntryId));

  let written = 0;

  for (const { line, controlAccount, accountCode } of lines) {
    if (!controlAccount) continue;

    const partyCode = resolveParty(line, controlAccount);
    if (!partyCode) {
      throw new MissingSubledgerPartyError(accountCode, controlAccount);
    }

    await tx
      .insert(subledgerEntry)
      .values({
        subledgerType: controlAccount,
        partyCode,
        controlAccountId: line.accountId,
        journalEntryId,
        journalLineId: line.id,
        postingDate: entry.postingDate,
        branchCode: line.branchCode ?? entry.branchCode,
        currency: line.currency,
        debitTxn: line.debitTxn,
        creditTxn: line.creditTxn,
        debitIqd: line.debitIqd,
        creditIqd: line.creditIqd,
        debitUsd: line.debitUsd,
        creditUsd: line.creditUsd,
        sourceModule: entry.sourceModule,
        sourceDocId: entry.sourceDocId,
      })
      .onConflictDoNothing();

    written += 1;
  }

  return written;
}

function resolveParty(
  line: typeof journalLine.$inferSelect,
  kind: ControlAccountKind,
): string | null {
  switch (PARTY_SOURCE[kind]) {
    case 'business_partner':
      return line.businessPartnerCode;
    case 'warehouse':
      return line.warehouseCode;
    case 'project':
      return line.projectCode;
    case 'bank_account':
      return line.bankAccountCode;
    case 'loan':
      return line.loanNo;
    default:
      // No dimension carries it yet — the posting must have supplied one
      // explicitly, which for now means the business partner field.
      return line.businessPartnerCode;
  }
}

// ---------------------------------------------------------------------------
// Reads and reconciliation
// ---------------------------------------------------------------------------

export interface SubledgerBalance {
  readonly partyCode: string;
  readonly debitIqd: string;
  readonly creditIqd: string;
  readonly balanceIqd: string;
}

/** Balances per party within one subledger, derived from the entries (§24). */
export async function balances(
  tx: Tx,
  subledgerType: ControlAccountKind,
  asOf?: string,
): Promise<SubledgerBalance[]> {
  const result = await tx.execute(sql`
    select party_code                                    as "partyCode",
           coalesce(sum(debit_iqd), 0)::text             as "debitIqd",
           coalesce(sum(credit_iqd), 0)::text            as "creditIqd",
           (coalesce(sum(debit_iqd), 0) - coalesce(sum(credit_iqd), 0))::text as "balanceIqd"
      from subledger_entry
     where subledger_type = ${subledgerType}
       and (${asOf ?? null}::date is null or posting_date <= ${asOf ?? null}::date)
     group by party_code
     order by party_code
  `);

  return result.rows as unknown as SubledgerBalance[];
}

export interface ReconciliationRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly subledgerType: string;
  readonly subledgerBalance: string;
  readonly generalLedgerBalance: string;
  readonly difference: string;
}

/**
 * The reconciliation §1.2 requires, as one query.
 *
 * Every control account, with its subledger total beside its G/L balance. The
 * difference column is expected to be zero everywhere; anything else is a
 * finding, not a rounding.
 */
export async function reconciliation(tx: Tx, asOf?: string): Promise<ReconciliationRow[]> {
  const result = await tx.execute(sql`
    select a.code                                         as "accountCode",
           a.name                                         as "accountName",
           a.control_account::text                        as "subledgerType",
           coalesce(s.balance, 0)::text                   as "subledgerBalance",
           coalesce(g.balance, 0)::text                   as "generalLedgerBalance",
           (coalesce(s.balance, 0) - coalesce(g.balance, 0))::text as "difference"
      from chart_of_account a
      left join (
            select control_account_id,
                   sum(debit_iqd) - sum(credit_iqd) as balance
              from subledger_entry
             where (${asOf ?? null}::date is null or posting_date <= ${asOf ?? null}::date)
             group by control_account_id
      ) s on s.control_account_id = a.id
      left join (
            select l.account_id,
                   sum(l.debit_iqd) - sum(l.credit_iqd) as balance
              from journal_line l
              join journal_entry e on e.id = l.journal_entry_id
             where e.status in ('posted', 'reversed')
               and (${asOf ?? null}::date is null or e.posting_date <= ${asOf ?? null}::date)
             group by l.account_id
      ) g on g.account_id = a.id
     where a.control_account is not null
     order by a.code
  `);

  return result.rows as unknown as ReconciliationRow[];
}

/** One party's movements, oldest first — the customer or supplier statement. */
export async function statementFor(
  tx: Tx,
  subledgerType: ControlAccountKind,
  partyCode: string,
) {
  return tx
    .select({
      id: subledgerEntry.id,
      postingDate: subledgerEntry.postingDate,
      journalEntryId: subledgerEntry.journalEntryId,
      debitIqd: subledgerEntry.debitIqd,
      creditIqd: subledgerEntry.creditIqd,
      currency: subledgerEntry.currency,
      sourceModule: subledgerEntry.sourceModule,
      sourceDocId: subledgerEntry.sourceDocId,
    })
    .from(subledgerEntry)
    .where(
      and(
        eq(subledgerEntry.subledgerType, subledgerType),
        eq(subledgerEntry.partyCode, partyCode),
      ),
    )
    .orderBy(subledgerEntry.postingDate, subledgerEntry.id);
}
