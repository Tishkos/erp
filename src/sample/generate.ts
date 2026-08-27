/**
 * Sample data for screens that are drawn but not yet wired.
 *
 * Every screen in the approved tree exists before the service behind it does.
 * Those screens need something to draw, and what they draw has three
 * constraints:
 *
 *   1. **Deterministic.** Derived from the screen's own key, never from
 *      `Math.random()` or the clock. A figure that changes between the server
 *      render and the client hydration is a React mismatch; one that changes
 *      between two screenshots makes visual review impossible.
 *   2. **Plausible but distinct.** Two screens seeded differently must not look
 *      like the same screen twice. A reviewer approving a design needs to see
 *      the shape a real Purchase Order list would take, not filler.
 *   3. **Obviously not real.** Paired with the preview banner every unwired
 *      screen carries. Nothing here should ever be mistaken for a ledger.
 *
 * This file is `.ts`, not `.tsx`, deliberately. Record *values* — a partner
 * name, a document number — are data, not labels, and do not belong in the
 * message catalogue: 325 screens of sample rows would swamp it and make an
 * Arabic translation meaningless. Labels around the data stay catalogue keys.
 */
import { DOCUMENT_STATUSES, type DocumentStatus } from '@domain/statuses';

/* -------------------------------------------------------------------------
 * A seeded generator
 * ---------------------------------------------------------------------- */

