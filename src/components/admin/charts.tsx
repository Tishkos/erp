import type { ReactNode } from 'react';
import { ChevronDown, Table2 } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import { INK } from '@/components/admin/dashboard-band';

/**
 * The dashboard's charts, in Intent UI's look (2026-10-06, the redesign).
 *
 * Every chart is a card: a title, a hint, the link to the screen that proves
 * it, the plot, and under it a `<details>` with the same figures as a table,
 * so no value is reachable only by pointing at it. The trends over months are
 * Intent's recharts `BarChart` (`components/home/trend-chart.tsx`, the one
 * piece that needs the browser, for its tooltips); the ranked lists and the
 * ageing bar are drawn here, on the server, in Intent's bar-list manner —
 * they are in the first paint and they print.
 *
 * ── The rules these follow ────────────────────────────────────────────────
 * Marks are thin: a ranked bar is an 8px track, a column caps at 24px, a 2px
 * gap in the surface colour separates touching fills rather than a stroke
 * drawn around them. Labels are the reader's words and figures beside the
 * mark, never inside it, and text never wears the series colour — identity
 * comes from the swatch beside it.
 *
 * Colour: one series follows the palette's own accent (`--ui-primary`); two
 * series that must be told apart, and the ordered ageing ramp, use the
 * `--chart-*` steps that were validated for colour vision on this
 * application's light and dark surfaces (admin.module.css).
 */

/** A chart and the table that says the same thing. */
export function Chart({
  title,
  hint,
  action,
  children,
  table,
  tableLabel = 'Table',
  wide,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  /** At the end of the title: the screen that reads the chart properly. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  /** The WCAG-clean twin. Every chart has one; nothing is gated behind hover. */
  readonly table: ReactNode;
  readonly tableLabel?: string;
  /** Takes the whole row. For a chart whose x-axis needs the width. */
  readonly wide?: boolean;
}) {
  return (
    <figure
      className={cn(
        'm-0 flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-overlay text-overlay-fg shadow-xs',
        wide && 'lg:col-span-2',
      )}
    >
      <figcaption className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="m-0 font-semibold text-base text-fg">{title}</h3>
          {hint ? <p className="m-0 mt-0.5 text-muted-fg text-sm">{hint}</p> : null}
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </figcaption>
      <div className="min-w-0 flex-1 px-4 pt-4 pb-4 sm:px-5">{children}</div>
      <details className="group/table border-border border-t">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 font-medium text-muted-fg text-xs outline-none hover:text-fg focus-visible:bg-muted sm:px-5 [&::-webkit-details-marker]:hidden">
          <Table2 aria-hidden="true" className="size-3.5" />
          {tableLabel}
          <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/table:rotate-180" />
        </summary>
        {table}
      </details>
    </figure>
  );
}

export interface Series {
  readonly label: string;
  /** A colour custom property name, e.g. `--chart-series-1`. */
  readonly token: string;
}

/** The identity channel that is not colour. Always present for two or more series. */
export function Legend({ series }: { readonly series: readonly Series[] }) {
  if (series.length < 2) return null; // one series: the title already names it
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1 p-0 text-muted-fg text-xs">
      {series.map((one) => (
        <li className="inline-flex items-center gap-1.5" key={one.label}>
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: `var(${one.token})` }} />
          {one.label}
        </li>
      ))}
    </ul>
  );
}

export interface BarRow {
  readonly key: string;
  readonly label: string;
  /** The plotted length — the last step before drawing, never added again. */
  readonly value: number;
  /** The figure as the reader reads it, formatted from the service's own decimal string. */
  readonly text: string;
}

/**
 * A ranked list as horizontal bars — one series, therefore one colour, the
 * palette's accent. The longest bar is the whole track; the figure sits at the
 * end of the label line, not on the bar.
 *
 * Deliberately not a value ramp. Colouring each bar darker-where-bigger would
 * spend the only free channel on what the bar's length already says. A
 * negative balance (an overdrawn account) is a real figure: it keeps its
 * length by magnitude and wears the validated negative colour.
 */
export function BarList({ rows }: { readonly rows: readonly BarRow[] }) {
  const top = Math.max(0, ...rows.map((row) => Math.abs(row.value)));
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map((row) => {
        const share = top > 0 ? Math.max(1.5, (Math.abs(row.value) / top) * 100) : 0;
        return (
          <li className="min-w-0" key={row.key}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-fg" title={row.label}>
                <bdi dir="auto">{row.label}</bdi>
              </span>
              <span className={cn('shrink-0 font-medium tabular-nums', row.value < 0 ? INK.danger : 'text-fg')}>
                <bdi dir="ltr">{row.text}</bdi>
              </span>
            </div>
            <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn('h-full rounded-full', row.value < 0 ? 'bg-[var(--chart-negative)]' : 'bg-primary')}
                style={{ inlineSize: `${share}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface StackBand {
  readonly key: string;
  readonly label: string;
  /** The plotted share — never added again as money. */
  readonly value: number;
  /** 1 … 5, the ordinal ramp step: later is darker. */
  readonly step: number;
  readonly text: string;
}

const RAMP: Readonly<Record<number, string>> = {
  1: 'var(--chart-ramp-1)',
  2: 'var(--chart-ramp-2)',
  3: 'var(--chart-ramp-3)',
  4: 'var(--chart-ramp-4)',
  5: 'var(--chart-ramp-5)',
};

/**
 * One stacked bar of ordered bands — how late the money is — and its legend,
 * one row a band, with the amount and its share of the whole.
 *
 * Ageing buckets are an *ordered* scale, so this is the ordinal ramp rather
 * than categorical colours: one hue, getting darker as it gets later, which
 * reads as "worse" without a second colour being asked to mean anything. The
 * 2px gaps are the surface showing through, not strokes.
 */
export function StackedBands({ bands, locale }: { readonly bands: readonly StackBand[]; readonly locale: string }) {
  const total = bands.reduce((sum, one) => sum + Math.max(0, one.value), 0);
  if (total <= 0) return null;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return (
    <>
      <div aria-hidden="true" className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {bands.map((one) => (
          <span
            className="h-full min-w-1 first:rounded-s-full last:rounded-e-full"
            key={one.key}
            style={{ background: RAMP[one.step] ?? RAMP[3], flexBasis: `${(Math.max(0, one.value) / total) * 100}%`, flexGrow: 0, flexShrink: 1 }}
            title={`${one.label}: ${one.text}`}
          />
        ))}
      </div>
      <ul className="m-0 mt-4 flex list-none flex-col divide-y divide-border p-0">
        {bands.map((one) => (
          <li className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0" key={one.key}>
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: RAMP[one.step] ?? RAMP[3] }} />
            <span className="min-w-0 flex-1 truncate text-fg">{one.label}</span>
            <span className="shrink-0 text-muted-fg text-xs tabular-nums">
              <bdi dir="ltr">{percent.format(Math.max(0, one.value) / total)}</bdi>
            </span>
            <span className="shrink-0 font-medium text-fg tabular-nums">
              <bdi dir="ltr">{one.text}</bdi>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
