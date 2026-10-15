/**
 * Global search — what a typed phrase means, and how matches are ordered.
 *
 * Pure: no database, no request. `services/global-search.ts` turns the phrase
 * into queries (as the asker, so the row policies and the grants decide what
 * exists); this file decides only what the phrase *is* and which match comes
 * first. Both the palette in the browser and the /search page use the screen
 * matcher at the end, so the two cannot rank a screen differently.
 *
 * ── Exact match first ──────────────────────────────────────────────────────
 * A phrase shaped like a document number — `API-HQ-2026-000012`, `AP-12`,
 * `api 12`, `API-١٢` — is read as {prefix, optional branch, optional year,
 * serial}. The prefixes are the numbering series' own (`doc_sequence`, handed in
 * as `SeriesInfo[]`): nothing here lists them, so a series added tomorrow is
 * recognised tomorrow. A prefix that is the *start* of a real prefix (AP for
 * API, APL) still finds those documents, one rank lower than a prefix that is
 * exact. A bare number ("1024") finds that serial in every series.
 *
 * ── Tiers ──────────────────────────────────────────────────────────────────
 *   0  the whole phrase is the record's number, code or name
 *   1  series prefix and serial agree ("AP-12" for API-HQ-2026-000012)
 *   2  a number, code or name begins with the phrase; or the bare serial
 *   3  the phrase is inside a name or a reference
 *   4  the phrase is the name of the record's party (invoices of "Al Noor")
 *
 * Groups are ordered by the best tier they hold, tiers 2 and 3 counting as one
 * (a name hit); among equals the master records (customers, suppliers) come
 * before documents — "names rank master records first".
 */

/** Records are not searched for less than this many characters (a screen still is). */
export const MIN_RECORD_QUERY = 2;
/** …and a substring match (rather than a prefix) wants at least this many. */
export const MIN_CONTAINS_QUERY = 3;
/** A phrase is cut here; nothing a person types to find a record is longer. */
export const MAX_QUERY_LENGTH = 80;
/** At most this many words are matched (each must be present). */
export const MAX_TOKENS = 4;
/** The palette shows this many of a group; "see all" shows more. */
export const DEFAULT_GROUP_LIMIT = 5;
export const PAGE_GROUP_LIMIT = 10;

export const TIER = {
  exact: 0,
  serial: 1,
  prefix: 2,
  contains: 3,
  party: 4,
} as const;

export type Tier = (typeof TIER)[keyof typeof TIER];

// ---------------------------------------------------------------------------
// Folding — the TypeScript twin of the database function search_fold (0330)
// ---------------------------------------------------------------------------

const ARABIC_MARKS = /[ً-ٰٟـ]/g;
const FOLD_FROM = 'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const FOLD_TO = 'اااايهوي01234567890123456789';
const FOLD = new Map<string, string>([...FOLD_FROM].map((ch, i) => [ch, FOLD_TO[i]!] as const));
const FOLD_CHARS = new RegExp(`[${FOLD_FROM}]`, 'g');
const DIGITS = new RegExp(`[٠-٩۰-۹]`, 'g');

/**
 * Lower case; Arabic marks and tatweel dropped; alef/ya/ta-marbuta variants and
 * Arabic digits read as their plain forms. The database does the same to what
 * is stored (`search_fold`), so a comparison is between two folded strings.
 * The search compares in SQL with the database's own function; this twin is for
 * deciding what a phrase *is* (a number? how many words?) and for the tests,
 * which hold the two equal.
 */
export function foldText(value: string): string {
  return value
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(FOLD_CHARS, (ch) => FOLD.get(ch) ?? ch);
}

/** Only the digits of other scripts read as 0–9 — case and letters left as typed. */
export function foldDigits(value: string): string {
  return value.replace(DIGITS, (ch) => FOLD.get(ch) ?? ch);
}

/** `\`, `%` and `_` taken literally in a LIKE pattern (escape character `\`). */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The most words a register's search box reads. */
export const MAX_SEARCH_WORDS = 6;

