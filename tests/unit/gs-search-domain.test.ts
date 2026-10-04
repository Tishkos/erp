/**
 * Global search (platform phase, Agent 5) — what a typed phrase means and which
 * match comes first. Pure: the database half is tests/integration/gs-global-search.test.ts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_LENGTH,
  TIER,
  allocationFilters,
  chipOf,
  compareGroups,
  compareHits,
  foldText,
  likeEscape,
  matchScreens,
  matchSeries,
  normaliseQuery,
  paddedNumbers,
  parseNumberShape,
  planQuery,
  screenTier,
  STATUS_CODES,
  tierBucket,
  type SeriesInfo,
} from '@/server/domain/search';

/** The real shape of `doc_sequence`: INV is shared by three series, A is a one-letter code. */
const CATALOG: readonly SeriesInfo[] = [
  { key: 'AP_INVOICE', prefix: 'API' },
  { key: 'APPLICANT', prefix: 'APL' },
  { key: 'AR_INVOICE', prefix: 'INV' },
  { key: 'INVESTMENT', prefix: 'INV' },
  { key: 'INVOICE', prefix: 'INV' },
  { key: 'ACCOUNT_CODE_ASSET', prefix: 'A' },
  { key: 'SUPPLIER_PAYMENT', prefix: 'PAY' },
  { key: 'PAYROLL_RUN', prefix: 'PAY' },
  { key: 'TASK', prefix: 'TASK' },
];

