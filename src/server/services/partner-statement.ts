/**
 * The customer and supplier Account Statement — Operations build, blocks 2 and
 * 3 (2026-09-12).
 *
 * The sponsor asked for one report on each side, and described them as
 * mirrors:
 *
 *   Customer   sales are Debit; payments or discounts are Credit.
 *   Supplier   purchases are Credit; payments or discounts are Debit.
 *
 * They are not two reports. Both read the subledger the posting engine already
 * writes beside every journal, and each entry already carries its debit and
 * its credit — an invoice debits the customer, a receipt credits them; an
 * invoice credits the supplier, a payment debits them. Nothing has to be
 * classified here, and nothing is re-derived from the document it came from.
 *
 * What differs is only which way the running balance is read:
 *
 *   a customer owes the company     balance = debits less credits
 *   the company owes a supplier     balance = credits less debits
 *
 * so both statements end at a positive figure when there is money outstanding,
 * which is how a person reading either of them expects it to look.
 */
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { journalEntry, subledgerEntry } from '../db/schema';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';

/** Which side of the ledger the party sits on. */
export type PartySide = 'customer' | 'supplier';

export interface StatementLine {
  readonly postingDate: string;
  /** The journal this came from, for the drill-down. */
  readonly entryNo: string;
  readonly description: string | null;
  /** The operational document, when the posting named one. */
  readonly sourceModule: string | null;
  readonly sourceDocId: string | null;
  readonly debit: string;
  readonly credit: string;
  /** Running, in the direction that party's balance is owed. */
  readonly balance: string;
}

export interface PartnerStatement {
  readonly partyCode: string;
  readonly side: PartySide;
  readonly from: string | null;
  readonly to: string;
  /** What was outstanding before the first line shown. */
  readonly opening: string;
  readonly lines: readonly StatementLine[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** What is outstanding at `to`. Positive means money is owed. */
  readonly closing: string;
}

const decimal = (value: bigint) => toDecimalString(value, MONEY_SCALE);

/**
 * Which subledger each side keeps. The names are the seven control-account
 * kinds the ledger has used since Phase 02.
 */
const SUBLEDGER = { customer: 'customer', supplier: 'supplier' } as const;

/** A customer's balance runs one way, a supplier's the other. See the note above. */
const owed = (side: PartySide, debit: bigint, credit: bigint) =>
  side === 'customer' ? debit - credit : credit - debit;

/**
 * One party's account, in posting order, with a running balance.
 *
 * `from` is optional: without it the statement starts at the beginning and
 * opens at zero. With it, everything before is folded into the opening figure
 * rather than dropped, so the closing balance is the same either way.
 */
export async function statementFor(
  tx: Tx,
  side: PartySide,
  partyCode: string,
  window: { readonly from?: string | null; readonly to: string },
): Promise<PartnerStatement> {
  const mine = and(
    eq(subledgerEntry.subledgerType, SUBLEDGER[side]),
    eq(subledgerEntry.partyCode, partyCode),
  );

  const before = window.from
    ? await tx
        .select({
          debit: sql<string>`coalesce(sum(${subledgerEntry.debitIqd}), 0)::text`,
          credit: sql<string>`coalesce(sum(${subledgerEntry.creditIqd}), 0)::text`,
        })
        .from(subledgerEntry)
        .where(and(mine, sql`${subledgerEntry.postingDate} < ${window.from}::date`))
    : [];

  const opening = before[0]
    ? owed(
        side,
        parseDecimal(before[0].debit, MONEY_SCALE),
        parseDecimal(before[0].credit, MONEY_SCALE),
      )
    : 0n;

  const rows = await tx
    .select({
      postingDate: subledgerEntry.postingDate,
      entryNo: journalEntry.entryNo,
      description: journalEntry.description,
      sourceModule: subledgerEntry.sourceModule,
      sourceDocId: subledgerEntry.sourceDocId,
      debit: subledgerEntry.debitIqd,
      credit: subledgerEntry.creditIqd,
    })
    .from(subledgerEntry)
    .innerJoin(journalEntry, eq(journalEntry.id, subledgerEntry.journalEntryId))
    .where(
      and(
        mine,
        lte(subledgerEntry.postingDate, window.to),
        window.from ? sql`${subledgerEntry.postingDate} >= ${window.from}::date` : undefined,
      ),
    )
    .orderBy(asc(subledgerEntry.postingDate), asc(subledgerEntry.id));

  let balance = opening;
  let totalDebit = 0n;
  let totalCredit = 0n;
  const lines: StatementLine[] = rows.map((row) => {
    const debit = parseDecimal(row.debit, MONEY_SCALE);
    const credit = parseDecimal(row.credit, MONEY_SCALE);
    totalDebit += debit;
    totalCredit += credit;
    balance += owed(side, debit, credit);
    return {
      postingDate: row.postingDate,
      entryNo: row.entryNo,
      description: row.description,
      sourceModule: row.sourceModule,
      sourceDocId: row.sourceDocId,
      debit: decimal(debit),
      credit: decimal(credit),
      balance: decimal(balance),
    };
  });

  return {
    partyCode,
    side,
    from: window.from ?? null,
    to: window.to,
    opening: decimal(opening),
    lines,
    totalDebit: decimal(totalDebit),
    totalCredit: decimal(totalCredit),
    closing: decimal(balance),
  };
}
