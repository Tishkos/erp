/**
 * What a Customer Payment and an Expense Payment share (0428, 2026-10-26): the account the money
 * leaves, its currency, the dinars at the payment date's rate, and the bank line in the account's own
 * currency (`bank-line-currency`). The two documents differ only in what the money pays.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { bankCashAccount, paymentMethod } from '../db/schema';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { bankLineFor, type BankLine } from './bank-line-currency';
import * as rates from './exchange-rates';

export class MoneyOutError extends Error {
  readonly code = 'MONEY_OUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'MoneyOutError';
  }
}

export interface PayingAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly glAccountId: string;
  readonly accountType: string;
}

/** The bank or cash account a payment leaves: active, with a ledger account. */
export async function payingAccount(tx: Tx, id: string): Promise<PayingAccount> {
  const [account] = await tx.select().from(bankCashAccount).where(eq(bankCashAccount.id, id)).limit(1);
  if (!account) throw new MoneyOutError(`No bank or cash account with id '${id}'.`);
  if (!account.active) throw new MoneyOutError(`${account.code} is closed, so nothing can be paid from it.`);
  if (!account.glAccountId) throw new MoneyOutError(`${account.code} has no ledger account, so a payment from it cannot post.`);
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    currency: account.currency.trim(),
    glAccountId: account.glAccountId,
    accountType: account.accountType,
  };
}

/** A payment method, when one is named, must be in use. */
export async function assertMethod(tx: Tx, code: string | null | undefined): Promise<void> {
  if (!code) return;
  const [method] = await tx
    .select({ active: paymentMethod.active })
    .from(paymentMethod)
    .where(eq(paymentMethod.code, code))
    .limit(1);
  if (!method?.active) throw new MoneyOutError(`'${code}' is not an active payment method. Choose one from Payment Methods.`);
}

/** The dinars `amount` of `currency` comes to on `date` — the amount itself for dinars. */
export async function dinarsOf(tx: Tx, amount: bigint, currency: string, date: string): Promise<bigint> {
  if (currency === 'IQD') return amount;
  try {
    return (await rates.convertOn(tx, amount, currency, date)).amountIqd;
  } catch {
    throw new MoneyOutError(`There is no ${currency} rate for ${date}, so the payment's dinars cannot be worked out. Enter the rate under Currencies and Rates first.`);
  }
}

/** The amount checked: positive, in the account's currency. */
export function assertAmount(amount: bigint): void {
  if (amount <= 0n) throw new MoneyOutError('A payment of nothing pays nothing. State the amount that leaves the account.');
}

/** The bank line, in the account's own currency (the dollars that left a USD account). */
export function bankLine(
  tx: Tx,
  document: { readonly paymentNo: string; readonly bankCashAccountId: string; readonly currency: string; readonly amount: string; readonly amountIqd: string; readonly paymentDate: string },
): Promise<BankLine> {
  return bankLineFor(tx, document.bankCashAccountId, {
    label: document.paymentNo,
    currency: document.currency,
    amountTxn: document.amount,
    amountIqd: document.amountIqd,
    postingDate: document.paymentDate,
  });
}

export const decimal = (value: bigint) => toDecimalString(value, MONEY_SCALE);
export const scaled = (value: string) => parseDecimal(value, MONEY_SCALE);
