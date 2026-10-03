import type { Blob } from 'node:buffer';
import type Stream from 'node:stream';
import writeExcelFile, { type Cell as SheetCell, type Feature, type Row as SheetRow } from 'write-excel-file/node';

/** What the Node build of the library writes a file's parts as. */
type FileContent = Stream | Buffer | Blob;
import { printedAt } from './format';
import { counts, isNumeric, type Column, type Letterhead, type PrintModel, type Table } from './model';

/**
 * The workbook — for someone who will work the figures, not file them.
 *
 * So every figure is a number Excel can add, not text that looks like one; a
 * date is a date; a code is text (so ITM-000001 and 0012 survive). The
 * totals row is a formula over the lines above it, so a line deleted or
 * corrected in the copy moves the total with it — and each formula also
 * carries the service's figure as its stored value, so a viewer that does not
 * recalculate (a phone's preview, a mail client) still shows the total.
 *
 * The letterhead and the filters the report was run with sit above the
 * table; the table's heading row is frozen, so it stays in view however far
 * down the lines go. Arabic workbooks open right to left.
 */

const FONT = 'Arial';
const HEAD_FILL = '#E6E6E6';
const TOTAL_FILL = '#F1F1F1';

export async function renderXlsx(model: PrintModel, head: Letterhead): Promise<Buffer> {
  const columns = model.tables[0]?.columns ?? [];
  const width = Math.max(columns.length, 4);
  const rows: SheetRow[] = [];
  const cached = new Map<string, number>();

  const span = (value: string, style: Partial<Record<string, unknown>> = {}): SheetRow => [
    { value, type: String, columnSpan: width, ...style } as SheetCell,
    ...Array.from({ length: width - 1 }, () => null),
  ];

  rows.push(span(`${head.companyEn} — ${head.companyAr}`, { fontWeight: 'bold', fontSize: 13 }));
  rows.push(
    span([model.title, model.number].filter(Boolean).join(' — '), { fontWeight: 'bold', fontSize: 12 }),
  );
  rows.push(
    span(
      [
        `${head.labels.branch}: ${head.branch}`,
        `${head.labels.printedAt}: ${printedAt(head.printedAt, head.locale)}`,
        `${head.labels.printedBy}: ${head.printedBy}`,
      ].join('   ·   '),
      { textColor: '#444444' },
    ),
  );
  // A workbook has no watermark, so an unposted document says so in red
  // above everything else it says.
  if (model.kind === 'document' && model.posted === false) {
    rows.push(span(head.labels.watermark, { fontWeight: 'bold', textColor: '#B00020', fontSize: 12 }));
  }

  const facts = (list: PrintModel['fields']) => {
    // Two to a row where the table is wide enough, as on paper.
    const perRow = width >= 4 ? 2 : 1;
    const slot = Math.floor(width / perRow);
    for (let i = 0; i < list.length; i += perRow) {
      const row: SheetCell[] = Array.from({ length: width }, () => null);
      list.slice(i, i + perRow).forEach((fact, index) => {
        const at = index * slot;
        row[at] = { value: fact.label, type: String, fontWeight: 'bold', textColor: '#444444' };
        row[at + 1] = { value: fact.value, type: String, columnSpan: Math.max(1, slot - 1), wrap: true };
      });
      rows.push(row);
    }
  };

  if (model.fields.length > 0) facts(model.fields);
  if (model.filters.length > 0) {
    rows.push(span(head.labels.filters, { fontWeight: 'bold' }));
    facts(model.filters);
  }
  rows.push([]);

  let frozen = 0;
  model.tables.forEach((table, index) => {
    if (table.title) rows.push(span(table.title, { fontWeight: 'bold', fontSize: 11 }));
    rows.push(headerRow(table.columns, model));
    if (index === 0) frozen = rows.length;
    writeTable(table, model, rows, cached);
    rows.push([]);
  });

  if (model.summary.length > 0) {
    for (const fact of model.summary) {
      const row: SheetCell[] = Array.from({ length: width }, () => null);
      row[0] = { value: fact.label, type: String, fontWeight: 'bold', columnSpan: width - 1 };
      row[width - 1] = numberCell(fact.value, model, { fontWeight: 'bold', backgroundColor: TOTAL_FILL }) ?? {
        value: fact.value,
        type: String,
        fontWeight: 'bold',
      };
      rows.push(row);
    }
  }

  const buffer = await writeExcelFile(
    rows,
    {
      sheet: sheetName(model.sheetName),
      columns: Array.from({ length: width }, (_, i) => ({ width: columnWidth(columns[i]) })),
      stickyRowsCount: frozen,
      rightToLeft: head.locale === 'ar',
      ...(model.orientation === 'landscape' ? { orientation: 'landscape' as const } : {}),
    },
    { fontFamily: FONT, fontSize: 10, features: [cachedTotals(cached)] },
  ).toBuffer();
  return buffer;
}

