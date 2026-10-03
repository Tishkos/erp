/**
 * The advance a purchase invoice is paid in front — §15.3, by direction
 * 2026-10-03: "if accountant writes 20 percentage of advances it
 * automatically takes 20 percent of the whole invoice".
 *
 * The figure this returns is shown beside the percentage on the form and asked
 * of the bank when the invoice posts, so the two can never disagree. These
 * hold it on the awkward cases: a percentage that does not divide, a
 * percentage with decimals of its own, and the several ways of meaning
 * "no advance".
 */
import { describe, expect, it } from 'vitest';
import { advanceOf } from '@/server/domain/payment-applications';

/** The money scale: 265,720.0000 as the books hold it. */
const iqd = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
};

describe('AP-15 · what 20 per cent of an invoice is', () => {
  it('takes a plain fifth of a round total', () => {
    // The Shenzhen invoice: USD 265,720 of goods, 20% in front.
    expect(advanceOf(iqd('265720'), '20')).toBe(iqd('53144'));
  });

  it('takes a fifth of a figure with fils in it', () => {
    expect(advanceOf(iqd('1234.5678'), '20')).toBe(iqd('246.9136'));
  });

  it('carries a percentage that has its own decimals', () => {
    expect(advanceOf(iqd('1000'), '20.5')).toBe(iqd('205'));
    expect(advanceOf(iqd('1000'), '33.3333')).toBe(iqd('333.333'));
  });

  it('rounds the share half-up on the last place rather than drifting', () => {
    // Exactly half a fils asked for: 0.005% of one dinar is 0.00005, which
    // rounds up to the fils the books can hold.
    expect(advanceOf(iqd('1'), '0.005')).toBe(1n);
    // Just under the half rounds away — and away from a fils is nothing, so
    // it is null rather than a request for no money.
    expect(advanceOf(iqd('1'), '0.004')).toBeNull();
  });

  it('asks for nothing when the share rounds away to nothing', () => {
    // A hundredth of a per cent of a small invoice is less than a fils.
    // Without this the bank would be asked to send zero — a request needing
    // an approval and a signature, for no money.
    expect(advanceOf(iqd('0.01'), '0.01')).toBeNull();
  });

  it('asks for the whole invoice at a hundred per cent', () => {
    expect(advanceOf(iqd('265720'), '100')).toBe(iqd('265720'));
  });

  it('raises nothing when there is nothing to raise', () => {
    // All four mean "no advance", and none of them means zero dinars asked
    // for — which is why null and not 0n.
    expect(advanceOf(iqd('265720'), null)).toBeNull();
    expect(advanceOf(iqd('265720'), undefined)).toBeNull();
    expect(advanceOf(iqd('265720'), '')).toBeNull();
    expect(advanceOf(iqd('265720'), '   ')).toBeNull();
    expect(advanceOf(iqd('265720'), '0')).toBeNull();
    expect(advanceOf(iqd('265720'), '0.0000')).toBeNull();
  });

  it('raises nothing against an invoice that totals nothing', () => {
    // An advance on nothing is nothing, however confident the percentage.
    expect(advanceOf(0n, '20')).toBeNull();
    expect(advanceOf(-1n, '20')).toBeNull();
  });

  it('refuses a percentage that is not a number, rather than guessing one', () => {
    // The same rule the invoice reader lives by: a hedge is not a figure.
    expect(advanceOf(iqd('1000'), 'twenty')).toBeNull();
    expect(advanceOf(iqd('1000'), '20%')).toBeNull();
    expect(advanceOf(iqd('1000'), '-20')).toBeNull();
    expect(advanceOf(iqd('1000'), '1e2')).toBeNull();
  });

  it('ignores a fifth decimal place in the percentage rather than refusing it', () => {
    // Nobody means the fifth decimal of a percent. Truncated, deliberately —
    // refusing the form over it would be worse than ignoring it. This is the
    // percentage being truncated, which is not the same thing as the share
    // being rounded, and conflating the two is how the first version of this
    // test came to assert something false.
    expect(advanceOf(iqd('1000'), '20.00001')).toBe(iqd('200'));
    expect(advanceOf(iqd('1'), '33.3335')).toBe(advanceOf(iqd('1'), '33.3333'));
  });

  it('is exact on a figure no double could hold', () => {
    // 9,199,874,500 IQD is a real supplier balance from the old books. A
    // double cannot hold its fils; bigints can, which is the whole reason
    // money is scaled integers here.
    expect(advanceOf(iqd('9199874500'), '20')).toBe(iqd('1839974900'));
  });
});
