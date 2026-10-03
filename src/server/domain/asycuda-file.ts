/**
 * Turning an ASYCUDA export into the lines the list parser reads —
 * REQ-AP-001 §21.8.
 *
 * The screen asked somebody to paste the document list. That is the step
 * where the mistakes come from: a customs officer exports the report, opens
 * it, selects the rows, and pastes — and a row missed at the bottom of a
 * scroll is a declaration nobody updated, which is a payment that will not go
 * out. The file is the thing they already have, so the file is what the
 * screen should take (by direction, 2026-10-02).
 *
 * ASYCUDA's report comes out as a workbook or a CSV depending on the office
 * and the version, so all of them arrive here and leave as the same thing:
 * one line per declaration, its fields separated by tabs, which is exactly
 * what `parseAsycudaList` already reads. Nothing here understands a status or
 * a date — that stays in `domain/customs-pd`, which already knows how ASYCUDA
 * spells things, misspellings included.
 */
import type { CellValue } from '../xlsx-read';

/** What a file turned into, and anything worth telling the reader about it. */
export interface AsycudaFileRead {
  /** One line per row, fields separated by tabs. */
  readonly text: string;
  readonly rowCount: number;
  /** Named when a workbook had more than one sheet and one was chosen. */
  readonly sheetName: string | null;
  /** The sheets that were there, so a wrong choice is visible rather than silent. */
  readonly sheetNames: readonly string[];
  /** Said plainly when something was dropped or guessed at. */
  readonly note: string | null;
}

export class AsycudaFileError extends Error {
  readonly code = 'ASYCUDA_FILE_UNREADABLE';
  constructor(detail: string) {
    super(detail);
    this.name = 'AsycudaFileError';
  }
}

const SHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'];
const TEXT_EXTENSIONS = ['.csv', '.txt', '.tsv'];

export function extensionOf(fileName: string): string {
  const at = fileName.lastIndexOf('.');
  return at === -1 ? '' : fileName.slice(at).toLowerCase();
}

/** Is this a file this screen can read at all? */
export function isReadableAsycudaFile(fileName: string): boolean {
  const extension = extensionOf(fileName);
  return SHEET_EXTENSIONS.includes(extension) || TEXT_EXTENSIONS.includes(extension);
}

function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
}

/**
 * The sheet that looks like the document list.
 *
 * An ASYCUDA export is usually one sheet; when it is not, the extra sheets are
 * a cover page or a key, and they are short. The one with the most non-empty
 * rows is the list. Named in the result either way, so a wrong guess is
 * something the reader can see rather than something that quietly happens.
 */
export function chooseSheet(
  sheets: ReadonlyMap<string, readonly (readonly CellValue[])[]>,
): { readonly name: string; readonly rows: readonly (readonly CellValue[])[] } | null {
  let best: { name: string; rows: readonly (readonly CellValue[])[]; filled: number } | null = null;
  for (const [name, rows] of sheets) {
    const filled = rows.filter((row) => row.some((cell) => cellText(cell) !== '')).length;
    if (!best || filled > best.filled) best = { name, rows, filled };
  }
  return best && best.filled > 0 ? { name: best.name, rows: best.rows } : null;
}

/**
 * A workbook's rows as tab-separated lines.
 *
 * Empty rows go — a spreadsheet's used range is nearly always bigger than its
 * data — and so do the trailing empty cells of each row, which would otherwise
 * leave a line ending in a run of tabs that the list parser would have to
 * think about.
 */
export function sheetToLines(rows: readonly (readonly CellValue[])[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const cells = row.map(cellText);
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

/**
 * A CSV as lines.
 *
 * Commas stay as they are: the list parser already separates on tabs, commas
 * or runs of spaces, so a comma-separated line needs no translation. Quoted
 * fields are unwrapped, because a quoted number is still that number and the
 * quotes would end up inside the PD number.
 */
export function textToLines(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .split(',')
        .map((field) => field.trim().replace(/^"(.*)"$/s, '$1'))
        .join(','),
    )
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** How many lines carry anything at all. */
export function countLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}
