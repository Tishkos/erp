import type { ReactNode } from 'react';
import admin from './admin.module.css';

/**
 * The dashboard's charts — plain SVG, drawn on the server.
 *
 * No charting library and no client JavaScript. A chart here is a few hundred
 * bytes of markup the server already had the numbers for, which means it is in
 * the first paint, it prints, and it costs the browser nothing. The cost is
 * that there is no drag-zoom and no animated tooltip; what there is instead is
 * a native `<title>` on every mark (the browser's own hover text) and a table
 * under every chart, so no value is reachable only by pointing at it.
 *
 * ── The rules these follow ────────────────────────────────────────────────
 * Marks are thin: bars cap at 24px and never fill their slot, lines are 2px,
 * a 2px gap in the surface colour separates touching fills rather than a
 * stroke drawn around them. Grid and axis are solid hairlines one step off the
 * surface — never dashed, which reads as "threshold" when it is just a grid.
 * Labels are selective: an endpoint, an extreme, the one series that matters —
 * never a number on every mark. Text never wears the series colour; identity
 * comes from the swatch beside it.
 *
 * Colour is not chosen here. Every fill is a `--chart-*` token whose light and
 * dark steps are set once in `admin.module.css` and were validated against
 * this application's own surfaces rather than picked by eye.
 */

const AXIS_INK = 'var(--chart-axis)';
const GRID = 'var(--chart-grid)';

/** A chart and the table that says the same thing. Named `Chart` because the
 * dashboard already has a `Figure` — a labelled box holding one number. */
export function Chart({
  title,
  hint,
  children,
  table,
  wide,
}: {
  readonly title: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
  /** The WCAG-clean twin. Every chart has one; nothing is gated behind hover. */
  readonly table: ReactNode;
  /** Takes the whole row. For a chart whose x-axis needs the width. */
  readonly wide?: boolean;
}) {
  return (
    <figure className={wide ? `${admin.chartFigure} ${admin.chartWide}` : admin.chartFigure}>
      <figcaption className={admin.chartCaption}>
        <strong>{title}</strong>
        {hint ? <span>{hint}</span> : null}
      </figcaption>
      {children}
      <details className={admin.chartTable}>
        <summary>{table ? 'Table' : ''}</summary>
        {table}
      </details>
    </figure>
  );
}

export interface Series {
  readonly label: string;
  /** A `--chart-*` custom property name. */
  readonly token: string;
  readonly values: readonly number[];
}

/** The identity channel that is not colour. Always present for two or more series. */
export function Legend({ series }: { readonly series: readonly Series[] }) {
  if (series.length < 2) return null; // one series: the title already names it
  return (
    <ul className={admin.chartLegend}>
      {series.map((one) => (
        <li key={one.label}>
          <span aria-hidden="true" style={{ background: `var(${one.token})` }} />
          {one.label}
        </li>
      ))}
    </ul>
  );
}

const niceCeiling = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
};

/**
 * Two series of columns over time — income against what it cost.
 *
 * Grouped rather than stacked: these two are compared with each other, not
 * added together, and a stack would invite reading the total as a figure that
 * means something. One baseline, one scale. Never a second y-axis.
 */
