import type { ReactNode } from 'react';
import { ChevronDown, Table2 } from 'lucide-react';
import { cn } from '@/components/intent/cn';
import { INK } from '@/components/admin/dashboard-band';

/**
 * The charts' frame and the pieces drawn on the server, in Intent UI's look
 * (2026-10-06, the redesign; made "more modern" the same day, by direction).
 *
 * Every chart is a card: a title, a hint, the link to the screen that proves
 * it, the plot, and under it a `<details>` with the same figures as a table,
 * so no value is reachable only by pointing at it. The pieces that need the
 * browser — the area trends and the donut, for their tooltips and pointing —
 * are the client components in `components/charts/`; the ranked bar list and
 * the sparkline are drawn here, so they are in the first paint and they print.
 *
 * ── The rules these follow ────────────────────────────────────────────────
 * Marks are thin and rounded; a 2px gap in the surface colour separates
 * touching fills rather than a stroke drawn around them. Figures are said
 * beside the mark, and text never wears the series colour — identity comes
 * from the swatch beside it.
 *
 * Colour: one series follows the palette's own accent (`--ui-primary`); two
 * series that must be told apart, and the ordered ageing ramp, use the
 * `--chart-*` steps that were validated for colour vision on this
 * application's light and dark surfaces (admin.module.css).
 *
 * Motion: a bar grows once from its start when it is first drawn
 * (`@starting-style`), and not at all under `prefers-reduced-motion`.
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
  className,
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
  /** Where the card sits in a page that is not Home's grid (its margin, its column). */
  readonly className?: string | undefined;
}) {
  return (
    <figure
      className={cn(
        'm-0 flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-overlay text-overlay-fg shadow-xs',
        wide && 'lg:col-span-2',
        className,
      )}
    >
      <figcaption className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="m-0 font-semibold text-base text-fg tracking-tight rtl:tracking-normal">{title}</h3>
          {hint ? <p className="m-0 mt-0.5 text-muted-fg text-sm">{hint}</p> : null}
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </figcaption>
      <div className="min-w-0 flex-1 px-4 pt-4 pb-5 sm:px-5">{children}</div>
      <details className="group/table border-border border-t">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 font-medium text-muted-fg text-xs outline-none hover:text-fg focus-visible:bg-muted sm:px-5 [&::-webkit-details-marker]:hidden">
          <Table2 aria-hidden="true" className="size-3.5" />
          {tableLabel}
          <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open/table:rotate-180 motion-reduce:transition-none" />
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
  /** The series' figure for the whole period, already in the reader's words ("12.5M IQD"). */
  readonly value?: string | undefined;
  /** The exact figure, when `value` is said short. */
  readonly title?: string | undefined;
}

/**
 * The series as chips: the swatch, the name and — where the caller has it —
 * the series' figure for the whole period. The identity channel that is not
 * colour; always present for two or more series. One series with no figure
 * needs none: the title already names it.
 */
export function Legend({ series }: { readonly series: readonly Series[] }) {
  if (series.length < 2 && !series.some((one) => one.value)) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-xs">
      {series.map((one) => (
        <li
          className="inline-flex min-w-0 items-center gap-2 rounded-full border border-border bg-muted/40 py-1 ps-2.5 pe-3"
          key={one.label}
          title={one.title}
        >
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ background: `var(${one.token})`, boxShadow: `0 0 0 3px color-mix(in oklab, var(${one.token}) 20%, transparent)` }}
          />
          <span className="text-muted-fg">{one.label}</span>
          {one.value ? (
            <span className="font-semibold text-fg tabular-nums">
              <bdi>{one.value}</bdi>
            </span>
          ) : null}
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
  /** Its share of the whole, already formatted, when the list is the whole. */
  readonly share?: string | null | undefined;
}

/**
 * A ranked list as rounded bars with the name on them — one series,
 * therefore one colour, the palette's accent, deepening along the bar. The
 * longest bar is the whole track; the figure and its share stand at the end of
 * the row, outside the bar.
 *
 * Deliberately not a value ramp: colouring each bar darker-where-bigger would
 * spend the only free channel on what the bar's length already says. A
 * negative balance (an overdrawn account) is a real figure: it keeps its
 * length by magnitude, wears the validated negative colour and says so in
 * words (`negativeLabel`), so it is never told by colour alone.
 */
export function BarList({ rows, negativeLabel }: { readonly rows: readonly BarRow[]; readonly negativeLabel?: string | undefined }) {
  const top = Math.max(0, ...rows.map((row) => Math.abs(row.value)));
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((row) => {
        const width = top > 0 ? Math.max(2, (Math.abs(row.value) / top) * 100) : 0;
        const negative = row.value < 0;
        return (
          <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3" key={row.key}>
            <div className="relative h-9 min-w-0 overflow-hidden rounded-lg bg-muted/50">
              <div
                aria-hidden="true"
                className={cn(
                  'absolute inset-y-0 start-0 rounded-lg border-e-2 bg-linear-to-r rtl:bg-linear-to-l',
                  negative
                    ? 'border-[var(--chart-negative)] from-[color-mix(in_oklab,var(--chart-negative)_6%,transparent)] to-[color-mix(in_oklab,var(--chart-negative)_24%,transparent)]'
                    : 'border-primary from-primary/6 to-primary/26',
                  'origin-left transition-transform duration-700 ease-out starting:scale-x-0 motion-reduce:transition-none rtl:origin-right',
                )}
                style={{ inlineSize: `${width}%` }}
              />
              <div className="relative flex h-full min-w-0 items-center gap-2 px-3">
                {/* Its own direction, so a Latin name in an Arabic page is cut at its own end, not its beginning. */}
                <span className="min-w-0 truncate text-fg text-sm" dir="auto" title={row.label}>
                  {row.label}
                </span>
                {negative && negativeLabel ? (
                  <span className={cn('shrink-0 rounded-md bg-danger-subtle px-1.5 py-px font-medium text-[0.7rem]/4', INK.danger)}>{negativeLabel}</span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col items-end leading-tight">
              <span className={cn('font-semibold text-sm tabular-nums', negative ? INK.danger : 'text-fg')}>
                <bdi dir="ltr">{row.text}</bdi>
              </span>
              {row.share ? (
                <span className="text-muted-fg text-xs tabular-nums">
                  <bdi dir="ltr">{row.share}</bdi>
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A figure's recent course as a small line and its soft area — on a stat tile,
 * beside the figure, only where the page already holds the series (Home's
 * month-by-month sales). Decorative: the series is the chart's below, with its
 * table; so it is hidden from assistive technology and says what it is only
 * as its title. Right to left, time runs from the right.
 */
export function Sparkline({ values, id, title }: { readonly values: readonly number[]; readonly id: string; readonly title?: string | undefined }) {
  if (values.length < 2) return null;
  const width = 96;
  const height = 32;
  const pad = 3;
  const least = Math.min(0, ...values);
  const most = Math.max(...values);
  const span = most - least || 1;
  const x = (index: number) => pad + (index / (values.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - least) / span) * (height - pad * 2);
  const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)} ${y(value).toFixed(2)}`).join(' ');
  const base = y(Math.max(least, 0)).toFixed(2);
  const area = `${line} L${x(values.length - 1).toFixed(2)} ${base} L${x(0).toFixed(2)} ${base} Z`;
  const gradient = `spark-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const last = values.length - 1;
  return (
    <svg aria-hidden="true" className="h-8 w-24 shrink-0 overflow-visible rtl:-scale-x-100" viewBox={`0 0 ${width} ${height}`}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--ui-primary)" stopOpacity={0.28} />
          <stop offset="100%" stopColor="var(--ui-primary)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradient})`} />
      <path d={line} fill="none" stroke="var(--ui-primary)" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} />
      <circle cx={x(last)} cy={y(values[last]!)} fill="var(--ui-primary)" r={2.75} stroke="var(--ui-overlay)" strokeWidth={1.5} />
    </svg>
  );
}
