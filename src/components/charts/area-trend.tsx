'use client';

import { useId, useMemo } from 'react';
import { Area, CartesianGrid } from 'recharts';
import { AreaChart } from '@/components/intent/area-chart';
import type { ChartConfig } from '@/components/intent/chart';
import { usePrefersReducedMotion } from '@/components/charts/motion';

/**
 * Money over time as Intent UI's area chart — smooth lines over a soft
 * gradient, a quiet grid, a tooltip that names the period and says every
 * series' figure in the reader's words.
 *
 * One or two series, on one baseline and one scale (never a second y-axis).
 * Two series are compared, not added, so their areas overlap rather than
 * stack, each fill light enough for the other's line to read through it.
 *
 * The server hands over plain data only: the plotted numbers (the last step
 * before drawing — money is summed as scaled bigints before it ever becomes a
 * `number`) and, beside each, the figure as the reader reads it, formatted on
 * the server from the service's own decimal string. The tooltip shows that
 * text, so the chart and the table under it can never disagree. The axis
 * ticks are the only figures formatted here, compact, with `Intl` in the
 * reader's locale.
 *
 * The value axis always holds zero: an area's height is its amount, and an
 * area drawn from the data's minimum would make a small figure look like
 * nothing. A balance that goes below zero is drawn below the line at zero.
 *
 * Right to left, time runs from the right and the value axis stands on the
 * right, as an Arabic reader reads a chart. Under `prefers-reduced-motion`
 * the lines are simply there; otherwise they rise once, briefly.
 */

export interface AreaTrendPoint {
  /** The tick under the point, short ("Oct", "06 Oct"). */
  readonly label: string;
  /** The tooltip's heading, in full ("October 2026 · so far"). */
  readonly title: string;
  /** One plotted number per series, in the series' order. */
  readonly values: readonly number[];
  /** One formatted figure per series, in the series' order. */
  readonly texts: readonly string[];
  /**
   * The point's instant (epoch milliseconds of its day). When every point has
   * one, the time axis is drawn to scale — days far apart stand far apart —
   * rather than one step per point.
   */
  readonly at?: number | undefined;
}

export interface AreaTrendSeries {
  readonly label: string;
  /** A CSS colour, e.g. `var(--chart-series-1)`. */
  readonly color: string;
}

/** The smallest round step (1, 2, 2.5 or 5 of a power of ten) at least `raw`. */
function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((one) => one * magnitude >= raw * (1 - 1e-12)) ?? 10) * magnitude;
}

/**
 * The value axis: zero always on it, both ends rounded out to whole steps, and
 * the ticks every step — so every tick is a round figure (0, 250K, 500K …;
 * −100M, 0, 100M …) whether or not the series goes below zero. Of four, five
 * or six steps, the one that wastes the least height is taken.
 */
function valueScale(values: readonly number[]): { readonly domain: [number, number]; readonly ticks: number[] } {
  const least = Math.min(0, ...values);
  const most = Math.max(0, ...values);
  if (least === most) return { domain: [0, 1], ticks: [0, 1] };
  let best: { lo: number; hi: number; step: number } | null = null;
  for (const steps of [4, 5, 6]) {
    const step = niceStep((most - least) / steps);
    const lo = Math.floor(least / step) * step;
    const hi = Math.ceil(most / step) * step;
    if (!best || hi - lo < best.hi - best.lo - step * 1e-9) best = { lo, hi, step };
  }
  const { lo, hi, step } = best!;
  const ticks: number[] = [];
  for (let at = lo; at <= hi + step / 2; at += step) ticks.push(Math.abs(at) < step / 1e6 ? 0 : at);
  return { domain: [lo, hi], ticks };
}

const DAY = 86_400_000;

/** About five dates across a time axis, on whole days, the first and the last included. */
function timeTicks(first: number, last: number): number[] {
  if (last <= first) return [first];
  const count = Math.min(5, Math.max(2, Math.round((last - first) / DAY) + 1));
  return Array.from({ length: count }, (_, index) => Math.round((first + ((last - first) * index) / (count - 1)) / DAY) * DAY);
}

type Datum = { readonly label: string; readonly point: AreaTrendPoint } & Record<string, unknown>;
type Payload = { readonly payload?: Datum };

function TrendTooltip({
  active,
  payload,
  series,
}: {
  readonly active?: boolean;
  readonly payload?: readonly Payload[];
  readonly series: readonly AreaTrendSeries[];
}) {
  const point = active ? payload?.[0]?.payload?.point : undefined;
  if (!point) return null;
  return (
    <div className="grid min-w-48 gap-2 rounded-xl border border-border bg-overlay/95 px-3 py-2.5 text-overlay-fg text-xs shadow-lg backdrop-blur-md">
      <span className="font-medium text-fg">
        <bdi>{point.title}</bdi>
      </span>
      <span aria-hidden="true" className="block h-px bg-border" />
      {series.map((one, index) => (
        <div className="flex items-center justify-between gap-4" key={one.label}>
          <span className="inline-flex min-w-0 items-center gap-2 text-muted-fg">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full ring-2 ring-overlay"
              style={{ background: one.color, boxShadow: `0 0 0 3px color-mix(in oklab, ${one.color} 22%, transparent)` }}
            />
            <span className="truncate">{one.label}</span>
          </span>
          <span className="font-semibold text-fg tabular-nums">
            <bdi dir="ltr">{point.texts[index] ?? '—'}</bdi>
          </span>
        </div>
      ))}
    </div>
  );
}

