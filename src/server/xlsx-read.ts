/**
 * Reads the cell values of an .xlsx workbook — enough for a one-time import
 * (REQ-AP-001 §24.3), with nothing but Node's own zlib.
 *
 * An .xlsx is a zip of XML parts: `xl/workbook.xml` names the sheets,
 * `xl/_rels/workbook.xml.rels` says which part each is, `xl/sharedStrings.xml`
 * holds the text, and each `xl/worksheets/sheetN.xml` holds its cells. A
 * formula cell carries its last computed value, which is what is read; the
 * formula itself is ignored. Dates arrive as Excel serial numbers — the caller
 * knows which columns are dates and converts them (`excelDate`).
 *
 * Deliberately small: no styles, no merged cells, no ZIP64. A workbook this
 * cannot read is refused with a sentence, never half-read.
 */
import { inflateRawSync } from 'node:zlib';

export type CellValue = string | number | boolean | null;
export type SheetRows = CellValue[][];

export class XlsxReadError extends Error {
  readonly code = 'XLSX_UNREADABLE';
  constructor(detail: string) {
    super(`The workbook could not be read: ${detail}`);
    this.name = 'XlsxReadError';
  }
}

/**
 * The archive's entries, by name.
 *
 * Exported because a workbook is not the only Office file that is a zip: a
 * `.docx` is one too, with its text in `word/document.xml`, and the supplier
 * invoices the company is sent arrive in both. One reader, no second
 * implementation of the same forty lines.
 */
export function unzip(buffer: Buffer): Map<string, Buffer> {
  const EOCD = 0x06054b50;
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxReadError('it is not a zip archive (an .xlsx file is).');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new XlsxReadError('its directory is damaged.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new XlsxReadError(`the entry ${name} is damaged.`);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + compressed);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new XlsxReadError(`the entry ${name} uses a compression this reader does not know.`);
  }
  return files;
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(
          entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10),
        );
    }
  });
}

/** The text of every <t> inside a fragment (a shared string may be rich text in runs). */
function textOf(fragment: string): string {
  let out = '';
  for (const match of fragment.matchAll(/<t(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    out += decode(match[1] ?? '');
  }
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]!) : null;
}

/** Every sheet of the workbook, by name, as rows of cell values (row 1 is index 0). */
export function readWorkbook(buffer: Buffer): Map<string, SheetRows> {
  const files = unzip(buffer);
  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8');
  if (!workbook || !rels) throw new XlsxReadError('it has no workbook part.');

  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const shared: string[] = [];
  const strings = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (strings) {
    for (const match of strings.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      shared.push(textOf(match[1] ?? ''));
    }
  }

  const sheets = new Map<string, SheetRows>();
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attribute(match[0], 'name');
    const id = attribute(match[0], 'r:id');
    const part = id ? targets.get(id) : undefined;
    if (!name || !part) continue;
    const xml = files.get(part)?.toString('utf8');
    if (!xml) continue;
    const rows: SheetRows = [];
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNumber = Number(attribute(row[1] ?? '', 'r') ?? rows.length + 1);
      const cells: CellValue[] = [];
      // A cell is `<c …/>` (empty) or `<c …>…</c>`; the attributes stop before
      // either, so an empty cell never swallows its neighbour's value.
      for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? '';
        const ref = attribute(attrs, 'r') ?? '';
        const type = attribute(attrs, 't');
        const body = cell[2] ?? '';
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: CellValue = null;
        if (type === 's') value = raw === undefined ? null : (shared[Number(raw)] ?? null);
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'str' || type === 'e') value = raw === undefined ? null : decode(raw);
        else if (type === 'b') value = raw === '1';
        else if (raw !== undefined && raw !== '') value = Number(raw);
        cells[columnIndex(ref)] = value;
      }
      for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = null;
      rows[rowNumber - 1] = cells;
    }
    for (let i = 0; i < rows.length; i += 1) if (rows[i] === undefined) rows[i] = [];
    sheets.set(name, rows);
  }
  return sheets;
}

/** An Excel serial date (1900 system) as YYYY-MM-DD; text dates pass through when ISO-shaped. */
export function excelDate(value: CellValue): string | null {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'string') {
    const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    return iso ? iso[1]! : null;
  }
  const ms = Math.round((value - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}
