/**
 * §8.4 — *"Three-Way Matching is mandatory. Quantity, price and value variances
 * are allowed only after manager approval."*
 *
 * The arithmetic of the match, tested where it decides whether a manager is
 * asked. Every case here is one an accounts-payable clerk meets in a week.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_TOLERANCE,
  MatchInputError,
  canInvoice,
  describeVariance,
  matchDocument,
  matchLine,
  type MatchLineInput,
} from '@domain/three-way-match';

/** Quantities carry six decimal places. */
const q = (n: string) => {
  const [whole = '0', fraction = ''] = n.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
};

/** Money carries four. */
const m = (n: string) => {
  const [whole = '0', fraction = ''] = n.split('.');
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
};

const line = (overrides: Partial<MatchLineInput> = {}): MatchLineInput => ({
  ordered: { quantity: q('100'), unitPriceIqd: m('10') },
  received: { quantity: q('100') },
  invoiced: { quantity: q('100'), unitPriceIqd: m('10') },
  ...overrides,
});

describe('§8.4 · a clean match', () => {
  it('matches when all three documents agree', () => {
    const result = matchLine(line());
    expect(result.status).toBe('matched');
    expect(result.variances).toHaveLength(0);
    expect(result.varianceValueIqd).toBe(0n);
  });

  it('matches a part delivery invoiced for exactly what arrived', () => {
    // The commonest legitimate case: 100 ordered, 40 delivered, 40 invoiced.
    // Nothing is wrong here, and an implementation that matched the invoice
    // against the *order* would raise an exception on every partial delivery.
    const result = matchLine(
      line({ received: { quantity: q('40') }, invoiced: { quantity: q('40'), unitPriceIqd: m('10') } }),
    );
    expect(result.status).toBe('matched');
  });

  it('matches an exact-decimal price that no float could hold', () => {
    const result = matchLine(
      line({
        ordered: { quantity: q('3'), unitPriceIqd: m('33.3333') },
        received: { quantity: q('3') },
        invoiced: { quantity: q('3'), unitPriceIqd: m('33.3333') },
      }),
    );
    // 3 × 33.3333 = 99.9999 exactly. A zero tolerance is only a workable rule
    // because the arithmetic is exact.
    expect(result.status).toBe('matched');
  });
});

describe('§8.4 · quantity variance', () => {
  it('catches an invoice for the whole order against a part delivery', () => {
    const result = matchLine(line({ received: { quantity: q('40') } }));

    expect(result.status).toBe('exception');
    const quantity = result.variances.find((v) => v.kind === 'quantity');
    expect(quantity?.expected).toBe(q('40'));
    expect(quantity?.actual).toBe(q('100'));
    expect(quantity?.difference).toBe(q('60'));
    // 60 more than 40 is 150% over.
    expect(quantity?.percent).toBe(1_500_000n);
  });

  it('treats a partial invoice as ordinary, not as an exception', () => {
    const result = matchLine(line({ invoiced: { quantity: q('90'), unitPriceIqd: m('10') } }));

    // 100 delivered, 90 billed, 10 still to come. Raising an exception here
    // would put a manager in front of every second invoice and teach them to
    // approve without reading. The unbilled balance stays visible in GRNI,
    // which is exactly what that account is for.
    expect(result.status).toBe('matched');
    expect(result.varianceValueIqd).toBe(0n);
  });

  it('adds up across invoices, so the third partial bill is caught', () => {
    // Two invoices of 40 already posted against a delivery of 100. A third of
    // 40 takes the total to 120, and no single one of the three looks wrong.
    const result = matchLine(
      line({
        invoiced: { quantity: q('40'), unitPriceIqd: m('10') },
        alreadyInvoiced: q('80'),
      }),
    );

    expect(result.status).toBe('exception');
    const quantity = result.variances.find((v) => v.kind === 'quantity');
    expect(quantity?.expected).toBe(q('100'));
    expect(quantity?.actual).toBe(q('120'));
  });

  it('lets the second partial invoice through when it fits', () => {
    const result = matchLine(
      line({
        invoiced: { quantity: q('40'), unitPriceIqd: m('10') },
        alreadyInvoiced: q('60'),
      }),
    );
    expect(result.status).toBe('matched');
  });

  it('absorbs an over-invoice inside a configured tolerance', () => {
    const result = matchLine(
      line({
        invoiced: { quantity: q('102'), unitPriceIqd: m('10') },
        tolerance: { ...NO_TOLERANCE, quantityPercent: '5', valuePercent: '5' },
      }),
    );
    expect(result.status).toBe('matched');
    // Absorbed, not erased: the variance is still reported so a report can show
    // what the tolerance let through.
    expect(result.allVariances.some((v) => v.kind === 'quantity')).toBe(true);
  });

  it('still catches an over-invoice past the tolerance', () => {
    const result = matchLine(
      line({
        invoiced: { quantity: q('106'), unitPriceIqd: m('10') },
        tolerance: { ...NO_TOLERANCE, quantityPercent: '5', valuePercent: '5' },
      }),
    );
    expect(result.status).toBe('exception');
  });
});

