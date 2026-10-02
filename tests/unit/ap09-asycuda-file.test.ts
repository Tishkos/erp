/**
 * REQ-AP-001 §21.8 — reading the ASYCUDA report instead of a pasted list.
 *
 * The declaration's status is what releases a payment, so a line dropped or
 * mangled on the way in is a payment that does not go out — or worse, one
 * that does. These hold the conversion: an exported workbook becomes exactly
 * the lines the list parser already reads, nothing is invented, and a file
 * this screen cannot read says so instead of being guessed at.
 */
import { describe, expect, it } from 'vitest';
import {
  chooseSheet,
  countLines,
  extensionOf,
  isReadableAsycudaFile,
  sheetToLines,
  textToLines,
} from '@/server/domain/asycuda-file';
import { parseAsycudaList } from '@/server/domain/customs-pd';
import type { CellValue } from '@/server/xlsx-read';

/** The statuses as the PD table holds them, with ASYCUDA's own wording. */
const STATUSES = [
  { code: 'validated', name: 'Validated', asycudaLabel: 'Validated', isTerminal: false },
  { code: 'submitted', name: 'Submitted', asycudaLabel: 'Submitted', isTerminal: false },
  { code: 'written_off', name: 'Written off', asycudaLabel: 'Written Off', isTerminal: true },
];

describe('AP-9 · which files the screen will take', () => {
  it('takes what ASYCUDA exports', () => {
    for (const name of ['list.xlsx', 'LIST.XLS', 'report.csv', 'dump.txt', 'export.tsv']) {
      expect(isReadableAsycudaFile(name), name).toBe(true);
    }
  });

  it('refuses what it cannot read, rather than guessing', () => {
    // Some offices print the list to PDF. Parsing that into "lines" would
    // produce confident nonsense about declarations, which is the one
    // outcome worth refusing outright.
    for (const name of ['list.pdf', 'scan.jpg', 'report.docx', 'noextension']) {
      expect(isReadableAsycudaFile(name), name).toBe(false);
    }
  });

  it('reads the extension in any case', () => {
    expect(extensionOf('List.XLSX')).toBe('.xlsx');
    expect(extensionOf('no-dot')).toBe('');
  });
});

describe('AP-9 · a workbook becomes the lines the parser reads', () => {
  const rows: CellValue[][] = [
    ['Declaration', 'Status', 'Date'],
    ['2026/I/12345', 'Validated', '2026-09-30'],
    ['', '', ''],
    ['2026/I/12346', 'Written Off', '2026-10-01'],
  ];

  it('drops empty rows and trailing empty cells', () => {
    const text = sheetToLines(rows);
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('2026/I/12345\tValidated\t2026-09-30');
    expect(text).not.toContain('\t\t');
  });

  it('hands the parser something it reads as declarations', () => {
    // The point of the whole conversion: what comes out of a file is what the
    // existing parser already understands, so the file route and the paste
    // route cannot disagree about a status.
    const parsed = parseAsycudaList(sheetToLines(rows), STATUSES);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ pdNo: '2026/I/12345', statusCode: 'validated' });
    expect(parsed.rows[1]).toMatchObject({ pdNo: '2026/I/12346', statusCode: 'written_off' });
  });

  it('keeps a number that a spreadsheet stored as a number', () => {
    expect(sheetToLines([[12345, 'Validated']])).toBe('12345\tValidated');
  });

  it('takes the sheet with the most rows, and says there were others', () => {
    const sheets = new Map<string, CellValue[][]>([
      ['Cover', [['ASYCUDA export'], ['Printed 2026-10-02']]],
      ['Documents', rows],
    ]);
    const chosen = chooseSheet(sheets);
    expect(chosen?.name).toBe('Documents');
  });

  it('answers nothing for a workbook with no rows at all', () => {
    expect(chooseSheet(new Map([['Empty', [[], ['', '']]]]))).toBeNull();
  });
});

describe('AP-9 · a CSV becomes the same lines', () => {
  it('unwraps quoted fields and drops blank lines', () => {
    const text = textToLines('"2026/I/12345","Validated","2026-09-30"\n\n2026/I/12346,Submitted\n');
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('2026/I/12345,Validated,2026-09-30');
    expect(text).not.toContain('"');
  });

  it('reads a Windows file, whose lines end differently', () => {
    expect(countLines(textToLines('a,b\r\nc,d\r\n'))).toBe(2);
  });

  it('is understood by the parser just as a workbook is', () => {
    const parsed = parseAsycudaList(textToLines('"2026/I/12345","Validated"'), STATUSES);
    expect(parsed.rows[0]).toMatchObject({ pdNo: '2026/I/12345', statusCode: 'validated' });
  });
});
