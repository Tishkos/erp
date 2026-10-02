/**
 * The pieces of printing that are pure logic: laying a mixed Arabic and
 * Latin line out in visual order, exact arithmetic on the database's decimal
 * strings, and the formulas a workbook's totals are written as.
 */
import { describe, expect, it } from 'vitest';
import { directionOf, printable, visualRuns } from '@/server/print/bidi';
import { average, lineTotal, sumMoney, sumQuantity } from '@/server/print/decimal';
import { columnLetter, sheetName, sumFormula } from '@/server/print/xlsx';
import { columnWidths } from '@/server/print/pdf';
import { safeFileName } from '@/server/print/format';

describe('bidi · a line is cut into runs the shaper can lay out on its own', () => {
  it('keeps a figure left to right inside an Arabic sentence', () => {
    // Visual order, left to right: the figure, then the Arabic word (which
    // the shaper reverses into place).
    expect(visualRuns('المجموع 1,250,000', 'rtl')).toEqual([
      { text: '1,250,000', direction: 'ltr' },
      { text: 'المجموع ', direction: 'rtl' },
    ]);
  });

  it('keeps a document number whole, and a date in the order it is read', () => {
    expect(visualRuns('API-HQ-2026-000001', 'rtl')).toEqual([{ text: 'API-HQ-2026-000001', direction: 'ltr' }]);
    expect(visualRuns('26 سبتمبر 2026', 'rtl').map((run) => run.text)).toEqual(['2026', ' سبتمبر ', '26']);
  });

  it('puts a Latin name in brackets after an Arabic one, brackets mirrored', () => {
    const runs = visualRuns('شركة النور (Al-Noor)', 'rtl');
    expect(runs.map((run) => run.direction)).toEqual(['rtl', 'ltr', 'rtl']);
    expect(runs[0]!.text).toBe('(');
    expect(runs[1]!.text).toBe('Al-Noor');
    // Logical order kept for the shaper, with the bracket turned to face the text.
    expect(runs[2]!.text).toBe('شركة النور )');
  });

  it('reads the direction marks Intl puts in Arabic figures, then drops them', () => {
    const iqd = new Intl.NumberFormat('ar', { style: 'currency', currency: 'IQD', maximumFractionDigits: 0 }).format(1250000);
    const runs = visualRuns(iqd, 'rtl');
    for (const run of runs) expect(run.text).not.toMatch(/[‎‏؜]/);
    expect(runs.map((run) => run.text).join('')).toContain('1,250,000');
    expect(printable('‏1 2‎')).toBe('1 2');
  });

  it('lays out an English line with an Arabic name inside it', () => {
    expect(directionOf('Supplier Name')).toBe('ltr');
    expect(directionOf('قمة السفینە')).toBe('rtl');
    expect(visualRuns('Customer: قمة السفینە', 'ltr').map((run) => run.direction)).toEqual(['ltr', 'rtl']);
  });
});

describe('decimal · the figures a print computes, exactly', () => {
  it('computes a Total Price as quantity × unit price − discount, to the fils', () => {
    expect(lineTotal('3.000000', '2500.0000', '0.0000')).toBe('7500.0000');
    expect(lineTotal('1.500000', '333.3333', '10.0000')).toBe('490.0000');
    // 0.1 + 0.2 is not a floating-point problem here.
    expect(sumMoney(['0.1000', '0.2000'])).toBe('0.3000');
    expect(sumMoney(['999999999999.9999', '0.0001'])).toBe('1000000000000.0000');
  });

  it('computes Opening Stock’s average unit price as total ÷ quantity', () => {
    expect(average('1000.0000', '8.000000')).toBe('125.0000');
    expect(average('100.0000', '3.000000')).toBe('33.3333');
    expect(average('100.0000', '0.000000')).toBeNull();
  });

  it('adds quantities at six places', () => {
    expect(sumQuantity(['1.500000', '2.250000', null])).toBe('3.750000');
  });
});

describe('workbook · the totals row is a formula over the lines that count', () => {
  it('writes one range for contiguous lines, and a list where some do not count', () => {
    expect(sumFormula('G', [12, 13, 14])).toBe('SUM(G12:G14)');
    expect(sumFormula('D', [5, 9, 14])).toBe('SUM(D5,D9,D14)');
    expect(sumFormula('D', [])).toBe('0');
  });

  it('nests past Excel’s 255 arguments to one SUM', () => {
    const rows = Array.from({ length: 450 }, (_, i) => 2 * i + 1);
    const formula = sumFormula('B', rows);
    expect(formula.startsWith('SUM(SUM(')).toBe(true);
    for (const group of formula.slice(4, -1).split(/\),SUM\(/)) {
      expect(group.split(',').length).toBeLessThanOrEqual(255);
    }
  });

  it('names columns and sheets the way Excel accepts', () => {
    expect([0, 25, 26, 27, 701].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ']);
    expect(sheetName('Trial Balance [2026]: all/branches?')).toBe('Trial Balance  2026   all branc');
    expect(sheetName('فاتورة شراء')).toBe('فاتورة شراء');
  });
});

describe('paper · a code, a date or a figure is never cut in two', () => {
  it('widens a code column to its widest value and takes the room from the text', () => {
    const columns = [
      { key: 'no', label: '#', kind: 'code' as const },
      { key: 'name', label: 'Name', kind: 'text' as const },
      { key: 'amount', label: 'Amount', kind: 'money' as const },
    ];
    const widths = columnWidths(columns, 400, (i) => (i === 0 ? 150 : 60));
    expect(widths[0]).toBeGreaterThanOrEqual(150);
    expect(widths[2]).toBeGreaterThanOrEqual(60);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(400, 6);
  });

  it('names the file after the document, and nothing a file system refuses', () => {
    expect(safeFileName('API-HQ-2026-000001')).toBe('API-HQ-2026-000001');
    expect(safeFileName('customer-statement_CUS/1:2026')).toBe('customer-statement_CUS_1_2026');
  });
});