/**
 * A register's search box, read as words (2026-10-15, by direction: "search
 * by name, not just by code … if the supplier is Hama I can search by ham,
 * much smarter"): the phrase compatibility-normalised, split on spaces,
 * folded as `search_fold` folds, each word once, at most `MAX_SEARCH_WORDS`.
 * Every word is then looked for on its own, anywhere in the row.
 */
export function searchWords(term: string | null | undefined): string[] {
  const display = (term ?? '')
    .normalize('NFKC')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
  if (!display) return [];
  const words = foldText(display)
    .split(' ')
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  return [...new Set(words)].slice(0, MAX_SEARCH_WORDS);
}

// ---------------------------------------------------------------------------
// The phrase
// ---------------------------------------------------------------------------

export interface NormalisedQuery {
  /** What was asked, as typed. */
  readonly raw: string;
  /** Compatibility-normalised (full-width and presentation forms), one space between words, cut to length. */
  readonly display: string;
  /** `display`, folded — for deciding what the phrase is. */
  readonly text: string;
  /** The words of `display`, as typed (at most `MAX_TOKENS`). */
  readonly tokens: readonly string[];
  /**
   * The phrase as a document number would be written: upper case, Latin
   * digits, words joined by dashes ("api 12" → "API-12").
   */
  readonly upper: string;
  /** Number columns are tried against each of these (the upper-cased form, then the digits-folded one as typed). */
  readonly numberCandidates: readonly string[];
}

export function normaliseQuery(raw: string): NormalisedQuery {
  const display = raw
    .normalize('NFKC')
    // Zero-width and directional marks pasted from a document or a chat.
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
  const text = foldText(display);
  const tokens = display ? display.split(' ').slice(0, MAX_TOKENS) : [];
  const upper = foldDigits(display)
    .toUpperCase()
    .replace(/\s*([-_/.])\s*/g, '$1')
    .replace(/\s+/g, '-');
  const asTyped = foldDigits(display).replace(/\s+/g, '');
  const numberCandidates = [...new Set([upper, asTyped].filter((v) => v.length > 0))];
  return { raw, display, text, tokens, upper, numberCandidates };
}

/**
 * The most variants of a phrase tried against a raw column: as typed, with its
 * spaces dropped, as a number is written — each as typed, upper and lower case.
 */
export const MAX_RAW_VARIANTS = 12;

/**
 * The spellings a reference may have been stored in, tried **as stored** (no
 * folding) against a btree: references (a supplier's invoice number, a bank's
 * reference, a container) are typed in whatever case they were given.
 */
export function rawVariants(query: NormalisedQuery): string[] {
  const out = new Set<string>();
  for (const base of [query.display, query.display.replace(/\s+/g, ''), ...query.numberCandidates]) {
    if (!base) continue;
    out.add(base);
    out.add(base.toUpperCase());
    out.add(base.toLowerCase());
  }
  return [...out].slice(0, MAX_RAW_VARIANTS);
}

/**
 * The smallest string greater than every string that begins with `prefix`, in
 * code point order — which is byte order in UTF-8 and so the order of a database
 * collated C. `column >= prefix and column < prefixUpperBound(prefix)` is
 * "begins with", written with the two comparisons a btree answers **and** the
 * two a row policy lets through ahead of its own filter (LIKE is not leakproof;
 * `>=` and `<` are). Null when nothing can follow the prefix (every code point
 * is the last one) — then `>= prefix` alone is the range.
 */
