/**
 * Phase 00.5 — money primitive.
 *
 * Proves TECHSTACK.md A4 in the domain layer: exact decimal arithmetic, the
 * four-part tuple, and the rate-direction rule.
 */
import { describe, expect, it } from 'vitest';
import {
  add,
  balancesInIqd,
  fromForeign,
  fromIqd,
  negate,
  parseDecimal,
  rate,
  toDecimalString,
} from '@domain/money';

describe('exact decimal arithmetic', () => {
  it('does not drift where IEEE-754 would', () => {
    // 0.1 + 0.2 !== 0.3 in floating point. Here it must be exact.
    const r = rate('1310.00000000');
    const a = fromIqd('0.1000', r);
    const b = fromIqd('0.2000', r);
    expect(toDecimalString(add(a, b).amountIqd)).toBe('0.3000');
  });

  it('shows zero drift over 10,000 repeated additions', () => {
    // Phase 02.3 test gate: "a repeated-addition test over 10,000 rows shows
    // zero drift".
    const r = rate('1310.00000000');
    const cent = fromIqd('0.0100', r);
    let total = fromIqd('0.0000', r);
    for (let i = 0; i < 10_000; i++) total = add(total, cent);
    expect(toDecimalString(total.amountIqd)).toBe('100.0000');
  });

  it('rejects more precision than the scale permits rather than truncating', () => {
    expect(() => parseDecimal('1.234567', 4n)).toThrow(/more than the 4 permitted/);
  });
});

describe('rate direction', () => {
  it('stores IQD per USD, preserving precision', () => {
    // The inverse (0.000763 USD per IQD) would round to 0.0008 at 4dp —
    // a ~5% error on every reporting figure. Direction is fixed by construction.
    const r = rate('1310.50000000');
    expect(toDecimalString(r.iqdPerUsd, 8n)).toBe('1310.50000000');
  });

  it('rejects a non-positive rate', () => {
    expect(() => rate('0')).toThrow(/must be positive/);
    expect(() => rate('-1310')).toThrow();
  });
});

describe('the four-part tuple (§24)', () => {
  it('derives USD from IQD at the historical rate', () => {
    const r = rate('1310.00000000');
    const m = fromIqd('1310.0000', r);
    expect(m.currency).toBe('IQD');
    expect(toDecimalString(m.amountIqd)).toBe('1310.0000');
    expect(toDecimalString(m.amountUsd)).toBe('1.0000');
    expect(m.rate).toBe(r);
  });

  it('rounds half-up so a reviewer reproduces it by hand', () => {
    const r = rate('1310.00000000');
    // 1000 IQD / 1310 = 0.76335877… → 0.7634 at 4dp
    expect(toDecimalString(fromIqd('1000.0000', r).amountUsd)).toBe('0.7634');
  });

  it('keeps the transaction currency separate from the ledger amount', () => {
    // §14.3: USD "does not replace IQD ledger values".
    const r = rate('1310.00000000');
    const m = fromForeign('100.0000', 'EUR', '143000.0000', r);
    expect(m.currency).toBe('EUR');
    expect(toDecimalString(m.amountTxn)).toBe('100.0000');
    expect(toDecimalString(m.amountIqd)).toBe('143000.0000');
  });

  it('refuses to add mixed currencies', () => {
    const r = rate('1310.00000000');
    const iqd = fromIqd('100.0000', r);
    const eur = fromForeign('100.0000', 'EUR', '143000.0000', r);
    expect(() => add(iqd, eur)).toThrow(/Cannot add/);
  });
});

describe('journal balancing (§14.3)', () => {
  it('accepts a journal that nets to zero in IQD', () => {
    const r = rate('1310.00000000');
    const debit = fromIqd('500.0000', r);
    expect(balancesInIqd([debit, negate(debit)])).toBe(true);
  });

  it('rejects a journal that does not', () => {
    const r = rate('1310.00000000');
    expect(balancesInIqd([fromIqd('500.0000', r), fromIqd('-499.9999', r)])).toBe(false);
  });

  it('balances in IQD even when USD equivalents do not sum to zero', () => {
    // Two lines converted at different historical rates can round differently
    // in USD. IQD is the balancing currency; USD is presentation only.
    const debit = fromIqd('1000.0000', rate('1310.00000000'));
    const credit = negate(fromIqd('1000.0000', rate('1315.00000000')));
    expect(balancesInIqd([debit, credit])).toBe(true);
  });
});
