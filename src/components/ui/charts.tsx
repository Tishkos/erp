/**
 * Chart primitives — the four forms a module dashboard needs.
 *
 * The form follows the data's job, not the panel's shape:
 *
 *   TrendChart  change over time, one measure   → line + area, no legend
 *   DonutChart  composition of a whole          → arcs + a labelled legend
 *   BarChart    two measures compared per period → grouped bars + legend
 *   RankedList  ordered magnitudes              → bars against a common track
 *
 * Colour is assigned by job, never by rank: a slice keeps its hue when a filter
 * changes the set. The categorical hues are declared once in the stylesheet and
 * validated against this application's own light and dark surfaces — see the
 * note there for the numbers.
 *
 * Every chart ships an sr-only table of the same figures. That covers the
 * screen-reader case and doubles as the relief the light-mode contrast warning
 * requires, alongside the direct labels in each legend.
 *
 * These are presentational and take no data of their own — the caller decides
 * what is shown, already formatted for its locale.
 */
import type { ReactNode } from 'react';
import styles from './charts.module.css';

export const SERIES_SLOTS = 5;

/** A categorical slot, 1-based, clamped to the validated set. */
function seriesVar(slot: number): string {
  return `var(--series-${((slot - 1) % SERIES_SLOTS) + 1})`;
}

export interface ChartPoint {
  /** Axis label — a month, a period. */
  readonly label: string;
  readonly value: number;
  /** Preformatted for the tooltip and the table. */
  readonly display: string;
}

/* -------------------------------------------------------------------------
 * Trend — one series over time
 * ---------------------------------------------------------------------- */

