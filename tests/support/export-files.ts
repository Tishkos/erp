import { inflateRawSync, inflateSync } from 'node:zlib';

/**
 * Reading the exported files back, the way a person's software would — so a
 * test can say "this PDF says API-HQ-2026-000001 and 1,000" rather than "the
 * route returned some bytes".
 *
 * Small readers for exactly what the exports contain: a zip container (the
 * workbook and the Word file are both zips of XML), the cells of a sheet, the
 * text of a Word document, and the text of a PDF decoded through each font's
 * own ToUnicode map — the same table a PDF reader's copy-and-paste uses.
 */

// ------------------------------------------------------------------ zip

export function unzip(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // End of central directory: the last "PK\x05\x06".
  let end = -1;
  for (let i = data.length - 22; i >= 0; i -= 1) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip file: no end of central directory');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localName = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const raw = data.subarray(start, start + compressedSize);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const entities = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

// ------------------------------------------------------------------ xlsx

export interface SheetCell {
  readonly ref: string;
  /** The shared string, for a text cell. */
  readonly text?: string;
  /** The number, for a numeric cell or a formula's stored result. */
  readonly number?: number;
  readonly formula?: string;
}

export interface Workbook {
  readonly sheetName: string;
  readonly rightToLeft: boolean;
  /** The rows frozen at the top, as Excel's pane says. */
  readonly frozenRows: number;
  readonly cells: ReadonlyMap<string, SheetCell>;
  readonly workbookXml: string;
  readonly strings: readonly string[];
}

export function readWorkbook(data: Buffer): Workbook {
  const files = unzip(data);
  const sheet = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
  const shared = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => entities(t[1]!)).join(''),
  );
  const cells = new Map<string, SheetCell>();
  for (const m of sheet.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, ref, attributes = '', body = ''] = m;
    const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
    const formula = /<f>([\s\S]*?)<\/f>/.exec(body)?.[1];
    const shared = /t="s"/.test(attributes);
    const inline = /<is><t[^>]*>([\s\S]*?)<\/t><\/is>/.exec(body)?.[1];
    cells.set(ref!, {
      ref: ref!,
      ...(shared && value !== undefined ? { text: strings[Number(value)] } : {}),
      ...(inline !== undefined ? { text: entities(inline) } : {}),
      ...(!shared && value !== undefined ? { number: Number(value) } : {}),
      ...(formula !== undefined ? { formula: entities(formula) } : {}),
    });
  }
  const workbookXml = files.get('xl/workbook.xml')!.toString('utf8');
  return {
    sheetName: entities(/<sheet [^>]*name="([^"]*)"/.exec(workbookXml)?.[1] ?? ''),
    rightToLeft: /rightToLeft="1"/.test(sheet),
    frozenRows: Number(/<pane [^>]*ySplit="(\d+)"[^>]*state="frozen"/.exec(sheet)?.[1] ?? 0),
    cells,
    workbookXml,
    strings,
  };
}

/** Evaluate a SUM formula the exports write — a range, or a list of cells. */
export function evaluateSum(formula: string, cells: ReadonlyMap<string, SheetCell>): number {
  // A total over no lines at all is written as the constant it is.
  if (/^-?\d+(\.\d+)?$/.test(formula.trim())) return Number(formula.trim());
  const inner = /^SUM\((.*)\)$/.exec(formula.trim())?.[1];
  if (inner === undefined) throw new Error(`Not a SUM: ${formula}`);
  let total = 0;
  for (const part of splitArguments(inner)) {
    if (part.startsWith('SUM(')) {
      total += evaluateSum(part, cells);
      continue;
    }
    const range = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(part);
    if (range) {
      for (let row = Number(range[2]); row <= Number(range[4]); row += 1) {
        total += cells.get(`${range[1]}${row}`)?.number ?? 0;
      }
    } else {
      total += cells.get(part)?.number ?? 0;
    }
  }
  return total;
}

function splitArguments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// ------------------------------------------------------------------ docx

export interface WordDocument {
  readonly body: string;
  readonly text: string;
  readonly headers: string;
  readonly fontNames: readonly string[];
}

export function readWord(data: Buffer): WordDocument {
  const files = unzip(data);
  const body = files.get('word/document.xml')!.toString('utf8');
  const headers = [...files.entries()]
    .filter(([name]) => /^word\/header\d*\.xml$/.test(name))
    .map(([, content]) => content.toString('utf8'))
    .join('\n');
  const text = [...body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => entities(m[1]!)).join(' ');
  const fontTable = files.get('word/fontTable.xml')?.toString('utf8') ?? '';
  const fontNames = [...fontTable.matchAll(/<w:font w:name="([^"]*)">[\s\S]*?<w:embedRegular/g)].map((m) => m[1]!);
  return { body, text, headers, fontNames };
}

// ------------------------------------------------------------------ pdf

export interface PdfDocument {
  readonly pages: number;
  /** The text of each page, drawn order, runs separated by spaces. */
  readonly pageText: readonly string[];
  readonly text: string;
  /** The embedded fonts' names, subset prefix removed. */
  readonly fonts: readonly string[];
  /** Glyphs drawn with no character behind them — the "boxes". */
  readonly unmappedGlyphs: number;
}

