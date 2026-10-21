import { describe, expect, it } from 'vitest';
import type { PrintModel } from '@/server/print/model';
import { amountInWords, arabicNumber, englishNumber, readPrintedMoney, spelledAmountOf } from '@/server/print/words';

/**
 * The amount in words under a printed document's figures (2026-10-21, by
 * direction: "2,000 IQD should be two thousand IQD — in Arabic too").
 */
describe('words · an amount written out', () => {
  it('writes numbers in English', () => {
    expect([0n, 7n, 15n, 42n, 100n, 2000n, 101000n, 57_190_000n, 15_000_000_000n].map(englishNumber)).toEqual([
      'zero',
      'seven',
      'fifteen',
      'forty-two',
      'one hundred',
      'two thousand',
      'one hundred one thousand',
      'fifty-seven million one hundred ninety thousand',
      'fifteen billion',
    ]);
  });

  it('writes numbers in Arabic, with each scale word in the form its count asks for', () => {
    expect(arabicNumber(1000n)).toBe('ألف');
    expect(arabicNumber(2000n)).toBe('ألفان');
    expect(arabicNumber(3000n)).toBe('ثلاثة آلاف');
    expect(arabicNumber(10_000n)).toBe('عشرة آلاف');
    expect(arabicNumber(11_000n)).toBe('أحد عشر ألفًا');
    expect(arabicNumber(105_000n)).toBe('مئة وخمسة آلاف');
    expect(arabicNumber(200_000n)).toBe('مئتا ألف');
    expect(arabicNumber(300_000n)).toBe('ثلاثمئة ألف');
    expect(arabicNumber(21n)).toBe('واحد وعشرون');
    expect(arabicNumber(1_250_000n)).toBe('مليون ومئتان وخمسون ألفًا');
    expect(arabicNumber(3_000_000n)).toBe('ثلاثة ملايين');
    expect(arabicNumber(57_190_000n)).toBe('سبعة وخمسون مليونًا ومئة وتسعون ألفًا');
    expect(arabicNumber(15_000_000_000n)).toBe('خمسة عشر مليارًا');
  });

  it('names the currency, rounds dinars whole as printed, and keeps cents', () => {
    expect(amountInWords('2000', 'IQD', 'en')).toBe('Two thousand Iraqi dinars');
    expect(amountInWords('2000', 'IQD', 'ar')).toBe('ألفان دينار عراقي');
    expect(amountInWords('1', 'IQD', 'en')).toBe('One Iraqi dinar');
    expect(amountInWords('1', 'IQD', 'ar')).toBe('دينار عراقي واحد');
    expect(amountInWords('1999.6000', 'IQD', 'en')).toBe('Two thousand Iraqi dinars');
    expect(amountInWords('1250.505', 'USD', 'en')).toBe('One thousand two hundred fifty US dollars and fifty-one cents');
    expect(amountInWords('0.99', 'USD', 'ar')).toBe('تسعة وتسعون سنت');
    expect(amountInWords('-500', 'IQD', 'en')).toBe('Minus five hundred Iraqi dinars');
    expect(amountInWords('0.0000', 'IQD', 'en')).toBeNull();
    expect(amountInWords('not a number', 'IQD', 'en')).toBeNull();
  });

  it('reads a printed figure back, brackets as a minus', () => {
    expect(readPrintedMoney('47,190,000 IQD')).toEqual({ amount: '47190000', currency: 'IQD' });
    expect(readPrintedMoney('‎-1,250.50 USD')).toEqual({ amount: '-1250.50', currency: 'USD' });
    expect(readPrintedMoney('(10,000) IQD')).toEqual({ amount: '-10000', currency: 'IQD' });
    // A count is not money: no currency, no words.
    expect(readPrintedMoney('5')).toBeNull();
  });

  it('spells what the builder names, else the first summary amount, else the table total; never a report', () => {
    const base: PrintModel = {
      kind: 'document',
      title: 'Purchase Invoice',
      orientation: 'portrait',
      fields: [],
      filters: [],
      tables: [
        {
          columns: [
            { key: 'name', label: 'Item', kind: 'text' },
            { key: 'qty', label: 'Quantity', kind: 'quantity' },
            { key: 'price', label: 'Price', kind: 'money' },
            { key: 'amount', label: 'Amount', kind: 'money' },
          ],
          rows: [],
          empty: '—',
          totals: { label: 'Totals', cells: { qty: '3', amount: '2000.0000' } },
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: 'PUR-1',
      sheetName: 'PUR-1',
    };
    expect(spelledAmountOf(base)).toEqual({ amount: '2000.0000', currency: 'IQD' });
    expect(spelledAmountOf({ ...base, summary: [{ label: 'Lines', value: '3' }, { label: 'Amount', value: '5,000 USD' }] })).toEqual({
      amount: '5000',
      currency: 'USD',
    });
    expect(spelledAmountOf({ ...base, amountInWords: { amount: '750' } })).toEqual({ amount: '750', currency: 'IQD' });
    expect(spelledAmountOf({ ...base, amountInWords: null })).toBeNull();
    expect(spelledAmountOf({ ...base, kind: 'report' })).toBeNull();
  });
});
