/**
 * Reads the cell values of a legacy `.xls` (BIFF8) workbook — enough for the
 * legacy books import (REQ-LEGACY-001), with nothing but Node.
 *
 * The accountant's old system exports its larger registers as `.xls`, the
 * 1997–2003 binary format: a Compound File (a small FAT file system in a
 * file) whose `Workbook` stream is a run of BIFF records. What is read:
 *
 *   * the compound file's directory, FAT and mini-FAT, to find the stream;
 *   * `BOUNDSHEET` for the sheet names and offsets;
 *   * the shared string table (`SST`, continued across `CONTINUE` records,
 *     with the compressed / UTF-16 flag re-read at every continuation);
 *   * `LABELSST`, `LABEL`, `NUMBER`, `RK`, `MULRK`, `BOOLERR`, `FORMULA`
 *     (its cached value; a string result in the `STRING` record that follows).
 *
 * Deliberately small: no styles, no dates (they arrive as serial numbers,
 * like the .xlsx reader's), no BIFF5. A file this cannot read is refused
 * with a sentence, never half-read.
 */
import type { CellValue, SheetRows } from './xlsx-read';

export class XlsReadError extends Error {
  readonly code = 'XLS_UNREADABLE';
  constructor(detail: string) {
    super(`The workbook could not be read: ${detail}`);
    this.name = 'XlsReadError';
  }
}

export function isCompoundFile(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.readUInt32LE(0) === 0xe011cfd0 && buffer.readUInt32LE(4) === 0xe11ab1a1;
}

// ---------------------------------------------------------------------------
// The compound file: the `Workbook` stream
// ---------------------------------------------------------------------------

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function workbookStream(buffer: Buffer): Buffer {
  if (!isCompoundFile(buffer)) throw new XlsReadError('it is not a compound file (an .xls file is).');
  const sectorShift = buffer.readUInt16LE(0x1e);
  const miniShift = buffer.readUInt16LE(0x20);
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const fatSectorCount = buffer.readUInt32LE(0x2c);
  const firstDirSector = buffer.readUInt32LE(0x30);
  const miniCutoff = buffer.readUInt32LE(0x38);
  const firstMiniFatSector = buffer.readUInt32LE(0x3c);
  const miniFatCount = buffer.readUInt32LE(0x40);
  const firstDifatSector = buffer.readUInt32LE(0x44);
  const difatCount = buffer.readUInt32LE(0x48);

  const sector = (n: number): Buffer => {
    const start = (n + 1) * sectorSize;
    if (start + sectorSize > buffer.length) throw new XlsReadError(`sector ${n} is past the end of the file.`);
    return buffer.subarray(start, start + sectorSize);
  };

  // The FAT sector list: 109 in the header, the rest chained through DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && i < fatSectorCount; i += 1) fatSectors.push(buffer.readUInt32LE(0x4c + i * 4));
  let difat = firstDifatSector;
  for (let d = 0; d < difatCount && difat !== ENDOFCHAIN && difat !== FREESECT; d += 1) {
    const s = sector(difat);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector && fatSectors.length < fatSectorCount; i += 1) {
      const v = s.readUInt32LE(i * 4);
      if (v !== FREESECT) fatSectors.push(v);
    }
    difat = s.readUInt32LE(perSector * 4);
  }
  const fat: number[] = [];
  for (const n of fatSectors) {
    const s = sector(n);
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(s.readUInt32LE(i * 4));
  }

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let n = start;
    const seen = new Set<number>();
    while (n !== ENDOFCHAIN && n !== FREESECT && n < table.length) {
      if (seen.has(n)) throw new XlsReadError('a sector chain loops.');
      seen.add(n);
      out.push(n);
      n = table[n]!;
    }
    return out;
  };
  const readChain = (start: number, size: number): Buffer =>
    Buffer.concat(chain(start, fat).map(sector)).subarray(0, size);

  // The directory: 128-byte entries; the root first.
  const directory = Buffer.concat(chain(firstDirSector, fat).map(sector));
  interface Entry {
    name: string;
    type: number;
    start: number;
    size: number;
  }
  const entries: Entry[] = [];
  for (let off = 0; off + 128 <= directory.length; off += 128) {
    const nameLength = directory.readUInt16LE(off + 0x40);
    const name = nameLength > 2 ? directory.subarray(off, off + nameLength - 2).toString('utf16le') : '';
    entries.push({
      name,
      type: directory.readUInt8(off + 0x42),
      start: directory.readUInt32LE(off + 0x74),
      size: directory.readUInt32LE(off + 0x78),
    });
  }
  const root = entries[0];
  const entry = entries.find((e) => e.type === 2 && (e.name === 'Workbook' || e.name === 'Book'));
  if (!root || !entry) throw new XlsReadError('it has no Workbook stream (is it really an Excel file?).');

  if (entry.size >= miniCutoff) return readChain(entry.start, entry.size);

  // A small stream lives in the mini stream, addressed through the mini FAT.
  const miniFat: number[] = [];
  for (const n of chain(firstMiniFatSector, fat).slice(0, Math.max(miniFatCount, 1))) {
    const s = sector(n);
    for (let i = 0; i < sectorSize / 4; i += 1) miniFat.push(s.readUInt32LE(i * 4));
  }
  const miniStream = readChain(root.start, root.size);
  const parts = chain(entry.start, miniFat).map((n) => miniStream.subarray(n * miniSize, (n + 1) * miniSize));
  return Buffer.concat(parts).subarray(0, entry.size);
}

