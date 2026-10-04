/**
 * What a Home widget hands the page — platform phase, Agent 2.
 *
 * Every widget's loader answers with one of these shapes and the page draws it
 * with one presenter per shape (`components/admin/home-widgets.tsx`). Splitting
 * *what a widget found* from *how it is drawn* is what lets a test read a
 * widget's figures without a browser, and what keeps forty widgets from being
 * forty hand-written pieces of markup that slowly stop looking alike.
 *
 * A cell is a typed value, never a formatted string: money stays a decimal
 * string at the ledger's scale, a date stays an ISO business date, a status
 * stays its code. The presenter formats them for the reader's locale, so the
 * same loader serves English and Arabic and nothing is rounded on the way.
 *
 * Pure types and two constructors; no database, no clock.
 */

export type Cell =
  /** Free text — a name or a title as a person typed it. */
  | { readonly t: 'text'; readonly v: string }
  /** An identifier: a document number, a code. Always left-to-right. */
  | { readonly t: 'code'; readonly v: string }
  /** A decimal string at the money scale, in its own currency. */
  | { readonly t: 'money'; readonly v: string; readonly currency: string }
  /** A decimal string in a base unit. */
  | { readonly t: 'qty'; readonly v: string }
  | { readonly t: 'count'; readonly v: number }
  /** An ISO business date. */
  | { readonly t: 'date'; readonly v: string }
  /** An ISO instant. */
  | { readonly t: 'instant'; readonly v: string }
  /** A status code, drawn as the shared status chip with `status.<code>` as its words. */
  | { readonly t: 'status'; readonly v: string }
  /** A code with words in the catalogue: `home.value.<v>`, or `<ns>.<v>` when another screen's words are reused. */
  | { readonly t: 'word'; readonly v: string; readonly ns?: string }
  /** A short sentence from the catalogue (`home.say.<v>`) with its numbers. */
  | { readonly t: 'say'; readonly v: string; readonly values?: Readonly<Record<string, string | number>> }
  | { readonly t: 'none' };

export const text = (v: string | null | undefined): Cell => (v ? { t: 'text', v } : { t: 'none' });
export const code = (v: string | null | undefined): Cell => (v ? { t: 'code', v } : { t: 'none' });
export const money = (v: string | null | undefined, currency = 'IQD'): Cell => (v === null || v === undefined ? { t: 'none' } : { t: 'money', v, currency });
export const qty = (v: string | null | undefined): Cell => (v === null || v === undefined ? { t: 'none' } : { t: 'qty', v });
export const count = (v: number): Cell => ({ t: 'count', v });
export const day = (v: string | null | undefined): Cell => (v ? { t: 'date', v } : { t: 'none' });
export const instant = (v: string | null | undefined): Cell => (v ? { t: 'instant', v } : { t: 'none' });
export const status = (v: string | null | undefined): Cell => (v ? { t: 'status', v } : { t: 'none' });
export const say = (v: string, values?: Readonly<Record<string, string | number>>): Cell => (values ? { t: 'say', v, values } : { t: 'say', v });
export const word = (v: string | null | undefined, ns?: string): Cell => (v ? (ns ? { t: 'word', v, ns } : { t: 'word', v }) : { t: 'none' });

/** A sentence from the catalogue (`home.note.<key>`) with its numbers. */
export interface Note {
  readonly key: string;
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface Column {
  /** `home.col.<key>`. */
  readonly key: string;
  readonly numeric?: boolean;
}

export interface TableRow {
  readonly key: string;
  /** Where the row opens — the real document. Null when the viewer has no screen for it. */
  readonly href: string | null;
  readonly cells: readonly Cell[];
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/** One primary figure. */
export interface KpiData {
  readonly kind: 'kpi';
  readonly value: Cell;
  readonly note: Note | null;
  /** The screen that proves the figure. */
  readonly href: string | null;
  readonly tone: 'warn' | null;
}

/** Rows to act on. `total` is the true count behind them, not the page. */
export interface TableData {
  readonly kind: 'table';
  readonly columns: readonly Column[];
  readonly rows: readonly TableRow[];
  readonly total: number;
  readonly href: string | null;
  readonly note: Note | null;
}

export type ChartSpec =
  /** Two money series over months (decimal strings), compared not added. */
  | {
      readonly type: 'columns';
      readonly firstKey: string;
      readonly secondKey: string;
      readonly points: readonly { readonly month: string; readonly first: string; readonly second: string }[];
    }
  /** Ranked bars, one series. `labelKey` is a `home.value` code; otherwise `label` is a name. */
  | {
      readonly type: 'bars';
      readonly unit: 'money' | 'count';
      readonly rows: readonly { readonly key: string; readonly label: string; readonly labelKey: boolean; readonly value: string }[];
    }
  /** One stacked bar of ordered bands (ageing). */
  | {
      readonly type: 'stack';
      readonly rows: readonly { readonly key: string; readonly labelKey: string; readonly value: string; readonly step: number; readonly count: number }[];
    };

export interface ChartData {
  readonly kind: 'chart';
  readonly chart: ChartSpec;
  readonly note: Note | null;
  readonly href: string | null;
  /** Take the whole row (a chart whose axis needs the width). */
  readonly wide: boolean;
}

/** The import journey: each stage and the imports in progress that have reached it. */
export interface JourneyData {
  readonly kind: 'journey';
  /** In journey order. `count` is how many imports have reached the stage. */
  readonly stages: readonly { readonly key: string; readonly count: number }[];
  /** Imports still in progress that were counted. */
  readonly inProgress: number;
  /** Imports read, and the imports the viewer has — differ only past the read cap. */
  readonly read: number;
  readonly total: number;
  readonly href: string | null;
}

export type WidgetData = KpiData | TableData | ChartData | JourneyData;

/**
 * How a widget ended:
 *   ready       figures to draw
 *   empty       the viewer holds the grants and there is nothing to show
 *   unreadable  the read failed (logged server-side); the page says so
 *   unwired     a slot nothing feeds yet (the Exception Center's); not drawn
 */
export type WidgetOutcome =
  | { readonly state: 'ready'; readonly data: WidgetData }
  | { readonly state: 'empty' }
  | { readonly state: 'unreadable' }
  | { readonly state: 'unwired' };

export const READY = (data: WidgetData): WidgetOutcome => ({ state: 'ready', data });
export const EMPTY: WidgetOutcome = { state: 'empty' };
export const UNREADABLE: WidgetOutcome = { state: 'unreadable' };
export const UNWIRED: WidgetOutcome = { state: 'unwired' };
