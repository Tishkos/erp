/**
 * QR code — ISO/IEC 18004, byte mode, error correction level M.
 *
 * Written here rather than fetched, because what the Security screen puts in
 * a QR code is the authenticator's setup key: a picture drawn by somebody
 * else's service would hand them the second factor. Pure — text in, a square
 * of dark and light modules out — so `tests/unit/qr-code.test.ts` can hold
 * every module against a reference encoder, mask by mask.
 *
 * Level M (about 15% of the symbol may be damaged and still read) is what an
 * authenticator app expects on a screen; the other three levels are not here
 * because nothing asks for them.
 */

export class QrTooLongError extends Error {
  readonly code = 'QR_TOO_LONG';
  constructor(readonly bytes: number) {
    super(`${bytes} bytes do not fit in a QR code at error correction level M (${MAX_BYTES} is the most).`);
    this.name = 'QrTooLongError';
  }
}

export interface QrCode {
  /** 1–40; the symbol is `17 + 4 × version` modules a side. */
  readonly version: number;
  readonly size: number;
  /** The mask pattern (0–7) the symbol was drawn with. */
  readonly mask: number;
  /** `modules[row][column]`, true = dark. No quiet zone. */
  readonly modules: readonly (readonly boolean[])[];
}

/**
 * Level M's blocks per version (index 0 is version 1), from the standard's
 * table 9: `[blocks, codewords per block, data codewords per block]`, and the
 * same three again where a version has a second group of longer blocks.
 */
const BLOCKS_M: readonly (readonly number[])[] = [
  [1, 26, 16],
  [1, 44, 28],
  [1, 70, 44],
  [2, 50, 32],
  [2, 67, 43],
  [4, 43, 27],
  [4, 49, 31],
  [2, 60, 38, 2, 61, 39],
  [3, 58, 36, 2, 59, 37],
  [4, 69, 43, 1, 70, 44],
  [1, 80, 50, 4, 81, 51],
  [6, 58, 36, 2, 59, 37],
  [8, 59, 37, 1, 60, 38],
  [4, 64, 40, 5, 65, 41],
  [5, 65, 41, 5, 66, 42],
  [7, 73, 45, 3, 74, 46],
  [10, 74, 46, 1, 75, 47],
  [9, 69, 43, 4, 70, 44],
  [3, 70, 44, 11, 71, 45],
  [3, 67, 41, 13, 68, 42],
  [17, 68, 42],
  [17, 74, 46],
  [4, 75, 47, 14, 76, 48],
  [6, 73, 45, 14, 74, 46],
  [8, 75, 47, 13, 76, 48],
  [19, 74, 46, 4, 75, 47],
  [22, 73, 45, 3, 74, 46],
  [3, 73, 45, 23, 74, 46],
  [21, 73, 45, 7, 74, 46],
  [19, 75, 47, 10, 76, 48],
  [2, 74, 46, 29, 75, 47],
  [10, 74, 46, 23, 75, 47],
  [14, 74, 46, 21, 75, 47],
  [14, 74, 46, 23, 75, 47],
  [12, 75, 47, 26, 76, 48],
  [6, 75, 47, 34, 76, 48],
  [29, 74, 46, 14, 75, 47],
  [13, 74, 46, 32, 75, 47],
  [40, 75, 47, 7, 76, 48],
  [18, 75, 47, 31, 76, 48],
];

/** Where the alignment patterns' centres sit, per version (annex E). */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const MODE_BYTE = 0b0100;
/** Level M's two bits in the format information. */
const LEVEL_M = 0b00;
const MASKS = 8;

interface Block {
  readonly total: number;
  readonly data: number;
}

function blocksOf(version: number): Block[] {
  const row = BLOCKS_M[version - 1]!;
  const blocks: Block[] = [];
  for (let i = 0; i < row.length; i += 3) {
    for (let n = 0; n < row[i]!; n++) blocks.push({ total: row[i + 1]!, data: row[i + 2]! });
  }
  return blocks;
}

function dataCapacity(version: number): number {
  return blocksOf(version).reduce((sum, block) => sum + block.data, 0);
}

/** The character count is one byte up to version 9 and two from version 10. */
function countBits(version: number): number {
  return version < 10 ? 8 : 16;
}

function fits(bytes: number, version: number): boolean {
  return 4 + countBits(version) + bytes * 8 <= dataCapacity(version) * 8;
}

const MAX_BYTES = dataCapacity(40) - 3;

// ---------------------------------------------------------------------------
// Reed–Solomon over GF(256), the field of x⁸ + x⁴ + x³ + x² + 1
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}

function multiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** (x − α⁰)(x − α¹)…(x − α^(degree−1)), highest power first. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= multiply(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function errorCorrection(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < degree; i++) remainder[i]! ^= multiply(gen[i + 1]!, factor);
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// The codewords: header, data, padding; then the blocks, interleaved
// ---------------------------------------------------------------------------

function codewords(bytes: Uint8Array, version: number): number[] {
  const blocks = blocksOf(version);
  const capacity = dataCapacity(version);

  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(MODE_BYTE, 4);
  put(bytes.length, countBits(version));
  for (const byte of bytes) put(byte, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    data.push(byte);
  }
  for (let pad = 0; data.length < capacity; pad++) data.push(pad % 2 === 0 ? 0xec : 0x11);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const block of blocks) {
    const slice = data.slice(offset, offset + block.data);
    offset += block.data;
    dataBlocks.push(slice);
    ecBlocks.push(errorCorrection(slice, block.total - block.data));
  }

  const out: number[] = [];
  for (const group of [dataBlocks, ecBlocks]) {
    const longest = Math.max(...group.map((block) => block.length));
    for (let i = 0; i < longest; i++) {
      for (const block of group) if (i < block.length) out.push(block[i]!);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------

/** The remainder of `value` shifted up by the generator's degree, BCH. */
function bch(value: number, poly: number): number {
  const degree = 31 - Math.clz32(poly);
  let rest = value << degree;
  while (rest !== 0 && 31 - Math.clz32(rest) >= degree) {
    rest ^= poly << (31 - Math.clz32(rest) - degree);
  }
  return (value << degree) | rest;
}

function masked(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row * column) % 3) + ((row + column) % 2)) % 2 === 0;
  }
}

