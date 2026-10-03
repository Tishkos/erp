/**
 * The legacy books — what the accountant's old system exports, read as data
 * (REQ-LEGACY-001, 2026-10-02).
 *
 * Ten workbooks, each recognised by its header row rather than its file
 * name, because the names arrive as whatever the export dialog offered
 * (`Clients-الزبائن.xlsx`, `Sales-المبيعات.xls`):
 *
 *   customers / suppliers   اسم الحساب · رقم الحساب · الرصيد بالدينار · الرصيد بالدولار · رقم الهاتف
 *   balances (IQD, USD)     الحساب · رقم الحساب · الرصيد · اخر حركة · اخر تسديد  (one sheet per currency)
 *   materials               تـ · المادة · العدد · المخزن
 *   warehouses              اسم المادة · رمز المادة · المخزن · العدد · المحجوز · موجود المخزن
 *   sales                   رقم القائمة · اسم الزبون · المادة · سعر الشراء · سعر البيع · العدد · المجموع
 *   purchases               رقم القائمة · اسم الزبون · المادة · سعر البيع · العدد · المجموع · التاريخ
 *   receipts                رقم السند · نوع العملية · المبلغ · العملة · الاسم · رقم الحساب · التاريخ
 *   payments                التاريخ · رقم الحساب · الاسم · العملة · المبلغ · نوع العملية · رقم السند
 *   accounts (the TB)       الفقرة · الرصيد بالدينار · الرصيد بالدولار · الرصيد النهائي
 *
 * Customers and suppliers share a header, so those two are told apart by
 * the file name (anything with "supplier", "مورد" or "مجهز" is the
 * suppliers' file) and the dry run says which reading it took.
 *
 * Amounts arrive as text: "24,634,400  مدين / لنا" (debit — they owe us),
 * "-81,486,500  دائن / علينا" (credit — we owe them; the sign is already in
 * the number), "195,000 د.ع" (dinars), "14 قطعة" (14 pieces), "10 متر" (10
 * metres). Dates are American (`M/D/YYYY`, sometimes with a time), or
 * `---` for none.
 *
 * Pure: no database, no file system. The service decides what to create.
 */
import { MONEY_SCALE, parseDecimal } from './money';
import { QUANTITY_SCALE } from './uom';
import type { CellValue, SheetRows } from '../xlsx-read';

export type LegacyKind =
  | 'customers'
  | 'suppliers'
  | 'balances'
  | 'materials'
  | 'warehouses'
  | 'sales'
  | 'purchases'
  | 'receipts'
  | 'payments'
  | 'accounts';

export const LEGACY_KINDS: readonly LegacyKind[] = [
  'customers',
  'suppliers',
  'balances',
  'materials',
  'warehouses',
  'sales',
  'purchases',
  'receipts',
  'payments',
  'accounts',
];

const HEADERS: Readonly<Record<Exclude<LegacyKind, 'customers' | 'suppliers'> | 'partners', readonly string[]>> = {
  partners: ['اسم الحساب', 'رقم الحساب', 'الرصيد بالدينار', 'الرصيد بالدولار', 'رقم الهاتف'],
  balances: ['الحساب', 'رقم الحساب', 'الرصيد', 'اخر حركة', 'اخر تسديد'],
  materials: ['تـ', 'المادة', 'العدد', 'المخزن'],
  warehouses: ['اسم المادة', 'رمز المادة', 'المخزن', 'العدد', 'المحجوز', 'موجود المخزن'],
  sales: ['رقم القائمة', 'اسم الزبون', 'المادة', 'سعر الشراء', 'سعر البيع', 'العدد', 'المجموع'],
  purchases: ['رقم القائمة', 'اسم الزبون', 'المادة', 'سعر البيع', 'العدد', 'المجموع', 'التاريخ'],
  receipts: ['رقم السند', 'نوع العملية', 'المبلغ', 'العملة', 'الاسم', 'رقم الحساب', 'التاريخ'],
  payments: ['التاريخ', 'رقم الحساب', 'الاسم', 'العملة', 'المبلغ', 'نوع العملية', 'رقم السند'],
  accounts: ['الفقرة', 'الرصيد بالدينار', 'الرصيد بالدولار', 'الرصيد النهائي'],
};

