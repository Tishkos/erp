/**
 * REQ-WA-001 WA-7 — a file sent to the group.
 *
 * The point of these is the honesty of the result rather than the parsing:
 * the house's own workbook readers are tested where they live. What matters
 * here is that a file nobody can read says so, that a long one admits it was
 * cut, and that a picture is never treated as though its contents were known
 * — a bot that invents figures out of a photograph of an invoice would be
 * worse than no bot.
 */
import { describe, expect, it } from 'vitest';
import { cap, describeSentFile, kindOf, questionForFiles, sheetsToText, type SentFile } from '@/server/domain/whatsapp-files';
import { extractSentFile } from '@/server/services/whatsapp-files';
import type { CellValue } from '@/server/xlsx-read';

const file = (over: Partial<SentFile> = {}): SentFile => ({
  fileName: 'prices.xlsx',
  kind: 'sheet',
  mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  bytes: 24_000,
  caption: '',
  text: 'a\tb',
  note: null,
  sheets: [{ name: 'Sheet1', rows: 12, columns: 3, rowsShown: 12 }],
  at: '2026-10-02T12:00:00.000Z',
  ...over,
});

describe('WA-7 · what kind of thing arrived', () => {
  it('trusts the name over the type, because WhatsApp mislabels', () => {
    // A workbook arrives as application/octet-stream often enough that the
    // extension is the more reliable of the two.
    expect(kindOf('prices.xlsx', 'application/octet-stream')).toBe('sheet');
    expect(kindOf('statement.pdf', '')).toBe('pdf');
    expect(kindOf('old-book.xls', 'application/octet-stream')).toBe('sheet');
  });

  it('falls back to the type when there is no useful name', () => {
    expect(kindOf('file', 'application/pdf')).toBe('pdf');
    expect(kindOf('file', 'image/jpeg')).toBe('image');
    expect(kindOf('file', 'application/vnd.ms-excel')).toBe('sheet');
    expect(kindOf('file', 'text/csv')).toBe('text');
    expect(kindOf('file', 'application/zip')).toBe('other');
  });
});

describe('WA-7 · a workbook as text', () => {
  const sheets = new Map<string, CellValue[][]>([
    [
      'Items',
      [
        ['code', 'name', 'price'],
        ['SOL-1', 'لوح شمسي', 250_000],
        ['', '', ''],
        ['MOT-1', 'دراجة', 1_500_000],
      ],
    ],
  ]);

  it('keeps the Arabic and drops the empty rows', () => {
    const { text, shapes } = sheetsToText(sheets);
    expect(text).toContain('لوح شمسي');
    expect(text).toContain('SOL-1\tلوح شمسي\t250000');
    // The blank row between them is a spreadsheet's used range, not data.
    expect(shapes[0]!.rows).toBe(3);
    expect(shapes[0]!.columns).toBe(3);
  });

  it('says when it showed only part of a sheet', () => {
    const long = new Map<string, CellValue[][]>([['Big', Array.from({ length: 30 }, (_, i) => [`row${i}`])]]);
    const { text, shapes, truncated } = sheetsToText(long, { rowCap: 10 });
    expect(truncated).toBe(true);
    expect(shapes[0]!.rows).toBe(30);
    expect(shapes[0]!.rowsShown).toBe(10);
    expect(text).toContain('20 more row(s) in this sheet, not shown');
  });

  it('caps the text as well as the rows', () => {
    const wide = new Map<string, CellValue[][]>([['Wide', [[('x').repeat(5_000)]], ]]);
    const { truncated } = sheetsToText(wide, { textCap: 100 });
    expect(truncated).toBe(true);
  });
});

describe('WA-7 · reading a real file', () => {
  it('says a picture is a picture, and does not pretend to have read it', async () => {
    const read = await extractSentFile({ buffer: Buffer.from([0xff, 0xd8, 0xff]), fileName: 'photo.jpg', mimetype: 'image/jpeg' });
    expect(read.kind).toBe('image');
    expect(read.text).toBe('');
    expect(read.note).toMatch(/cannot see inside it/);
  });

  it('reads a csv as it is', async () => {
    const read = await extractSentFile({ buffer: Buffer.from('code,qty\nSOL-1,5\n', 'utf8'), fileName: 'stock.csv', mimetype: 'text/csv' });
    expect(read.kind).toBe('text');
    expect(read.text).toContain('SOL-1,5');
    expect(read.note).toBeNull();
  });

  it('does not throw on a workbook that is not one', async () => {
    // Somebody renames a PDF to .xlsx. The answer is a sentence, not a crash
    // in the middle of a conversation.
    const read = await extractSentFile({ buffer: Buffer.from('not a workbook at all', 'utf8'), fileName: 'prices.xlsx', mimetype: '' });
    expect(read.kind).toBe('sheet');
    expect(read.text).toBe('');
    expect(read.note).toMatch(/could not be read/);
  });

  it('reads a workbook the house writes itself, round trip', async () => {
    // The one end-to-end case: a real xlsx, made by the same library the ERP
    // exports with, read back by the same reader the legacy import used.
    const writeXlsxFile = (await import('write-excel-file/node')).default;
    const buffer = (await writeXlsxFile(
      [
        [{ value: 'code' }, { value: 'name' }],
        [{ value: 'SOL-1' }, { value: 'لوح شمسي' }],
      ] as never,
    ).toBuffer()) as Buffer;

    const read = await extractSentFile({ buffer, fileName: 'items.xlsx', mimetype: '' });
    expect(read.kind).toBe('sheet');
    expect(read.text).toContain('SOL-1');
    expect(read.text).toContain('لوح شمسي');
    expect(read.sheets.length).toBeGreaterThan(0);
  });
});

describe('WA-7 · how a file is put to him', () => {
  it('writes the question for a file sent with no words', () => {
    const asked = questionForFiles('', [file({ fileName: 'statement.pdf', kind: 'pdf', sheets: [] })]);
    expect(asked).toContain('statement.pdf');
    expect(asked).toMatch(/no message/);
    expect(asked).toMatch(/say what it is/);
  });

  it('keeps what they actually typed, and names the file beside it', () => {
    const asked = questionForFiles('does this match our books?', [file()]);
    expect(asked.startsWith('does this match our books?')).toBe(true);
    expect(asked).toContain('prices.xlsx');
    expect(asked).toContain('sent_file');
  });

  it('describes a workbook by its shape', () => {
    expect(describeSentFile(file())).toContain('Sheet1 (12×3)');
    expect(describeSentFile(file({ note: 'only part of this workbook is shown' }))).toContain('only part');
  });

  it('caps plain text and says it capped it', () => {
    expect(cap('x'.repeat(10), 5)).toEqual({ text: 'xxxxx', truncated: true });
    expect(cap('xx', 5).truncated).toBe(false);
  });
});
