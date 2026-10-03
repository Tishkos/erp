/**
 * A file somebody sent to the group — REQ-WA-001 WA-7.
 *
 * By direction (2026-10-02): "reads xlsx files pdf everything when sent in
 * the group discussion". People in this company work by sending each other
 * workbooks and scans — a supplier's price list, a bank statement, a customs
 * declaration — and a colleague who could not open them would be useless.
 *
 * So a file that arrives in the group is read into text and put in front of
 * Noah with the message it came with. Three sizes of thing matter here, and
 * they pull against each other:
 *
 *   * a workbook of ten thousand rows cannot go into a WhatsApp answer, nor
 *     into one prompt. It is capped, and the cap is declared in the text, so
 *     an answer is never quietly based on the first page of a long file.
 *   * the shape of a workbook — which sheets, how many rows — is usually the
 *     first thing to say about it, and costs nothing to carry.
 *   * what could NOT be read is as important as what could. A photograph of
 *     an invoice is a photograph: saying so is honest, and guessing at it
 *     would put invented figures in the company's chat.
 *
 * This file does no reading of its own: the formats live in the service
 * beside it, and the house's own `xlsx-read` / `xls-read` do the work. Here
 * is only the shape of the thing, what it is called, and how it is put into
 * words.
 */
import type { CellValue } from '../xlsx-read';

/** What kind of thing arrived, as far as how to get text out of it goes. */
export type SentFileKind = 'sheet' | 'pdf' | 'text' | 'image' | 'other';

/** A sheet as a shape, which is worth saying even when its rows are capped. */
export interface SheetShape {
  readonly name: string;
  readonly rows: number;
  readonly columns: number;
  /** How many of those rows are in the text below. */
  readonly rowsShown: number;
}

export interface SentFile {
  readonly fileName: string;
  readonly kind: SentFileKind;
  readonly mimetype: string;
  readonly bytes: number;
  /** What was typed with it, which is usually the actual question. */
  readonly caption: string;
  /** What could be read out of it. Empty when nothing could. */
  readonly text: string;
  /** Why the text is missing or short, when it is. Null when it is whole. */
  readonly note: string | null;
  readonly sheets: readonly SheetShape[];
  /** When it arrived, so "the file you sent earlier" has an order to it. */
  readonly at: string;
}

/**
 * How much of a file's text is carried.
 *
 * Generous, because the brain is Opus and the whole point is that it can hold
 * a supplier's price list in its head while answering about it. A workbook
 * past this is cut, and told that it was cut.
 */
export const FILE_TEXT_CAP = 60_000;

/** How many rows of one sheet are carried, before the character cap bites. */
export const SHEET_ROW_CAP = 500;

const SHEET_EXTENSIONS = ['.xlsx', '.xlsm', '.xls'];
const TEXT_EXTENSIONS = ['.csv', '.txt', '.tsv', '.json', '.md', '.log', '.xml'];

function extensionOf(fileName: string): string {
  const at = fileName.lastIndexOf('.');
  return at === -1 ? '' : fileName.slice(at).toLowerCase();
}

/**
 * What kind of file this is, by name first and type second.
 *
 * The name is the more reliable of the two: WhatsApp labels a workbook
 * `application/octet-stream` often enough, and a phone that re-encodes a
 * document loses the type entirely, but `.xlsx` survives both.
 */
export function kindOf(fileName: string, mimetype: string): SentFileKind {
  const extension = extensionOf(fileName);
  const type = mimetype.toLowerCase();
  if (SHEET_EXTENSIONS.includes(extension)) return 'sheet';
  if (extension === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.includes(extension)) return 'text';
  if (type.includes('spreadsheet') || type.includes('excel')) return 'sheet';
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

/** One cell, as it would be read aloud. */
function cellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * A workbook as text: one block per sheet, tab-separated, capped.
 *
 * Tabs rather than a drawn table, because the reader is a model and not a
 * person: the columns line up for it either way, and a drawn table would
 * spend half the cap on dashes. An entirely empty trailing row is dropped,
 * since a spreadsheet's used range is nearly always larger than its data.
 */
export function sheetsToText(
  sheets: ReadonlyMap<string, readonly (readonly CellValue[])[]>,
  limits: { readonly rowCap?: number; readonly textCap?: number } = {},
): { readonly text: string; readonly shapes: readonly SheetShape[]; readonly truncated: boolean } {
  const rowCap = limits.rowCap ?? SHEET_ROW_CAP;
  const textCap = limits.textCap ?? FILE_TEXT_CAP;
  const blocks: string[] = [];
  const shapes: SheetShape[] = [];
  let truncated = false;
  let spent = 0;

  for (const [name, rows] of sheets) {
    const used = rows.filter((row) => row.some((cell) => cellText(cell).trim() !== ''));
    const columns = used.reduce((widest, row) => Math.max(widest, row.length), 0);
    const shown = used.slice(0, rowCap);
    const lines = [`## sheet "${name}" — ${used.length} row(s), ${columns} column(s)`];
    for (const row of shown) lines.push(row.map(cellText).join('\t'));
    if (used.length > shown.length) {
      lines.push(`… ${used.length - shown.length} more row(s) in this sheet, not shown`);
      truncated = true;
    }
    const block = lines.join('\n');
    if (spent + block.length > textCap) {
      blocks.push(`## sheet "${name}" — ${used.length} row(s): too much left to show`);
      truncated = true;
      shapes.push({ name, rows: used.length, columns, rowsShown: 0 });
      continue;
    }
    spent += block.length;
    blocks.push(block);
    shapes.push({ name, rows: used.length, columns, rowsShown: shown.length });
  }

  return { text: blocks.join('\n\n'), shapes, truncated };
}

/** Text from anything else, capped the same way. */
export function cap(text: string, textCap = FILE_TEXT_CAP): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= textCap) return { text, truncated: false };
  return { text: text.slice(0, textCap), truncated: true };
}

/**
 * One line naming a file, for the message that goes with the question.
 *
 * Deliberately short: the contents are handed over separately, and this is
 * only so the question reads like what a person actually sent — "look at
 * this" about a named thing, rather than about nothing.
 */
export function describeSentFile(file: SentFile): string {
  const size = file.bytes >= 1_000_000 ? `${(file.bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(file.bytes / 1000))} KB`;
  const shape =
    file.sheets.length > 0
      ? `, ${file.sheets.length} sheet(s): ${file.sheets.map((sheet) => `${sheet.name} (${sheet.rows}×${sheet.columns})`).join(', ')}`
      : '';
  return `${file.fileName} — ${file.kind}, ${size}${shape}${file.note ? ` — ${file.note}` : ''}`;
}

/**
 * The question, with the file named in it.
 *
 * A file sent with no caption is still a question: somebody put it in the
 * group for a reason, and the reason is nearly always "look at this and tell
 * me". So one is written for them rather than answering silence with silence.
 */
export function questionForFiles(caption: string, files: readonly SentFile[]): string {
  if (files.length === 0) return caption;
  const named = files.map((file) => describeSentFile(file)).join('; ');
  const asked = caption.trim();
  return asked
    ? `${asked}\n\n[sent with this message: ${named}. Its contents are available through the sent_file tool.]`
    : `[${named} was sent to the group with no message. Its contents are available through the sent_file tool. Read it, say what it is and what stands out in it, and ask what they want done with it.]`;
}
