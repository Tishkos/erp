/**
 * The Imports section of a supplier statement (2026-10-14): the supplier's
 * imports in the statement's currency, with their totals, and how many are in
 * each other currency — so the screen can offer that statement and the copy
 * prints exactly what the screen shows. No database.
 */
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';

export interface ImportFigures {
  readonly currency: string;
  readonly agreedTxn: string;
  readonly withBankTxn: string;
  readonly paidTxn: string;
  readonly remainingTxn: string;
}

export interface ImportsSection<T extends ImportFigures> {
  readonly rows: readonly T[];
  readonly totals: { readonly agreed: string; readonly withBank: string; readonly paid: string; readonly remaining: string };
  readonly elsewhere: Readonly<Record<string, number>>;
}

export function importsSection<T extends ImportFigures>(all: readonly T[], currency: string): ImportsSection<T> {
  const rows = all.filter((row) => row.currency.trim() === currency);
  const elsewhere: Record<string, number> = {};
  for (const row of all) {
    const code = row.currency.trim();
    if (code !== currency) elsewhere[code] = (elsewhere[code] ?? 0) + 1;
  }
  const sum = (pick: (row: T) => string) =>
    toDecimalString(rows.reduce((total, row) => total + parseDecimal(pick(row), MONEY_SCALE), 0n));
  return {
    rows,
    totals: {
      agreed: sum((row) => row.agreedTxn),
      withBank: sum((row) => row.withBankTxn),
      paid: sum((row) => row.paidTxn),
      remaining: sum((row) => row.remainingTxn),
    },
    elsewhere,
  };
}
