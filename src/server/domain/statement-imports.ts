/**
 * The Imports section of a supplier statement (2026-10-14): every import of the
 * supplier in its own currency, and what they come to, one total per currency.
 *
 * Every currency, whatever the statement is run in (the second pass, the same
 * day: the imports from the sheet are all in dollars, a supplier statement opens
 * in dinars, and the owner read "No imports in IQD" as "still didn't show").
 * Totals are never added across currencies. No database.
 */
import { currencyOrder } from './legacy-history';
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';

export interface ImportFigures {
  readonly currency: string;
  readonly agreedTxn: string;
  readonly withBankTxn: string;
  readonly paidTxn: string;
  readonly remainingTxn: string;
}

export interface ImportsTotal {
  readonly currency: string;
  readonly agreed: string;
  readonly withBank: string;
  readonly paid: string;
  readonly remaining: string;
}

export interface ImportsSection<T extends ImportFigures> {
  /** Every import, each in its own currency (the code trimmed: `payable.currency` is a char(3)). */
  readonly rows: readonly T[];
  /** One per currency the imports are in, dinars first. */
  readonly totals: readonly ImportsTotal[];
}

export function importsSection<T extends ImportFigures>(all: readonly T[]): ImportsSection<T> {
  const rows = all.map((row) => ({ ...row, currency: row.currency.trim() }));
  const sums = new Map<string, { agreed: bigint; withBank: bigint; paid: bigint; remaining: bigint }>();
  for (const row of rows) {
    const sum = sums.get(row.currency) ?? { agreed: 0n, withBank: 0n, paid: 0n, remaining: 0n };
    sum.agreed += parseDecimal(row.agreedTxn, MONEY_SCALE);
    sum.withBank += parseDecimal(row.withBankTxn, MONEY_SCALE);
    sum.paid += parseDecimal(row.paidTxn, MONEY_SCALE);
    sum.remaining += parseDecimal(row.remainingTxn, MONEY_SCALE);
    sums.set(row.currency, sum);
  }
  const totals = [...sums.entries()]
    .sort(([a], [b]) => currencyOrder(a, b))
    .map(([currency, sum]) => ({
      currency,
      agreed: toDecimalString(sum.agreed),
      withBank: toDecimalString(sum.withBank),
      paid: toDecimalString(sum.paid),
      remaining: toDecimalString(sum.remaining),
    }));
  return { rows, totals };
}
