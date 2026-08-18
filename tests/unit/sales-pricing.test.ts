/**
 * §7.3 — sales line pricing and discount.
 *
 * The price is not tested for being *un-editable* here, because it is not a
 * field: `PricedLine` takes a price the caller resolved from the price list, and
 * the sales-order input type has no price at all. That is proved where the
 * service is, in the integration gate. What is tested here is the arithmetic of
 * the one negotiable thing §7.3 allows — the line discount.
 */
import { describe, expect, it } from 'vitest';
import {
  SalesDiscountError,
  documentTotals,
  grossOf,
  totalsFor,
} from '@domain/sales-pricing';

const qty = (n: string) => {
  const [whole = '0', fraction = ''] = n.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
};
const m = (n: string) => {
  const [whole = '0', fraction = ''] = n.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
};
/** A percentage, scaled at four places. */
const pct = (n: string) => m(n);

describe('§7.3 · what a line comes to', () => {
  it('multiplies quantity by the price-list price', () => {
    expect(grossOf(qty('12'), m('2500'))).toBe(m('30000'));
  });

  it('holds a fractional quantity exactly', () => {
    // 2.5 metres at 1,333.3333 is 3,333.33325 — truncated to the money scale.
    expect(grossOf(qty('2.5'), m('1333.3333'))).toBe(m('3333.3332'));
  });

  it('charges the gross when there is no discount', () => {
    const totals = totalsFor({ quantity: qty('10'), unitPriceIqd: m('100') });
    expect(totals.grossIqd).toBe(m('1000'));
    expect(totals.discountIqd).toBe(0n);
    expect(totals.netIqd).toBe(m('1000'));
    expect(totals.netUnitPriceIqd).toBe(m('100'));
  });
});

describe('§7.3 · a discount percentage', () => {
  it('takes the stated percentage off the line', () => {
    const totals = totalsFor({
      quantity: qty('10'),
      unitPriceIqd: m('100'),
      discount: { percent: pct('12.5') },
    });

    expect(totals.discountIqd).toBe(m('125'));
    expect(totals.netIqd).toBe(m('875'));
    expect(totals.netUnitPriceIqd).toBe(m('87.5'));
  });

  it('handles a percentage that does not divide evenly', () => {
    // 3 × 33.3333 = 99.9999; a third off is 33.3333.
    const totals = totalsFor({
      quantity: qty('3'),
      unitPriceIqd: m('33.3333'),
      discount: { percent: pct('33.3333') },
    });
    expect(totals.grossIqd).toBe(m('99.9999'));
    expect(totals.netIqd).toBe(totals.grossIqd - totals.discountIqd);
  });

  it('allows a full hundred per cent — a free-of-charge line', () => {
    const totals = totalsFor({
      quantity: qty('1'),
      unitPriceIqd: m('500'),
      discount: { percent: pct('100') },
    });
    expect(totals.netIqd).toBe(0n);
  });

  it('refuses more than a hundred per cent', () => {
    expect(() =>
      totalsFor({
        quantity: qty('1'),
        unitPriceIqd: m('500'),
        discount: { percent: pct('120') },
      }),
    ).toThrow(/pay the customer to buy/);
  });

  it('refuses a negative percentage, because that is a price change', () => {
    expect(() =>
      totalsFor({ quantity: qty('1'), unitPriceIqd: m('500'), discount: { percent: -pct('5') } }),
    ).toThrow(/the price list is what changes/);
  });
});

describe('§7.3 · a discount amount', () => {
  it('takes the stated amount off the line', () => {
    const totals = totalsFor({
      quantity: qty('10'),
      unitPriceIqd: m('100'),
      discount: { amountIqd: m('150') },
    });
    expect(totals.netIqd).toBe(m('850'));
  });

  it('allows an amount equal to the line', () => {
    const totals = totalsFor({
      quantity: qty('10'),
      unitPriceIqd: m('100'),
      discount: { amountIqd: m('1000') },
    });
    expect(totals.netIqd).toBe(0n);
  });

  it('refuses an amount larger than the line rather than clamping it', () => {
    // The realistic mistake: 15 typed into the amount field meaning 15%. A
    // clamped discount turns that into a free line silently.
    expect(() =>
      totalsFor({
        quantity: qty('10'),
        unitPriceIqd: m('100'),
        discount: { amountIqd: m('1500') },
      }),
    ).toThrow(/a percentage has been typed into the amount field/);
  });

  it('refuses a negative amount', () => {
    expect(() =>
      totalsFor({ quantity: qty('10'), unitPriceIqd: m('100'), discount: { amountIqd: -m('10') } }),
    ).toThrow(SalesDiscountError);
  });
});

describe('§7.3 · a percentage and an amount are not both allowed', () => {
  it('refuses the pair, and says why', () => {
    expect(() =>
      totalsFor({
        quantity: qty('10'),
        unitPriceIqd: m('100'),
        discount: { percent: pct('10'), amountIqd: m('50') },
      }),
    ).toThrow(/the order of application undecided/);
  });

  it('treats a zero alongside a real one as no clash', () => {
    // A screen that always sends both fields, one of them empty, must not be
    // refused for it.
    const totals = totalsFor({
      quantity: qty('10'),
      unitPriceIqd: m('100'),
      discount: { percent: pct('10'), amountIqd: 0n },
    });
    expect(totals.netIqd).toBe(m('900'));
  });
});

describe('§7.3 · refusing what cannot be priced', () => {
  it('refuses a line with no quantity', () => {
    expect(() => totalsFor({ quantity: 0n, unitPriceIqd: m('100') })).toThrow(
      /nothing to price/,
    );
  });

  it('refuses a negative price', () => {
    expect(() => totalsFor({ quantity: qty('1'), unitPriceIqd: -m('1') })).toThrow(
      /not a price/,
    );
  });
});

describe('§7.3 · a document is the sum of its lines', () => {
  it('totals gross, discount and net across lines', () => {
    const totals = documentTotals([
      { quantity: qty('10'), unitPriceIqd: m('100'), discount: { percent: pct('10') } },
      { quantity: qty('5'), unitPriceIqd: m('200'), discount: { amountIqd: m('100') } },
      { quantity: qty('2'), unitPriceIqd: m('50') },
    ]);

    // 1,000 − 100 = 900; 1,000 − 100 = 900; 100 − 0 = 100.
    expect(totals.grossIqd).toBe(m('2100'));
    expect(totals.discountIqd).toBe(m('200'));
    expect(totals.netIqd).toBe(m('1900'));
  });

  it('is nothing for a document with no lines', () => {
    const totals = documentTotals([]);
    expect(totals.netIqd).toBe(0n);
    expect(totals.netUnitPriceIqd).toBe(0n);
  });

  it('carries one bad line up rather than quietly excluding it', () => {
    expect(() =>
      documentTotals([
        { quantity: qty('10'), unitPriceIqd: m('100') },
        { quantity: qty('10'), unitPriceIqd: m('100'), discount: { amountIqd: m('9999') } },
      ]),
    ).toThrow(SalesDiscountError);
  });
});