export function prefixUpperBound(prefix: string): string | null {
  const points = [...prefix];
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) {
      // Surrogates are not scalar values: step over the gap.
      const next = last === 0xd7ff ? 0xe000 : last + 1;
      return points.join('') + String.fromCodePoint(next);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** One numbering series, as `doc_sequence` holds it. */
export interface SeriesInfo {
  readonly key: string;
  readonly prefix: string;
}

/**
 * Prefixes a series has issued numbers under and no longer does (0409): a
 * purchase invoice was API- until 2026-10-06 and is PUR- since; the
 * local-goods payable was PUR- and is LOC-. The numbers already issued keep
 * their prefix, so "API-12" must still find serial 12 of the purchase
 * invoices — read beside the series' current prefix.
 */
export const RETIRED_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  AP_INVOICE: ['API'],
  PAYABLE_LOCAL_GOODS: ['PUR'],
};

/** The catalogue with each series' retired prefixes beside its current one. */
export function withRetiredPrefixes(catalog: readonly SeriesInfo[]): SeriesInfo[] {
  const out = [...catalog];
  for (const series of catalog) {
    for (const prefix of RETIRED_PREFIXES[series.key] ?? []) {
      if (!out.some((row) => row.key === series.key && row.prefix.toUpperCase() === prefix)) {
        out.push({ key: series.key, prefix });
      }
    }
  }
  return out;
}

export interface NumberShape {
  /** The letters the number begins with, upper case. Empty for a bare number. */
  readonly prefix: string;
  /** A branch code between prefix and year, if the phrase carried one. */
  readonly branch: string | null;
  readonly year: number | null;
  /** The last run of digits, as a number (leading zeros dropped). */
  readonly serial: bigint;
  /** …and as typed, so a number column can also be tried literally. */
  readonly serialDigits: string;
}

const SEPARATORS = /[-_/.]+/;

/**
 * `PREFIX[-BRANCH][-YEAR]-SERIAL`, in the forms people write it. Null when the
 * phrase is not shaped like a number (a name, a sentence, two numbers).
 */
export function parseNumberShape(upper: string): NumberShape | null {
  if (!upper || upper.length > 40) return null;
  // "API1024" → API-1024: a letter run meeting a digit run is a boundary too.
  const parts = upper
    .replace(/([A-Z])(\d)/g, '$1-$2')
    .split(SEPARATORS)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const last = parts[parts.length - 1]!;
  if (!/^\d{1,18}$/.test(last)) return null;
  const head = parts.slice(0, -1);
  if (head.length === 0) {
    return { prefix: '', branch: null, year: null, serial: BigInt(last), serialDigits: last };
  }
  const prefix = head[0]!;
  if (!/^[A-Z]{1,10}$/.test(prefix)) return null;
  let branch: string | null = null;
  let year: number | null = null;
  for (const part of head.slice(1)) {
    if (/^(19|20)\d{2}$/.test(part) && year === null) year = Number(part);
    else if (/^[A-Z][A-Z0-9]{0,9}$/.test(part) && branch === null && year === null) branch = part;
    else if (/^\d{2}$/.test(part) && year === null) year = 2000 + Number(part);
    else return null;
  }
  return { prefix, branch, year, serial: BigInt(last), serialDigits: last };
}

export interface SeriesMatch {
  /** Series whose prefix is the phrase's prefix. */
  readonly exact: readonly string[];
  /** Series whose prefix merely begins with it (AP → API, APL). */
  readonly partial: readonly string[];
  /** Every series (a bare number). */
  readonly any: boolean;
}

export const NO_SERIES: SeriesMatch = { exact: [], partial: [], any: false };

export function matchSeries(shape: NumberShape | null, catalog: readonly SeriesInfo[]): SeriesMatch {
  if (!shape) return NO_SERIES;
  if (shape.prefix === '') return { exact: [], partial: [], any: true };
  const exact: string[] = [];
  const partial: string[] = [];
  for (const series of catalog) {
    const prefix = series.prefix.toUpperCase();
    if (prefix === shape.prefix) exact.push(series.key);
    else if (prefix.startsWith(shape.prefix)) partial.push(series.key);
  }
  return { exact, partial, any: false };
}

