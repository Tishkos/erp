/**
 * Phase 02.3 test gate — rate selection and the arithmetic it feeds.
 *
 * The "rate cannot be edited inside Journal Entry" and "a reprint reproduces"
 * assertions need a database and are in
 * tests/integration/phase02-periods-rates.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  NoRateForDateError,
  RATE_TYPES,
  RateNotEditableError,
  assertCurrencyUsable,
  assertRateNotSupplied,
  parseRate,
  rateOn,
  type PublishedRate,
} from '@domain/exchange-rates';
import { MONEY_SCALE, parseDecimal, toDecimalString, toIqd, toUsd } from '@domain/money';

const rate = (overrides: Partial<PublishedRate> = {}): PublishedRate => ({
  currency: 'USD',
  rateType: 'accounting',
  iqdPerUnit: parseRate('1310.00000000'),
  effectiveFrom: '2026-01-01',
  source: 'Central Bank',
  ...overrides,
});

describe('§4.3 · rate types', () => {
  it('are the three the blueprint lists', () => {
    expect(RATE_TYPES).toEqual(['accounting', 'market', 'client']);
  });
});

describe('the rate in force on a date', () => {
  const rates = [
    rate({ effectiveFrom: '2026-01-01', iqdPerUnit: parseRate('1310.00000000') }),
    rate({ effectiveFrom: '2026-03-01', iqdPerUnit: parseRate('1320.00000000') }),
    rate({ effectiveFrom: '2026-06-01', iqdPerUnit: parseRate('1330.00000000') }),
  ];

  it('is the latest one effective on or before the date', () => {
    expect(rateOn(rates, 'USD', 'accounting', '2026-04-15').effectiveFrom).toBe('2026-03-01');
  });

  it('includes the effective date itself', () => {
    expect(rateOn(rates, 'USD', 'accounting', '2026-03-01').effectiveFrom).toBe('2026-03-01');
  });

  it('is not affected by a rate published later', () => {
    // 02.3 gate: "Re-running a report for a past period reproduces the same USD
    // figures it produced originally." A June rate must not touch March.
    const inMarch = rateOn(rates.slice(0, 2), 'USD', 'accounting', '2026-03-15');
    const afterJuneWasPublished = rateOn(rates, 'USD', 'accounting', '2026-03-15');
    expect(afterJuneWasPublished.iqdPerUnit).toBe(inMarch.iqdPerUnit);
  });

  it('refuses a date before any rate exists, rather than guessing', () => {
    expect(() => rateOn(rates, 'USD', 'accounting', '2025-12-31')).toThrow(NoRateForDateError);
    expect(() => rateOn(rates, 'USD', 'accounting', '2025-12-31')).toThrow(
      /Rates are maintained in the Finance Exchange Rate section/,
    );
  });

  it('does not mix rate types', () => {
    const withMarket = [...rates, rate({ rateType: 'market', iqdPerUnit: parseRate('1400') })];
    expect(rateOn(withMarket, 'USD', 'accounting', '2026-08-01').iqdPerUnit).toBe(
      parseRate('1330'),
    );
    expect(rateOn(withMarket, 'USD', 'market', '2026-08-01').iqdPerUnit).toBe(parseRate('1400'));
  });

  it('does not mix currencies', () => {
    const withEur = [...rates, rate({ currency: 'EUR', iqdPerUnit: parseRate('1450') })];
    expect(rateOn(withEur, 'EUR', 'accounting', '2026-08-01').iqdPerUnit).toBe(parseRate('1450'));
  });
});

describe('§14.3 · the rate is never supplied by the document', () => {
  it('refuses a payload that carries a rate under any of its names', () => {
    for (const field of ['rate', 'exchangeRate', 'exchange_rate', 'iqdPerUnit', 'iqd_per_unit']) {
      expect(() => assertRateNotSupplied({ amount: '100', [field]: '1310' }), field).toThrow(
        RateNotEditableError,
      );
    }
  });

  it('accepts a payload that carries only a date and an amount', () => {
    expect(() =>
      assertRateNotSupplied({ amount: '100', currency: 'USD', postingDate: '2026-08-16' }),
    ).not.toThrow();
  });

  it('refuses a non-positive rate at parse time', () => {
    expect(() => parseRate('0')).toThrow(RangeError);
    expect(() => parseRate('-1310')).toThrow(RangeError);
  });

  it('keeps eight decimal places on a rate', () => {
    expect(parseRate('1310.12345678')).toBe(131012345678n);
  });
});

describe('converting at a rate (§1.1, §24)', () => {
  const usd = parseRate('1310.00000000');

  it('converts a foreign amount into IQD', () => {
    const hundredUsd = parseDecimal('100.0000', MONEY_SCALE);
    expect(toDecimalString(toIqd(hundredUsd, usd))).toBe('131000.0000');
  });

  it('converts IQD to itself at a rate of one', () => {
    const amount = parseDecimal('131000.0000', MONEY_SCALE);
    expect(toIqd(amount, parseRate('1'))).toBe(amount);
  });

  it('derives the USD reporting equivalent from the IQD amount', () => {
    const iqd = parseDecimal('131000.0000', MONEY_SCALE);
    expect(toDecimalString(toUsd(iqd, usd))).toBe('100.0000');
  });

  it('rounds half-up, the way a reviewer would by hand', () => {
    // 1 IQD at 1310 = 0.00076335… USD, which is 0.0008 at four places.
    const oneIqd = parseDecimal('1.0000', MONEY_SCALE);
    expect(toDecimalString(toUsd(oneIqd, usd))).toBe('0.0008');
  });

  it('holds the round trip stable for exact values', () => {
    const iqd = parseDecimal('1310.0000', MONEY_SCALE);
    const usdAmount = toUsd(iqd, usd);
    expect(toDecimalString(usdAmount)).toBe('1.0000');
    expect(toDecimalString(toIqd(usdAmount, usd))).toBe('1310.0000');
  });

  it('shows zero drift over ten thousand conversions', () => {
    // 02.3 gate: "Money arithmetic uses exact decimals — a repeated-addition
    // test over 10,000 rows shows zero drift."
    const line = parseDecimal('1234.5678', MONEY_SCALE);
    let total = 0n;
    for (let i = 0; i < 10_000; i++) total += toIqd(line, parseRate('1310'));

    // Ten thousand conversions sum to exactly ten thousand times one of them.
    expect(toDecimalString(total)).toBe(toDecimalString(toIqd(line, parseRate('1310')) * 10_000n));
    // And to the figure worked out by hand: 1234.5678 × 1310 = 1,617,283.818.
    expect(toDecimalString(total)).toBe('16172838180.0000');
  });

  it('refuses a non-positive rate at conversion time too', () => {
    expect(() => toIqd(1000n, 0n)).toThrow(RangeError);
    expect(() => toUsd(1000n, -1n)).toThrow(RangeError);
  });
});

describe('the currency master', () => {
  it('refuses an inactive currency', () => {
    expect(() =>
      assertCurrencyUsable({
        code: 'EUR',
        name: 'Euro',
        decimals: 2,
        isLedger: false,
        isActive: false,
      }),
    ).toThrow(/it is inactive/);
  });

  it('accepts an active one', () => {
    expect(() =>
      assertCurrencyUsable({
        code: 'IQD',
        name: 'Iraqi Dinar',
        decimals: 0,
        isLedger: true,
        isActive: true,
      }),
    ).not.toThrow();
  });
});
