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
import { advanceInCurrency, advanceOf, advanceShareOf, advanceTxnFor, invoiceAdvance } from '@/server/domain/payment-applications';

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

describe('AP-15 · the advance in the import\u2019s own currency (2026-10-06)', () => {
  it('an import in dinars is asked for the dinars as they are', () => {
    expect(advanceInCurrency(iqd('53144'), 'IQD', null, null)).toBe(iqd('53144'));
    // Agreed in dollars, import in dinars: the import is paid in dinars.
    expect(advanceInCurrency(iqd('53144'), 'IQD', 'USD', '1310.00000000')).toBe(iqd('53144'));
  });

  it('an import in dollars is asked for the supplier\u2019s own figure, back at the rate on the invoice', () => {
    // USD 1,000 at 1,310 = IQD 1,310,000; 20% = IQD 262,000 = USD 200.
    expect(advanceInCurrency(iqd('262000'), 'USD', 'USD', '1310.00000000')).toBe(iqd('200'));
    // The Shenzhen invoice: USD 265,720 × 20% = USD 53,144 — through dinars and back, to the cent.
    expect(advanceInCurrency(advanceOf(iqd('265720') * 1310n, '20')!, 'USD', 'USD', '1310')).toBe(iqd('53144'));
    // A rate with decimals: USD 123.45 × 20% = 24.69.
    const dinars = advanceOf(iqd('123.45') * 130950000000n / 100000000n, '20')!;
    expect(advanceInCurrency(dinars, 'USD', 'USD', '1309.5')).toBe(iqd('24.69'));
  });

  it('is to the cent, half up', () => {
    // IQD 1,000 at 1,310 per dollar = USD 0.763358… → 0.76.
    expect(advanceInCurrency(iqd('1000'), 'USD', 'USD', '1310')).toBe(iqd('0.76'));
    // IQD 6.55 at 1,310 = USD 0.005 exactly → 0.01.
    expect(advanceInCurrency(iqd('6.55'), 'USD', 'USD', '1310')).toBe(iqd('0.01'));
    // Less than half a cent is nothing to ask a bank for.
    expect(advanceInCurrency(iqd('6'), 'USD', 'USD', '1310')).toBeNull();
  });

  it('chooses no rate: an invoice that does not say what the import is in is left to the accountant', () => {
    // Typed in dinars against an import in dollars.
    expect(advanceInCurrency(iqd('262000'), 'USD', null, null)).toBeNull();
    // Agreed in a third currency.
    expect(advanceInCurrency(iqd('262000'), 'USD', 'EUR', '1500')).toBeNull();
    // Agreed in dollars but no rate written down.
    expect(advanceInCurrency(iqd('262000'), 'USD', 'USD', null)).toBeNull();
    expect(advanceInCurrency(iqd('262000'), 'USD', 'USD', '0')).toBeNull();
    expect(advanceInCurrency(iqd('262000'), 'USD', 'USD', 'abc')).toBeNull();
    expect(advanceInCurrency(0n, 'USD', 'USD', '1310')).toBeNull();
  });
});

/*
 * 0411 (2026-10-06, by direction): "choose percentage select or amount … never
 * more than 100 percent … total amount − payable amount". No share is preset
 * any more ("what is 20 percentage? … any percentage"); the figures below are
 * typed values, not defaults.
 */
describe('AP-15 · the advance by percentage or by amount (`invoiceAdvance`)', () => {
  it('by percentage: the share of the total, as `advanceOf` takes it, and what is left', () => {
    const advance = invoiceAdvance({ totalIqd: iqd('1000000'), basis: 'percent', percent: '35', amount: null })!;
    expect(advance).toEqual({ basis: 'percent', iqd: iqd('350000'), currency: 'IQD', agreed: iqd('350000'), totalAgreed: iqd('1000000') });
    expect(advanceShareOf(advance)).toBe('35');
    // An invoice written before 0411 carries only its percentage: it is a percentage advance.
    expect(invoiceAdvance({ totalIqd: iqd('1000000'), basis: null, percent: '35', amount: null })?.iqd).toBe(iqd('350000'));
  });

  it('by amount: exactly the amount written, its share of the total, and in a foreign currency its dinars at the agreed rate', () => {
    const dinars = invoiceAdvance({ totalIqd: iqd('1000000'), basis: 'amount', percent: null, amount: '125000' })!;
    expect(dinars).toMatchObject({ basis: 'amount', iqd: iqd('125000'), agreed: iqd('125000'), currency: 'IQD' });
    expect(advanceShareOf(dinars)).toBe('12.5');
    // USD 1,000 of goods at 1,310 = IQD 1,310,000; USD 333.33 asked in front.
    const dollars = invoiceAdvance({ totalIqd: iqd('1310000'), basis: 'amount', percent: null, amount: '333.33', agreedCurrency: 'USD', agreedRate: '1310.00000000' })!;
    expect(dollars).toMatchObject({ currency: 'USD', agreed: iqd('333.33'), totalAgreed: iqd('1000'), iqd: iqd('436662.3') });
    expect(advanceShareOf(dollars)).toBe('33.33');
    // What the bank is asked for: the amount itself in the import's currency, the dinars for a dinar import, none across currencies.
    expect(advanceTxnFor(dollars, 'USD')).toBe(iqd('333.33'));
    expect(advanceTxnFor(dollars, 'IQD')).toBe(iqd('436662.3'));
    expect(advanceTxnFor(dollars, 'EUR')).toBeNull();
    expect(advanceTxnFor(dinars, 'USD')).toBeNull();
  });

  it('never more than the invoice: an amount above the total, or a percentage above a hundred, is refused', () => {
    expect(() => invoiceAdvance({ totalIqd: iqd('1000'), basis: 'amount', percent: null, amount: '1000.0001' })).toThrow(/cannot be more than the invoice/);
    expect(invoiceAdvance({ totalIqd: iqd('1000'), basis: 'amount', percent: null, amount: '1000' })?.agreed).toBe(iqd('1000'));
    expect(() => invoiceAdvance({ totalIqd: iqd('1000'), basis: 'percent', percent: '100.01', amount: null })).toThrow(/100%/);
    // USD 1,000 exactly, against the dinars it was converted to: equal, not over.
    expect(invoiceAdvance({ totalIqd: iqd('1310000'), basis: 'amount', percent: null, amount: '1000', agreedCurrency: 'USD', agreedRate: '1310' })?.iqd).toBe(iqd('1310000'));
  });

  it('is nothing to ask for when nothing is written, nought is written, or the invoice totals nothing', () => {
    expect(invoiceAdvance({ totalIqd: iqd('1000'), basis: 'amount', percent: null, amount: '' })).toBeNull();
    expect(invoiceAdvance({ totalIqd: iqd('1000'), basis: 'amount', percent: null, amount: '0' })).toBeNull();
    expect(invoiceAdvance({ totalIqd: iqd('1000'), basis: 'percent', percent: '', amount: null })).toBeNull();
    expect(invoiceAdvance({ totalIqd: 0n, basis: 'amount', percent: null, amount: '10' })).toBeNull();
    expect(invoiceAdvance({ totalIqd: iqd('1000'), basis: null, percent: null, amount: null })).toBeNull();
  });
});
