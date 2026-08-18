/**
 * Phase 01.11 test gate — parsing, validation summary and the error file.
 *
 * The "same permissions and validations as manual entry" assertion needs the
 * real services and is in tests/integration/phase01-import.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  ImportParseError,
  ImportRowError,
  ImportStateError,
  assertBatchTransition,
  assertColumnsPresent,
  assertCommittable,
  booleanCell,
  errorFile,
  optionalCell,
  parseDelimited,
  requireCell,
  summarise,
  type RawImportRow,
  type RowValidation,
} from '@domain/import';

describe('reading a delimited file', () => {
  it('reads a header and its rows', () => {
    const { columns, rows } = parseDelimited('code,name\nBP-1,Acme\nBP-2,Globex\n');

    expect(columns).toEqual(['code', 'name']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rowNo: 1, values: { code: 'BP-1', name: 'Acme' } });
    expect(rows[1]!.rowNo).toBe(2);
  });

  it('keeps a comma inside a quoted cell', () => {
    // A legal name containing a comma is ordinary. A parser that split on every
    // comma would import the row with the wrong data in it, silently.
    const { rows } = parseDelimited('code,name\nBP-1,"Acme, Trading & Co."\n');
    expect(rows[0]!.values.name).toBe('Acme, Trading & Co.');
  });

  it('keeps a newline inside a quoted cell', () => {
    const { rows } = parseDelimited('code,address\nBP-1,"Line one\nLine two"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values.address).toBe('Line one\nLine two');
  });

  it('unescapes a doubled quote', () => {
    const { rows } = parseDelimited('code,name\nBP-1,"The ""Big"" Co"\n');
    expect(rows[0]!.values.name).toBe('The "Big" Co');
  });

  it('treats an empty cell as absent, not as an empty string', () => {
    const { rows } = parseDelimited('code,name,email\nBP-1,Acme,\n');
    expect(rows[0]!.values.email).toBeNull();
  });

  it('handles CRLF and skips blank lines', () => {
    const { rows } = parseDelimited('code,name\r\nBP-1,Acme\r\n\r\nBP-2,Globex\r\n');
    expect(rows).toHaveLength(2);
  });

  it('picks up the source id column (§26)', () => {
    const { rows } = parseDelimited('source_id,code,name\nLEGACY-77,BP-1,Acme\n', {
      sourceIdColumn: 'source_id',
    });
    expect(rows[0]!.sourceId).toBe('LEGACY-77');
  });

  it('refuses a file with no header', () => {
    expect(() => parseDelimited('')).toThrow(ImportParseError);
  });

  it('names the columns a definition needs when they are missing', () => {
    // A missing column fails the whole file, not a row: every row would fail
    // for the same reason and the error file would be the file.
    expect(() =>
      assertColumnsPresent(
        {
          key: 'business_partner',
          label: 'Business Partner',
          permissionObject: 'business_partner',
          requiredColumns: ['code', 'legal_name'],
          mapRow: () => ({}),
        },
        ['code', 'name'],
      ),
    ).toThrow(/missing the column\(s\) legal_name/);
  });
});

describe('reading cells', () => {
  const row: RawImportRow = {
    rowNo: 3,
    sourceId: null,
    values: { code: 'BP-1', empty: null, flag: 'Yes', bad: 'maybe' },
  };

  it('names the column when a required cell is empty', () => {
    expect(() => requireCell(row, 'empty')).toThrow(ImportRowError);
    expect(() => requireCell(row, 'empty')).toThrow(/Row 3: empty is empty and is required/);
  });

  it('returns null for an optional empty cell', () => {
    expect(optionalCell(row, 'empty')).toBeNull();
    expect(optionalCell(row, 'code')).toBe('BP-1');
  });

  it('reads yes/no tolerantly — files come from spreadsheets', () => {
    expect(booleanCell(row, 'flag')).toBe(true);
    expect(booleanCell(row, 'empty', false)).toBe(false);
  });

  it('refuses a value that is neither', () => {
    expect(() => booleanCell(row, 'bad')).toThrow(/must be yes or no/);
  });
});

describe('§4.4 · the validation preview', () => {
  const validations: RowValidation[] = [
    { rowNo: 1, status: 'valid', errorCode: null, errorMessage: null },
    { rowNo: 2, status: 'invalid', errorCode: 'PARTNER_DUPLICATE', errorMessage: 'Looks like BP-1' },
    { rowNo: 3, status: 'valid', errorCode: null, errorMessage: null },
  ];

  it('counts what passed and what did not', () => {
    const preview = summarise(validations);
    expect(preview).toMatchObject({ totalRows: 3, validRows: 2, invalidRows: 1 });
  });

  it('is committable only when every row passed', () => {
    // All-or-nothing on purpose: a file with one bad row is corrected and
    // re-uploaded, rather than half-imported and reconciled by hand.
    expect(summarise(validations).committable).toBe(false);
    expect(summarise(validations.filter((v) => v.status === 'valid')).committable).toBe(true);
  });

  it('is not committable when the file was empty', () => {
    expect(summarise([]).committable).toBe(false);
    expect(() => assertCommittable(summarise([]))).toThrow(/contained no rows/);
  });

  it('says how many rows failed and that nothing was imported', () => {
    expect(() => assertCommittable(summarise(validations))).toThrow(
      /1 of 3 rows failed validation/,
    );
    expect(() => assertCommittable(summarise(validations))).toThrow(
      /nothing has been imported/,
    );
  });
});

describe('§4.4 · the error file', () => {
  const rawRows: RawImportRow[] = [
    { rowNo: 1, sourceId: 'L-1', values: { code: 'BP-1', legal_name: 'Acme' } },
    { rowNo: 2, sourceId: 'L-2', values: { code: 'BP-2', legal_name: 'Acme, Trading' } },
  ];

  const validations: RowValidation[] = [
    { rowNo: 1, status: 'valid', errorCode: null, errorMessage: null },
    {
      rowNo: 2,
      status: 'invalid',
      errorCode: 'PARTNER_DUPLICATE',
      errorMessage: 'Looks like an existing partner: BP-1',
    },
  ];

  it('contains only the failures, with their original values beside the reason', () => {
    // Someone must be able to open it, see what was wrong and fix the source. A
    // list of row numbers would send them back to count lines in the original.
    const csv = errorFile(rawRows, validations, ['code', 'legal_name']);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('row,source_id,code,legal_name,error_code,error');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('BP-2');
    expect(lines[1]).toContain('PARTNER_DUPLICATE');
  });

  it('quotes a value containing a comma so the file re-reads correctly', () => {
    const csv = errorFile(rawRows, validations, ['code', 'legal_name']);
    expect(csv).toContain('"Acme, Trading"');

    // And the file it produces can be parsed straight back.
    const reparsed = parseDelimited(csv);
    expect(reparsed.rows[0]!.values.legal_name).toBe('Acme, Trading');
  });

  it('is empty of rows when everything passed', () => {
    const csv = errorFile(rawRows, [validations[0]!], ['code']);
    expect(csv.split('\n')).toHaveLength(1);
  });
});

describe('the batch lifecycle', () => {
  it('goes draft → validated → committed', () => {
    expect(() => assertBatchTransition('draft', 'validated')).not.toThrow();
    expect(() => assertBatchTransition('validated', 'committed')).not.toThrow();
    expect(() => assertBatchTransition('committed', 'rolled_back')).not.toThrow();
  });

  it('refuses to commit a batch that was never validated', () => {
    expect(() => assertBatchTransition('draft', 'committed')).toThrow(ImportStateError);
  });

  it('refuses to commit a batch twice', () => {
    expect(() => assertBatchTransition('committed', 'committed')).toThrow(
      /already been committed/,
    );
  });

  it('refuses to revive a rolled-back batch', () => {
    for (const target of ['draft', 'validated', 'committed'] as const) {
      expect(() => assertBatchTransition('rolled_back', target), target).toThrow(
        ImportStateError,
      );
    }
  });
});