export function TrendChart({
  points,
  scale,
  caption,
  valueHeader,
  periodHeader,
}: {
  readonly points: readonly ChartPoint[];
  /** Y-axis labels, highest first. Already formatted. */
  readonly scale: readonly string[];
  readonly caption: string;
  readonly valueHeader: string;
  readonly periodHeader: string;
}) {
  if (points.length === 0) return null;

  const max = Math.max(...points.map((point) => point.value), 1);
  const coords = points.map((point, index) => ({
    x: (index / Math.max(points.length - 1, 1)) * 100,
    y: 100 - (point.value / max) * 92,
    point,
  }));
  const line = coords.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

  return (
    <div className={`${styles.viz} ${styles.trend}`}>
      <div aria-hidden="true" className={styles.scale}>
        {scale.map((entry) => (
          <span key={entry}>{entry}</span>
        ))}
      </div>
      <div className={styles.plot}>
        <svg
          className={styles.plotSvg}
          preserveAspectRatio="none"
          role="img"
          aria-label={caption}
          viewBox="0 0 100 100"
        >
          {[25, 50, 75].map((y) => (
            <line className={styles.gridLine} key={y} x1="0" x2="100" y1={y} y2={y} />
          ))}
          <polygon className={styles.area} points={`0,100 ${line} 100,100`} />
          <polyline className={styles.line} points={line} />
        </svg>
        <div aria-hidden="true" className={styles.axis}>
          {points.map((point) => (
            <span key={point.label}>{point.label}</span>
          ))}
        </div>
      </div>
      <DataTableView
        caption={caption}
        headers={[periodHeader, valueHeader]}
        rows={points.map((point) => [point.label, point.display])}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Donut — composition
 * ---------------------------------------------------------------------- */

export interface DonutSlice {
  readonly label: string;
  readonly value: number;
  readonly display: string;
  readonly share: string;
}

export function DonutChart({
  slices,
  centreValue,
  centreLabel,
  caption,
  nameHeader,
  valueHeader,
}: {
  readonly slices: readonly DonutSlice[];
  readonly centreValue: string;
  readonly centreLabel: string;
  readonly caption: string;
  readonly nameHeader: string;
  readonly valueHeader: string;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;

  // Drawn as a stroked circle: one arc per slice via dash offsets, so the 2px
  // surface stroke between fills is exact rather than eyeballed.
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let travelled = 0;

  return (
    <div className={`${styles.viz} ${styles.donutLayout}`}>
      <div className={styles.donut}>
        <svg className={styles.donutSvg} role="img" aria-label={caption} viewBox="0 0 100 100">
          {slices.map((slice, index) => {
            const length = (slice.value / total) * circumference;
            const dash = `${Math.max(length - 2, 0)} ${circumference - Math.max(length - 2, 0)}`;
            const offset = circumference - travelled;
            travelled += length;
            return (
              <circle
                className={styles.slice}
                cx="50"
                cy="50"
                fill="none"
                key={`slice-${index}`}
                r={radius}
                stroke={seriesVar(index + 1)}
                strokeDasharray={dash}
                strokeDashoffset={offset}
                strokeWidth="14"
                transform="rotate(-90 50 50)"
              >
                <title>{`${slice.label}: ${slice.display}`}</title>
              </circle>
            );
          })}
        </svg>
        <div className={styles.donutCentre}>
          <strong className={styles.donutValue}>
            <bdi dir="ltr">{centreValue}</bdi>
          </strong>
          <span className={styles.donutLabel}>{centreLabel}</span>
        </div>
      </div>

      <ul className={styles.legend}>
        {slices.map((slice, index) => (
          <li key={`legend-${index}`}>
            <span
              aria-hidden="true"
              className={styles.swatch}
              style={{ background: seriesVar(index + 1) }}
            />
            <span className={styles.legendText}>
              <span className={styles.legendName}>{slice.label}</span>
              <span className={styles.legendValue}>
                <bdi dir="ltr">
                  {slice.display} ({slice.share})
                </bdi>
              </span>
            </span>
          </li>
        ))}
      </ul>

      <DataTableView
        caption={caption}
        headers={[nameHeader, valueHeader]}
        rows={slices.map((slice) => [slice.label, slice.display])}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Grouped bars — two measures per period
 * ---------------------------------------------------------------------- */

export interface BarGroup {
  readonly label: string;
  readonly primary: number;
  readonly secondary: number;
  readonly primaryDisplay: string;
  readonly secondaryDisplay: string;
}

export function BarChart({
  groups,
  primaryLabel,
  secondaryLabel,
  caption,
  periodHeader,
}: {
  readonly groups: readonly BarGroup[];
  readonly primaryLabel: string;
  readonly secondaryLabel: string;
  readonly caption: string;
  readonly periodHeader: string;
}) {
  const max = Math.max(...groups.flatMap((group) => [group.primary, group.secondary]), 1);

  return (
    <div className={styles.viz}>
      {/* Two series, so a legend is always present. */}
      <ul className={styles.legend} style={{ gridAutoFlow: 'column', justifyContent: 'start', gap: '0.9rem', marginBlockEnd: '0.6rem' }}>
        {[
          { label: primaryLabel, slot: 1 },
          { label: secondaryLabel, slot: 2 },
        ].map((entry) => (
          <li key={entry.label} style={{ gridTemplateColumns: 'auto auto' }}>
            <span
              aria-hidden="true"
              className={styles.swatch}
              style={{ background: seriesVar(entry.slot) }}
            />
            <span className={styles.legendName}>{entry.label}</span>
          </li>
        ))}
      </ul>

      <div className={styles.bars} role="img" aria-label={caption}>
        {groups.map((group) => (
          <div className={styles.barGroup} key={group.label}>
            <span className={styles.barPair}>
              <span
                className={`${styles.bar} ${styles.barPrimary}`}
                style={{ blockSize: `${Math.max((group.primary / max) * 100, 2)}%` }}
                title={`${primaryLabel}: ${group.primaryDisplay}`}
              />
              <span
                className={`${styles.bar} ${styles.barSecondary}`}
                style={{ blockSize: `${Math.max((group.secondary / max) * 100, 2)}%` }}
                title={`${secondaryLabel}: ${group.secondaryDisplay}`}
              />
            </span>
            <span className={styles.barLabel}>{group.label}</span>
          </div>
        ))}
      </div>

      <DataTableView
        caption={caption}
        headers={[periodHeader, primaryLabel, secondaryLabel]}
        rows={groups.map((group) => [group.label, group.primaryDisplay, group.secondaryDisplay])}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * Ranked list — ordered magnitudes
 * ---------------------------------------------------------------------- */

export interface RankedEntry {
  readonly label: string;
  readonly value: number;
  readonly display: string;
}

export function RankedList({
  entries,
  locale,
  caption,
  nameHeader,
  valueHeader,
}: {
  readonly entries: readonly RankedEntry[];
  readonly locale: string;
  readonly caption: string;
  readonly nameHeader: string;
  readonly valueHeader: string;
}) {
  const max = Math.max(...entries.map((entry) => entry.value), 1);
  const number = new Intl.NumberFormat(locale);

  return (
    <div className={styles.viz}>
      <ol className={styles.ranked}>
        {entries.map((entry, index) => (
          <li className={styles.rankedRow} key={`rank-${index}`}>
            <span className={styles.rankNumber}>
              <bdi dir="ltr">{number.format(index + 1)}</bdi>
            </span>
            <span className={styles.rankBody}>
              <span className={styles.rankName}>{entry.label}</span>
              <span aria-hidden="true" className={styles.rankTrack}>
                <span
                  className={styles.rankFill}
                  style={{ inlineSize: `${Math.max((entry.value / max) * 100, 3)}%` }}
                />
              </span>
            </span>
            <strong className={styles.rankValue}>
              <bdi dir="ltr">{entry.display}</bdi>
            </strong>
          </li>
        ))}
      </ol>
      <DataTableView
        caption={caption}
        headers={[nameHeader, valueHeader]}
        rows={entries.map((entry) => [entry.label, entry.display])}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The table behind every chart
 * ---------------------------------------------------------------------- */

function DataTableView({
  caption,
  headers,
  rows,
}: {
  readonly caption: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): ReactNode {
  return (
    <table className={styles.srOnly}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} scope="col">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={`row-${rowIndex}`}>
            {row.map((cell, index) =>
              index === 0 ? (
                <th key={`${rowIndex}-h`} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={`${rowIndex}-${index}`}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