export const text = (value: CellValue): string =>
  value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();

/** Arabic text as a key: collapsed spaces, no tatweel, no diacritics, one shape of alef / yeh / teh marbuta. */
export function nameKey(value: string): string {
  return text(value)
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}

function headerMatches(row: readonly CellValue[] | undefined, expected: readonly string[]): boolean {
  if (!row) return false;
  return expected.every((label, index) => nameKey(text(row[index] ?? null)) === nameKey(label));
}

export interface RecognisedSheet {
  readonly kind: LegacyKind;
  readonly sheet: string;
  readonly rows: SheetRows;
}

const SUPPLIER_FILE = /supplier|مورد|مجهز|موردين|مجهزين/i;

/** Which register a workbook is, from its header rows (and, for the partners, its name). */
export function recognise(fileName: string, workbook: ReadonlyMap<string, SheetRows>): RecognisedSheet[] {
  const found: RecognisedSheet[] = [];
  for (const [sheet, rows] of workbook) {
    const header = rows[0];
    if (!header) continue;
    if (headerMatches(header, HEADERS.partners)) {
      found.push({ kind: SUPPLIER_FILE.test(fileName) ? 'suppliers' : 'customers', sheet, rows });
      continue;
    }
    for (const kind of ['balances', 'materials', 'warehouses', 'sales', 'purchases', 'receipts', 'payments', 'accounts'] as const) {
      if (headerMatches(header, HEADERS[kind])) {
        found.push({ kind, sheet, rows });
        break;
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** "-81,486,500  دائن / علينا" → -81486500 (scaled money); "0  " → 0; "" → null. */
export function legacyAmount(value: CellValue): bigint | null {
  if (typeof value === 'number') return parseDecimal(String(value), MONEY_SCALE);
  // The leading number only: "195,000 د.ع" carries a dot in the currency word.
  const match = /^(-?[\d,]+(?:\.\d+)?)/.exec(text(value));
  if (!match) return null;
  const raw = match[1]!.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return parseDecimal(raw, MONEY_SCALE);
}

/** Debit / credit as the sheet words it, when it says. */
export function legacySide(value: CellValue): 'debit' | 'credit' | null {
  const s = text(value);
  if (/مدين|لنا/.test(s)) return 'debit';
  if (/دائن|علينا/.test(s)) return 'credit';
  return null;
}

/** "14 قطعة" → { quantity: 14, unit: 'قطعة' }; "552 " → { quantity: 552, unit: '' }. */
export function legacyQuantity(value: CellValue): { quantity: bigint; unit: string } | null {
  if (typeof value === 'number') return { quantity: parseDecimal(String(value), QUANTITY_SCALE), unit: '' };
  const s = text(value);
  const match = /^(-?[\d,]+(?:\.\d+)?)\s*(.*)$/.exec(s);
  if (!match) return null;
  const number = match[1]!.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(number)) return null;
  return { quantity: parseDecimal(number, QUANTITY_SCALE), unit: match[2]!.trim() };
}

/** The unit of measure the legacy unit word maps to. */
export function uomFor(unit: string): 'EA' | 'M' | 'KG' | 'L' | 'BOX' {
  const u = nameKey(unit);
  if (/متر/.test(u)) return 'M';
  if (/كغم|كيلو/.test(u)) return 'KG';
  if (/لتر/.test(u)) return 'L';
  if (/كارتون|صندوق/.test(u)) return 'BOX';
  return 'EA';
}

/** "9/21/2026", "4/13/2025 9:13:11 AM" → "2026-09-21"; "---", "" → null. An Excel serial is accepted too. */
export function legacyDate(value: CellValue): string | null {
  if (typeof value === 'number') {
    if (value < 20_000 || value > 80_000) return null;
    const ms = Math.round((value - 25_569) * 86_400_000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = text(value);
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (!match) return null;
  const [, m, d, y] = match;
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function legacyCurrency(value: CellValue): 'IQD' | 'USD' | null {
  const s = text(value);
  if (/دولار|\$|usd/i.test(s)) return 'USD';
  if (/دينار|د\.ع|iqd/i.test(s)) return 'IQD';
  return null;
}

// ---------------------------------------------------------------------------
// The registers
// ---------------------------------------------------------------------------

export interface LegacyPartner {
  /** The legacy account number — the partner code the ERP keeps. */
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly balanceIqd: bigint;
  readonly balanceUsd: bigint;
  readonly kind: 'customer' | 'supplier';
  readonly row: number;
}

export interface LegacyBalance {
  readonly code: string;
  readonly name: string;
  readonly currency: 'IQD' | 'USD';
  /** Positive: they owe us (debit); negative: we owe them (credit). */
  readonly balance: bigint;
  readonly lastMovement: string | null;
  readonly lastPayment: string | null;
  readonly row: number;
}

export interface LegacyPosition {
  readonly item: string;
  readonly warehouse: string;
  readonly quantity: bigint;
  readonly reserved: bigint;
  readonly row: number;
}

export interface LegacySaleLine {
  readonly listNo: string;
  readonly customerName: string;
  readonly item: string;
  readonly unitCost: bigint | null;
  readonly unitPrice: bigint | null;
  readonly quantity: bigint | null;
  readonly unit: string;
  readonly total: bigint | null;
  readonly row: number;
}

export interface LegacyPurchaseLine {
  readonly listNo: string;
  readonly supplierName: string;
  readonly item: string;
  readonly unitPrice: bigint | null;
  readonly quantity: bigint | null;
  readonly unit: string;
  readonly total: bigint | null;
  readonly date: string | null;
  readonly row: number;
}

export interface LegacyVoucher {
  readonly kind: 'receipt' | 'payment';
  readonly voucherNo: string;
  readonly operation: string;
  readonly amount: bigint | null;
  readonly currency: 'IQD' | 'USD' | null;
  readonly name: string;
  readonly code: string;
  readonly date: string | null;
  readonly row: number;
}

export interface LegacyAccountLine {
  readonly caption: string;
  readonly iqd: bigint | null;
  readonly usd: bigint | null;
  readonly final: bigint | null;
}

export interface LegacyBooks {
  readonly files: readonly { fileName: string; sheets: readonly { sheet: string; kind: LegacyKind; rows: number }[] }[];
  readonly partners: readonly LegacyPartner[];
  readonly balances: readonly LegacyBalance[];
  readonly positions: readonly LegacyPosition[];
  readonly sales: readonly LegacySaleLine[];
  readonly purchases: readonly LegacyPurchaseLine[];
  readonly vouchers: readonly LegacyVoucher[];
  readonly accounts: readonly LegacyAccountLine[];
  /** Rows that could not be read, with the sentence that says why. */
  readonly problems: readonly { fileName: string; sheet: string; row: number; message: string }[];
}

const empty = (row: readonly CellValue[]) => row.every((c) => text(c) === '');
const cell = (row: readonly CellValue[], index: number): CellValue => row[index] ?? null;

export function readBooks(files: readonly { fileName: string; workbook: ReadonlyMap<string, SheetRows> }[]): LegacyBooks {
  const partners: LegacyPartner[] = [];
  const balances: LegacyBalance[] = [];
  const positions: LegacyPosition[] = [];
  const sales: LegacySaleLine[] = [];
  const purchases: LegacyPurchaseLine[] = [];
  const vouchers: LegacyVoucher[] = [];
  const accounts: LegacyAccountLine[] = [];
  const problems: { fileName: string; sheet: string; row: number; message: string }[] = [];
  const summary: { fileName: string; sheets: { sheet: string; kind: LegacyKind; rows: number }[] }[] = [];

  for (const file of files) {
    const recognised = recognise(file.fileName, file.workbook);
    summary.push({ fileName: file.fileName, sheets: recognised.map((r) => ({ sheet: r.sheet, kind: r.kind, rows: r.rows.length - 1 })) });
    for (const { kind, sheet, rows } of recognised) {
      const problem = (row: number, message: string) => problems.push({ fileName: file.fileName, sheet, row, message });
      rows.slice(1).forEach((cells, index) => {
        const row = index + 2;
        if (empty(cells)) return;
        switch (kind) {
          case 'customers':
          case 'suppliers': {
            const code = text(cell(cells, 1));
            const name = text(cell(cells, 0));
            if (!code || !name) return problem(row, 'no account number or name');
            partners.push({
              code,
              name,
              phone: text(cell(cells, 4)) || null,
              balanceIqd: legacyAmount(cell(cells, 2)) ?? 0n,
              balanceUsd: legacyAmount(cell(cells, 3)) ?? 0n,
              kind: kind === 'suppliers' ? 'supplier' : 'customer',
              row,
            });
            return;
          }
          case 'balances': {
            const currency = /usd|دولار/i.test(sheet) ? 'USD' : /iqd|دينار/i.test(sheet) ? 'IQD' : null;
            if (!currency) return problem(row, `sheet "${sheet}" is neither IQD nor USD`);
            const code = text(cell(cells, 1));
            if (!code) return problem(row, 'no account number');
            balances.push({
              code,
              name: text(cell(cells, 0)),
              currency,
              balance: legacyAmount(cell(cells, 2)) ?? 0n,
              lastMovement: legacyDate(cell(cells, 3)),
              lastPayment: legacyDate(cell(cells, 4)),
              row,
            });
            return;
          }
          case 'warehouses': {
            const item = text(cell(cells, 0));
            const warehouse = text(cell(cells, 2));
            if (!item || !warehouse) return problem(row, 'no item or warehouse');
            const quantity = legacyQuantity(cell(cells, 3));
            if (!quantity) return problem(row, `quantity "${text(cell(cells, 3))}" is not a number`);
            positions.push({ item, warehouse, quantity: quantity.quantity, reserved: legacyQuantity(cell(cells, 4))?.quantity ?? 0n, row });
            return;
          }
          case 'materials': {
            // The same positions as the warehouses file, without the reserved
            // column; kept for the cross-check, never for a second import.
            return;
          }
          case 'sales': {
            const quantity = legacyQuantity(cell(cells, 5));
            sales.push({
              listNo: text(cell(cells, 0)),
              customerName: text(cell(cells, 1)),
              item: text(cell(cells, 2)),
              unitCost: legacyAmount(cell(cells, 3)),
              unitPrice: legacyAmount(cell(cells, 4)),
              quantity: quantity?.quantity ?? null,
              unit: quantity?.unit ?? '',
              total: legacyAmount(cell(cells, 6)),
              row,
            });
            return;
          }
          case 'purchases': {
            const quantity = legacyQuantity(cell(cells, 4));
            purchases.push({
              listNo: text(cell(cells, 0)),
              supplierName: text(cell(cells, 1)),
              item: text(cell(cells, 2)),
              unitPrice: legacyAmount(cell(cells, 3)),
              quantity: quantity?.quantity ?? null,
              unit: quantity?.unit ?? '',
              total: legacyAmount(cell(cells, 5)),
              date: legacyDate(cell(cells, 6)),
              row,
            });
            return;
          }
          case 'receipts': {
            vouchers.push({
              kind: 'receipt',
              voucherNo: text(cell(cells, 0)),
              operation: text(cell(cells, 1)),
              amount: legacyAmount(cell(cells, 2)),
              currency: legacyCurrency(cell(cells, 3)),
              name: text(cell(cells, 4)),
              code: text(cell(cells, 5)),
              date: legacyDate(cell(cells, 6)),
              row,
            });
            return;
          }
          case 'payments': {
            vouchers.push({
              kind: 'payment',
              voucherNo: text(cell(cells, 6)),
              operation: text(cell(cells, 5)),
              amount: legacyAmount(cell(cells, 4)),
              currency: legacyCurrency(cell(cells, 3)),
              name: text(cell(cells, 2)),
              code: text(cell(cells, 1)),
              date: legacyDate(cell(cells, 0)),
              row,
            });
            return;
          }
          case 'accounts': {
            const caption = text(cell(cells, 0));
            if (!caption) return;
            accounts.push({ caption, iqd: legacyAmount(cell(cells, 1)), usd: legacyAmount(cell(cells, 2)), final: legacyAmount(cell(cells, 3)) });
            return;
          }
          default:
            return;
        }
      });
    }
  }

  return { files: summary, partners, balances, positions, sales, purchases, vouchers, accounts, problems };
}

// ---------------------------------------------------------------------------
// What the books say, in the shape the import needs
// ---------------------------------------------------------------------------

/** The trial balance's captions, as the accountant's system names them. */
export const TB_CAPTIONS = {
  stock: /مخزون/,
  customers: /الزبائن/,
  cash: /الصناديق/,
  fx: /صيرفة|العملات/,
  capital: /رأس المال/,
  suppliers: /مجهزين|موردين/,
  expenses: /مصاريف/,
  revenues: /ايرادات|إيرادات/,
} as const;

export function tbLine(books: LegacyBooks, which: keyof typeof TB_CAPTIONS): LegacyAccountLine | null {
  return books.accounts.find((line) => TB_CAPTIONS[which].test(line.caption)) ?? null;
}

/** The rate the legacy books carried their dollars at: (IQD + USD × rate = final) solved on the customers line. */
export function impliedRate(books: LegacyBooks): bigint | null {
  for (const line of books.accounts) {
    if (line.iqd === null || line.usd === null || line.final === null || line.usd === 0n) continue;
    const rate = ((line.final - line.iqd) * 10n ** MONEY_SCALE) / line.usd;
    if (rate > 0n) return rate;
  }
  return null;
}

/** The sum of a currency's partner balances, by kind. */
export function balanceTotals(books: LegacyBooks): Record<'customer' | 'supplier', Record<'IQD' | 'USD', bigint>> {
  const totals = { customer: { IQD: 0n, USD: 0n }, supplier: { IQD: 0n, USD: 0n } };
  const kinds = new Map(books.partners.map((p) => [p.code, p.kind] as const));
  for (const balance of books.balances) {
    const kind = kinds.get(balance.code) ?? 'customer';
    totals[kind][balance.currency] += balance.balance;
  }
  return totals;
}

export interface ItemCost {
  readonly item: string;
  /** The latest cost the books carry for the item, from the newest sale (its purchase price) or purchase. */
  readonly unitCost: bigint | null;
  readonly source: 'sale' | 'purchase' | null;
  readonly uom: ReturnType<typeof uomFor>;
}

/** The cost and unit each item is carried at, from the newest line that names it. */
export function itemCosts(books: LegacyBooks): Map<string, ItemCost> {
  const costs = new Map<string, ItemCost>();
  const units = new Map<string, Map<string, number>>();
  const note = (item: string, unit: string) => {
    const key = nameKey(item);
    const bag = units.get(key) ?? new Map<string, number>();
    bag.set(uomFor(unit), (bag.get(uomFor(unit)) ?? 0) + 1);
    units.set(key, bag);
  };
  const preferred = (item: string): ReturnType<typeof uomFor> => {
    const bag = units.get(nameKey(item));
    if (!bag) return 'EA';
    return [...bag.entries()].sort((a, b) => b[1] - a[1])[0]![0] as ReturnType<typeof uomFor>;
  };
  for (const line of books.sales) note(line.item, line.unit);
  for (const line of books.purchases) note(line.item, line.unit);

  // Sales are in list order; purchases carry a date. The newest wins.
  const latestSale = new Map<string, bigint>();
  for (const line of books.sales) {
    if (line.unitCost !== null && line.unitCost > 0n && line.item) latestSale.set(nameKey(line.item), line.unitCost);
  }
  const latestPurchase = new Map<string, { date: string; price: bigint }>();
  for (const line of books.purchases) {
    if (line.unitPrice === null || line.unitPrice <= 0n || !line.item) continue;
    const key = nameKey(line.item);
    const date = line.date ?? '';
    const current = latestPurchase.get(key);
    if (!current || date >= current.date) latestPurchase.set(key, { date, price: line.unitPrice });
  }
  for (const position of books.positions) {
    const key = nameKey(position.item);
    if (costs.has(key)) continue;
    const purchase = latestPurchase.get(key);
    const sale = latestSale.get(key);
    const unitCost = purchase?.price ?? sale ?? null;
    costs.set(key, { item: position.item, unitCost, source: purchase ? 'purchase' : sale !== undefined ? 'sale' : null, uom: preferred(position.item) });
  }
  return costs;
}
