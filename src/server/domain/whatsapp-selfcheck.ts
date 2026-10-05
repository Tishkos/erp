/**
 * Before an answer goes — is everything in it something he read?
 *
 * By direction (2026-10-05): "Self-check on every answer: before sending,
 * every figure and document number in his answer is verified against what he
 * actually read. Anything he can't trace is removed or corrected. You don't
 * see it — you just stop getting invented details."
 *
 * The instructions already say that every figure must come from a tool call
 * and that a document number is never invented. This is the same rule held by
 * arithmetic instead of by good intentions: the answer is read once more, by
 * code, against everything he was given — the question, the earlier turns,
 * every tool result — and what is in the answer and in none of those is
 * handed back to him, once, to look up or take out.
 *
 * Two kinds of thing can be checked this way, and they are not equally sure:
 *
 *   a CODE     a document number or a record's code, in the shapes this ERP
 *              mints them (`API-HQ-2026-000005`, `JE-2026-000001`,
 *              `SUP-00001`, `WH-INPROC`, `A000008`). He cannot work one out;
 *              one that is in nothing he read is wrong until proved
 *              otherwise.
 *   a FIGURE   an amount or a quantity. He is allowed arithmetic — a total,
 *              a difference, quantity × price, an amount at a rate — so a
 *              figure is let through when it is in what he read OR is one
 *              step of arithmetic from figures that are. What is left is
 *              flagged softly: he may have worked it out the long way, and is
 *              asked to show the working or take it out.
 *
 * Precision first: a false alarm costs a whole extra round of the model, ten
 * to thirty seconds of somebody waiting. So a pattern, a placeholder
 * (`INV-…`), a date, a time, a year, a phone number, a percentage, an address
 * and a number under a thousand are never checked.
 *
 * What this cannot see, and does not pretend to: a NAME. "A real warehouse
 * like مخزن بغداد" (2026-10-05) is words, and words he did not read look
 * exactly like words he did. A warehouse's code is checked; its name is the
 * instructions' business.
 *
 * Pure: text in, lists out. No database, no clock.
 */

export interface Unsupported {
  /** Document numbers and codes in the answer that are in nothing he read: these are wrong until proved otherwise. */
  readonly codes: readonly string[];
  /** Figures (amounts, quantities) in the answer that are neither in what he read nor a simple sum, difference or product of figures that are. */
  readonly figures: readonly string[];
}