function draw(version: number, mask: number, data: readonly number[]): boolean[][] {
  const size = 17 + 4 * version;
  /** null = not a function module: the data goes there. */
  const grid: (boolean | null)[][] = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));

  // The three finder patterns, each with its light separator.
  for (const [top, left] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const row = top + r;
        const column = left + c;
        if (row < 0 || row >= size || column < 0 || column >= size) continue;
        grid[row]![column] =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  }

  // Alignment patterns, except where a finder already stands.
  const centres = ALIGNMENT[version - 1]!;
  for (const row of centres) {
    for (const column of centres) {
      if (grid[row]![column] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          grid[row + r]![column + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (grid[i]![6] === null) grid[i]![6] = i % 2 === 0;
    if (grid[6]![i] === null) grid[6]![i] = i % 2 === 0;
  }

  // Format information (level and mask), twice, and the module that is always dark.
  const format = bch((LEVEL_M << 3) | mask, 0x537) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const dark = ((format >> i) & 1) === 1;
    if (i < 6) grid[i]![8] = dark;
    else if (i < 8) grid[i + 1]![8] = dark;
    else grid[size - 15 + i]![8] = dark;

    if (i < 8) grid[8]![size - 1 - i] = dark;
    else if (i < 9) grid[8]![7] = dark;
    else grid[8]![14 - i] = dark;
  }
  grid[size - 8]![8] = true;

  // Version information, twice, from version 7.
  if (version >= 7) {
    const info = bch(version, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const dark = ((info >> i) & 1) === 1;
      grid[Math.floor(i / 3)]![(i % 3) + size - 11] = dark;
      grid[(i % 3) + size - 11]![Math.floor(i / 3)] = dark;
    }
  }

  // The data, in two-module columns from the bottom right, up then down,
  // stepping over the vertical timing pattern.
  let bit = 0;
  let upward = true;
  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column--;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const c of [column, column - 1]) {
        if (grid[row]![c] !== null) continue;
        const byte = data[bit >> 3];
        const dark = byte !== undefined && ((byte >> (7 - (bit & 7))) & 1) === 1;
        grid[row]![c] = dark !== masked(mask, row, c);
        bit++;
      }
    }
    upward = !upward;
  }

  return grid as boolean[][];
}

/** The standard's four penalties; the mask with the fewest points is drawn. */
function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let points = 0;

  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push([...modules[i]!]);
    lines.push(modules.map((row) => row[i]!));
  }

  // 1 — five or more in a row of one colour. 3 — a finder's 1:1:3:1:1 beside four light modules.
  const finderLike = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true],
  ];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) {
        run++;
        continue;
      }
      if (run >= 5) points += run - 2;
      run = 1;
    }
    for (let i = 0; i + 11 <= size; i++) {
      for (const pattern of finderLike) {
        if (pattern.every((dark, k) => line[i + k] === dark)) points += 40;
      }
    }
  }

  // 2 — every two-by-two block of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const dark = modules[row]![column]!;
      if (
        modules[row]![column + 1] === dark &&
        modules[row + 1]![column] === dark &&
        modules[row + 1]![column + 1] === dark
      ) {
        points += 3;
      }
    }
  }

  // 4 — how far the share of dark modules is from a half, in steps of 5%.
  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  points += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

  return points;
}

/**
 * Encodes text (as UTF-8) in the smallest symbol that holds it.
 *
 * `mask` fixes the mask pattern instead of choosing the best one — for the
 * test that holds each of the eight against the reference; a screen leaves it
 * out.
 */
export function qrCode(text: string, options: { readonly mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  while (version <= 40 && !fits(bytes.length, version)) version++;
  if (version > 40) throw new QrTooLongError(bytes.length);

  const data = codewords(bytes, version);
  const size = 17 + 4 * version;

  if (options.mask !== undefined) {
    if (!Number.isInteger(options.mask) || options.mask < 0 || options.mask >= MASKS) {
      throw new RangeError(`A QR mask pattern is 0 to ${MASKS - 1}, not ${options.mask}.`);
    }
    return { version, size, mask: options.mask, modules: draw(version, options.mask, data) };
  }

  let best: { mask: number; modules: boolean[][]; points: number } | null = null;
  for (let mask = 0; mask < MASKS; mask++) {
    const modules = draw(version, mask, data);
    const points = penalty(modules);
    if (best === null || points < best.points) best = { mask, modules, points };
  }
  return { version, size, mask: best!.mask, modules: best!.modules };
}

/** The standard's quiet zone: four light modules on every side. */
export const QR_QUIET_ZONE = 4;

/**
 * The dark modules as one SVG path, a rectangle per horizontal run, in a
 * `0 0 n n` view box where `n = size + 2 × quiet`.
 */
export function qrPath(code: QrCode, quiet = QR_QUIET_ZONE): string {
  let path = '';
  for (let row = 0; row < code.size; row++) {
    const line = code.modules[row]!;
    for (let column = 0; column < code.size; column++) {
      if (!line[column]) continue;
      let end = column;
      while (end + 1 < code.size && line[end + 1]) end++;
      path += `M${column + quiet} ${row + quiet}h${end - column + 1}v1h-${end - column + 1}z`;
      column = end;
    }
  }
  return path;
}