// ---------------------------------------------------------------------------
// BIFF8 records
// ---------------------------------------------------------------------------

interface Record_ {
  readonly type: number;
  readonly data: Buffer;
  readonly offset: number;
}

function* records(stream: Buffer, from = 0): Generator<Record_> {
  let offset = from;
  while (offset + 4 <= stream.length) {
    const type = stream.readUInt16LE(offset);
    const length = stream.readUInt16LE(offset + 2);
    const data = stream.subarray(offset + 4, offset + 4 + length);
    yield { type, data, offset };
    offset += 4 + length;
    if (type === 0x0a && offset >= stream.length) return; // EOF
  }
}

const RT = {
  BOF: 0x0809,
  EOF: 0x000a,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BLANK: 0x0201,
  MULBLANK: 0x00be,
} as const;

function rkValue(rk: number): number {
  const multiplied = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let value: number;
  if (isInt) {
    value = rk >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    value = b.readDoubleLE(0);
  }
  return multiplied ? value / 100 : value;
}

/**
 * A Unicode string as BIFF8 writes it (`XLUnicodeRichExtendedString`),
 * starting at `offset` in a sequence of buffers (the SST and its
 * continuations). The flag byte says whether the characters are compressed
 * (one byte each) or UTF-16; a continuation may switch the flag, which is
 * the part most home-made readers get wrong.
 */
class StringReader {
  private part = 0;
  private offset: number;
  constructor(
    private readonly parts: Buffer[],
    start: number,
  ) {
    this.offset = start;
  }

  private ensure(): void {
    while (this.part < this.parts.length && this.offset >= this.parts[this.part]!.length) {
      this.offset -= this.parts[this.part]!.length;
      this.part += 1;
    }
  }
  private remaining(): number {
    this.ensure();
    return this.part < this.parts.length ? this.parts[this.part]!.length - this.offset : 0;
  }
  u8(): number {
    this.ensure();
    const v = this.parts[this.part]!.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }
  u16(): number {
    return this.u8() | (this.u8() << 8);
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }
  skip(n: number): void {
    this.offset += n;
    this.ensure();
  }
  done(): boolean {
    this.ensure();
    return this.part >= this.parts.length;
  }

  /**
   * Reads `count` characters. A string that continues into the next
   * CONTINUE record restates its flag byte there, so the width can change
   * at every boundary crossed while characters are still owed.
   */
  chars(count: number, compressedAtStart: boolean): string {
    let compressed = compressedAtStart;
    let out = '';
    let left = count;
    this.ensure();
    let currentPart = this.part;
    while (left > 0) {
      this.ensure();
      if (this.part >= this.parts.length) throw new XlsReadError('a shared string runs past the end of the table.');
      if (this.part !== currentPart) {
        currentPart = this.part;
        compressed = (this.u8() & 0x01) === 0;
        continue;
      }
      const available = this.remaining();
      const width = compressed ? 1 : 2;
      const take = Math.min(left, Math.floor(available / width));
      if (take === 0) {
        // An odd byte at the end of the record: the character is in the next one.
        this.offset = this.parts[this.part]!.length;
        continue;
      }
      const buf = this.parts[this.part]!.subarray(this.offset, this.offset + take * width);
      out += compressed ? buf.toString('latin1') : buf.toString('utf16le');
      this.offset += take * width;
      left -= take;
    }
    return out;
  }

  unicodeString(lengthBytes: 1 | 2): string {
    const count = lengthBytes === 1 ? this.u8() : this.u16();
    const flags = this.u8();
    const compressed = (flags & 0x01) === 0;
    const rich = (flags & 0x08) !== 0;
    const extended = (flags & 0x04) !== 0;
    const runs = rich ? this.u16() : 0;
    const extraBytes = extended ? this.u32() : 0;
    const text = this.chars(count, compressed);
    this.skip(runs * 4 + extraBytes);
    return text;
  }
}