export function GroupedColumns({
  labels,
  series,
  format,
  height = 168,
}: {
  readonly labels: readonly string[];
  readonly series: readonly [Series, Series];
  readonly format: (value: number) => string;
  readonly height?: number;
}) {
  const width = 720;
  const pad = { top: 14, right: 8, bottom: 22, left: 8 };
  const plot = { w: width - pad.left - pad.right, h: height - pad.top - pad.bottom };
  const top = niceCeiling(Math.max(1, ...series.flatMap((s) => s.values)));
  const band = plot.w / labels.length;
  // Two bars, a 2px gap between them, and the band's leftover left as air.
  const barW = Math.min(24, Math.max(4, (band - 12) / 2));
  const y = (value: number) => pad.top + plot.h - (value / top) * plot.h;
  // The one label worth drawing: the tallest column. Its cap is by definition
  // the highest point on the plot, so there is always room above it, and it is
  // the figure a reader looks for first.
  const peakValue = Math.max(0, ...series.flatMap((one) => one.values));
  const peakAt = series
    .flatMap((one) => one.values)
    .indexOf(peakValue) % Math.max(1, labels.length);

  return (
    <svg
      className={admin.chartSvg}
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      {[0.5, 1].map((fraction) => (
        <line
          key={fraction}
          stroke={GRID}
          strokeWidth="1"
          x1={pad.left}
          x2={width - pad.right}
          y1={y(top * fraction)}
          y2={y(top * fraction)}
        />
      ))}

      {labels.map((label, index) => {
        const centre = pad.left + band * index + band / 2;
        return (
          <g key={label}>
            {series.map((one, s) => {
              const value = one.values[index] ?? 0;
              const barH = Math.max(value > 0 ? 2 : 0, (value / top) * plot.h);
              const x = centre - barW - 1 + s * (barW + 2);
              return (
                <rect
                  fill={`var(${one.token})`}
                  height={barH}
                  key={one.label}
                  // 4px rounded data-end; the baseline end stays square because
                  // the radius is smaller than the bar and the rect sits on it.
                  rx={Math.min(4, barW / 2)}
                  width={barW}
                  x={x}
                  y={pad.top + plot.h - barH}
                >
                  <title>{`${label} · ${one.label}: ${format(value)}`}</title>
                </rect>
              );
            })}
            <text
              fill={AXIS_INK}
              fontSize="10"
              textAnchor="middle"
              x={centre}
              y={height - 7}
            >
              {label}
            </text>
          </g>
        );
      })}

      {/* The baseline, and the one label that earns its place: the last month. */}
      <line
        stroke={AXIS_INK}
        strokeWidth="1"
        x1={pad.left}
        x2={width - pad.right}
        y1={pad.top + plot.h}
        y2={pad.top + plot.h}
      />
      {peakValue > 0 ? (
        <text
          fill="var(--chart-ink)"
          fontSize="11"
          fontWeight="700"
          textAnchor={peakAt > labels.length / 2 ? 'end' : 'start'}
          x={
            peakAt > labels.length / 2
              ? Math.min(width - pad.right, pad.left + band * peakAt + band)
              : Math.max(pad.left, pad.left + band * peakAt)
          }
          y={Math.max(10, y(peakValue) - 5)}
        >
          {format(peakValue)}
        </text>
      ) : null}
    </svg>
  );
}

export interface BarRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/**
 * A ranked list as horizontal bars — one series, therefore one colour.
 *
 * Deliberately not a value ramp. Colouring each bar darker-where-bigger would
 * spend the only free channel on what the bar's length already says, and the
 * categories here (accounts, warehouses, customers) have no natural order
 * beyond the one the sort gives them.
 */
export function BarList({
  rows,
  format,
  token = '--chart-series-1',
}: {
  readonly rows: readonly BarRow[];
  readonly format: (value: number) => string;
  readonly token?: string;
}) {
  const top = niceCeiling(Math.max(1, ...rows.map((row) => Math.abs(row.value))));
  return (
    <ul className={admin.chartBars}>
      {rows.map((row) => (
        <li key={row.key}>
          <span className={admin.chartBarLabel} title={row.label}>
            {row.label}
          </span>
          <span className={admin.chartBarTrack}>
            <span
              className={admin.chartBarFill}
              style={{
                background: `var(${token})`,
                // A negative balance is a real figure; it gets a visible sliver
                // and the status colour, rather than disappearing at zero.
                inlineSize: `${Math.max(1.5, (Math.abs(row.value) / top) * 100)}%`,
                ...(row.value < 0 ? { background: 'var(--chart-negative)' } : {}),
              }}
            />
          </span>
          <span className={admin.chartBarValue}>
            <bdi dir="ltr">{format(row.value)}</bdi>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One stacked bar of ordered bands — how late the money is.
 *
 * Ageing buckets are an *ordered* scale, so this is the ordinal ramp rather
 * than the categorical palette: one hue, getting darker as it gets later, which
 * reads as "worse" without a second colour being asked to mean anything. The
 * 2px gaps are the surface showing through, not strokes.
 */
export function StackedBands({
  bands,
  format,
}: {
  readonly bands: readonly { readonly key: string; readonly label: string; readonly value: number; readonly step: number }[];
  readonly format: (value: number) => string;
}) {
  const total = bands.reduce((sum, one) => sum + one.value, 0);
  if (total <= 0) return null;
  return (
    <>
      <div className={admin.chartStack}>
        {bands.map((one) => (
          <span
            className={admin.chartStackSegment}
            key={one.key}
            style={{
              background: `var(--chart-ramp-${one.step})`,
              flexBasis: `${(one.value / total) * 100}%`,
            }}
            title={`${one.label}: ${format(one.value)}`}
          />
        ))}
      </div>
      <ul className={admin.chartLegend}>
        {bands.map((one) => (
          <li key={one.key}>
            <span aria-hidden="true" style={{ background: `var(--chart-ramp-${one.step})` }} />
            {one.label}
            <strong>
              <bdi dir="ltr">{format(one.value)}</bdi>
            </strong>
          </li>
        ))}
      </ul>
    </>
  );
}