export function AreaTrend({
  points,
  series,
  locale,
  rtl,
  height = 240,
  curve = 'monotone',
  partialLast = false,
}: {
  readonly points: readonly AreaTrendPoint[];
  readonly series: readonly AreaTrendSeries[];
  readonly locale: string;
  readonly rtl: boolean;
  readonly height?: number;
  /**
   * `monotone` for totals per period (a smooth line that never overshoots a
   * point, so it cannot invent a dip or a peak); `stepAfter` for a running
   * balance, which stays where it is until the next entry moves it.
   */
  readonly curve?: 'monotone' | 'stepAfter' | 'linear';
  /**
   * The last point is a period still going on (this month so far): the line
   * into it is dashed and its area paler, so a month that has only begun does
   * not read as a collapse.
   */
  readonly partialLast?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }), [locale]);
  const keys = useMemo(() => series.map((_, index) => `s${index}`), [series]);
  const config = useMemo<ChartConfig>(
    () => Object.fromEntries(series.map((one, index) => [`s${index}`, { label: one.label, color: one.color }])),
    [series],
  );
  const tail = partialLast && points.length >= 2;
  const last = points.length - 1;
  // A series is two runs when the last period is still open: the settled points (`s0`) and, dashed, the step from
  // the last settled point into the open one (`t0`). Each point is in the run it belongs to and nowhere else.
  const timed = points.length > 1 && points.every((point) => typeof point.at === 'number');
  const data = useMemo<Datum[]>(
    () =>
      points.map((point, at) => ({
        label: point.label,
        at: point.at,
        point,
        ...Object.fromEntries(
          keys.flatMap((key, index) => {
            const value = point.values[index] ?? 0;
            return [
              [key, tail && at === last ? undefined : value],
              [`t${index}`, tail && at >= last - 1 ? value : undefined],
            ];
          }),
        ),
      })),
    [points, keys, tail, last],
  );
  const scale = useMemo(() => valueScale(points.flatMap((point) => point.values)), [points]);
  const days = useMemo(() => new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' }), [locale]);
  const instants = useMemo(() => (timed ? timeTicks(points[0]!.at!, points[points.length - 1]!.at!) : []), [timed, points]);
  // The value axis is as wide as its longest label ("80M", "-1.2B", "80 مليون"), so a tick never runs onto the plot.
  const axisWidth = useMemo(() => {
    const widest = Math.max(0, ...scale.ticks.map((value) => compact.format(value).length));
    return Math.max(40, Math.ceil(widest * 6.6) + 14);
  }, [scale, compact]);

  return (
    <AreaChart
      chartProps={{ margin: { top: 10, bottom: 0, left: 0, right: 0 } }}
      className="z-auto [&_.recharts-cartesian-axis-tick_text]:fill-[var(--chart-axis)]"
      config={config}
      containerHeight={height}
      data={data}
      dataKey="label"
      hideGridLines
      legend={false}
      tooltip={<TrendTooltip series={series} />}
      tooltipProps={{ cursor: { stroke: 'var(--chart-axis)', strokeWidth: 1, strokeDasharray: '3 4' } }}
      valueFormatter={(value: number) => compact.format(value)}
      xAxisProps={
        timed
          ? {
              reversed: rtl,
              padding: { left: 18, right: 18 },
              minTickGap: 12,
              type: 'number',
              dataKey: 'at',
              scale: 'time',
              domain: ['dataMin', 'dataMax'],
              ticks: instants,
              interval: 'preserveStartEnd',
              tickFormatter: (value: number) => days.format(value),
            }
          : { reversed: rtl, padding: { left: 18, right: 18 }, minTickGap: 12 }
      }
      // Right to left the axis stands on the right; under `direction: rtl` an SVG "start" anchor is the text's right
      // edge, so the label would grow back over the plot — "end" (its left edge) keeps it in the axis.
      yAxisProps={{
        orientation: rtl ? 'right' : 'left',
        width: axisWidth,
        domain: scale.domain,
        ticks: scale.ticks,
        interval: 0,
        ...(rtl ? { tick: { textAnchor: 'end', transform: 'translate(4, 0)' } } : {}),
      }}
    >
      <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 6" vertical={false} />
      <defs>
        {series.map((one, index) => (
          <linearGradient id={`${id}-fill-${index}`} key={one.label} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={one.color} stopOpacity={series.length > 1 ? 0.22 : 0.3} />
            <stop offset="100%" stopColor={one.color} stopOpacity={0.02} />
          </linearGradient>
        ))}
      </defs>
      {series.map((one, index) => (
        <Area
          activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--ui-overlay)', fill: one.color }}
          animationDuration={700}
          animationEasing="ease-out"
          dataKey={keys[index]!}
          dot={false}
          fill={`url(#${id}-fill-${index})`}
          isAnimationActive={!reduced}
          key={one.label}
          name={keys[index]!}
          stroke={one.color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          type={curve}
        />
      ))}
      {tail
        ? series.map((one, index) => (
            <Area
              activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--ui-overlay)', fill: one.color }}
              animationDuration={700}
              animationEasing="ease-out"
              dataKey={`t${index}`}
              dot={false}
              fill={`url(#${id}-fill-${index})`}
              fillOpacity={0.45}
              isAnimationActive={!reduced}
              key={`${one.label}-open`}
              name={`t${index}`}
              stroke={one.color}
              strokeDasharray="4 4"
              strokeLinecap="round"
              strokeWidth={2}
              type={curve}
            />
          ))
        : null}
    </AreaChart>
  );
}