// ---------------------------------------------------------------------------
// Reading text as it is written here: two alphabets' digits, two commas
// ---------------------------------------------------------------------------

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits as ASCII ones — one character for one, so every position stays where it was. */
function plainDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String.fromCharCode(48 + code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/** The same length of nothing: what is masked keeps its place, so what is found after it is still where the answer has it. */
const blank = (match: string) => ' '.repeat(match.length);

interface Span {
  readonly at: number;
  readonly end: number;
}

/** The text with these places blanked. `spans` in order, not overlapping. */
function without(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let from = 0;
  for (const span of spans) {
    parts.push(text.slice(from, span.at), ' '.repeat(span.end - span.at));
    from = span.end;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * A number the system minted: letters, then up to three more parts, then a
 * serial of three digits or more — `{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}` and
 * its shorter forms, as the numbering series write them.
 */
const SERIAL_CODE = /(?<![A-Za-z0-9-])([A-Z]{2,8})((?:-[A-Z0-9]{1,10}){0,3})-(\d{3,})(?![A-Za-z0-9])/g;

/** A code that is words rather than a serial: a warehouse (`WH-INPROC`), an item, a partner — only where the ERP keeps such codes. */
const WORD_CODE = /(?<![A-Za-z0-9-])(WH|ITM|SUP|CUS|CUST)-([A-Z][A-Z0-9_]{1,14})(?![A-Za-z0-9-])/g;

/** An account of the chart: its type's letter and six digits. */
const ACCOUNT_CODE = /(?<![A-Za-z0-9-])[ALERX]\d{6}(?![A-Za-z0-9])/g;

/** A shipping container (ISO 6346): owner, category, six digits and the check digit. */
const CONTAINER_CODE = /(?<![A-Za-z0-9-])[A-Z]{3}[UJZ]\d{7}(?![A-Za-z0-9])/g;

/**
 * Letters before a hyphen and a number that are not this ERP's: standards,
 * calendars, currencies. "ISO-6346", "FY-2026", "OCT-2026", "USD-1000".
 */
const NOT_A_PREFIX = new Set([
  'ISO', 'IEC', 'IFRS', 'IAS', 'GAAP', 'RFC', 'SHA', 'AES', 'RSA', 'UTF', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'COVID', 'HS', 'MT',
  'FY', 'CY', 'YTD', 'QTR', 'UTC', 'GMT', 'AD', 'BC',
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC',
  'IQD', 'USD', 'EUR', 'GBP', 'AED', 'SAR', 'KWD', 'JOD', 'TRY', 'CNY', 'IRR',
]);

/** What follows a pattern rather than a number: `INV-…`, `API-HQ-2026-<serial>`, `SUP-xxxxx`, `PO-#`. */
const PLACEHOLDER_AFTER = /^-?(?:…|\.{3}|<|#|\{|\[|[xX]{2,}|N{2,}|\*{2,})/;

interface FoundCode extends Span {
  /** As it is compared: upper case, plain digits. */
  readonly code: string;
}

/** Every code in a text, in order, with where it is. `text` must already have plain digits. */
function codesIn(text: string): FoundCode[] {
  const found: FoundCode[] = [];

  for (const match of text.matchAll(SERIAL_CODE)) {
    const at = match.index;
    const code = match[0];
    const after = text.slice(at + code.length, at + code.length + 6);
    // A pattern, not a number; or only the head of something longer.
    if (PLACEHOLDER_AFTER.test(after) || /^-[A-Za-z0-9]/.test(after)) continue;
    if (NOT_A_PREFIX.has(match[1]!)) continue;
    found.push({ at, end: at + code.length, code });
  }
  for (const match of text.matchAll(WORD_CODE)) {
    const at = match.index;
    const code = match[0];
    // `SUP-XXXXX`, `WH-NNN`, `ITM-CODE`: a shape somebody is being shown.
    if (/^(?:X{2,}|N{2,}|CODE|NAME|NUMBER|NO|ID|SERIAL|BRANCH)$/.test(match[2]!)) continue;
    if (PLACEHOLDER_AFTER.test(text.slice(at + code.length, at + code.length + 6))) continue;
    found.push({ at, end: at + code.length, code });
  }
  for (const pattern of [ACCOUNT_CODE, CONTAINER_CODE]) {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index, end: match.index + match[0].length, code: match[0] });
  }

  // In order, and no place twice (the patterns do not overlap by design; this holds it).
  found.sort((a, b) => a.at - b.at || b.end - a.end);
  const kept: FoundCode[] = [];
  let upTo = -1;
  for (const one of found) {
    if (one.at < upTo) continue;
    kept.push(one);
    upTo = one.end;
  }
  return kept;
}

/** Is the code in the text, as itself — not as the head or the tail of a longer one? `haystack` and `code` are upper case. */
function holdsCode(haystack: string, code: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(code, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : haystack[at - 1]!;
    const after = haystack[at + code.length] ?? '';
    if (!/[A-Z0-9-]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/** Six places: a quantity is kept to six, an amount to four. */
const SCALE = 1_000_000n;
const THOUSAND = 1000n * SCALE;

/** What is a number and is not a figure, blanked before the figures are read. */
const NOT_FIGURES: readonly RegExp[] = [
  // A picture's tag: `[picture: payables_suppliers-menu]`.
  /\[\s*(?:picture|pic|image|صورة|صوره)[^\]\n]*\]/gi,
  // An address, with whatever follows it.
  /\bhttps?:\/\/[^\s<>"')\]]+/gi,
  /[^\s<>"'()]+@[^\s<>"'()]+/g,
  /\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s<>"')\]]*)?/gi,
  /\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?:[:/][^\s<>"')\]]*)?/g,
  // Dates: 2026-10-04, 2026-10, 2026-10-04T22:53:00Z, 04/10/2026, 4.10.2026.
  /(?<![\d.,-])(?:19|20)\d{2}-\d{1,2}(?:-\d{1,2})?(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])/g,
  /(?<![\d/])\d{1,2}\/\d{1,2}\/\d{2,4}(?![\d/])/g,
  /(?<![\d.])\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}(?![\d.])/g,
  // A time, with its seconds.
  /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g,
  // A request's or a record's id.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // A version: 1.0.0, v2.1.287.
  /(?<![\d.,])v?\d+\.\d+\.\d+(?:\.\d+)*(?![\d.])/g,
  // A telephone: +964 782 462 0327, 0770 192 9191, 782-462-0327.
  /(?<![\w+])\+\d[\d\s().-]{6,}\d/g,
  /(?<![\w.,])0\d{2,3}[\s-]\d{3}[\s-]\d{3,4}(?![\d])/g,
  /(?<![\w.,])\d{3}[\s-]\d{3}[\s-]\d{4}(?![\d])/g,
];

/** A number as people write one here: grouped by a comma (ours or the Arabic ones), or not grouped; a point or ٫ before its fraction. */
const NUMBER = /(?<![\d.,٬٫_])(\d{1,3}(?:[,٬،]\d{3})+|\d+)(?:[.٫](\d{1,6}))?(?![\d])/g;

/** What a number after it is the name of, not the amount of: "ISO 6346", "HS code 8541", "port 3200", "error 1024". */
const REFERENCE_BEFORE =
  /(?:^|[^A-Za-z\u0600-\u06FF])(?:ISO|IEC|IFRS|IAS|RFC|SHA|HS|MT|HTTP|port|error|code|line|row|page|step|article|section|رقم|سطر|صفحة|خطوة|منفذ)[\s:#-]{1,2}$/i;

/** Said of money, straight after a number or straight before it. */
const CURRENCY_AFTER = /^\s{0,2}(?:IQD|USD|EUR|GBP|AED|dinars?|dollars?|دينار|دنانير|دولار|د\.ع|\$|€)/i;
const CURRENCY_BEFORE = /(?:IQD|USD|EUR|GBP|AED|\$|€)\s{0,2}$/i;

interface Figure extends Span {
  /** Scaled by `SCALE`. */
  readonly value: bigint;
  /** The smallest step it was written to, scaled: 1 for a whole number, 0.01 for two places. */
  readonly unit: bigint;
}

/**
 * Every number in a text, scaled. `text` has plain digits and its codes
 * blanked. `all` is for what he read (every number is material for his
 * arithmetic); without it only what counts as a figure in an answer is kept.
 */
function numbersIn(text: string, all: boolean): Figure[] {
  let masked = text;
  for (const pattern of NOT_FIGURES) masked = masked.replace(pattern, blank);

  const out: Figure[] = [];
  for (const match of masked.matchAll(NUMBER)) {
    const whole = match[1]!;
    const fraction = match[2] ?? '';
    const at = match.index;
    const end = at + match[0].length;
    const grouped = /[,٬،]/.test(whole);
    const digits = grouped ? whole.replace(/[,٬،]/g, '') : whole;
    // A serial, a telephone, a reference: not an amount. ("0.5" is one.)
    if (!grouped && digits.length > 1 && digits.startsWith('0')) continue;
    if (!grouped && digits.length >= 11) continue;

    const before = masked.slice(Math.max(0, at - 12), at);
    const after = masked.slice(end, end + 10);
    const money = CURRENCY_AFTER.test(after) || CURRENCY_BEFORE.test(before);
    // Part of a word — FY2026, v2, RISEN725 — unless the word is a currency: IQD1,000.
    if (/[A-Za-z]$/.test(before) && !money) continue;

    const value = BigInt(digits) * SCALE + BigInt((fraction + '000000').slice(0, 6));
    if (!all) {
      // A share, not an amount.
      if (/^\s?[%٪]/.test(after)) continue;
      // "#1024", "HS-8541", "ISO 6346", "port 3200": a reference.
      if (before.endsWith('#')) continue;
      if (!money && (/[A-Za-z]-$/.test(before) || REFERENCE_BEFORE.test(before))) continue;
      // 725W, 5000mAh, 1500ms: a thing's size, written against its unit.
      if (/^[A-Za-z؀-ۿ]/.test(after) && !money) continue;
      const year = !grouped && fraction === '' && digits.length === 4 && Number(digits) >= 1900 && Number(digits) <= 2100;
      if (year && !money) continue;
      // A count of anything under a thousand is not checked — unless it is plainly money with its fils or cents.
      if (value < THOUSAND && !(fraction !== '' && money)) continue;
    }
    out.push({ at, end, value, unit: SCALE / 10n ** BigInt(fraction.length) });
  }
  return out;
}

/** How many of what he read are tried against each other. A long report has thousands of figures; the first of them are the ones an answer is built on. */
const POOL = 400;
/** A total is a few lines added up, not a column of a hundred. */
const RUN = 24;

interface Ledger {
  /** Every value in what he read, with how many times it is there: a figure added to itself must be there twice. */
  readonly has: ReadonlyMap<bigint, number>;
  /** The first `POOL` distinct ones, for arithmetic — and the same, in order of size. */
  readonly pool: readonly bigint[];
  readonly sorted: readonly bigint[];
  /** Sums of three or more figures that follow one another, or stand at the end of lines that do. */
  readonly runs: ReadonlySet<bigint>;
}

/** Every sum of three or more neighbours, up to `RUN` of them. */
function addRuns(row: readonly bigint[], into: Set<bigint>): void {
  for (let from = 0; from < row.length; from += 1) {
    let sum = row[from]!;
    for (let to = from + 1; to < row.length && to - from < RUN; to += 1) {
      sum += row[to]!;
      if (to - from >= 2) into.add(sum);
    }
  }
}

function ledgerOf(sources: readonly string[]): Ledger {
  const has = new Map<bigint, number>();
  const pool: bigint[] = [];
  const runs = new Set<bigint>();
  for (const source of sources) {
    const plain = plainDigits(source);
    // The number a list gives its lines ("1.", "2)") is not a figure of the books: left in, every amount "times two" would pass.
    const text = without(plain, codesIn(plain)).replace(/^[ \t]*\(?\d{1,3}[.)](?=\s)/gm, blank);
    const figures = numbersIn(text, true);
    for (const figure of figures) {
      const times = has.get(figure.value) ?? 0;
      has.set(figure.value, times + 1);
      if (times === 0 && pool.length < POOL) pool.push(figure.value);
    }
    // A document's lines added up: the figures as they come, and the last figure of each line (where a line's total stands).
    const first = figures.slice(0, POOL);
    addRuns(first.map((figure) => figure.value), runs);
    const lineEnds: bigint[] = [];
    let lineEnd = -1;
    for (const figure of first) {
      if (figure.at > lineEnd) {
        lineEnds.push(figure.value);
        const next = text.indexOf('\n', figure.at);
        lineEnd = next < 0 ? text.length : next;
      } else {
        lineEnds[lineEnds.length - 1] = figure.value;
      }
    }
    addRuns(lineEnds, runs);
  }
  return { has, pool, sorted: [...pool].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), runs };
}

/** Is any of the sorted values within `slack` of `centre`? */
function near(sorted: readonly bigint[], centre: bigint, slack: bigint): boolean {
  const low = centre - slack;
  const high = centre + slack;
  let from = 0;
  let to = sorted.length;
  while (from < to) {
    const mid = (from + to) >> 1;
    if (sorted[mid]! < low) from = mid + 1;
    else to = mid;
  }
  return from < sorted.length && sorted[from]! <= high;
}

/** In what he read — or one step of arithmetic from it. */
function accountedFor(figure: Figure, ledger: Ledger): boolean {
  const value = figure.value;
  if (ledger.has.has(value) || ledger.runs.has(value)) return true;
  for (const a of ledger.pool) {
    if (a <= 0n) continue;
    // a + b (a figure added to itself only where it stands twice), and b − a.
    if (a < value && (ledger.has.get(value - a) ?? 0) >= (value - a === a ? 2 : 1)) return true;
    if (ledger.has.has(value + a)) return true;
    // One is not a factor.
    if (a === SCALE) continue;
    // a × b: quantity × price, an amount at a rate.
    const product = value * SCALE;
    if (product % a === 0n && product / a !== SCALE && ledger.has.has(product / a)) return true;
    // b ÷ a, to the places he wrote it to: an amount back from a rate, a price per unit.
    if (near(ledger.sorted, (value * a) / SCALE, (figure.unit * a) / (2n * SCALE) + 1n)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** As he wrote it, without the asterisks of a bold and the punctuation round it. */
const asWritten = (text: string) => text.replace(/^[\s*_`'"“”(\[]+|[\s*_`'"“”)\].,;:!?،؛]+$/g, '');

/**
 * What is in the answer and in nothing he read.
 *
 * `sources`: everything he was given — the question, the earlier turns, every
 * tool result, the notes in his instructions that carry facts.
 */
export function unsupportedIn(answer: string, sources: readonly string[]): Unsupported {
  const text = plainDigits(answer);
  const found = codesIn(text);

  const codes: string[] = [];
  if (found.length > 0) {
    // What he read, as one text to look codes up in.
    const read = plainDigits(sources.join('\n')).toUpperCase();
    const seen = new Set<string>();
    for (const one of found) {
      if (seen.has(one.code)) continue;
      seen.add(one.code);
      if (!holdsCode(read, one.code)) codes.push(asWritten(answer.slice(one.at, one.end)));
    }
  }

  // The figures: read with the codes blanked, so a serial is never an amount.
  const candidates = numbersIn(without(text, found), false);
  const figures: string[] = [];
  if (candidates.length > 0) {
    const ledger = ledgerOf(sources);
    const seen = new Set<bigint>();
    for (const one of candidates) {
      if (seen.has(one.value)) continue;
      seen.add(one.value);
      if (!accountedFor(one, ledger)) figures.push(asWritten(answer.slice(one.at, one.end)));
    }
  }
  return { codes, figures };
}

/** True when there is nothing to send back. */
export function isClean(found: Unsupported): boolean {
  return found.codes.length === 0 && found.figures.length === 0;
}

/** No correction lists more than this: past it he is rewriting the answer, not mending it. */
const LISTED = 12;

const listed = (items: readonly string[]) => {
  const shown = items.slice(0, LISTED).join(', ');
  return items.length > LISTED ? `${shown} — and ${items.length - LISTED} more` : shown;
};

/**
 * What is said to the model, once, when something is unsupported: what was
 * found and what to do about it. English; he answers in the person's language
 * anyway. Empty when there is nothing to say.
 */
export function correctionFor(found: Unsupported): string {
  if (isClean(found)) return '';
  const parts: string[] = ['Before this goes to the person — one check of your answer against what you actually read.'];
  if (found.codes.length > 0) {
    parts.push(
      `These are in your answer and in nothing you read: ${listed(found.codes)}. Either look each one up now with a tool and use what you find, or take it out. Do not keep a document number, a code or a name you did not read.`,
    );
  }
  if (found.figures.length > 0) {
    const one = found.figures.length === 1;
    parts.push(
      found.codes.length > 0
        ? `These figures are not in anything you read and are not a simple sum, difference or product of figures that are: ${listed(found.figures)}. If you worked one out, show the working in one line; if you cannot, take it out or read it with a tool.`
        : `Nothing in it is certainly wrong, but ${one ? 'this figure is' : 'these figures are'} not in anything you read and not a simple sum, difference or product of figures that are: ${listed(found.figures)}. If you worked ${one ? 'it' : 'one'} out, show the working in one line; if you cannot, take it out or read it with a tool.`,
    );
  }
  parts.push('Then give the whole answer again, complete, in the same language — the person sees only this version.');
  return parts.join('\n');
}