describe('§8.4 · price variance', () => {
  it('compares against the order, never against the receipt', () => {
    const result = matchLine(line({ invoiced: { quantity: q('100'), unitPriceIqd: m('11') } }));

    const price = result.variances.find((v) => v.kind === 'price');
    expect(price?.expected).toBe(m('10'));
    expect(price?.actual).toBe(m('11'));
    expect(price?.percent).toBe(100_000n); // 10%
    expect(result.status).toBe('exception');
  });

  it('catches a price rise of one fils on a large order', () => {
    const result = matchLine(
      line({
        ordered: { quantity: q('100000'), unitPriceIqd: m('1.0000') },
        received: { quantity: q('100000') },
        invoiced: { quantity: q('100000'), unitPriceIqd: m('1.0001') },
      }),
    );

    // A hundredth of a percent on the unit price is ten dinars on the line —
    // invisible per unit and real in the ledger.
    expect(result.status).toBe('exception');
    expect(result.varianceValueIqd).toBe(m('10'));
  });

  it('reports a price *fall* as a variance too', () => {
    const result = matchLine(line({ invoiced: { quantity: q('100'), unitPriceIqd: m('9') } }));
    // Confirm the lower price is intended: a supplier who under-charges by
    // mistake will send a correction, and the company should not have posted
    // the wrong cost in the meantime.
    expect(result.status).toBe('exception');
    expect(result.variances.find((v) => v.kind === 'price')?.difference).toBe(-m('1'));
  });
});

describe('§8.4 · value variance', () => {
  it('is the money at stake, not a restatement of the causes', () => {
    // 40 received, invoiced 100 at the agreed price: the quantity is wrong and
    // the price is right, and the money is 600 dinars.
    const result = matchLine(line({ received: { quantity: q('40') } }));
    expect(result.varianceValueIqd).toBe(m('600'));
  });

  it('bills a partial delivery at the wrong price — quantity fine, money not', () => {
    // 110 delivered, 100 billed at 9 against an agreed 10. The quantity is
    // ordinary (the balance is still to come); the price is not, and the
    // hundred dinars is what a manager has to decide about.
    const result = matchLine(
      line({
        received: { quantity: q('110') },
        invoiced: { quantity: q('100'), unitPriceIqd: m('9') },
      }),
    );

    expect(result.variances.map((v) => v.kind).sort()).toEqual(['price', 'value']);
    expect(result.varianceValueIqd).toBe(m('900') - m('1000'));
  });

  it('measures the money against what this invoice may charge, not the whole delivery', () => {
    // 100 delivered, 40 billed at the agreed price. Comparing against the whole
    // delivery would report a 600-dinar shortfall that does not exist — the
    // rest is still owed and still sitting in GRNI.
    const result = matchLine(
      line({ received: { quantity: q('100') }, invoiced: { quantity: q('40'), unitPriceIqd: m('10') } }),
    );
    expect(result.varianceValueIqd).toBe(0n);
  });

  it('is zero when quantity and price both agree', () => {
    expect(matchLine(line()).varianceValueIqd).toBe(0n);
  });

  it('carries the money even when tolerance absorbed the variance', () => {
    const result = matchLine(
      line({
        invoiced: { quantity: q('100'), unitPriceIqd: m('10.5') },
        tolerance: { ...NO_TOLERANCE, pricePercent: '10', valuePercent: '10' },
      }),
    );

    // A tolerance decides whether a manager is asked. It never decides whether
    // the money exists — 50 dinars still has to post somewhere.
    expect(result.status).toBe('matched');
    expect(result.varianceValueIqd).toBe(m('50'));
  });
});