interface PdfObject {
  readonly dict: string;
  readonly stream: Buffer | null;
}

export function readPdf(data: Buffer): PdfDocument {
  const source = data.toString('latin1');
  if (!source.startsWith('%PDF-')) throw new Error('Not a PDF');
  const objects = new Map<number, PdfObject>();
  for (const m of source.matchAll(/(\d+) 0 obj\s*([\s\S]*?)endobj/g)) {
    const body = m[2]!;
    const at = body.indexOf('stream');
    if (at >= 0 && /^<<[\s\S]*>>\s*$/.test(body.slice(0, at))) {
      const dict = body.slice(0, at);
      let start = at + 'stream'.length;
      if (body[start] === '\r') start += 1;
      if (body[start] === '\n') start += 1;
      const stop = body.lastIndexOf('endstream');
      let raw = Buffer.from(body.slice(start, stop), 'latin1');
      const length = /\/Length (\d+)/.exec(dict)?.[1];
      if (length) raw = raw.subarray(0, Number(length));
      const stream = /\/FlateDecode/.test(dict) ? inflateSync(raw) : raw;
      objects.set(Number(m[1]), { dict, stream });
    } else {
      objects.set(Number(m[1]), { dict: body, stream: null });
    }
  }
  const resolve = (text: string) => {
    const ref = /^\s*(\d+) 0 R\s*$/.exec(text);
    return ref ? (objects.get(Number(ref[1]))?.dict ?? '') : text;
  };

  // Each font's ToUnicode map, glyph code → text.
  const maps = new Map<number, Map<number, string>>();
  const fonts: string[] = [];
  for (const [id, object] of objects) {
    if (!/\/Type \/Font/.test(object.dict) || !/\/Subtype \/Type0/.test(object.dict)) continue;
    const name = /\/BaseFont \/([^\s/]+)/.exec(object.dict)?.[1] ?? '';
    fonts.push(name.replace(/^[A-Z]{6}\+/, ''));
    const cmapRef = /\/ToUnicode (\d+) 0 R/.exec(object.dict)?.[1];
    const cmap = cmapRef ? objects.get(Number(cmapRef))?.stream?.toString('latin1') ?? '' : '';
    maps.set(id, parseToUnicode(cmap));
  }

  const pageText: string[] = [];
  let unmappedGlyphs = 0;
  for (const [, object] of objects) {
    if (!/\/Type \/Page\b/.test(object.dict) || /\/Type \/Pages/.test(object.dict)) continue;
    const resources = resolve(/\/Resources (\d+ 0 R|<<[\s\S]*?>>\s*>>)/.exec(object.dict)?.[1] ?? '');
    const fontDict = resolve(/\/Font (\d+ 0 R|<<[\s\S]*?>>)/.exec(resources)?.[1] ?? '');
    const fontRefs = new Map<string, number>();
    for (const f of fontDict.matchAll(/\/(\w+) (\d+) 0 R/g)) fontRefs.set(f[1]!, Number(f[2]));
    const contentRefs = [...(/\/Contents (\[[^\]]*\]|\d+ 0 R)/.exec(object.dict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map(
      (r) => Number(r[1]),
    );
    const runs: string[] = [];
    for (const ref of contentRefs) {
      const content = objects.get(ref)?.stream?.toString('latin1') ?? '';
      let map = new Map<number, string>();
      for (const token of content.matchAll(/\/(\w+) [\d.]+ Tf|\[((?:<[0-9a-fA-F]*>|[^\]])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
        if (token[1] !== undefined) {
          map = maps.get(fontRefs.get(token[1]) ?? -1) ?? new Map();
          continue;
        }
        const hexes = token[2] !== undefined ? [...token[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]!) : [token[3]!];
        let run = '';
        for (const hex of hexes) {
          for (let i = 0; i + 4 <= hex.length; i += 4) {
            const code = parseInt(hex.slice(i, i + 4), 16);
            const text = map.get(code);
            if (text === undefined || code === 0) unmappedGlyphs += 1;
            run += text ?? '';
          }
        }
        runs.push(run);
      }
    }
    pageText.push(runs.join(' '));
  }
  return { pages: pageText.length, pageText, text: pageText.join('\n'), fonts, unmappedGlyphs };
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  // A destination may hold several characters — a ligature is written
  // `<0066 0069>`, "fi" — so spaces inside the brackets are not separators.
  const text = (hex: string) => {
    const digits = hex.replace(/\s+/g, '');
    const units: number[] = [];
    for (let i = 0; i + 4 <= digits.length; i += 4) units.push(parseInt(digits.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  };
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(m[1]!, 16), text(m[2]!));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F\s]+>)/g)) {
      const start = parseInt(m[1]!, 16);
      const stop = parseInt(m[2]!, 16);
      if (m[3]!.startsWith('[')) {
        [...m[3]!.matchAll(/<([0-9a-fA-F\s]+)>/g)].forEach((d, i) => map.set(start + i, text(d[1]!)));
      } else {
        const first = parseInt(m[3]!.slice(1, -1), 16);
        for (let code = start; code <= stop; code += 1) map.set(code, String.fromCharCode(first + (code - start)));
      }
    }
  }
  return map;
}