/**
 * The numbers a bare `PREFIX-serial` could be written as in a series that is
 * kept to neither branch nor year: SUP-1 is SUP-1, SUP-01 … SUP-000001 (and
 * A1 is A000001). Tried as equalities on the number's own btree, so a code
 * issued by hand, or by a padding the series has since changed, is still met
 * by its serial. Series with a branch or a year in them go through
 * `doc_number_allocation` instead.
 */
export function paddedNumbers(shape: NumberShape | null): string[] {
  if (!shape || shape.prefix === '' || shape.branch !== null || shape.year !== null) return [];
  const digits = shape.serial.toString();
  const numbers: string[] = [];
  for (let width = digits.length; width <= 9; width++) {
    const padded = digits.padStart(width, '0');
    numbers.push(`${shape.prefix}-${padded}`, `${shape.prefix}${padded}`);
  }
  return numbers;
}

export type QueryKind = 'empty' | 'short' | 'number' | 'text';

export interface QueryPlan {
  readonly query: NormalisedQuery;
  readonly kind: QueryKind;
  readonly shape: NumberShape | null;
  readonly series: SeriesMatch;
  /** `paddedNumbers(shape)` — the serial as an unscoped series would have written it. */
  readonly padded: readonly string[];
  /** Substring matches are allowed (the phrase is long enough for the trigram index). */
  readonly contains: boolean;
  /** Records are searched at all. */
  readonly records: boolean;
}

/**
 * What the phrase is, given the numbering series. `short` is a phrase too short
 * for a record query (the screens still answer); `number` is anything shaped
 * like a document number, a code, or a bare number — the text columns are
 * still tried, a name can look like a number.
 */
export function planQuery(raw: string, catalog: readonly SeriesInfo[]): QueryPlan {
  const query = normaliseQuery(raw);
  if (query.display.length === 0) {
    return { query, kind: 'empty', shape: null, series: NO_SERIES, padded: [], contains: false, records: false };
  }
  const shape = parseNumberShape(query.upper);
  const series = matchSeries(shape, catalog);
  const records = query.display.length >= MIN_RECORD_QUERY;
  return {
    query,
    kind: !records ? 'short' : shape ? 'number' : 'text',
    shape,
    series,
    padded: paddedNumbers(shape),
    contains: query.display.length >= MIN_CONTAINS_QUERY,
    records,
  };
}