describe('foldText — the twin of search_fold', () => {
  it('lower-cases, drops Arabic marks and the tatweel, and reads the alef/ya/ta-marbuta variants as plain letters', () => {
    expect(foldText('ABC Trading')).toBe('abc trading');
    expect(foldText('أَحْمَد')).toBe('احمد');
    expect(foldText('إبراهيم')).toBe('ابراهيم');
    expect(foldText('آمنة')).toBe('امنه');
    expect(foldText('شركة')).toBe('شركه');
    expect(foldText('على')).toBe('علي');
    expect(foldText('مؤسسة')).toBe('موسسه');
    expect(foldText('النُّـور')).toBe('النور');
  });

  it('reads Arabic-Indic and Extended Arabic-Indic digits as 0–9', () => {
    expect(foldText('١٢٣٤٥٦٧٨٩٠')).toBe('1234567890');
    expect(foldText('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(foldText('API-١٠٢٤')).toBe('api-1024');
  });

  it('leaves everything else alone', () => {
    expect(foldText('abc-123 _%')).toBe('abc-123 _%');
    expect(foldText('')).toBe('');
  });
});

describe('normaliseQuery', () => {
  it('collapses whitespace, trims and cuts to length', () => {
    expect(normaliseQuery('   al    noor  ').display).toBe('al noor');
    expect(normaliseQuery('x'.repeat(500)).display).toHaveLength(MAX_QUERY_LENGTH);
    expect(normaliseQuery('').tokens).toEqual([]);
  });

  it('removes zero-width and directional marks pasted from a chat or a PDF', () => {
    expect(normaliseQuery('‏API-12‎').display).toBe('API-12');
  });

  it('applies compatibility normalisation (full-width letters and digits)', () => {
    expect(normaliseQuery('ＡＰＩ－１２').display).toBe('API-12');
    expect(normaliseQuery('ＡＰＩ-１２').upper).toBe('API-12');
  });

  it('writes the phrase as a document number would be: upper case, Latin digits, words joined', () => {
    expect(normaliseQuery('api 12').upper).toBe('API-12');
    expect(normaliseQuery('api - 12').upper).toBe('API-12');
    expect(normaliseQuery('api-hq-2026-000012').upper).toBe('API-HQ-2026-000012');
    expect(normaliseQuery('API-١٢').upper).toBe('API-12');
  });

  it('offers the number columns the upper-cased form and the form as typed', () => {
    expect(normaliseQuery('wh-main').numberCandidates).toEqual(['WH-MAIN', 'wh-main']);
    expect(normaliseQuery('API-12').numberCandidates).toEqual(['API-12']);
  });

  it('keeps at most four words', () => {
    expect(normaliseQuery('a b c d e f').tokens).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('parseNumberShape', () => {
  it('reads a full document number', () => {
    expect(parseNumberShape('API-HQ-2026-000012')).toEqual({
      prefix: 'API',
      branch: 'HQ',
      year: 2026,
      serial: 12n,
      serialDigits: '000012',
    });
  });

  it('reads the short forms people type', () => {
    expect(parseNumberShape('AP-1024')).toMatchObject({ prefix: 'AP', serial: 1024n, branch: null, year: null });
    expect(parseNumberShape('API1024')).toMatchObject({ prefix: 'API', serial: 1024n });
    expect(parseNumberShape('API-2026-1024')).toMatchObject({ prefix: 'API', year: 2026, serial: 1024n });
    expect(parseNumberShape('API-HQ-1024')).toMatchObject({ prefix: 'API', branch: 'HQ', year: null });
    expect(parseNumberShape('TASK-100')).toMatchObject({ prefix: 'TASK', serial: 100n });
  });

  it('reads a one-letter code with no separator (A000001)', () => {
    expect(parseNumberShape('A000001')).toMatchObject({ prefix: 'A', serial: 1n });
  });

  it('reads a bare number as a serial with no prefix', () => {
    expect(parseNumberShape('1024')).toMatchObject({ prefix: '', serial: 1024n });
    expect(parseNumberShape('000012')).toMatchObject({ prefix: '', serial: 12n });
  });

  it('refuses what is not a number: a name, a sentence, two numbers, something far too long', () => {
    expect(parseNumberShape('AL-NOOR')).toBeNull();
    expect(parseNumberShape('2026-000012')).toBeNull();
    expect(parseNumberShape('12-34')).toBeNull();
    expect(parseNumberShape('API-HQ-2026-X-12')).toBeNull();
    expect(parseNumberShape('A'.repeat(41))).toBeNull();
    expect(parseNumberShape('')).toBeNull();
  });
});

describe('matchSeries — the prefixes come from the numbering config, not from this file', () => {
  it('finds the series whose prefix is the phrase’s prefix', () => {
    expect(matchSeries(parseNumberShape('API-12'), CATALOG)).toEqual({ exact: ['AP_INVOICE'], partial: [], any: false });
  });

  it('lets a prefix shared by several series find them all (INV, PAY)', () => {
    expect(matchSeries(parseNumberShape('INV-12'), CATALOG).exact).toEqual(['AR_INVOICE', 'INVESTMENT', 'INVOICE']);
    expect(matchSeries(parseNumberShape('PAY-3'), CATALOG).exact).toEqual(['SUPPLIER_PAYMENT', 'PAYROLL_RUN']);
  });

  it('finds the series a short prefix begins (AP → API, APL) one rank lower', () => {
    expect(matchSeries(parseNumberShape('AP-1024'), CATALOG)).toEqual({
      exact: [],
      partial: ['AP_INVOICE', 'APPLICANT'],
      any: false,
    });
  });

  it('knows a series the moment the configuration has it (TASK-100)', () => {
    expect(matchSeries(parseNumberShape('TASK-100'), CATALOG).exact).toEqual(['TASK']);
    expect(matchSeries(parseNumberShape('TASK-100'), CATALOG.filter((s) => s.key !== 'TASK')).exact).toEqual([]);
  });

  it('matches a bare number to every series, and a name to none', () => {
    expect(matchSeries(parseNumberShape('1024'), CATALOG)).toMatchObject({ any: true });
    expect(matchSeries(parseNumberShape('AL-NOOR'), CATALOG)).toEqual({ exact: [], partial: [], any: false });
    expect(matchSeries(null, CATALOG)).toEqual({ exact: [], partial: [], any: false });
  });

  it('is case-insensitive about the configured prefix', () => {
    expect(matchSeries(parseNumberShape('API-1'), [{ key: 'AP_INVOICE', prefix: 'api' }]).exact).toEqual(['AP_INVOICE']);
  });
});

describe('planQuery', () => {
  it('is empty for nothing, short for one character, number for a number, text for a name', () => {
    expect(planQuery('', CATALOG).kind).toBe('empty');
    expect(planQuery('   ', CATALOG).kind).toBe('empty');
    expect(planQuery('a', CATALOG)).toMatchObject({ kind: 'short', records: false });
    expect(planQuery('API-12', CATALOG)).toMatchObject({ kind: 'number', records: true });
    expect(planQuery('Al Noor Trading', CATALOG)).toMatchObject({ kind: 'text', records: true, contains: true });
  });

  it('allows a substring search only from three characters', () => {
    expect(planQuery('al', CATALOG)).toMatchObject({ records: true, contains: false });
    expect(planQuery('alp', CATALOG)).toMatchObject({ records: true, contains: true });
  });

  it('reads Arabic digits in a document number', () => {
    const plan = planQuery('API-١٢', CATALOG);
    expect(plan.shape).toMatchObject({ prefix: 'API', serial: 12n });
    expect(plan.series.exact).toEqual(['AP_INVOICE']);
  });

  it('treats an Arabic name as text', () => {
    expect(planQuery('شركة النور', CATALOG)).toMatchObject({ kind: 'text', records: true });
  });
});

describe('paddedNumbers — a serial as an unscoped series would have written it', () => {
  it('pads with and without the dash, up to nine digits', () => {
    const numbers = paddedNumbers(parseNumberShape('SUP-1'));
    expect(numbers).toContain('SUP-1');
    expect(numbers).toContain('SUP-00001');
    expect(numbers).toContain('SUP-000001');
    expect(numbers).toContain('SUP000001');
    expect(numbers).toHaveLength(18);
  });

  it('takes the serial, not the zeros typed', () => {
    expect(paddedNumbers(parseNumberShape('A-000012'))).toContain('A000012');
    expect(paddedNumbers(parseNumberShape('A-000012'))).toContain('A-12');
  });

  it('is empty for a bare number, and where a branch or a year is named (those go through the allocations)', () => {
    expect(paddedNumbers(parseNumberShape('1024'))).toEqual([]);
    expect(paddedNumbers(parseNumberShape('API-HQ-2026-12'))).toEqual([]);
    expect(paddedNumbers(parseNumberShape('JE-2026-12'))).toEqual([]);
    expect(paddedNumbers(null)).toEqual([]);
  });

  it('is part of the plan', () => {
    expect(planQuery('SUP-1', CATALOG).padded).toContain('SUP-000001');
    expect(planQuery('al noor', CATALOG).padded).toEqual([]);
  });
});

describe('allocationFilters', () => {
  it('turns a branch and a year into patterns over the document number', () => {
    expect(allocationFilters(parseNumberShape('API-HQ-2026-12')!)).toEqual({ branch: '%-HQ-%', year: '%-2026-%' });
    expect(allocationFilters(parseNumberShape('API-12')!)).toEqual({ branch: null, year: null });
  });
});

describe('ordering', () => {
  it('puts the exact match first, the serial match next, then names and references together', () => {
    expect(tierBucket(TIER.exact)).toBeLessThan(tierBucket(TIER.serial));
    expect(tierBucket(TIER.serial)).toBeLessThan(tierBucket(TIER.prefix));
    expect(tierBucket(TIER.prefix)).toBe(tierBucket(TIER.contains));
    expect(tierBucket(TIER.contains)).toBeLessThan(tierBucket(TIER.party));
  });

  it('ranks master records ahead of documents when both hold a name hit', () => {
    const customer = { key: 'customer', best: TIER.contains, priority: 10 };
    const invoice = { key: 'ap_invoice', best: TIER.prefix, priority: 40 };
    expect([invoice, customer].sort(compareGroups).map((g) => g.key)).toEqual(['customer', 'ap_invoice']);
  });

  it('never lets a master outrank an exact document number', () => {
    const customer = { key: 'customer', best: TIER.prefix, priority: 10 };
    const invoice = { key: 'ap_invoice', best: TIER.exact, priority: 40 };
    expect([customer, invoice].sort(compareGroups).map((g) => g.key)).toEqual(['ap_invoice', 'customer']);
  });

  it('ranks a party-name hit below a name hit', () => {
    const invoice = { key: 'ap_invoice', best: TIER.party, priority: 40 };
    const supplier = { key: 'supplier', best: TIER.contains, priority: 11 };
    expect([invoice, supplier].sort(compareGroups).map((g) => g.key)).toEqual(['supplier', 'ap_invoice']);
  });

  it('breaks a tie by priority, then by key', () => {
    const a = { key: 'b', best: TIER.exact, priority: 5 };
    const b = { key: 'a', best: TIER.exact, priority: 5 };
    expect([a, b].sort(compareGroups).map((g) => g.key)).toEqual(['a', 'b']);
  });

  it('orders hits by tier, then newest first, then number; a missing date last', () => {
    const hits = [
      { tier: 2, date: '2026-01-01', number: 'B' },
      { tier: 0, date: '2020-01-01', number: 'Z' },
      { tier: 2, date: '2026-03-01', number: 'A' },
      { tier: 2, date: null, number: 'C' },
      { tier: 2, date: '2026-03-01', number: '0' },
    ];
    expect([...hits].sort(compareHits).map((h) => h.number)).toEqual(['Z', '0', 'A', 'B', 'C']);
  });
});

describe('chipOf — a code wears one of the eleven chips, never itself', () => {
  it('maps the document and record statuses', () => {
    expect(chipOf('posted')).toBe('posted');
    expect(chipOf('fully_repaid')).toBe('settled');
    expect(chipOf('prospect')).toBe('draft');
    expect(chipOf('on_hold')).toBe('submitted');
    expect(chipOf('reversed')).toBe('reversed');
  });

  it('gives the neutral chip to a code it does not know, and to none', () => {
    expect(chipOf('some_new_state')).toBe('draft');
    expect(chipOf(null)).toBe('draft');
  });
});

describe('likeEscape', () => {
  it('takes %, _ and \\ literally', () => {
    expect(likeEscape('100%_a\\b')).toBe('100\\%\\_a\\\\b');
  });
});

describe('screens — "go to Customer Receipts"', () => {
  const screens = [
    { key: 'sales:customer_receipts', label: 'Customer Receipts', section: 'Sales & Receivables', href: '/sales/customer-receipts' },
    { key: 'sales:customers', label: 'Customers', section: 'Sales & Receivables', href: '/sales/customers' },
    { key: 'payables:ap_invoices', label: 'Purchase Invoices', section: 'Purchasing & Invoices', href: '/payables/invoices' },
    { key: 'sales:ar_invoices', label: 'Sales Invoices', section: 'Sales & Receivables', href: '/sales/ar-invoices' },
  ];

  it('ranks the exact title first, then a title that begins with the phrase, then a title containing every word', () => {
    expect(screenTier(screens[0]!, normaliseQuery('customer receipts'))).toBe(TIER.exact);
    expect(screenTier(screens[0]!, normaliseQuery('customer rec'))).toBe(TIER.prefix);
    expect(screenTier(screens[0]!, normaliseQuery('receipts customer'))).toBe(TIER.contains);
    expect(screenTier(screens[0]!, normaliseQuery('receivables receipts'))).toBe(TIER.party);
    expect(screenTier(screens[0]!, normaliseQuery('payroll'))).toBeNull();
  });

  it('lists the best screens first and at most the limit', () => {
    const found = matchScreens(screens, normaliseQuery('invoices'), 5);
    expect(found.map((s) => s.key).sort()).toEqual(['payables:ap_invoices', 'sales:ar_invoices']);
    expect(matchScreens(screens, normaliseQuery('customer'), 1).map((s) => s.key)).toEqual(['sales:customers']);
    expect(matchScreens(screens, normaliseQuery('customer receipts'), 5)[0]!.href).toBe('/sales/customer-receipts');
  });

  it('matches Arabic titles through the same folding (hamza, ta marbuta, diacritics)', () => {
    const arabic = [{ key: 'a', label: 'إيصالات العملاء', section: 'المبيعات', href: '/x' }];
    expect(screenTier(arabic[0]!, normaliseQuery('ايصالات'))).toBe(TIER.prefix);
    expect(screenTier(arabic[0]!, normaliseQuery('العملاء'))).toBe(TIER.contains);
    expect(screenTier(arabic[0]!, normaliseQuery('المبيعات'))).toBe(TIER.party);
  });

  it('answers nothing for an empty phrase', () => {
    expect(matchScreens(screens, normaliseQuery('   '), 5)).toEqual([]);
  });
});

describe('messages — everything the search shows reads in both languages', () => {
  const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as { search: Record<string, Record<string, string> | string> };
  const ar = JSON.parse(readFileSync('messages/ar.json', 'utf8')) as { search: Record<string, Record<string, string> | string> };

  /** Every `key: '…'` the entity declarations register (the files are the source of truth, read as text so this stays database-free). */
  const typeKeys = ['customer', 'supplier'] // masters.ts makes these two from one function (`key: role`)
    .concat(readdirSync('src/server/search/entities')
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts')
    .flatMap((file) => [...readFileSync(`src/server/search/entities/${file}`, 'utf8').matchAll(/^\s+key: '([a-z_]+)',/gm)].map((m) => m[1]!)));

  it('finds the declared types', () => {
    expect(typeKeys.length).toBeGreaterThanOrEqual(20);
    expect(typeKeys).toContain('employee');
    expect(typeKeys).toContain('attachment');
    expect(new Set(typeKeys).size).toBe(typeKeys.length);
  });

  it('has a heading for every type (and for the screens), in English and Arabic', () => {
    for (const key of [...typeKeys, 'screen']) {
      expect((en.search.types as Record<string, string>)[key], `en ${key}`).toBeTruthy();
      expect((ar.search.types as Record<string, string>)[key], `ar ${key}`).toBeTruthy();
    }
  });

  it('has a label for every status code, in English and Arabic — a status is never shown as its code', () => {
    for (const code of STATUS_CODES) {
      const english = (en.search.status as Record<string, string>)[code];
      const arabic = (ar.search.status as Record<string, string>)[code];
      expect(english, `en ${code}`).toBeTruthy();
      expect(arabic, `ar ${code}`).toBeTruthy();
      expect(english).not.toBe(code);
    }
    // …and nothing is translated that no code can carry.
    expect(Object.keys(en.search.status as object).sort()).toEqual([...STATUS_CODES].sort());
    expect(Object.keys(ar.search.status as object).sort()).toEqual([...STATUS_CODES].sort());
  });

  it('keeps the two catalogues the same shape', () => {
    expect(Object.keys(ar.search).sort()).toEqual(Object.keys(en.search).sort());
    expect(Object.keys(ar.search.types as object).sort()).toEqual(Object.keys(en.search.types as object).sort());
  });
});