describe('§8.4 · the mandatory half — no receipt, no invoice', () => {
  it('says a line with nothing received cannot be invoiced', () => {
    expect(canInvoice({ quantity: 0n })).toBe(false);
    expect(canInvoice({ quantity: q('0.000001') })).toBe(true);
  });

  it('refuses to match an invoice line for nothing', () => {
    expect(() => matchLine(line({ invoiced: { quantity: 0n, unitPriceIqd: m('10') } }))).toThrow(
      MatchInputError,
    );
  });

  it('refuses a negative tolerance, and says why', () => {
    expect(() =>
      matchLine(line({ tolerance: { ...NO_TOLERANCE, pricePercent: '-5' } })),
    ).toThrow(/Under-invoicing needs no tolerance/);
  });
});

describe('§8.4 · the document is what gets approved', () => {
  it('is Matched only when every line is', () => {
    const clean = matchLine(line());
    const broken = matchLine(line({ received: { quantity: q('40') } }));

    expect(matchDocument([clean, clean]).status).toBe('matched');
    expect(matchDocument([clean, broken]).status).toBe('exception');
    expect(matchDocument([clean, broken]).exceptionCount).toBe(1);
  });

  it('totals the money across lines', () => {
    const first = matchLine(line({ received: { quantity: q('40') } }));
    const second = matchLine(line({ invoiced: { quantity: q('100'), unitPriceIqd: m('11') } }));

    expect(matchDocument([first, second]).varianceValueIqd).toBe(m('600') + m('100'));
  });

  it('matches an empty document — nothing to disagree about', () => {
    expect(matchDocument([]).status).toBe('matched');
  });
});

describe('§25 · the message names the correction', () => {
  it('tells the clerk what an over-billed quantity usually means', () => {
    const result = matchLine(line({ received: { quantity: q('40') } }));
    const quantity = result.variances.find((v) => v.kind === 'quantity')!;
    expect(describeVariance(quantity)).toMatch(/invoiced the whole order/);
  });

  it('asks the clerk to confirm a price that came in lower than agreed', () => {
    const result = matchLine(line({ invoiced: { quantity: q('100'), unitPriceIqd: m('9') } }));
    const price = result.variances.find((v) => v.kind === 'price')!;
    // A supplier who under-charges by mistake sends a correction, and the
    // company should not have posted the wrong cost in the meantime.
    expect(describeVariance(price)).toMatch(/Confirm the lower price is intended/);
  });

  it('offers the two ways out of a price variance', () => {
    const result = matchLine(line({ invoiced: { quantity: q('100'), unitPriceIqd: m('11') } }));
    const price = result.variances.find((v) => v.kind === 'price')!;
    expect(describeVariance(price)).toMatch(/order is varied|correct the invoice/);
  });

  it('says where the value variance will post', () => {
    const result = matchLine(line({ received: { quantity: q('40') } }));
    const value = result.variances.find((v) => v.kind === 'value')!;
    expect(describeVariance(value)).toMatch(/variance account/);
  });
});
