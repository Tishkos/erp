/**
 * Phase 03.6 and 03.7 test gates — effective dating, due dates and instalments.
 */
import { describe, expect, it } from 'vitest';
import {
  CalendarDateError,
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  parseDate,
} from '@domain/dates';
import {
  NoEffectiveValueError,
  NoPriceError,
  PaymentTermsError,
  TaxAccountError,
  assertInstalmentsComplete,
  assertTaxAccountsDistinct,
  basisDateFor,
  dueDateFor,
  effectiveOn,
  instalmentSchedule,
  priceOn,
  taxRateOn,
  type PaymentTerms,
  type PriceEntry,
} from '@domain/payment-terms';

describe('calendar arithmetic (A10)', () => {
  it('refuses a date that does not exist rather than shifting it', () => {
    // `new Date('2026-02-31')` silently becomes 3 March. A due date computed
    // from a silent correction is a payment made on the wrong day.
    expect(() => parseDate('2026-02-31')).toThrow(CalendarDateError);
    expect(() => parseDate('2026-13-01')).toThrow(CalendarDateError);
    expect(() => parseDate('16/08/2026')).toThrow(CalendarDateError);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-08-16', 30)).toBe('2026-09-15');
    expect(addDays('2026-12-20', 15)).toBe('2027-01-04');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('subtracts days', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2027-01-04', -15)).toBe('2026-12-20');
  });

  it('adds months, clamping to the end of the target month', () => {
    // 31 January plus one month is 28 February, not 3 March.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-08-16', 6)).toBe('2027-02-16');
  });

  it('finds the end of a month', () => {
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-01')).toBe('2026-12-31');
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-08-16', '2026-09-15')).toBe(30);
    expect(daysBetween('2026-09-15', '2026-08-16')).toBe(-30);
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
  });
});

describe('§4.4 · effective dating', () => {
  const values = [
    { effectiveFrom: '2026-01-01', label: 'january' },
    { effectiveFrom: '2026-03-01', label: 'march' },
    { effectiveFrom: '2026-06-01', label: 'june' },
  ];

  it('takes the latest value effective on or before the date', () => {
    expect(effectiveOn(values, '2026-04-15').label).toBe('march');
    expect(effectiveOn(values, '2026-03-01').label).toBe('march');
  });

  it('is not affected by a value published later', () => {
    // Resolving by the document date is what makes a reprint reproduce.
    expect(effectiveOn(values.slice(0, 2), '2026-04-15').label).toBe(
      effectiveOn(values, '2026-04-15').label,
    );
  });

  it('refuses a date before anything is effective', () => {
    expect(() => effectiveOn(values, '2025-12-31')).toThrow(NoEffectiveValueError);
  });
});

describe('§7.3 · prices come from the price list', () => {
  const prices: PriceEntry[] = [
    { itemId: 'i-1', uomCode: 'EA', unitPrice: '1000.0000', effectiveFrom: '2026-01-01' },
    { itemId: 'i-1', uomCode: 'EA', unitPrice: '1200.0000', effectiveFrom: '2026-06-01' },
    { itemId: 'i-1', uomCode: 'BOX', unitPrice: '11000.0000', effectiveFrom: '2026-01-01' },
  ];

  it('resolves by the document date', () => {
    expect(priceOn(prices, 'i-1', 'EA', '2026-03-15').unitPrice).toBe('1000.0000');
    expect(priceOn(prices, 'i-1', 'EA', '2026-08-16').unitPrice).toBe('1200.0000');
  });

  it('prices each unit separately', () => {
    // A box and a piece are different prices; a list that priced only the base
    // unit would have every order doing arithmetic nobody could reproduce.
    expect(priceOn(prices, 'i-1', 'BOX', '2026-08-16').unitPrice).toBe('11000.0000');
  });

  it('is deterministic — the same partner, item and date always give the same price', () => {
    const first = priceOn(prices, 'i-1', 'EA', '2026-03-15');
    const second = priceOn(prices, 'i-1', 'EA', '2026-03-15');
    expect(second).toEqual(first);
  });

  it('refuses to invent a price', () => {
    expect(() => priceOn(prices, 'i-1', 'EA', '2025-01-01', 'ITEM-1')).toThrow(NoPriceError);
    expect(() => priceOn(prices, 'i-2', 'EA', '2026-08-16', 'ITEM-2')).toThrow(
      /cannot be typed on the order/,
    );
  });
});

describe('§4.3 · tax codes', () => {
  it('resolves a rate by the document date, not by today', () => {
    const rates = [
      { taxCode: 'VAT', ratePercent: '15', effectiveFrom: '2026-01-01' },
      { taxCode: 'VAT', ratePercent: '18', effectiveFrom: '2026-07-01' },
    ];
    expect(taxRateOn(rates, 'VAT', '2026-05-01').ratePercent).toBe('15');
    expect(taxRateOn(rates, 'VAT', '2026-08-16').ratePercent).toBe('18');
  });

  it('refuses one account serving recoverable and non-recoverable tax', () => {
    // Recoverable tax is an asset that is reclaimed; non-recoverable tax is a
    // cost. One account cannot be both, and the discovery would come at the
    // first tax return.
    expect(() =>
      assertTaxAccountsDistinct([
        { code: 'VAT-IN', isRecoverable: true, accountId: 'acc-1' },
        { code: 'VAT-NR', isRecoverable: false, accountId: 'acc-1' },
      ]),
    ).toThrow(TaxAccountError);
  });

  it('permits two codes of the same kind sharing an account', () => {
    expect(() =>
      assertTaxAccountsDistinct([
        { code: 'VAT-IN', isRecoverable: true, accountId: 'acc-1' },
        { code: 'VAT-IN-2', isRecoverable: true, accountId: 'acc-1' },
      ]),
    ).not.toThrow();
  });
});

describe('§16 · due dates and instalments', () => {
  const net30: PaymentTerms = {
    code: 'NET30',
    name: 'Net 30 days',
    basis: 'document_date',
    dueDays: 30,
    instalments: [],
  };

  const eom60: PaymentTerms = {
    code: 'EOM60',
    name: '60 days end of month',
    basis: 'end_of_month',
    dueDays: 60,
    instalments: [],
  };

  const thirds: PaymentTerms = {
    code: 'THIRDS',
    name: 'Three instalments',
    basis: 'document_date',
    dueDays: 0,
    instalments: [
      { sequence: 1, daysAfter: 0, percentage: '33.33' },
      { sequence: 2, daysAfter: 30, percentage: '33.33' },
      { sequence: 3, daysAfter: 60, percentage: '33.34' },
    ],
  };

  it('calculates a simple due date from the document date', () => {
    expect(dueDateFor(net30, '2026-08-16')).toBe('2026-09-15');
  });

  it('calculates an end-of-month term from the month end', () => {
    // "60 days end of month" counts from 31 August, not from 16 August.
    expect(basisDateFor(eom60, '2026-08-16')).toBe('2026-08-31');
    expect(dueDateFor(eom60, '2026-08-16')).toBe('2026-10-30');
  });

  it('schedules instalments on their own dates', () => {
    const schedule = instalmentSchedule(thirds, '2026-08-16', '3000.0000');

    expect(schedule.map((i) => i.dueDate)).toEqual([
      '2026-08-16',
      '2026-09-15',
      '2026-10-15',
    ]);
  });

  it('makes the instalments add back to the invoice exactly', () => {
    // The last one absorbs the rounding. Spreading the remainder would be
    // defensible arithmetic and indefensible accounting: the total would move
    // depending on how it was split.
    const schedule = instalmentSchedule(thirds, '2026-08-16', '1000.0000');
    const total = schedule.reduce((sum, i) => sum + i.amount, 0n);

    expect(total).toBe(10_000_000n); // 1000.0000 scaled
    expect(schedule.map((i) => i.amount)).toEqual([3_333_000n, 3_333_000n, 3_334_000n]);
  });

  it('refuses instalments that do not total the whole invoice', () => {
    expect(() =>
      assertInstalmentsComplete({
        ...thirds,
        instalments: [
          { sequence: 1, daysAfter: 0, percentage: '50' },
          { sequence: 2, daysAfter: 30, percentage: '30' },
        ],
      }),
    ).toThrow(/total 80.00%, not 100%/);
  });

  it('refuses instalments numbered with a gap', () => {
    expect(() =>
      assertInstalmentsComplete({
        ...thirds,
        instalments: [
          { sequence: 1, daysAfter: 0, percentage: '50' },
          { sequence: 3, daysAfter: 30, percentage: '50' },
        ],
      }),
    ).toThrow(PaymentTermsError);
  });

  it('takes the last instalment date as the due date of the whole invoice', () => {
    expect(dueDateFor(thirds, '2026-08-16')).toBe('2026-10-15');
  });

  it('permits a single-payment term with no instalments', () => {
    expect(() => assertInstalmentsComplete(net30)).not.toThrow();
    expect(instalmentSchedule(net30, '2026-08-16', '1000.0000')).toEqual([
      { sequence: 1, dueDate: '2026-09-15', amount: 10_000_000n },
    ]);
  });
});