function headerRow(columns: readonly Column[], model: PrintModel): SheetRow {
  return columns.map((column) => ({
    value: column.kind === 'money' ? `${column.label} (${model.currency})` : column.label,
    type: String,
    fontWeight: 'bold',
    backgroundColor: HEAD_FILL,
    borderStyle: 'thin',
    borderColor: '#777777',
    wrap: true,
    alignVertical: 'center',
    ...(isNumeric(column) ? { align: 'right' as const } : {}),
  }));
}

function writeTable(table: Table, model: PrintModel, rows: SheetRow[], cached: Map<string, number>) {
  const first = rows.length + 1; // 1-based row of the first line
  const counted: number[] = [];
  table.rows.forEach((row, index) => {
    const bold = row.tone !== undefined && row.tone !== 'line' && row.tone !== 'account';
    rows.push(
      table.columns.map((column, i) => {
        const value = row.cells[column.key] ?? null;
        const style = {
          borderStyle: 'thin' as const,
          borderColor: '#BBBBBB',
          ...(bold ? { fontWeight: 'bold' as const } : {}),
          ...(i === 0 && row.depth ? { indent: row.depth } : {}),
        };
        return cell(column, value, model, style);
      }),
    );
    if (counts(row)) counted.push(first + index);
  });

  if (!table.totals) return;
  const totals = table.totals;
  const firstTotal = table.columns.findIndex((column) => (totals.cells[column.key] ?? null) !== null);
  const labelSpan = firstTotal <= 0 ? 1 : firstTotal;
  const totalRow = rows.length + 1;
  const line: SheetCell[] = table.columns.map(() => null);
  line[0] = {
    value: totals.label,
    type: String,
    fontWeight: 'bold',
    backgroundColor: TOTAL_FILL,
    topBorderStyle: 'medium',
    columnSpan: labelSpan,
  };
  table.columns.forEach((column, i) => {
    if (i < labelSpan) return;
    const value = totals.cells[column.key] ?? null;
    const style = { fontWeight: 'bold' as const, backgroundColor: TOTAL_FILL, topBorderStyle: 'medium' as const };
    if (value === null) {
      line[i] = { value: '', type: String, ...style };
      return;
    }
    if (isNumeric(column) && (totals.sum === undefined || totals.sum.includes(column.key))) {
      const letter = columnLetter(i);
      const formula = sumFormula(letter, counted);
      const format = numberFormat(column, model);
      line[i] = { value: formula, type: 'Formula', ...(format ? { format } : {}), ...style };
      cached.set(`${letter}${totalRow}`, Number(value));
      return;
    }
    line[i] = cell(column, value, model, style);
  });
  rows.push(line);
}