/** The LIKE patterns a document number is tried against for one parsed shape and series. */
export function allocationFilters(shape: NumberShape): { branch: string | null; year: string | null } {
  return {
    branch: shape.branch ? `%-${likeEscape(shape.branch)}-%` : null,
    year: shape.year ? `%-${shape.year}-%` : null,
  };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Tiers 2 and 3 are both "a name hit"; masters outrank documents within a bucket. */
export function tierBucket(tier: number): number {
  if (tier <= TIER.serial) return tier;
  if (tier <= TIER.contains) return 2;
  return 3;
}

export interface Rankable {
  readonly key: string;
  readonly best: number;
  readonly priority: number;
}

export function compareGroups(a: Rankable, b: Rankable): number {
  return (
    tierBucket(a.best) - tierBucket(b.best) ||
    a.priority - b.priority ||
    a.best - b.best ||
    a.key.localeCompare(b.key)
  );
}

/** Within a group: better tier, then the more recent date, then the number. */
export function compareHits(
  a: { readonly tier: number; readonly date: string | null; readonly number: string },
  b: { readonly tier: number; readonly date: string | null; readonly number: string },
): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  return a.number < b.number ? -1 : a.number > b.number ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Statuses — the chip a code wears
// ---------------------------------------------------------------------------

/**
 * Every status the records carry, mapped onto the eleven chips the application
 * draws (`status status--<chip>` in globals.css). A code with no entry wears
 * the neutral chip. The label is a translation (`search.status.<code>`), never
 * the code itself.
 */
const CHIP: Readonly<Record<string, string>> = {
  // The document status — the eleven chips themselves.
  draft: 'draft',
  submitted: 'submitted',
  approved: 'approved',
  partially_executed: 'partially_executed',
  executed: 'executed',
  posted: 'posted',
  settled: 'settled',
  rejected: 'rejected',
  cancelled: 'cancelled',
  reversed: 'reversed',
  closed: 'closed',
  // Partners, employees, projects, accounts.
  prospect: 'draft',
  active: 'approved',
  on_hold: 'submitted',
  blocked: 'rejected',
  inactive: 'cancelled',
  suspended: 'rejected',
  ended: 'cancelled',
  closing: 'submitted',
  // Loans, payment applications, customs declarations.
  fully_repaid: 'settled',
  sent: 'submitted',
  confirmed: 'posted',
  debited: 'settled',
  accepted: 'approved',
  assessed: 'approved',
  cleared: 'settled',
  // The stages of an import or a purchase.
  requested: 'submitted',
  ordered: 'submitted',
  order_confirmed: 'approved',
  invoiced: 'posted',
  invoiced_funded: 'posted',
  shipped: 'submitted',
  pd_registered: 'partially_executed',
  payment_in_progress: 'partially_executed',
  partly_received: 'partially_executed',
  all_received: 'executed',
  received: 'settled',
  due: 'submitted',
  paid: 'settled',
  // A container on its way.
  not_loaded: 'draft',
  on_sea: 'submitted',
  at_port: 'submitted',
  customs_cleared: 'approved',
  late: 'rejected',
  missing_damaged: 'rejected',
  // A PD at customs.
  pre_approved: 'approved',
  validated: 'approved',
  partially_written_off: 'partially_executed',
  totally_written_off: 'settled',
  expired_validated: 'closed',
  expired_part_written_off: 'closed',
  // A task on its road (the Task Center; draft, submitted, accepted, blocked, rejected and cancelled are above).
  assigned: 'submitted',
  in_progress: 'executed',
  completed: 'posted',
  // An exception on its road (the Exception Center): open needs a person, acknowledged has one, resolved cleared by itself.
  open: 'submitted',
  acknowledged: 'approved',
  resolved: 'settled',
};

/** Every status code the search can show; each has a `search.status.<code>` translation in both locales. */
export const STATUS_CODES: readonly string[] = Object.keys(CHIP);

export function chipOf(status: string | null): string {
  if (!status) return 'draft';
  return CHIP[status] ?? 'draft';
}

// ---------------------------------------------------------------------------
// Screens — "go to Customer Receipts"
// ---------------------------------------------------------------------------

export interface ScreenEntry {
  /** `<section>:<item>` */
  readonly key: string;
  readonly label: string;
  readonly section: string;
  readonly href: string;
}

/**
 * The tier a screen answers a phrase with, or null for no match. The screen's
 * title and its menu heading are searched, each word of the phrase being
 * somewhere in one of them.
 */
export function screenTier(entry: Pick<ScreenEntry, 'label' | 'section'>, query: NormalisedQuery): Tier | null {
  if (query.display.length === 0) return null;
  const label = foldText(entry.label);
  const section = foldText(entry.section);
  const whole = query.text;
  if (label === whole) return TIER.exact;
  if (label.startsWith(whole)) return TIER.prefix;
  const words = whole.split(' ');
  if (words.every((word) => label.includes(word))) return TIER.contains;
  const both = `${label} ${section}`;
  if (words.every((word) => both.includes(word))) return TIER.party;
  return null;
}

export interface RankedScreen extends ScreenEntry {
  readonly tier: Tier;
}

/** Matching screens, best first; at most `limit`. */
export function matchScreens(entries: readonly ScreenEntry[], query: NormalisedQuery, limit: number): RankedScreen[] {
  const ranked: RankedScreen[] = [];
  for (const entry of entries) {
    const tier = screenTier(entry, query);
    if (tier !== null) ranked.push({ ...entry, tier });
  }
  // The closer title (the shorter one, for a phrase that begins both) first.
  ranked.sort((a, b) => a.tier - b.tier || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return ranked.slice(0, limit);
}