/** FNV-1a — a small, stable string hash. Same key, same screen, every time. */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** mulberry32 — a compact PRNG, seeded from the hash above. */
export function seeded(seed: string): () => number {
  let state = hash(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!;
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

/* -------------------------------------------------------------------------
 * The pools
 * ---------------------------------------------------------------------- */

const PARTNERS = [
  'Al Noor Trading Co.',
  'Gulf Supplies Ltd.',
  'Modern Builders Group',
  'Baghdad Retailers',
  'Green World Co.',
  'Tigris Logistics',
  'Basra Marine Services',
  'Erbil Industrial Supply',
  'Mesopotamia Freight',
  'Nineveh Contracting',
  'Karbala Distribution',
  'Zagros Equipment',
] as const;

const BRANCHES = ['HQ', 'BSR', 'ERB', 'MSL'] as const;

const DESCRIPTIONS = [
  'Quarterly replenishment',
  'Project material call-off',
  'Spot purchase — urgent',
  'Framework agreement draw',
  'Customer replacement order',
  'Warehouse transfer request',
  'Service retainer',
  'Freight and handling',
  'Annual maintenance',
  'Opening balance adjustment',
] as const;

/**
 * Statuses weighted towards the working end of the lifecycle.
 *
 * An unweighted pick puts a tenth of every list in `reversed`, which no real
 * ledger looks like and which makes the status column read as noise.
 */
const COMMON_STATUSES: readonly DocumentStatus[] = [
  'posted',
  'posted',
  'posted',
  'approved',
  'approved',
  'submitted',
  'draft',
  'draft',
  'settled',
  'executed',
  'cancelled',
  'closed',
];

/** The document-number prefix for a screen, from its key. */
export function prefixFor(key: string): string {
  const words = key.split('_').filter((word) => word !== 'md');
  const letters = words.map((word) => word[0]!.toUpperCase()).join('');
  return (letters.length >= 2 ? letters : key.slice(0, 3).toUpperCase()).slice(0, 3);
}

/* -------------------------------------------------------------------------
 * Rows
 * ---------------------------------------------------------------------- */

export interface SampleRow {
  readonly id: string;
  readonly reference: string;
  readonly date: string;
  readonly partner: string;
  readonly description: string;
  readonly branch: string;
  readonly amount: number;
  readonly status: DocumentStatus;
}

/**
 * A page of plausible rows for a screen.
 *
 * Dates walk backwards from a fixed day rather than from `new Date()`: a
 * screenshot taken tomorrow must match one taken today, and a business date
 * must never depend on the server's clock (TECHSTACK A10).
 */
export function sampleRows(key: string, count = 12): readonly SampleRow[] {
  const random = seeded(key);
  const prefix = prefixFor(key);
  const rows: SampleRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const serial = between(random, 1, 900) + index;
    const dayOffset = index * between(random, 1, 4);
    const date = new Date(Date.UTC(2026, 7, 21) - dayOffset * 86_400_000)
      .toISOString()
      .slice(0, 10);

    rows.push({
      id: `${key}-${index}`,
      reference: `${prefix}-2026-${String(serial).padStart(5, '0')}`,
      date,
      partner: pick(random, PARTNERS),
      description: pick(random, DESCRIPTIONS),
      branch: pick(random, BRANCHES),
      amount: between(random, 250, 48_000) * 1_000,
      status: pick(random, COMMON_STATUSES),
    });
  }

  return rows;
}

/** A plausible total row count, so pagination has something to page over. */
export function sampleTotal(key: string): number {
  return between(seeded(`${key}:total`), 24, 780);
}

/* -------------------------------------------------------------------------
 * Figures
 * ---------------------------------------------------------------------- */

export interface SampleMetric {
  readonly key: string;
  readonly amount: number;
  readonly trend: number;
  readonly currency: boolean;
}

/** Four or five headline figures for a dashboard or a list's KPI strip. */
export function sampleMetrics(key: string, count = 4): readonly SampleMetric[] {
  const random = seeded(`${key}:metrics`);
  return Array.from({ length: count }, (_, index) => ({
    key: `${key}-metric-${index}`,
    amount: between(random, 40, 9_800) * 1_000,
    trend: (between(random, -140, 260) / 1000),
    currency: index < count - 1,
  }));
}

/** A monthly series for a sparkline or a small chart. */
export function sampleSeries(key: string, points = 12): readonly number[] {
  const random = seeded(`${key}:series`);
  let value = between(random, 30, 70);
  return Array.from({ length: points }, () => {
    value = Math.max(8, Math.min(100, value + between(random, -14, 18)));
    return value;
  });
}

export const SAMPLE_STATUSES = DOCUMENT_STATUSES;

/* -------------------------------------------------------------------------
 * Rows per entity shape
 * ---------------------------------------------------------------------- */

const ITEMS = [
  'Marine diesel filter',
  'Container seal, steel',
  'Pallet wrap 500mm',
  'Hydraulic hose 3/4"',
  'Safety helmet, white',
  'Bearing assembly 6205',
  'Cable, 3-core 2.5mm',
  'Paint, marine primer',
  'Gasket set, generic',
  'Forklift tyre 7.00-12',
] as const;

const CATEGORIES = [
  'Consumables',
  'Spare parts',
  'Safety equipment',
  'Raw material',
  'Packaging',
  'Services',
] as const;

const PEOPLE = [
  'Ahmed Karim',
  'Sara Mahmoud',
  'Rania Hassan',
  'Omar Al-Bakri',
  'Layla Jassim',
  'Yusuf Rashid',
  'Noor Abdullah',
  'Hussein Ali',
] as const;

const DEPARTMENTS = ['Finance', 'Operations', 'Logistics', 'Procurement', 'Warehouse'] as const;
const WAREHOUSES = ['WH-BGD', 'WH-BSR', 'WH-ERB', 'WH-MSL'] as const;
const ROUTES = ['Umm Qasr → Baghdad', 'Baghdad → Erbil', 'Basra → Najaf', 'Erbil → Mosul'] as const;
const CARRIERS = ['Tigris Haulage', 'Zagros Transit', 'Gulf Freight', 'Mesopotamia Lines'] as const;
const CHANNELS = ['SWIFT', 'Correspondent', 'Internal book', 'Cash desk'] as const;
const AGE_BUCKETS = ['Current', '1–30', '31–60', '61–90', '90+'] as const;
const RESULTS = ['Completed', 'Completed with warnings', 'Failed', 'Skipped'] as const;
const PERIODS = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'] as const;

/**
 * One page of rows in the shape a screen's module actually uses.
 *
 * Returns plain values keyed by column. Formatting — currency, dates, status
 * pills — is the renderer's job, so this file stays free of locale and JSX and
 * a row can be reformatted without regenerating it.
 */
export function sampleEntityRows(
  key: string,
  entity: string,
  count = 12,
): readonly Record<string, unknown>[] {
  const random = seeded(`${key}:${entity}`);
  const prefix = prefixFor(key);

  return Array.from({ length: count }, (_, index) => {
    const serial = between(random, 1, 900) + index;
    const reference = `${prefix}-2026-${String(serial).padStart(5, '0')}`;
    const date = new Date(Date.UTC(2026, 7, 21) - index * between(random, 1, 4) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const amount = between(random, 250, 48_000) * 1_000;
    const status = pick(random, COMMON_STATUSES);
    const base = { id: `${key}-${index}` };

    switch (entity) {
      case 'ledger': {
        const debit = random() > 0.5 ? amount : 0;
        return {
          ...base,
          entry_no: reference,
          posting_date: date,
          description: pick(random, DESCRIPTIONS),
          debit,
          credit: debit === 0 ? amount : 0,
          balance: between(random, -20_000, 90_000) * 1_000,
        };
      }
      case 'ageing': {
        const outstanding = Math.round(amount * (between(random, 20, 100) / 100));
        return {
          ...base,
          partner: pick(random, PARTNERS),
          reference,
          due_date: date,
          amount,
          outstanding,
          days_overdue: between(random, 0, 120),
          ageing_bucket: pick(random, AGE_BUCKETS),
        };
      }
      case 'item': {
        const quantity = between(random, 5, 900);
        const unitPrice = between(random, 2, 400) * 250;
        return {
          ...base,
          item_code: `ITM-${String(between(random, 1000, 9999))}`,
          name: pick(random, ITEMS),
          category: pick(random, CATEGORIES),
          quantity,
          unit_price: unitPrice,
          line_total: quantity * unitPrice,
        };
      }
      case 'stock': {
        const onHand = between(random, 0, 1_800);
        const reserved = Math.min(onHand, between(random, 0, 400));
        return {
          ...base,
          item_code: `ITM-${String(between(random, 1000, 9999))}`,
          name: pick(random, ITEMS),
          warehouse_code: pick(random, WAREHOUSES),
          on_hand: onHand,
          reserved,
          available: onHand - reserved,
          valuation: onHand * between(random, 2, 90) * 500,
        };
      }
      case 'party':
        return {
          ...base,
          code: `${prefix}-${String(between(random, 100, 999))}`,
          name: pick(random, PARTNERS),
          category: pick(random, CATEGORIES),
          branch_code: pick(random, BRANCHES),
          balance: between(random, -8_000, 60_000) * 1_000,
          status,
        };
      case 'person':
        return {
          ...base,
          code: `EMP-${String(between(random, 1000, 4999))}`,
          employee: pick(random, PEOPLE),
          department: pick(random, DEPARTMENTS),
          category: pick(random, CATEGORIES),
          amount,
          status,
        };
      case 'asset': {
        const depreciation = Math.round(amount * (between(random, 5, 60) / 100));
        return {
          ...base,
          asset_code: `FA-${String(between(random, 1000, 9999))}`,
          name: pick(random, ITEMS),
          category: pick(random, CATEGORIES),
          document_date: date,
          depreciation,
          net_book_value: amount - depreciation,
          status,
        };
      }
      case 'job':
        return {
          ...base,
          job_number: reference,
          document_date: date,
          customer: pick(random, PARTNERS),
          route: pick(random, ROUTES),
          carrier: pick(random, CARRIERS),
          cost: amount,
          margin: between(random, -60, 320) / 1000,
          status,
        };
      case 'transfer':
        return {
          ...base,
          reference,
          value_date: date,
          beneficiary: pick(random, PARTNERS),
          channel: pick(random, CHANNELS),
          amount,
          fee: between(random, 5, 90) * 1_000,
          status,
        };
      case 'budget': {
        const budget = between(random, 500, 60_000) * 1_000;
        const actual = Math.round(budget * (between(random, 55, 135) / 100));
        return {
          ...base,
          period: pick(random, PERIODS),
          department: pick(random, DEPARTMENTS),
          budget_amount: budget,
          actual_amount: actual,
          variance: actual - budget,
        };
      }
      case 'run':
        return {
          ...base,
          reference,
          last_run: date,
          user: pick(random, PEOPLE),
          result: pick(random, RESULTS),
          status,
        };
      default:
        return {
          ...base,
          reference,
          document_date: date,
          partner: pick(random, PARTNERS),
          description: pick(random, DESCRIPTIONS),
          branch_code: pick(random, BRANCHES),
          amount,
          status,
        };
    }
  });
}

/**
 * Settings as name/value pairs, each with the kind of value it takes.
 *
 * Pairing a name with a value from one shared pool produced rows like
 * "Attachment size limit (MB): HQ", which reads as filler the moment anyone
 * looks at it. A setting knows what sort of value it holds.
 */
const SETTINGS: readonly { readonly name: string; readonly options: readonly string[] }[] = [
  { name: 'Default posting period', options: ['Current period', 'Document date', 'Manual'] },
  { name: 'Require approval above', options: ['1,000,000', '5,000,000', '25,000,000'] },
  { name: 'Numbering series', options: ['Per branch', 'Per company', 'Per document type'] },
  { name: 'Allow negative stock', options: ['Enabled', 'Disabled'] },
  { name: 'Base reporting currency', options: ['IQD', 'USD'] },
  { name: 'Auto-post on approval', options: ['Enabled', 'Disabled'] },
  { name: 'Retention period (months)', options: ['24', '60', '84'] },
  { name: 'Duplicate invoice check', options: ['Enabled', 'Warn only', 'Disabled'] },
  { name: 'Rounding tolerance', options: ['0', '250', '1,000'] },
  { name: 'Notify on rejection', options: ['Enabled', 'Disabled'] },
  { name: 'Session timeout (minutes)', options: ['15', '30', '60'] },
  { name: 'Attachment size limit (MB)', options: ['5', '10', '25'] },
];

export interface SampleSetting {
  readonly id: string;
  readonly setting: string;
  readonly value: string;
  readonly defaultValue: string;
  /** True when the value differs from the shipped default. */
  readonly changed: boolean;
}

/**
 * Name/value pairs for one configuration panel.
 *
 * `offset` walks a different slice of the list for each panel on a screen, so
 * three panels show twelve distinct settings rather than the same four names
 * three times over.
 */
export function sampleSettings(key: string, offset = 0, count = 4): readonly SampleSetting[] {
  const random = seeded(`${key}:settings:${offset}`);
  return Array.from({ length: count }, (_, index) => {
    const setting = SETTINGS[(offset * count + index) % SETTINGS.length]!;
    const defaultValue = setting.options[0]!;
    const value = pick(random, setting.options);
    return {
      id: `${key}-setting-${offset}-${index}`,
      setting: setting.name,
      value,
      defaultValue,
      changed: value !== defaultValue,
    };
  });
}

/**
 * Distinct category names, for a composition chart.
 *
 * Picking each slice independently produced donuts with "Packaging" twice —
 * two slices the legend cannot tell apart, which is exactly the identity
 * failure a categorical palette exists to avoid. Walking the list guarantees
 * distinctness; the seed only chooses where to start.
 */
export function sampleCategories(key: string, count = 5): readonly string[] {
  const start = between(seeded(`${key}:categories`), 0, CATEGORIES.length - 1);
  return Array.from(
    { length: Math.min(count, CATEGORIES.length) },
    (_, index) => CATEGORIES[(start + index) % CATEGORIES.length]!,
  );
}

/**
 * Distinct partners with a value each, for a ranked list.
 *
 * Same reasoning as `sampleCategories`: a "top five" that names the same
 * partner twice is not a ranking. Walking the pool guarantees distinctness.
 */
export function sampleRanking(
  key: string,
  count = 5,
): readonly { readonly label: string; readonly value: number }[] {
  const random = seeded(`${key}:ranking`);
  const start = between(random, 0, PARTNERS.length - 1);
  return Array.from({ length: Math.min(count, PARTNERS.length) }, (_, index) => ({
    label: PARTNERS[(start + index) % PARTNERS.length]!,
    value: between(random, 4, 90) * 1_000_000,
  })).sort((a, b) => b.value - a.value);
}