/** SUM over the rows that count: one range when they are contiguous. */
export function sumFormula(letter: string, rowNumbers: readonly number[]): string {
  if (rowNumbers.length === 0) return '0';
  const contiguous = rowNumbers.every((n, i) => i === 0 || n === rowNumbers[i - 1]! + 1);
  if (contiguous) return `SUM(${letter}${rowNumbers[0]}:${letter}${rowNumbers[rowNumbers.length - 1]})`;
  // Excel takes at most 255 arguments to one SUM; nest beyond that.
  const refs = rowNumbers.map((n) => `${letter}${n}`);
  const groups: string[] = [];
  for (let i = 0; i < refs.length; i += 200) groups.push(`SUM(${refs.slice(i, i + 200).join(',')})`);
  return groups.length === 1 ? groups[0]! : `SUM(${groups.join(',')})`;
}

function cell(column: Column, value: string | null, model: PrintModel, style: Record<string, unknown>): SheetCell {
  if (value === null || value === '') return { value: '', type: String, ...style } as SheetCell;
  if (isNumeric(column)) {
    return numberCell(value, model, style, column) ?? ({ value, type: String, ...style } as SheetCell);
  }
  if (column.kind === 'date') {
    const [y, m, d] = value.split('-').map(Number);
    if (y && m && d) {
      return { value: new Date(Date.UTC(y, m - 1, d)), type: Date, format: 'yyyy-mm-dd', ...style } as SheetCell;
    }
  }
  return {
    value,
    type: String,
    ...(column.kind === 'code' ? { format: '@' } : { wrap: true }),
    ...style,
  } as SheetCell;
}

function numberCell(
  value: string,
  model: PrintModel,
  style: Record<string, unknown>,
  column?: Column,
): SheetCell | null {
  const number = Number(value);
  if (!Number.isFinite(number) || value.trim() === '') return null;
  const format = column ? numberFormat(column, model) : moneyFormat(model);
  return { value: number, type: Number, ...(format ? { format } : {}), ...style } as SheetCell;
}

function moneyFormat(model: PrintModel): string {
  return model.currency === 'USD' ? '#,##0.00;(#,##0.00)' : '#,##0;(#,##0)';
}

function numberFormat(column: Column, model: PrintModel): string | undefined {
  // A quantity keeps Excel's General format: whole units without a point,
  // fractions as far as they go.
  if (column.kind !== 'money') return undefined;
  if (column.sides) {
    const figure = model.currency === 'USD' ? '#,##0.00' : '#,##0';
    return `${figure} "${column.sides.debit}";${figure} "${column.sides.credit}";0`;
  }
  if (column.decimals !== undefined) return `#,##0.${'0'.repeat(Math.min(2, column.decimals))}${'#'.repeat(Math.max(0, column.decimals - 2))}`;
  return moneyFormat(model);
}

function columnWidth(column: Column | undefined): number {
  if (!column) return 16;
  switch (column.kind) {
    case 'text':
      return 34;
    case 'money':
      return 18;
    case 'quantity':
      return 12;
    case 'date':
      return 13;
    default:
      return column.key === 'line_no' ? 6 : 20;
  }
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Excel's rules for a sheet name: 31 characters, none of []:*?/\ . */
export function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet1';
}

/**
 * Store each total's figure beside its formula, and ask Excel to recalculate
 * on opening. A formula with no stored value shows as blank or 0 in any
 * reader that does not calculate.
 */
function cachedTotals(values: ReadonlyMap<string, number>): Feature<FileContent> {
  return {
    files: {
      transform: {
        'xl/workbook.xml': {
          transform: (content) => content.replace(/<calcPr\s*\/>/, '<calcPr fullCalcOnLoad="1"/>'),
        },
        'xl/worksheets/sheet{id}.xml': {
          transform: (content) =>
            content.replace(
              /<c r="([A-Z]+\d+)"([^>]*)><f>([^<]*)<\/f><\/c>/g,
              (whole, ref: string, attributes: string, formula: string) =>
                values.has(ref) ? `<c r="${ref}"${attributes}><f>${formula}</f><v>${values.get(ref)}</v></c>` : whole,
            ),
        },
      },
    },
  };
}
