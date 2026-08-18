/**
 * Import framework — Phase 01.11.
 *
 * §4.4: "Bulk import requires validation preview, error file, import batch ID
 * and rollback before final posting."
 * §26: master data is "Cleanse, deduplicate, map, approve, then import with
 * source ID."
 *
 * ── The rule that shapes everything ─────────────────────────────────────────
 * "Import respects the same permissions and validations as manual entry" is the
 * 01.11 gate, and it is why this framework has no insert path of its own. An
 * import definition supplies a *mapper* from a file row to the same input a
 * screen would build, and the framework calls the same service function the
 * screen calls. A second write path would be a second set of rules, and the
 * duplicate check or the approval requirement would be the thing that got
 * missed.
 *
 * ── Two phases, always ──────────────────────────────────────────────────────
 * Validate, then commit. Validation writes nothing and produces a preview and
 * an error file; commit runs in one transaction and can be rolled back whole.
 * §4.4 asks for both, and the reason is that a half-imported master file is
 * worse than none: nobody can tell which half.
 */

/** Where a batch is in its life. */
export const IMPORT_BATCH_STATUSES = [
  'draft',
  'validated',
  'committed',
  'rolled_back',
  'failed',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_ROW_STATUSES = ['pending', 'valid', 'invalid', 'committed'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** One row as it arrived, before anything has been decided about it. */
export interface RawImportRow {
  readonly rowNo: number;
  /** §26 — the identifier the row carried in its source system. */
  readonly sourceId: string | null;
  readonly values: Readonly<Record<string, string | null>>;
}

/** What validating one row produced. */
export interface RowValidation {
  readonly rowNo: number;
  readonly status: Extract<ImportRowStatus, 'valid' | 'invalid'>;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface ImportPreview {
  readonly totalRows: number;
  readonly validRows: number;
  readonly invalidRows: number;
  readonly rows: readonly RowValidation[];
  /** True when every row passed and the batch may be committed. */
  readonly committable: boolean;
}

export class ImportStateError extends Error {
  readonly code = 'IMPORT_STATE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'ImportStateError';
  }
}

export class ImportRowError extends Error {
  readonly code = 'IMPORT_ROW_INVALID';
  constructor(
    readonly rowNo: number,
    detail: string,
  ) {
    super(`Row ${rowNo}: ${detail}`);
    this.name = 'ImportRowError';
  }
}

/**
 * Summarises a validated batch.
 *
 * `committable` is all-or-nothing on purpose. §4.4 asks for "rollback before
 * final posting", and the cheapest rollback is not having committed: a file
 * with one bad row is corrected and re-uploaded, rather than half-imported and
 * then reconciled by hand.
 */
export function summarise(rows: readonly RowValidation[]): ImportPreview {
  const invalidRows = rows.filter((row) => row.status === 'invalid').length;

  return {
    totalRows: rows.length,
    validRows: rows.length - invalidRows,
    invalidRows,
    rows,
    committable: rows.length > 0 && invalidRows === 0,
  };
}

/** The moves a batch may make. Anything else is refused. */
const ALLOWED_TRANSITIONS: Readonly<Record<ImportBatchStatus, readonly ImportBatchStatus[]>> = {
  draft: ['validated', 'failed'],
  validated: ['committed', 'draft', 'failed'],
  committed: ['rolled_back'],
  rolled_back: [],
  failed: ['draft'],
};

export function assertBatchTransition(from: ImportBatchStatus, to: ImportBatchStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ImportStateError(
      `An import batch cannot go from '${from}' to '${to}'.` +
        (from === 'committed' && to === 'committed'
          ? ' It has already been committed; roll it back if it was wrong.'
          : ''),
    );
  }
}

export function assertCommittable(preview: ImportPreview): void {
  if (preview.totalRows === 0) {
    throw new ImportStateError('The file contained no rows.');
  }

  if (!preview.committable) {
    throw new ImportStateError(
      `${preview.invalidRows} of ${preview.totalRows} rows failed validation. ` +
        'Download the error file, correct the source and upload it again — nothing has been imported (§4.4).',
    );
  }
}

// ---------------------------------------------------------------------------
// The error file — §4.4
// ---------------------------------------------------------------------------

/**
 * Renders the failures as CSV, with the original values beside the reason.
 *
 * The point of the error file is that someone can open it, see what was wrong
 * and fix the source. A list of row numbers would make them go back to the
 * original file and count lines, which is how corrections introduce new errors.
 */
export function errorFile(
  rawRows: readonly RawImportRow[],
  validations: readonly RowValidation[],
  columns: readonly string[],
): string {
  const failures = validations.filter((row) => row.status === 'invalid');
  const byRowNo = new Map(rawRows.map((row) => [row.rowNo, row]));

  const header = ['row', 'source_id', ...columns, 'error_code', 'error'];
  const lines = [header.map(csvCell).join(',')];

  for (const failure of failures) {
    const raw = byRowNo.get(failure.rowNo);
    lines.push(
      [
        String(failure.rowNo),
        raw?.sourceId ?? '',
        ...columns.map((column) => raw?.values[column] ?? ''),
        failure.errorCode ?? '',
        failure.errorMessage ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }

  return lines.join('\n');
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export class ImportParseError extends Error {
  readonly code = 'IMPORT_PARSE_FAILED';
  constructor(detail: string) {
    super(`The file could not be read: ${detail}`);
    this.name = 'ImportParseError';
  }
}

/**
 * Parses delimited text into rows.
 *
 * Handles quoted cells and embedded commas, because a legal name containing a
 * comma is ordinary and a parser that splits on every comma would corrupt it
 * silently — the row would import, with the wrong data in it.
 */
export function parseDelimited(
  content: string,
  options: { delimiter?: string; sourceIdColumn?: string } = {},
): { columns: string[]; rows: RawImportRow[] } {
  const delimiter = options.delimiter ?? ',';
  const lines = splitRecords(content);

  if (lines.length === 0) {
    throw new ImportParseError('it is empty');
  }

  const columns = parseLine(lines[0]!, delimiter).map((c) => c.trim());
  if (columns.length === 0 || columns.every((c) => c === '')) {
    throw new ImportParseError('it has no header row');
  }

  const rows: RawImportRow[] = [];

  for (const [index, line] of lines.slice(1).entries()) {
    if (line.trim() === '') continue;

    const cells = parseLine(line, delimiter);
    const values: Record<string, string | null> = {};

    for (const [columnIndex, column] of columns.entries()) {
      const cell = cells[columnIndex];
      values[column] = cell === undefined || cell.trim() === '' ? null : cell.trim();
    }

    rows.push({
      rowNo: index + 1,
      sourceId: options.sourceIdColumn ? (values[options.sourceIdColumn] ?? null) : null,
      values,
    });
  }

  return { columns, rows };
}

/** Splits on newlines that are not inside a quoted cell. */
function splitRecords(content: string): string[] {
  const records: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;

    if (char === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && content[i + 1] === '\n') i += 1;
      records.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current !== '') records.push(current);
  return records;
}

function parseLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * What an import definition supplies.
 *
 * Note what is *not* here: any way to write a record. `mapRow` produces the
 * same input a screen would build, and the framework hands it to the same
 * service function the screen calls. That is what makes "the same permissions
 * and validations as manual entry" true by construction rather than by
 * diligence.
 */
export interface ImportDefinitionShape<TInput> {
  readonly key: string;
  readonly label: string;
  /** The permission object the importer must hold `import` on (§5.3). */
  readonly permissionObject: string;
  /** Columns the file must carry. A missing one fails the whole file, not a row. */
  readonly requiredColumns: readonly string[];
  /** Column carrying the source system's identifier (§26). */
  readonly sourceIdColumn?: string;
  /** Maps a raw row to the service input. Throws to reject the row. */
  mapRow(row: RawImportRow): TInput;
}

export function assertColumnsPresent(
  definition: ImportDefinitionShape<unknown>,
  columns: readonly string[],
): void {
  const missing = definition.requiredColumns.filter((column) => !columns.includes(column));

  if (missing.length > 0) {
    throw new ImportParseError(
      `it is missing the column(s) ${missing.join(', ')}. ` +
        `A ${definition.label} import needs ${definition.requiredColumns.join(', ')}.`,
    );
  }
}

/** Reads a required cell, or rejects the row saying which column was empty. */
export function requireCell(row: RawImportRow, column: string): string {
  const value = row.values[column];
  if (value === null || value === undefined || value === '') {
    throw new ImportRowError(row.rowNo, `${column} is empty and is required.`);
  }
  return value;
}

export function optionalCell(row: RawImportRow, column: string): string | null {
  const value = row.values[column];
  return value === undefined || value === '' ? null : value;
}

/** Reads a yes/no cell tolerantly — files come from spreadsheets, not from APIs. */
export function booleanCell(row: RawImportRow, column: string, fallback = false): boolean {
  const value = optionalCell(row, column);
  if (value === null) return fallback;

  const normalised = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(normalised)) return true;
  if (['false', 'no', 'n', '0'].includes(normalised)) return false;

  throw new ImportRowError(
    row.rowNo,
    `${column} is "${value}"; it must be yes or no.`,
  );
}
