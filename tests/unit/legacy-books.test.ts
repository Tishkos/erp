/**
 * REQ-LEGACY-001 — reading the old books (LG1, LG2).
 *
 * The accountant's export is text in Arabic with the sign written in words,
 * the currency written after the number, the unit written after the
 * quantity and the dates American. Every one of those is read here against
 * the exact shapes the real files carry, and the `.xls` reader is held to a
 * fixture whose shared-string table is long enough to continue across
 * records — the case that garbled every row after the first boundary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  balanceTotals,
  impliedRate,
  itemCosts,
  legacyAmount,
  legacyCurrency,
  legacyDate,
  legacyQuantity,
  legacySide,
  nameKey,
  readBooks,
  recognise,
  tbLine,
  uomFor,
} from '../../src/server/domain/legacy-books';
import { readXlsWorkbook, isCompoundFile } from '../../src/server/xls-read';
import type { SheetRows } from '../../src/server/xlsx-read';

const M = 10n ** 4n;
const Q = 10n ** 6n;

describe('LG1 · the cells', () => {
  it('reads an amount with its side in words, the sign already in the number', () => {
    expect(legacyAmount('24,634,400  مدين / لنا')).toBe(24_634_400n * M);
    expect(legacyAmount('-81,486,500  دائن / علينا')).toBe(-81_486_500n * M);
    expect(legacyAmount('0  ')).toBe(0n);
    expect(legacyAmount('195,000 د.ع')).toBe(195_000n * M);
    expect(legacyAmount('195,003.08 د.ع')).toBe(195_003_0800n);
    expect(legacyAmount('404,105,773.166')).toBe(404_105_773_1660n);
    expect(legacyAmount(12.5)).toBe(125_000n);
    expect(legacyAmount('')).toBeNull();
    expect(legacyAmount('n/a')).toBeNull();
    expect(legacySide('24,634,400  مدين / لنا')).toBe('debit');
    expect(legacySide('-81,486,500  دائن / علينا')).toBe('credit');
    expect(legacySide('0')).toBeNull();
  });

  it('reads a quantity with its unit, and maps the unit', () => {
    expect(legacyQuantity('14 قطعة')).toEqual({ quantity: 14n * Q, unit: 'قطعة' });
    expect(legacyQuantity('10 متر')).toEqual({ quantity: 10n * Q, unit: 'متر' });
    expect(legacyQuantity('552 ')).toEqual({ quantity: 552n * Q, unit: '' });
    expect(legacyQuantity('-10,800')).toEqual({ quantity: -10_800n * Q, unit: '' });
    expect(legacyQuantity(3)).toEqual({ quantity: 3n * Q, unit: '' });
    expect(legacyQuantity('many')).toBeNull();
    expect(uomFor('قطعة')).toBe('EA');
    expect(uomFor('متر')).toBe('M');
    expect(uomFor('')).toBe('EA');
  });

  it('reads American dates, with or without a time, and nothing for ---', () => {
    expect(legacyDate('9/21/2026')).toBe('2026-09-21');
    expect(legacyDate('4/13/2025 9:13:11 AM')).toBe('2025-04-13');
    expect(legacyDate('---')).toBeNull();
    expect(legacyDate('')).toBeNull();
    expect(legacyDate(46_000)).toBe('2025-12-09');
  });

  it('reads the currency words', () => {
    expect(legacyCurrency('دينار')).toBe('IQD');
    expect(legacyCurrency('دولار')).toBe('USD');
    expect(legacyCurrency('')).toBeNull();
  });

  it('keys Arabic names so spacing and letter shapes do not make two partners of one', () => {
    expect(nameKey('VOLT  GUIDE')).toBe(nameKey('volt guide'));
    expect(nameKey('أحمد  البصرة')).toBe(nameKey('احمد البصره'));
    expect(nameKey('مخزن بغداد ')).toBe(nameKey('مخزن بغداد'));
  });
});

const header = (...cells: string[]) => cells;

describe('LG1 · recognising the workbooks', () => {
  it('knows each register by its header row, and the suppliers by the file name', () => {
    const partners: SheetRows = [header('اسم الحساب', 'رقم الحساب', 'الرصيد بالدينار', 'الرصيد بالدولار', 'رقم الهاتف'), ['A', '1000', '0', '0', '']];
    expect(recognise('Clients-الزبائن.xlsx', new Map([['Sheet1', partners]]))[0]?.kind).toBe('customers');
    expect(recognise('Suppliers-الموردين.xlsx', new Map([['Sheet1', partners]]))[0]?.kind).toBe('suppliers');
    expect(recognise('مجهزين.xlsx', new Map([['Sheet1', partners]]))[0]?.kind).toBe('suppliers');
    const balances: SheetRows = [header('الحساب', 'رقم الحساب', 'الرصيد', 'اخر حركة', 'اخر تسديد')];
    expect(recognise('x.xlsx', new Map([['IQD', balances], ['USD', balances]])).map((r) => r.kind)).toEqual(['balances', 'balances']);
    expect(recognise('x.xlsx', new Map([['Sheet1', [header('رقم القائمة', 'اسم الزبون', 'المادة', 'سعر الشراء', 'سعر البيع', 'العدد', 'المجموع')]]]))[0]?.kind).toBe('sales');
    expect(recognise('x.xlsx', new Map([['Sheet1', [header('رقم القائمة', 'اسم الزبون', 'المادة', 'سعر البيع', 'العدد', 'المجموع', 'التاريخ')]]]))[0]?.kind).toBe('purchases');
    expect(recognise('x.xlsx', new Map([['ورقة1', [header('رقم السند', 'نوع العملية', 'المبلغ', 'العملة', 'الاسم', 'رقم الحساب', 'التاريخ')]]]))[0]?.kind).toBe('receipts');
    expect(recognise('x.xlsx', new Map([['ورقة1', [header('التاريخ', 'رقم الحساب', 'الاسم', 'العملة', 'المبلغ', 'نوع العملية', 'رقم السند')]]]))[0]?.kind).toBe('payments');
    expect(recognise('x.xlsx', new Map([['ورقة1', [header('اسم المادة', 'رمز المادة', 'المخزن', 'العدد', 'المحجوز', 'موجود المخزن')]]]))[0]?.kind).toBe('warehouses');
    expect(recognise('x.xlsx', new Map([['ورقة1', [header('الفقرة', 'الرصيد بالدينار', 'الرصيد بالدولار', 'الرصيد النهائي')]]]))[0]?.kind).toBe('accounts');
    expect(recognise('x.xlsx', new Map([['Sheet1', [header('Name', 'Value')]]]))).toEqual([]);
  });
});

function sample() {
  return readBooks([
    {
      fileName: 'Clients.xlsx',
      workbook: new Map([
        ['Sheet1', [
          header('اسم الحساب', 'رقم الحساب', 'الرصيد بالدينار', 'الرصيد بالدولار', 'رقم الهاتف'),
          ['VOLT GUIDE', '1000', '24,634,400  مدين / لنا', '0  ', '0784'],
          ['شركة زحل', '1038', '-24,469,200  دائن / علينا', '-100  دائن / علينا', ''],
          ['زبون صفر', '1050', '0  ', '0  ', ''],
        ]],
      ]),
    },
    {
      fileName: 'Suppliers.xlsx',
      workbook: new Map([
        ['Sheet1', [header('اسم الحساب', 'رقم الحساب', 'الرصيد بالدينار', 'الرصيد بالدولار', 'رقم الهاتف'), ['كاك بابان', '1023', '-8,979,309,500  دائن / علينا', '0  ', '']]],
      ]),
    },
    {
      fileName: 'Account_balances.xlsx',
      workbook: new Map([
        ['IQD', [header('الحساب', 'رقم الحساب', 'الرصيد', 'اخر حركة', 'اخر تسديد'), ['VOLT GUIDE', '1000', '24,634,400  مدين / لنا', '9/21/2026', '9/15/2026'], ['شركة زحل', '1038', '-24,469,200  دائن / علينا', '9/21/2026', '---'], ['زبون صفر', '1050', '0  ', '1/1/2025', '---']]],
        ['USD', [header('الحساب', 'رقم الحساب', 'الرصيد', 'اخر حركة', 'اخر تسديد'), ['شركة زحل', '1038', '-100  دائن / علينا', '2/26/2026', '2/7/2026']]],
      ]),
    },
    {
      fileName: 'warehouses.xlsx',
      workbook: new Map([
        ['ورقة1', [
          header('اسم المادة', 'رمز المادة', 'المخزن', 'العدد', 'المحجوز', 'موجود المخزن'),
          ['CABLE 1*6 200M', '', 'مخزن بغداد ', '86', '0', '86'],
          ['CABLE 1*6 200M', '', 'مخزن قيد الشحن', '-5', '0', '-5'],
          ['645W HIMOX10', '', 'مخزن بغداد ', '0', '0', '0'],
          ['Gsl 16 Kw', '', 'مخزن QS', '2', '0', '2'],
        ]],
      ]),
    },
    {
      fileName: 'Sales.xls',
      workbook: new Map([
        ['Sheet1', [
          header('رقم القائمة', 'اسم الزبون', 'المادة', 'سعر الشراء', 'سعر البيع', 'العدد', 'المجموع'),
          ['3', 'VOLT GUIDE', 'CABLE 1*6 200M', '190,000 د.ع', '215,000 د.ع', '10 متر', '2,150,000 د.ع'],
          ['3', 'VOLT GUIDE', 'Gsl 16 Kw', '1,500,000 د.ع', '1,900,000 د.ع', '1 قطعة', '1,900,000 د.ع'],
          ['4', 'زبون نقدي', 'CABLE 1*6 200M', '0', '220,000 د.ع', '2 متر', '440,000 د.ع'],
        ]],
      ]),
    },
    {
      fileName: 'Purchases.xlsx',
      workbook: new Map([
        ['Sheet1', [header('رقم القائمة', 'اسم الزبون', 'المادة', 'سعر البيع', 'العدد', 'المجموع', 'التاريخ'), ['510510', 'كاك بابان', 'CABLE 1*6 200M', '205,000 د.ع', '14 قطعة', '2,870,000 د.ع', '4/23/2025 5:36:06 PM']]],
      ]),
    },
    {
      fileName: 'Receipt_Vouchers.xlsx',
      workbook: new Map([
        ['ورقة1', [header('رقم السند', 'نوع العملية', 'المبلغ', 'العملة', 'الاسم', 'رقم الحساب', 'التاريخ'), ['1', ' قبض', '30,000,000', 'دينار', 'VOLT GUIDE', '1000', '11/2/2024']]],
      ]),
    },
    {
      fileName: 'the_accounts.xlsx',
      workbook: new Map([
        ['ورقة1', [
          header('الفقرة', 'الرصيد بالدينار', 'الرصيد بالدولار', 'الرصيد النهائي'),
          ['مخزون البضائع بغرض البيع', '404,105,773.166', '0', '404,105,773.166'],
          ['حسابات الزبائن', '165,200', '-100', '18,200'],
          ['حسابات مجهزين', '-8,979,309,500', '0', '-8,979,309,500'],
        ]],
      ]),
    },
  ]);
}

describe('LG1 · the books as data', () => {
  const books = sample();

  it('reads every register, and names what it could not', () => {
    expect(books.problems).toEqual([]);
    expect(books.partners.map((p) => `${p.code}:${p.kind}`)).toEqual(['1000:customer', '1038:customer', '1050:customer', '1023:supplier']);
    expect(books.balances).toHaveLength(4);
    expect(books.balances[1]).toMatchObject({ code: '1038', currency: 'IQD', balance: -24_469_200n * M, lastMovement: '2026-09-21', lastPayment: null });
    expect(books.positions.map((p) => [p.item, p.warehouse, p.quantity])).toEqual([
      ['CABLE 1*6 200M', 'مخزن بغداد', 86n * Q],
      ['CABLE 1*6 200M', 'مخزن قيد الشحن', -5n * Q],
      ['645W HIMOX10', 'مخزن بغداد', 0n],
      ['Gsl 16 Kw', 'مخزن QS', 2n * Q],
    ]);
    expect(books.sales[0]).toMatchObject({ listNo: '3', customerName: 'VOLT GUIDE', unitCost: 190_000n * M, unitPrice: 215_000n * M, quantity: 10n * Q, unit: 'متر', total: 2_150_000n * M });
    expect(books.purchases[0]).toMatchObject({ listNo: '510510', supplierName: 'كاك بابان', unitPrice: 205_000n * M, quantity: 14n * Q, date: '2025-04-23' });
    expect(books.vouchers[0]).toMatchObject({ kind: 'receipt', voucherNo: '1', operation: 'قبض', amount: 30_000_000n * M, currency: 'IQD', code: '1000', date: '2024-11-02' });
  });

  it('sums the balances by kind and currency, and reads the trial balance', () => {
    const totals = balanceTotals(books);
    expect(totals.customer.IQD).toBe((24_634_400n - 24_469_200n) * M);
    expect(totals.customer.USD).toBe(-100n * M);
    expect(tbLine(books, 'customers')?.iqd).toBe(165_200n * M);
    expect(tbLine(books, 'stock')?.iqd).toBe(404_105_773_1660n);
    // final = IQD + USD × rate  →  18,200 = 165,200 − 100 × rate  →  rate 1,470
    expect(impliedRate(books)).toBe(1470n * M);
  });

  it('costs each item from the newest purchase, else the newest sale, and takes the unit it is sold in', () => {
    const costs = itemCosts(books);
    expect(costs.get(nameKey('CABLE 1*6 200M'))).toMatchObject({ unitCost: 205_000n * M, source: 'purchase', uom: 'M' });
    expect(costs.get(nameKey('Gsl 16 Kw'))).toMatchObject({ unitCost: 1_500_000n * M, source: 'sale', uom: 'EA' });
    expect(costs.get(nameKey('645W HIMOX10'))).toMatchObject({ unitCost: null, source: null, uom: 'EA' });
  });
});

describe('LG2 · the .xls reader', () => {
  const buffer = readFileSync(join(process.cwd(), 'tests/fixtures/legacy-sample.xls'));

  it('recognises a compound file', () => {
    expect(isCompoundFile(buffer)).toBe(true);
    expect(isCompoundFile(Buffer.from('PK\u0003\u0004'))).toBe(false);
  });

  it('reads every row, through the shared-string continuations, in both scripts', () => {
    const rows = readXlsWorkbook(buffer).get('Sheet1');
    expect(rows).toBeDefined();
    expect(rows).toHaveLength(122);
    expect(rows![0]).toEqual(['رقم القائمة', 'اسم الزبون', 'المادة', 'سعر الشراء', 'سعر البيع', 'العدد', 'المجموع']);
    for (let i = 1; i <= 120; i += 1) {
      const row = rows![i]!;
      expect(row[0], `row ${i}`).toBe(String(i));
      expect(row[1], `row ${i}`).toBe(`زبون رقم ${i} — ` + 'شركة الطاقة الشمسية للتجارة العامة والمقاولات '.repeat(2));
      expect(row[2], `row ${i}`).toBe(`PANEL MODEL ${i} LONGI HIMO SERIES WITH LONG DESCRIPTION TEXT `.repeat(2));
      expect(row[5], `row ${i}`).toBe(`${i} قطعة`);
    }
    expect(rows![121]!.slice(0, 3)).toEqual([12345.5, true, 'last']);
  });

  it('refuses what is not a workbook with a sentence', () => {
    expect(() => readXlsWorkbook(Buffer.from('hello'))).toThrow(/not a compound file/);
  });
});
