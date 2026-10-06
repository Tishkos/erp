'use client';

import { useMemo } from 'react';
import { BarChart } from '@/components/intent/bar-chart';
import type { ChartConfig } from '@/components/intent/chart';

/**
 * Two money series over months, as Intent UI's grouped bar chart — Home's
 * trends (income against expenses, invoiced against collected).
 *
 * Grouped rather than stacked: the two are compared with each other, not added
 * together. One baseline, one scale, never a second y-axis. The server hands
 * over plain data only — the plotted numbers (the last step before drawing)
 * and, beside each, the figure as the reader reads it, formatted on the server
 * from the service's own decimal string; the tooltip shows that text, so the
 * chart and the table under it can never disagree. The axis ticks are the
 * only figures formatted here, compact, with `Intl` in the reader's locale.
 *
 * Right to left, the months run from the right and the value axis stands on
 * the right, as an Arabic reader reads a chart.
 */

export interface TrendPoint {
  /** The month as the reader says it ("Oct"). */
  readonly label: string;
  readonly first: number;
  readonly second: number;
  readonly firstText: string;
  readonly secondText: string;
}

export interface TrendSeries {
  readonly label: string;
  /** A CSS colour, e.g. `var(--chart-series-1)`. */
  readonly color: string;
}

type Payload = { readonly dataKey?: unknown; readonly color?: string; readonly payload?: TrendPoint };

function TrendTooltip({
  active,
  payload,
  label,
  series,
}: {
  readonly active?: boolean;
  readonly payload?: readonly Payload[];
  readonly label?: unknown;
  readonly series: readonly [TrendSeries, TrendSeries];
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  return (
    <div className="grid min-w-44 gap-2 rounded-lg border border-border bg-overlay p-2.5 text-overlay-fg text-xs shadow-lg">
      <span className="font-medium text-fg">{typeof label === 'string' ? label : point.label}</span>
      {(['first', 'second'] as const).map((key, index) => (
        <div className="flex items-center justify-between gap-4" key={key}>
          <span className="inline-flex items-center gap-1.5 text-muted-fg">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: series[index]!.color }} />
            {series[index]!.label}
          </span>
          <span className="font-medium text-fg tabular-nums">
            <bdi dir="ltr">{key === 'first' ? point.firstText : point.secondText}</bdi>
          </span>
        </div>
      ))}
    </div>
  );
}

export function TrendBars({
  points,
  series,
  locale,
  rtl,
  height = 240,
}: {
  readonly points: readonly TrendPoint[];
  readonly series: readonly [TrendSeries, TrendSeries];
  readonly locale: string;
  readonly rtl: boolean;
  readonly height?: number;
}) {
  const compact = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }), [locale]);
  const config = useMemo<ChartConfig>(
    () => ({
      first: { label: series[0].label, color: series[0].color },
      second: { label: series[1].label, color: series[1].color },
    }),
    [series],
  );
  const data = useMemo(() => points.map((point) => ({ ...point })), [points]);
  // The value axis is as wide as its longest label ("80M", "80 مليون"), so a tick never runs onto a bar.
  const axisWidth = useMemo(() => {
    const top = Math.max(0, ...points.flatMap((point) => [Math.abs(point.first), Math.abs(point.second)]));
    return Math.max(40, Math.ceil(compact.format(top).length * 6.6) + 14);
  }, [points, compact]);

  return (
    <BarChart
      barGap={2}
      barProps={{ maxBarSize: 24, radius: [4, 4, 0, 0] }}
      cartesianGridProps={{ strokeDasharray: '', stroke: 'var(--chart-grid)' }}
      chartProps={{ barCategoryGap: '22%', margin: { top: 8, bottom: 0, left: 0, right: 0 } }}
      className="z-auto [&_.recharts-cartesian-axis-tick_text]:fill-[var(--chart-axis)]"
      config={config}
      containerHeight={height}
      data={data}
      dataKey="label"
      legend={false}
      tooltip={<TrendTooltip series={series} />}
      valueFormatter={(value: number) => compact.format(value)}
      xAxisProps={{ reversed: rtl }}
      // Bars grow from zero: a value axis that starts at the data's minimum would make a small month look like nothing.
      // Right to left the axis stands on the right; under `direction: rtl` an SVG "start" anchor is the text's right
      // edge, so the label would grow back over the bars — "end" (its left edge) keeps it in the axis.
      yAxisProps={{
        orientation: rtl ? 'right' : 'left',
        width: axisWidth,
        domain: [(least: number) => Math.min(0, least), 'auto'],
        ...(rtl ? { tick: { textAnchor: 'end', transform: 'translate(4, 0)' } } : {}),
      }}
    />
  );
}
