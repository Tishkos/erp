/**
 * The dinar figure on the screen and the dinar figure in the journal agree —
 * by direction, 2026-10-03.
 *
 * The purchase invoice is agreed in dollars and the books are kept in dinars,
 * so the header shows both totals as the lines are typed. Only the currency is
 * submitted: the server reads the same rate with `rateOn` and converts every
 * line itself, because a rate that arrived from a browser is one somebody could
 * have edited and these dinars end up in the ledger.
 *
 * Which means there are two implementations of one conversion, and the whole
 * point of them is that they agree. `toIqd` is the server's (`domain/money.ts`,
 * used by the action); `inLedger` is the browser's, duplicated because a client
 * component here does not import from `src/server` — the same arrangement
 * `src/lib/decimal.ts` has with the money domain.
 *
 * These run both over the awkward figures: the published USD rate, a rate with
 * eight decimal places, a total with fils in it, and the Shenzhen invoice.
 */
import { describe, expect, it } from 'vitest';
import { toIqd } from '@/server/domain/money';
import { inLedger } from '@/components/admin/invoice-currency';

/** The money scale: 265,720.0000 as the books hold it. */
const money = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
};

/** A rate as `exchange_rate` publishes it: eight decimal places. */
const rate = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
};

const AMOUNTS = [
  '0.0001',
  '1',
  '7.5',
  '276',
  '1120',
  '1234.5678',
  '19320',
  '235200',
  '265720',
  '9199874.5',
] as const;

const RATES = [
  // What the books imply and what the ERP has published.
  '1470.00000000',
  // The CBI official rate the import script mentions.
  '1320.00000000',
  // A rate that does not divide cleanly.
  '1471.33333333',
  '1.00000000',
  '0.00012345',
] as const;

describe('AP-17 · the screen and the journal convert alike', () => {
  it.each(RATES)('agrees on every amount at %s IQD per unit', (published) => {
    for (const amount of AMOUNTS) {
      expect(inLedger(money(amount), published)).toBe(toIqd(money(amount), rate(published)));
    }
  });

  it('agrees on the invoice this was built for', () => {
    // The Shenzhen invoice: USD 265,720 of goods at 1,470.
    const usd = money('265720');
    const iqd = toIqd(usd, rate('1470.00000000'));
    expect(inLedger(usd, '1470.00000000')).toBe(iqd);
    // 265,720 × 1,470 = 390,608,400 dinars, to the dinar.
    expect(iqd).toBe(money('390608400'));
  });

  it('rounds half-up, both of them, on the fils that decides', () => {
    // A rate chosen so the product lands exactly on half a fils.
    const half = money('0.0001');
    expect(inLedger(half, '0.50000000')).toBe(toIqd(half, rate('0.50000000')));
    // And just under it.
    expect(inLedger(half, '0.49990000')).toBe(toIqd(half, rate('0.49990000')));
  });

  it('is exact where a double would not be', () => {
    // 9,199,874.5 dollars at 1,470 is more than a double can hold to the fils.
    const big = money('9199874.5');
    expect(inLedger(big, '1470.00000000')).toBe(toIqd(big, rate('1470.00000000')));
  });
});
