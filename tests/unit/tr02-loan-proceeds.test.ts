/**
 * The figure on the loan form and the figure the bank sends agree —
 * by direction, 2026-10-03: "where is the amount when taking loan should give
 * us make into credit please and amount of the loan".
 *
 * A loan letter states a principal and a commission percentage. What lands in
 * the account is neither of them: with the commission deducted at disbursement
 * the bank sends the principal less its commission, and the company still owes
 * the principal. The form says both as the letter is typed, and
 * `loans.disburse` works the same two out again from the stored loan when the
 * money actually arrives.
 *
 * Which means there are two implementations of one rule, and the whole point of
 * them is that they agree. `commissionOf` / `netProceeds` are the server's
 * (`domain/loans.ts`); `commissionShare` / `landsInAccount` are the browser's,
 * duplicated because a client component does not import from `src/server`.
 *
 * The rounding is where they would part company: the commission goes to the
 * cent, half up, so a percentage that lands on half a cent has to round the
 * same way on both sides or the screen promises money the bank will not send.
 */
import { describe, expect, it } from 'vitest';
import { commissionOf, netProceeds } from '@/server/domain/loans';
import { commissionShare, landsInAccount } from '@/components/admin/loan-proceeds';

/** The money scale: 250,000.0000 as the books hold it. */
const money = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
};

const PRINCIPALS = [
  '1',
  '1000',
  '12500',
  '250000',
  '1000000',
  '1307000',
  '9199874.5',
  '0.0001',
] as const;

const PERCENTS = ['0.0001', '0.5', '1', '1.25', '2', '3.33', '20', '99.9999', '100'] as const;

describe('TR-02 · the loan form and the disbursement work out one commission', () => {
  it.each(PERCENTS)('agrees on every principal at %s per cent', (percent) => {
    for (const principal of PRINCIPALS) {
      expect(commissionShare(money(principal), money(percent))).toBe(
        commissionOf(money(principal), money(percent)),
      );
    }
  });

  it('agrees on the offer this was built for', () => {
    // A 250,000 dinar facility at 2%: 5,000 of commission.
    const principal = money('250000');
    const commission = commissionOf(principal, money('2'));
    expect(commissionShare(principal, money('2'))).toBe(commission);
    expect(commission).toBe(money('5000'));
  });

  it('rounds to the cent the same way, where the half-cent decides', () => {
    // Chosen so the raw product lands exactly on half a cent.
    const principal = money('1.005');
    for (const percent of ['50', '0.5', '33.3333'] as const) {
      expect(commissionShare(principal, money(percent))).toBe(commissionOf(principal, money(percent)));
    }
  });

  it('is exact where a double would not be', () => {
    const big = money('9199874.5');
    expect(commissionShare(big, money('3.33'))).toBe(commissionOf(big, money('3.33')));
  });
});

describe('TR-02 · what lands in the account', () => {
  it('is the principal less the commission when the bank keeps it', () => {
    const principal = money('250000');
    const commission = commissionOf(principal, money('2'));
    expect(landsInAccount(principal, commission, true)).toBe(netProceeds(principal, commission, true));
    expect(landsInAccount(principal, commission, true)).toBe(money('245000'));
  });

  it('is the whole principal when the commission is paid separately', () => {
    const principal = money('250000');
    const commission = commissionOf(principal, money('2'));
    expect(landsInAccount(principal, commission, false)).toBe(netProceeds(principal, commission, false));
    expect(landsInAccount(principal, commission, false)).toBe(principal);
  });

  it('agrees with the server across the offers a bank might write', () => {
    for (const principal of PRINCIPALS) {
      for (const percent of PERCENTS) {
        for (const deducted of [true, false]) {
          const commission = commissionOf(money(principal), money(percent));
          expect(landsInAccount(money(principal), commission, deducted)).toBe(
            netProceeds(money(principal), commission, deducted),
          );
        }
      }
    }
  });
});
