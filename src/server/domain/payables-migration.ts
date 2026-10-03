/**
 * REQ-AP-001 §24.3 — reading `QS_DASHBOARD.xlsx` into the rows the import
 * creates, decidable without a database.
 *
 * Columns are found by their header text, not their position, so a column
 * moved in the sheet is still read; a sheet missing a column the import needs
 * is refused by name. Every value that is changed on the way in (a trimmed
 * key, a name with a hidden space, a missing date filled from another column)
 * is noted as a *fix* with its original value, for the report.
 */
import { MONEY_SCALE, parseDecimal } from './money';
import { referenceKey } from './payables';
import { parseContainerList } from './shipments';

export class SheetFormatError extends Error {
  readonly code = 'SHEET_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'SheetFormatError';
  }
}

export type Cell = string | number | boolean | null;
export type Rows = Cell[][];

export interface Fix {
  readonly sheet: string;
  readonly row: number;
  readonly field: string;
  readonly original: string;
  readonly used: string;
}

export interface ImportRow {
  readonly row: number;
  readonly reference: string;
  readonly key: string;
  readonly date: string | null;
  readonly supplierName: string;
  readonly supplierKey: string;
  readonly amount: string;
  readonly quantity: string | null;
  readonly terms: string | null;
  readonly products: string | null;
  readonly legacyCleared: boolean;
  readonly sheetPaid: string;
  readonly sheetApplied: string;
}

export interface PaymentRow {
  readonly row: number;
  readonly reference: string;
  readonly key: string;
  readonly bank: string | null;
  readonly amount: string;
  readonly applicationDate: string | null;
  readonly swiftDate: string | null;
}

export interface PdRow {
  readonly row: number;
  readonly reference: string;
  readonly key: string | null;
  readonly pdNo: string;
  readonly registrationDate: string | null;
  readonly expiryDate: string | null;
  readonly statusLabel: string;
  readonly swift: string | null;
  readonly notes: string | null;
}

export interface PendingRow {
  readonly row: number;
  readonly pdNo: string;
  readonly reference: string | null;
  readonly notes: string;
}

export interface BlRow {
  readonly row: number;
  readonly reference: string;
  readonly key: string | null;
  readonly blNo: string;
  readonly category: string | null;
  readonly pod: string | null;
  readonly totalQty: string | null;
  readonly eta: string | null;
  readonly shippingStatus: string | null;
  readonly portFileSentOn: string | null;
  readonly blDate: string | null;
  readonly containers: string[];
  readonly invalidContainers: string[];
}

export interface DetailRow {
  readonly row: number;
  readonly blNo: string;
  readonly containers: string[];
  readonly model: string;
  readonly plannedQty: string;
  readonly inboundQty: string | null;
  readonly warehouse: string | null;
}

export interface OrderRow {
  readonly row: number;
  readonly key: string;
  readonly model: string;
  readonly specification: string | null;
  readonly quantity: string;
  readonly remarks: string | null;
}