function readSst(parts: Buffer[]): string[] {
  const reader = new StringReader(parts, 0);
  reader.u32(); // total string count, with repeats
  const unique = reader.u32();
  const out: string[] = [];
  for (let i = 0; i < unique && !reader.done(); i += 1) out.push(reader.unicodeString(2));
  return out;
}

/** A short 8-bit-length string (BOUNDSHEET names, LABEL cells in BIFF8). */
function shortString(data: Buffer, offset: number, lengthBytes: 1 | 2): string {
  const reader = new StringReader([data], offset);
  return reader.unicodeString(lengthBytes);
}

export function readXlsWorkbook(buffer: Buffer): Map<string, SheetRows> {
  const stream = workbookStream(buffer);
  const sheets: { name: string; offset: number }[] = [];
  const sstParts: Buffer[] = [];
  let collectingSst = false;

  // The workbook globals: sheet names and the shared strings.
  for (const record of records(stream)) {
    if (record.type === RT.BOUNDSHEET) {
      const offset = record.data.readUInt32LE(0);
      const kind = record.data.readUInt8(5);
      const name = shortString(record.data, 6, 1);
      if (kind === 0) sheets.push({ name, offset });
      collectingSst = false;
    } else if (record.type === RT.SST) {
      sstParts.push(record.data);
      collectingSst = true;
    } else if (record.type === RT.CONTINUE && collectingSst) {
      sstParts.push(record.data);
    } else if (record.type === RT.EOF) {
      break;
    } else {
      collectingSst = false;
    }
  }
  const sst = sstParts.length > 0 ? readSst(sstParts) : [];

  const result = new Map<string, SheetRows>();
  for (const sheet of sheets) {
    const rows: CellValue[][] = [];
    const set = (r: number, c: number, value: CellValue) => {
      let row = rows[r];
      if (!row) {
        row = [];
        rows[r] = row;
      }
      row[c] = value;
    };
    let pendingFormula: { r: number; c: number } | null = null;
    let depth = 0;
    for (const record of records(stream, sheet.offset)) {
      if (record.type === RT.BOF) depth += 1;
      if (record.type === RT.EOF) {
        depth -= 1;
        if (depth <= 0) break;
        continue;
      }
      const d = record.data;
      switch (record.type) {
        case RT.LABELSST: {
          set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? '');
          break;
        }
        case RT.LABEL: {
          set(d.readUInt16LE(0), d.readUInt16LE(2), shortString(d, 6, 2));
          break;
        }
        case RT.NUMBER: {
          set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
          break;
        }
        case RT.RK: {
          set(d.readUInt16LE(0), d.readUInt16LE(2), rkValue(d.readInt32LE(6)));
          break;
        }
        case RT.MULRK: {
          const r = d.readUInt16LE(0);
          const first = d.readUInt16LE(2);
          const last = d.readUInt16LE(d.length - 2);
          for (let c = first, off = 4; c <= last; c += 1, off += 6) set(r, c, rkValue(d.readInt32LE(off + 2)));
          break;
        }
        case RT.BOOLERR: {
          const isError = d.readUInt8(7) === 1;
          set(d.readUInt16LE(0), d.readUInt16LE(2), isError ? null : d.readUInt8(6) === 1);
          break;
        }
        case RT.FORMULA: {
          const r = d.readUInt16LE(0);
          const c = d.readUInt16LE(2);
          // The cached result: a double, unless the last two bytes are 0xFFFF,
          // in which case the first byte says what follows (0 = string in the
          // next STRING record, 1 = boolean, 2 = error, 3 = empty string).
          if (d.readUInt16LE(12) === 0xffff) {
            const kind = d.readUInt8(6);
            if (kind === 0) pendingFormula = { r, c };
            else if (kind === 1) set(r, c, d.readUInt8(8) === 1);
            else if (kind === 3) set(r, c, '');
            else set(r, c, null);
          } else {
            set(r, c, d.readDoubleLE(6));
          }
          break;
        }
        case RT.STRING: {
          if (pendingFormula) {
            set(pendingFormula.r, pendingFormula.c, shortString(d, 0, 2));
            pendingFormula = null;
          }
          break;
        }
        default:
          break;
      }
    }
    // Normalise: every row an array, holes as null, trailing empty rows dropped.
    const width = rows.reduce((n, row) => Math.max(n, row?.length ?? 0), 0);
    const normalised: SheetRows = [];
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r] ?? [];
      const cells: CellValue[] = [];
      for (let c = 0; c < width; c += 1) cells.push(row[c] ?? null);
      normalised.push(cells);
    }
    while (normalised.length > 0 && normalised[normalised.length - 1]!.every((v) => v === null || v === '')) normalised.pop();
    result.set(sheet.name, normalised);
  }
  return result;
}
