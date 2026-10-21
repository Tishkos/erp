/**
 * Which currency a document's bank line is written in (2026-10-21, by
 * direction: "we still can't upload the SWIFTs … fix it so it converts
 * automatically").
 *
 * A supplier paid from a USD bank account could not be posted: the bank's
 * ledger account takes dollars only and the supplier's control account dinars
 * only, and a journal was written in one currency. The posting engine now
 * takes a currency per line, so the bank line is written in the bank's own
 * currency — the dollars that actually left — and the supplier's line in the
 * dinars they come to at the payment date's rate; the journal balances in
 * dinars, as every journal does.
 *
 * The rule, read off the bank account and its ledger account:
 *   * an IQD bank account, or a ledger account restricted to IQD → dinars, as before;
 *   * otherwise → the bank account's currency, for the document's own amount
 *     in that currency, which must come to exactly the dinars the document
 *     carries at the posting date's rate (the payment application converted it
 *     at that same rate, so it does; anything else is a document that disagrees
 *     with itself and is refused with both figures).
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { bankCashAccount, chartOfAccount } from '../db/schema';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import * as rates from './exchange-rates';

export class BankLineCurrencyError extends Error {
  readonly code = 'BANK_LINE_CURRENCY';
  constructor(message: string) {
    super(message);
    this.name = 'BankLineCurrencyError';
  }
}

export interface BankLine {
  /** Absent: the journal's own currency (dinars). */
  readonly currency?: string;
  /** The line's amount, in its currency. */
  readonly amount: string;
}

export async function bankLineFor(
  tx: Tx,
  bankCashAccountId: string,
  document: {
    readonly label: string;
    readonly currency: string | null;
    readonly amountTxn: string | null;
    readonly amountIqd: string;
    readonly postingDate: string;
  },
): Promise<BankLine> {
  const [account] = await tx
    .select({ code: bankCashAccount.code, currency: bankCashAccount.currency, restriction: chartOfAccount.currencyRestriction })
    .from(bankCashAccount)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, bankCashAccount.glAccountId))
    .where(eq(bankCashAccount.id, bankCashAccountId))
    .limit(1);
  const dinars: BankLine = { amount: document.amountIqd };
  if (!account) return dinars;
  const bankCurrency = account.currency.trim();
  if (bankCurrency === 'IQD' || account.restriction?.trim() === 'IQD') return dinars;

  if (!document.amountTxn || (document.currency ?? '').trim() !== bankCurrency) {
    throw new BankLineCurrencyError(
      `${document.label} leaves ${account.code}, a ${bankCurrency} account, so it is posted in ${bankCurrency}; ` +
        `give its amount in ${bankCurrency}.`,
    );
  }
  const amountTxn = parseDecimal(document.amountTxn, MONEY_SCALE);
  const converted = await rates.convertOn(tx, amountTxn, bankCurrency, document.postingDate);
  if (converted.amountIqd !== parseDecimal(document.amountIqd, MONEY_SCALE)) {
    throw new BankLineCurrencyError(
      `${document.label}: ${bankCurrency} ${toDecimalString(amountTxn, MONEY_SCALE)} comes to IQD ` +
        `${toDecimalString(converted.amountIqd, MONEY_SCALE)} at the rate of ${document.postingDate}, ` +
        `not the IQD ${document.amountIqd} it carries. Check the exchange rate of that day.`,
    );
  }
  return { currency: bankCurrency, amount: toDecimalString(amountTxn, MONEY_SCALE) };
}