export interface SheetImport {
  readonly imports: ImportRow[];
  readonly payments: PaymentRow[];
  readonly pds: PdRow[];
  readonly pending: PendingRow[];
  readonly bls: BlRow[];
  readonly details: DetailRow[];
  readonly orders: OrderRow[];
  readonly warehouseNames: string[];
  readonly fixes: Fix[];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Trim, collapse spaces, strip U+2002 / NBSP (the sheet carries both). */
export function cleanText(value: Cell): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  return String(value)
    .replace(/[  -​　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A supplier's name as matched: cleaned, upper case, punctuation spaced alike. */
export function supplierKey(name: string): string {
  return cleanText(name)
    .toUpperCase()
    .replace(/[.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An Excel serial date (1900 system) or an ISO text date, as YYYY-MM-DD. */
export function dateOf(value: Cell): string | null {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return iso ? iso[1]! : null;
  }
  if (!Number.isFinite(value) || value < 1) return null;
  return new Date(Math.round((value - 25569) * 86_400_000)).toISOString().slice(0, 10);
}

/** A number cell as a decimal string (4 places at most); blank when empty. */
export function amountOf(value: Cell): string | null {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const text = typeof value === 'number' ? value.toFixed(4) : String(value).replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const trimmed = fraction.slice(0, 4).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

/** A PD number as ASYCUDA prints it: digits, no ".0". */
export function pdNumberOf(value: Cell): string {
  if (typeof value === 'number') return String(Math.round(value));
  return cleanText(value).replace(/\.0+$/, '');
}

function keyOrNull(reference: string): string | null {
  try {
    return referenceKey(reference);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The sheet's status words
// ---------------------------------------------------------------------------

const PD_STATUS: Readonly<Record<string, string>> = {
  submited: 'submitted',
  submitted: 'submitted',
  preapproved: 'pre_approved',
  validated: 'validated',
  partiallywrittenoff: 'partially_written_off',
  totallywrittenoff: 'totally_written_off',
  rejected: 'rejected',
  expiredvalidated: 'expired_validated',
  expiredpartwrittenoff: 'expired_part_written_off',
  expiredpartiallywrittenoff: 'expired_part_written_off',
};

/** ASYCUDA's spelling (as the sheet keeps it) → the PD status code. */
export function pdStatusOf(label: string): string | null {
  return PD_STATUS[label.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/** The BL sheet's shipping status → the container status (§24.3). */
export function containerStatusOf(label: string | null): string {
  const key = (label ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'inbounded' || key === 'received') return 'received';
  if (key === 'onthesea' || key === 'onsea') return 'on_sea';
  if (key === 'onport' || key === 'atport') return 'at_port';
  if (key === 'customscleared') return 'customs_cleared';
  return 'not_loaded';
}

// ---------------------------------------------------------------------------
// Reading a sheet by its headers
// ---------------------------------------------------------------------------

const norm = (header: Cell) => cleanText(header).toLowerCase().replace(/[^a-z0-9]/g, '');

interface Table {
  readonly headerRow: number;
  readonly column: (name: string) => number;
  readonly has: (name: string) => boolean;
  readonly rows: { row: number; cells: Cell[] }[];
}

function table(sheets: ReadonlyMap<string, Rows>, sheet: string, first: string, required: readonly string[]): Table | null {
  const rows = sheets.get(sheet);
  if (!rows) return null;
  const headerRow = rows.findIndex((cells) => cells.some((cell) => norm(cell) === norm(first)));
  if (headerRow < 0) throw new SheetFormatError(`The ${sheet} sheet has no "${first}" header.`);
  const headers = rows[headerRow]!.map(norm);
  const column = (name: string) => headers.indexOf(norm(name));
  for (const name of required) {
    if (column(name) < 0) throw new SheetFormatError(`The ${sheet} sheet has no "${name}" column.`);
  }
  const body = rows
    .slice(headerRow + 1)
    .map((cells, index) => ({ row: headerRow + 2 + index, cells }))
    .filter(({ cells }) => cells.some((cell) => cleanText(cell) !== ''));
  return { headerRow, column, has: (name) => column(name) >= 0, rows: body };
}

const at = (cells: Cell[], index: number): Cell => (index >= 0 ? (cells[index] ?? null) : null);

/** The workbook, read into the rows the import creates. */
export function readSheets(sheets: ReadonlyMap<string, Rows>): SheetImport {
  const fixes: Fix[] = [];
  const note = (sheet: string, row: number, field: string, original: Cell, used: string) => {
    const before = original === null ? '' : String(original);
    if (before !== used) fixes.push({ sheet, row, field, original: before, used });
  };

  // ── dashboard: one row per import ──────────────────────────────────────
  const dash = table(sheets, 'dashboard', 'PO no./ INV.', [
    'PO no./ INV.',
    'INV. Date',
    'Supplier',
    'INV. Amount',
    'INV. Qty',
    'Pmt Terms',
    'Products',
    'Paid Amount (SWIFT)',
    'Applied Amount',
    'Clear?',
  ]);
  if (!dash) throw new SheetFormatError('The workbook has no dashboard sheet.');
  const imports: ImportRow[] = [];
  for (const { row, cells } of dash.rows) {
    const raw = at(cells, dash.column('PO no./ INV.'));
    const reference = cleanText(raw);
    const key = keyOrNull(reference);
    if (!key) continue;
    note('dashboard', row, 'PO no./ INV.', raw, reference);
    const supplierRaw = at(cells, dash.column('Supplier'));
    const supplierName = cleanText(supplierRaw);
    note('dashboard', row, 'Supplier', supplierRaw, supplierName);
    imports.push({
      row,
      reference,
      key,
      date: dateOf(at(cells, dash.column('INV. Date'))),
      supplierName,
      supplierKey: supplierKey(supplierName),
      amount: amountOf(at(cells, dash.column('INV. Amount'))) ?? '0',
      quantity: amountOf(at(cells, dash.column('INV. Qty'))),
      terms: cleanText(at(cells, dash.column('Pmt Terms'))) || null,
      products: cleanText(at(cells, dash.column('Products'))) || null,
      legacyCleared: cleanText(at(cells, dash.column('Clear?'))).toLowerCase() === 'cleared',
      sheetPaid: amountOf(at(cells, dash.column('Paid Amount (SWIFT)'))) ?? '0',
      sheetApplied: amountOf(at(cells, dash.column('Applied Amount'))) ?? '0',
    });
  }

  // ── PMT: one row per application to the bank ──────────────────────────
  const pmt = table(sheets, 'PMT', 'PO/INV. no.', ['PO/INV. no.', 'Bank', 'Application AMT.', 'Application date', 'Swift date']);
  const payments: PaymentRow[] = [];
  for (const { row, cells } of pmt?.rows ?? []) {
    const raw = at(cells, pmt!.column('PO/INV. no.'));
    const reference = cleanText(raw);
    const key = keyOrNull(reference);
    const amount = amountOf(at(cells, pmt!.column('Application AMT.')));
    if (!key || !amount) continue;
    payments.push({
      row,
      reference,
      key,
      bank: cleanText(at(cells, pmt!.column('Bank'))) || null,
      amount,
      applicationDate: dateOf(at(cells, pmt!.column('Application date'))),
      swiftDate: dateOf(at(cells, pmt!.column('Swift date'))),
    });
  }

  // ── PD: every registration, latest status as ASYCUDA spells it ─────────
  const pdTable = table(sheets, 'PD', 'PD No.', ['PO no./ INV.', 'PD No.', 'Registration Date', 'Expire Date', 'Status']);
  const pds: PdRow[] = [];
  for (const { row, cells } of pdTable?.rows ?? []) {
    const pdNo = pdNumberOf(at(cells, pdTable!.column('PD No.')));
    if (!pdNo) continue;
    const reference = cleanText(at(cells, pdTable!.column('PO no./ INV.')));
    pds.push({
      row,
      reference,
      key: reference ? keyOrNull(reference) : null,
      pdNo,
      registrationDate: dateOf(at(cells, pdTable!.column('Registration Date'))),
      expiryDate: dateOf(at(cells, pdTable!.column('Expire Date'))),
      statusLabel: cleanText(at(cells, pdTable!.column('Status'))),
      swift: pdTable!.has('SWIFT') ? cleanText(at(cells, pdTable!.column('SWIFT'))) || null : null,
      notes: pdTable!.has('Notes') ? cleanText(at(cells, pdTable!.column('Notes'))) || null : null,
    });
  }

  // ── Pending: notes the customs officer keeps per PD ───────────────────
  const pendingTable = table(sheets, 'Pending', 'PD No.', ['PD No.', 'Notes']);
  const pending: PendingRow[] = [];
  for (const { row, cells } of pendingTable?.rows ?? []) {
    const pdNo = pdNumberOf(at(cells, pendingTable!.column('PD No.')));
    const extra = cells
      .slice(pendingTable!.column('Notes'))
      .map(cleanText)
      .filter(Boolean)
      .join(' — ');
    if (!pdNo || !extra) continue;
    pending.push({
      row,
      pdNo,
      reference: pendingTable!.has('Invoice / PO') ? cleanText(at(cells, pendingTable!.column('Invoice / PO'))) || null : null,
      notes: extra,
    });
  }

  // ── CTN No. (hidden): containers per B/L, when the BL row has none ─────
  const ctnTable = table(sheets, 'CTN No.', 'BL No.', ['BL No.', 'CTN NO.']);
  const containersByBl = new Map<string, string>();
  for (const { cells } of ctnTable?.rows ?? []) {
    const blNo = cleanText(at(cells, ctnTable!.column('BL No.'))).toUpperCase();
    const list = String(at(cells, ctnTable!.column('CTN NO.')) ?? '');
    if (blNo && list.trim()) containersByBl.set(blNo, list);
  }

  // ── BL: one row per bill of lading ─────────────────────────────────────
  const blTable = table(sheets, 'BL', 'BL No.', ['Po/INV. NO.', 'BL No.', 'POD', 'BL Total Qty', 'ETA', 'Shipping Status', 'BL Date']);
  const bls: BlRow[] = [];
  for (const { row, cells } of blTable?.rows ?? []) {
    const blRaw = at(cells, blTable!.column('BL No.'));
    const blNo = cleanText(blRaw).toUpperCase();
    if (!blNo) continue;
    note('BL', row, 'BL No.', blRaw, blNo);
    const reference = cleanText(at(cells, blTable!.column('Po/INV. NO.')));
    const listed = blTable!.has('CTN No.') ? String(at(cells, blTable!.column('CTN No.')) ?? '') : '';
    const parsed = parseContainerList(listed.trim() ? listed : (containersByBl.get(blNo) ?? ''));
    bls.push({
      row,
      reference,
      key: reference ? keyOrNull(reference) : null,
      blNo,
      category: blTable!.has('Product Category') ? cleanText(at(cells, blTable!.column('Product Category'))) || null : null,
      pod: cleanText(at(cells, blTable!.column('POD'))) || null,
      totalQty: amountOf(at(cells, blTable!.column('BL Total Qty'))),
      eta: dateOf(at(cells, blTable!.column('ETA'))),
      shippingStatus: cleanText(at(cells, blTable!.column('Shipping Status'))) || null,
      portFileSentOn: blTable!.has('PORT File Sent?') ? dateOf(at(cells, blTable!.column('PORT File Sent?'))) : null,
      blDate: dateOf(at(cells, blTable!.column('BL Date'))),
      containers: parsed.numbers,
      invalidContainers: parsed.invalid,
    });
  }

  // ── BL Product Detail: model × container × warehouse ──────────────────
  const detailTable = table(sheets, 'BL Product Detail', 'BL No.', ['BL No.', 'CTN No.', 'Model', 'Planned Inbound Qty']);
  const details: DetailRow[] = [];
  for (const { row, cells } of detailTable?.rows ?? []) {
    const blNo = cleanText(at(cells, detailTable!.column('BL No.'))).toUpperCase();
    const model = cleanText(at(cells, detailTable!.column('Model')));
    const planned = amountOf(at(cells, detailTable!.column('Planned Inbound Qty')));
    if (!blNo || !model || !planned) continue;
    details.push({
      row,
      blNo,
      containers: parseContainerList(String(at(cells, detailTable!.column('CTN No.')) ?? '')).numbers,
      model,
      plannedQty: planned,
      inboundQty: detailTable!.has('SKU Inbound Qty') ? amountOf(at(cells, detailTable!.column('SKU Inbound Qty'))) : null,
      warehouse: detailTable!.has('Warehouse') ? cleanText(at(cells, detailTable!.column('Warehouse'))) || null : null,
    });
  }

  // ── Pending Order: the model lines of orders not yet shipped ──────────
  const orderTable = table(sheets, 'Pending Order', 'PO/INV No.', ['PO/INV No.', 'Model / SKU', 'Order Qty']);
  const orders: OrderRow[] = [];
  for (const { row, cells } of orderTable?.rows ?? []) {
    const key = keyOrNull(cleanText(at(cells, orderTable!.column('PO/INV No.'))));
    const model = cleanText(at(cells, orderTable!.column('Model / SKU')));
    const quantity = amountOf(at(cells, orderTable!.column('Order Qty')));
    if (!key || !model || !quantity) continue;
    orders.push({
      row,
      key,
      model,
      specification: orderTable!.has('Specification') ? cleanText(at(cells, orderTable!.column('Specification'))) || null : null,
      quantity,
      remarks: orderTable!.has('Remarks') ? cleanText(at(cells, orderTable!.column('Remarks'))) || null : null,
    });
  }

  // ── Warehouse Master: names only, reconciled in the report ────────────
  const masterRows = sheets.get('Warehouse Master') ?? [];
  const warehouseNames = [
    ...new Set(
      masterRows
        .slice(1)
        .map((cells) => cleanText(cells[0] ?? null))
        .filter((name) => name && !/warehouse/i.test(name)),
    ),
  ];

  return { imports, payments, pds, pending, bls, details, orders, warehouseNames, fixes };
}

// ---------------------------------------------------------------------------
// §20.1 — what the sheet's own data says about clearing
// ---------------------------------------------------------------------------

export interface ClearingVerdict {
  readonly fullyPaid: boolean;
  readonly allReceived: boolean;
  readonly pdsWrittenOff: boolean;
  readonly cleared: boolean;
}

/** The three §20.1 conditions, read from the sheet rows of one import. */
export function clearingFromSheet(
  input: ImportRow,
  payments: readonly PaymentRow[],
  pds: readonly PdRow[],
  bls: readonly BlRow[],
): ClearingVerdict {
  // HD8 — the sheet's amounts are decimal strings with at most four places
  // (`amountOf`); they are compared as scaled integers, never as doubles.
  const scaled = (value: string | null) => parseDecimal(value ?? '0', MONEY_SCALE);
  const paid = payments.filter((p) => p.swiftDate).reduce((sum, p) => sum + scaled(p.amount), 0n);
  const invoiced = scaled(input.amount);
  const fullyPaid = invoiced > 0n && paid >= invoiced && payments.every((p) => p.swiftDate);
  const containers = bls.flatMap((bl) => bl.containers.map(() => containerStatusOf(bl.shippingStatus)));
  const received = bls
    .filter((bl) => containerStatusOf(bl.shippingStatus) === 'received')
    .reduce((sum, bl) => sum + scaled(bl.totalQty), 0n);
  const allReceived =
    containers.length > 0 &&
    containers.every((status) => status === 'received') &&
    received === scaled(input.quantity);
  const pdsWrittenOff = pds.length > 0 && pds.every((pd) => pdStatusOf(pd.statusLabel) === 'totally_written_off');
  return { fullyPaid, allReceived, pdsWrittenOff, cleared: fullyPaid && allReceived && pdsWrittenOff };
}
