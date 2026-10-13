/**
 * REQ-AP-001 §24.3 — reading the sheet, without a database (2026-10-13).
 *
 *   * The Pending sheet is several lists, each under its own header. A note is
 *     words beside a PD — under "Notes", or to the right of the list's last
 *     header. Read as one table it gave a date serial ("46224") and a status
 *     ("Submited") as notes of twenty-two PDs.
 *   * The Warehouse Master's names are under "Warehouse Name"; its codes
 *     (W01…) and the placeholders not named yet are nobody's warehouse.
 *   * "PORT File Sent?" answered YES is kept, though it is no date.
 */
import { describe, expect, it } from 'vitest';
import { readSheets, type Rows } from '@/server/domain/payables-migration';

const DASHBOARD: Rows = [
  ['PO no./ INV.', 'INV. Date', 'Supplier', 'INV. Amount', 'INV. Qty', 'Pmt Terms', 'Products', 'Paid Amount (SWIFT)', 'Applied Amount', 'Clear?'],
  ['AIK-001', 46082, 'AIKO', 1000, 10, 'CFR', 'panel', 0, 0, null],
];

const read = (extra: Record<string, Rows>) => readSheets(new Map<string, Rows>([['dashboard', DASHBOARD], ...Object.entries(extra)]));

describe('the Pending sheet is read list by list', () => {
  const PENDING: Rows = [
    [null],
    ['PD No.', 'Invoice / PO', 'Status', 'Notes'],
    [5596, 'SKTCWX250118-3-IQ', 'Expired validated', 'all file at the bank, settlement 2025', null, null, '3597 need swift'],
    [10204, 'C251021FS01-3', 'Totally written off'],
    [56962, 'ZWN-IQ-PEGLJY042226-028', 'Validated', null, 'One invoice, two PD?', 'Other PD: 93976'],
    [null],
    ['PD Number', 'Date', 'Invoice No.', 'Status'],
    [302, 46026, 'WMT25014A', 'Submited'],
    [23545, 46061, 'M40251213158&M40251213440', 'Submited'],
    [null],
    ['Expired validated'],
    ['PD No.', 'Invoice Number', 'Registration Date', 'Expire Date'],
    [3597, 'HAM-HM20250915 IRAQ05', 46030, 46224],
    [11394, 'SQ-20250417-001', 46042, 46250, 'settlement of 2025'],
    [null],
    ['PD No.', 'Invoice Number', 'Registration Date', 'Expire Date', 'Status'],
    [9330, 'CSA-AL0001-1', 46040, 46275, 'Partially written off', 'all should be provided tomorrow.'],
    [14158, '20251224FF', 46047, 46233, 'Expired Part writtenOff', 'ask port files from pd settling.', ' '],
    [null],
    ['PD No.', 'Date', 'Status'],
    [24604, 46063, 'Expired validated'],
  ];

  it('keeps the words written beside a PD, and nothing that is a list’s own column', () => {
    const { pending } = read({ Pending: PENDING });
    expect(pending.map((row) => [row.pdNo, row.notes])).toEqual([
      ['5596', 'all file at the bank, settlement 2025 — 3597 need swift'],
      ['56962', 'One invoice, two PD? — Other PD: 93976'],
      ['11394', 'settlement of 2025'],
      ['9330', 'all should be provided tomorrow.'],
      ['14158', 'ask port files from pd settling.'],
    ]);
    // Never a date serial, a status or a header as a note.
    for (const row of pending) expect(row.notes).not.toMatch(/^[0-9]+$|Submited|written ?off|Expire Date|^Status$/i);
  });

  it('names the row and the invoice of each note, whatever its list calls the invoice', () => {
    const { pending } = read({ Pending: PENDING });
    expect(pending.map((row) => [row.row, row.reference])).toEqual([
      [3, 'SKTCWX250118-3-IQ'],
      [5, 'ZWN-IQ-PEGLJY042226-028'],
      [14, 'SQ-20250417-001'],
      [17, 'CSA-AL0001-1'],
      [18, '20251224FF'],
    ]);
  });

  it('a sheet with no Pending list, or a list with no notes, gives none', () => {
    expect(read({}).pending).toEqual([]);
    expect(read({ Pending: [['PD No.', 'Date', 'Status'], [24604, 46063, 'Validated']] }).pending).toEqual([]);
  });
});

describe('the Warehouse Master gives names', () => {
  it('reads "Warehouse Name", not the sheet’s own codes or its unnamed placeholders', () => {
    const { warehouseNames } = read({
      'Warehouse Master': [
        ['WAREHOUSE MASTER'],
        ['Rename Warehouse Name for the 9 warehouses.'],
        ['Warehouse Code', 'Warehouse Name', 'Region / City', 'Active'],
        ['W01', 'CNBM', null, 'YES'],
        ['W02', 'Baghdad - Al-Jurf', null, 'YES'],
        ['W03', 'Warehouse 3', null, 'YES'],
      ],
    });
    expect(warehouseNames).toEqual(['CNBM', 'Baghdad - Al-Jurf']);
  });

  it('a one-column list is that column, under its heading', () => {
    expect(read({ 'Warehouse Master': [['Warehouse'], ['W01']] }).warehouseNames).toEqual(['W01']);
  });
});

describe('"PORT File Sent?" answered YES', () => {
  const HEAD = ['Po/INV. NO.', 'BL No.', 'POD', 'BL Total Qty', 'ETA', 'Shipping Status', 'PORT File Sent?', 'BL Date', 'CTN No.'];

  it('is kept as sent with no date; a date is kept as the date; an empty cell is not sent', () => {
    const { bls } = read({
      BL: [
        HEAD,
        ['AIK-001', 'GGZ3177081', 'AQABA', 211, 46294, 'On the sea', 'YES', 46265, 'ECMU5370319'],
        ['AIK-001', 'GGZ3177084', 'AQABA', 440, 46294, 'On the sea', 46270, 46265, 'CMAU8936006'],
        ['AIK-001', 'SHZ8290087', 'AQABA', 211, 46265, 'On port', null, 46215, 'TXGU4289991'],
      ],
    });
    expect(bls.map((bl) => [bl.blNo, bl.portFileSent, bl.portFileSentOn])).toEqual([
      ['GGZ3177081', true, null],
      ['GGZ3177084', true, '2026-09-05'],
      ['SHZ8290087', false, null],
    ]);
  });
});
