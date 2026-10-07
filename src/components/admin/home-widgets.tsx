import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowUpRight,
  Banknote,
  Bell,
  Boxes,
  CircleDashed,
  ClipboardCheck,
  FolderKanban,
  HandCoins,
  Landmark,
  ListTodo,
  Lock,
  MessageSquare,
  ReceiptText,
  Scale,
  Ship,
  ShoppingCart,
  TrendingUp,
  TriangleAlert,
  Users,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/components/intent/cn';
import { BarList, Chart, Legend, Sparkline, type Series } from '@/components/admin/charts';
import { Band, BandTable, INK, NUMERIC_CELL, SeeAll } from '@/components/admin/dashboard-band';
import { AreaTrend } from '@/components/charts/area-trend';
import { Donut } from '@/components/charts/donut';
import { sharesOf, shortMoney } from '@/components/charts/figures';
import { directionOf, formatBusinessDate, formatMoney, formatQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { chartNumber, daysInMonth, moneyString, sumMoney } from '@/server/domain/dashboard-charts';
import type { Cell, ChartData, JourneyData, KpiData, Note, TableData } from '@/server/domain/dashboard-data';
import type { DataFamily } from '@/server/domain/dashboard-widgets';
import type { HomeWidget } from '@/server/services/home';

/**
 * Home's widgets, drawn — platform phase, Agent 2; Intent UI's look since the
 * 2026-10-06 redesign.
 *
 * One presenter per *shape* (a figure, a table, a chart, the import journey).
 * A loader hands over typed cells and these functions turn them into the
 * reader's words and numbers — money through `formatMoney`, dates through
 * `formatBusinessDate` — so a figure is formatted exactly once, last.
 *
 * Server components throughout but for the area trends (Intent's recharts
 * area chart) and the ageing donut (`components/charts/`), which are handed
 * plain data: the plotted numbers and the figures already in the reader's
 * words.
 */

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

type Translator = Awaited<ReturnType<typeof getTranslations>>;

export interface HomeText {
  readonly locale: Locale;
  /** The root translator: any namespace is reachable, as a server component may. */
  readonly t: Translator;
}

export async function homeText(): Promise<HomeText> {
  const [locale, t] = await Promise.all([getLocale(), getTranslations()]);
  return { locale: locale as Locale, t };
}

const humanize = (code: string): string => code.replace(/[._]/g, ' ');

/** The catalogue's words for a code, or the code made readable — never a raw key on the page. */
function wordFor(x: HomeText, key: string, fallback: string): string {
  return x.t.has(key) ? x.t(key) : humanize(fallback);
}

const widgetTitle = (x: HomeText, widget: HomeWidget): string => x.t(`home.widget.${widget.key}.title`);
const widgetEmpty = (x: HomeText, widget: HomeWidget): string => x.t(`home.widget.${widget.key}.empty`);

function noteText(x: HomeText, note: Note | null): string | null {
  return note ? x.t(`home.note.${note.key}`, note.values ?? {}) : null;
}

const countText = (x: HomeText, value: number): string => new Intl.NumberFormat(x.locale).format(value);

/**
 * Which cards of a two-to-a-row grid take the whole row, in the registry's
 * order: those that ask for it, and a half-row card that would otherwise sit
 * alone beside a hole — so the grid has no gaps and nothing moves out of order.
 */
export function fullRows(asks: readonly boolean[]): boolean[] {
  const full = [...asks];
  let open = -1; // a half-row card waiting for its neighbour
  for (let index = 0; index < full.length; index += 1) {
    if (full[index]) {
      if (open >= 0) full[open] = true;
      open = -1;
    } else if (open < 0) {
      open = index;
    } else {
      open = -1;
    }
  }
  if (open >= 0) full[open] = true;
  return full;
}

/** Where a widget's link goes, if this person is served that screen. */
const linkFor = (href: string | null, served: (route: string) => boolean): string | null =>
  href && served(href.split('?')[0]!) ? href : null;

/**
 * A document-status tone as Intent's badge colours. The theme derives the four
 * subtle pairs from the palette's own status colours, so a chip reads on every
 * palette, light and dark.
 */
const TONE_BADGE: Readonly<Record<string, string>> = {
  posted: `bg-success-subtle ${INK.success}`,
  settled: `bg-success-subtle ${INK.success}`,
  approved: `bg-info-subtle ${INK.info}`,
  executed: `bg-info-subtle ${INK.info}`,
  partially_executed: `bg-info-subtle ${INK.info}`,
  submitted: `bg-warning-subtle ${INK.warning}`,
  rejected: `bg-danger-subtle ${INK.danger}`,
  reversed: `bg-danger-subtle ${INK.danger}`,
};
const BADGE = 'inline-flex min-h-0 items-center gap-x-1.5 whitespace-nowrap rounded-md border-0 px-2 py-0.5 font-medium text-xs/5';
const badgeFor = (tone: string): string => cn('status', `status--${tone}`, BADGE, TONE_BADGE[tone] ?? 'bg-secondary text-secondary-fg');

/** One typed cell, in the reader's words. */
export function CellView({ cell, x }: { readonly cell: Cell; readonly x: HomeText }): ReactNode {
  switch (cell.t) {
    case 'text':
      return <bdi dir="auto">{cell.v}</bdi>;
    case 'code':
      return <bdi dir="ltr">{cell.v}</bdi>;
    case 'money':
      return <bdi dir="ltr">{formatMoney(cell.v, cell.currency, x.locale)}</bdi>;
    case 'qty':
      return <bdi dir="ltr">{formatQuantity(cell.v, x.locale)}</bdi>;
    case 'count':
      return <bdi dir="ltr">{countText(x, cell.v)}</bdi>;
    // A date or a time is words as well as digits in Arabic ("04 أكتوبر 2026", "9:00 م"): forced left-to-right it is read back to front.
    case 'date':
      return <bdi>{formatBusinessDate(cell.v, x.locale)}</bdi>;
    case 'instant':
      return <bdi>{formatTimestamp(cell.v, x.locale)}</bdi>;
    case 'word':
      return wordFor(x, `${cell.ns ?? 'home.value'}.${cell.v}`, cell.v);
    case 'chip': {
      const label = wordFor(x, `${cell.ns}.${cell.v}`, cell.v);
      return (
        <span className={badgeFor(cell.tone)} data-status={cell.tone}>
          {label}
        </span>
      );
    }
    case 'say':
      return x.t.has(`home.say.${cell.v}`) ? <bdi dir="auto">{x.t(`home.say.${cell.v}`, cell.values ?? {})}</bdi> : humanize(cell.v);
    case 'none':
      return <span className="text-muted-fg">—</span>;
  }
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

const KPI_ICON: Readonly<Record<string, LucideIcon>> = {
  approvals_waiting: ClipboardCheck,
  cash_position: Landmark,
  receivable_total: HandCoins,
  payable_total: ReceiptText,
  overdue_receivables: TriangleAlert,
  overdue_payables: TriangleAlert,
  inventory_value: Boxes,
  net_result: Scale,
  pending_payments: Banknote,
  imports_in_progress: Ship,
  warehouse_today: Warehouse,
  purchasing_open: ShoppingCart,
  sales_period: TrendingUp,
  hr_overview: Users,
  projects_overview: FolderKanban,
  tasks_mine: ListTodo,
  notifications_unread: Bell,
  chat_unread: MessageSquare,
};

/**
 * A dinar figure of eight digits or more does not fit the tile's value: it is shown compact ("1.25B IQD", from
 * the decimal string, `Number` being the last step before `Intl`) and the exact amount is the tile's title, as well
 * as the page it opens. Anything shorter is shown whole.
 */
function KpiValue({ cell, x }: { readonly cell: Cell; readonly x: HomeText }): ReactNode {
  if (cell.t === 'money') {
    const short = shortMoney(cell.v, cell.currency, x.locale);
    // Not forced left to right: in Arabic the compact figure has a word in it ("1.25 مليار"), as a date does.
    if (short.shortened) return <bdi title={short.exact}>{short.text}</bdi>;
  }
  return <CellView cell={cell} x={x} />;
}

/**
 * The tiles that carry a sparkline, and the chart on the same page it is read from — only where that chart's
 * series ends on exactly the tile's figure. *Sales this month* is this month's posted invoices, net, in the branch:
 * the last point of the six-month *invoiced* series, read the same way. Nothing is fetched for it; without the
 * chart on the page (it asks the same grant) there is no line, and no other tile is given one it has not got.
 */
const SPARK_FROM: Readonly<Partial<Record<string, { readonly chart: string; readonly series: 'first' | 'second' }>>> = {
  sales_period: { chart: 'chart_sales_trend', series: 'first' },
};

function sparkFor(widget: HomeWidget, charts: readonly HomeWidget[]): { readonly values: readonly number[]; readonly months: number } | null {
  const from = SPARK_FROM[widget.key];
  if (!from) return null;
  const chart = charts.find((one) => one.key === from.chart);
  if (!chart || chart.outcome.state !== 'ready' || chart.outcome.data.kind !== 'chart') return null;
  const spec = chart.outcome.data.chart;
  if (spec.type !== 'columns' || spec.points.length < 2) return null;
  return { values: spec.points.map((point) => chartNumber(point[from.series])), months: spec.points.length };
}

/**
 * The primary figures: an Intent stat card each — the label and its glyph,
 * the figure large, the note under it and, where the page already holds the
 * figure's course, a sparkline beside it — opening the screen that proves it.
 * A tile whose widget has nothing to say shows a dash and says why in the
 * widget's own words — it never shows a zero that was not counted.
 */
export function KpiRow({
  widgets,
  x,
  served,
  charts = [],
}: {
  readonly widgets: readonly HomeWidget[];
  readonly x: HomeText;
  readonly served: (route: string) => boolean;
  /** The page's chart widgets, for the sparklines a tile may borrow (`SPARK_FROM`). */
  readonly charts?: readonly HomeWidget[];
}) {
  if (widgets.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {widgets.map((widget) => {
        const title = widgetTitle(x, widget);
        const Icon = KPI_ICON[widget.key] ?? ClipboardCheck;
        const outcome = widget.outcome;
        let value: ReactNode = <span className="text-muted-fg">—</span>;
        let note: string | null = null;
        let href: string | null = null;
        let tone: 'plain' | 'warn' | 'quiet' | 'trouble' = 'plain';
        let spark: ReturnType<typeof sparkFor> = null;
        if (outcome.state === 'ready' && outcome.data.kind === 'kpi') {
          const data: KpiData = outcome.data;
          value = <KpiValue cell={data.value} x={x} />;
          note = noteText(x, data.note);
          href = linkFor(data.href, served);
          if (data.tone === 'warn') tone = 'warn';
          spark = sparkFor(widget, charts);
        } else if (outcome.state === 'unreadable') {
          note = x.t('admin.dashboard.unreadable', { band: title });
          tone = 'trouble';
        } else {
          note = widgetEmpty(x, widget);
          tone = 'quiet';
        }
        const Glyph = tone === 'warn' || tone === 'trouble' ? TriangleAlert : Icon;
        const body = (
          <>
            <span className="flex min-w-0 items-start justify-between gap-3">
              <span className="flex min-w-0 items-center gap-1 pt-0.5 font-medium text-muted-fg text-sm">
                <span className="min-w-0">{title}</span>
                {href ? (
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 opacity-50 transition group-hover:text-fg group-hover:opacity-100 motion-reduce:transition-none rtl:-scale-x-100"
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-lg',
                  tone === 'warn' || tone === 'trouble'
                    ? 'bg-warning-subtle text-warning-subtle-fg'
                    : tone === 'quiet'
                      ? 'bg-muted text-muted-fg'
                      : 'bg-primary-subtle text-primary-subtle-fg',
                )}
              >
                <Glyph aria-hidden="true" className="size-[1.1rem]" />
              </span>
            </span>
            <span className="flex min-w-0 items-end justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <strong
                  className={cn(
                    'font-semibold text-[1.65rem]/8 tabular-nums tracking-tight rtl:tracking-normal',
                    tone === 'quiet' ? 'text-muted-fg' : 'text-fg',
                  )}
                >
                  {value}
                </strong>
                {note ? <span className="mt-1 text-muted-fg text-xs">{note}</span> : null}
              </span>
              {spark ? <Sparkline id={widget.key} title={x.t('home.note.last_months', { count: spark.months })} values={spark.values} /> : null}
            </span>
          </>
        );
        const card = cn(
          'relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border bg-overlay p-4 text-overlay-fg shadow-xs',
          // A figure that is a problem by its nature (money overdue, a loss) says so with a thin line along its top, as well as its glyph.
          (tone === 'warn' || tone === 'trouble') && 'before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-warning-subtle-fg/60',
        );
        return href ? (
          <Link
            className={cn(
              card,
              'group no-underline outline-offset-2 transition hover:border-input hover:shadow-sm focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none',
            )}
            href={href}
            key={widget.key}
          >
            {body}
          </Link>
        ) : (
          <div className={card} key={widget.key}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The charts
// ---------------------------------------------------------------------------

const monthName = (month: string, locale: Locale): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString(locale, { month: 'short', timeZone: 'UTC' });

/** "October 2026" — a month as the tooltip and the table say it. */
const monthLong = (month: string, locale: Locale): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The summary over each chart's table twin. */
const tableLabel = (x: HomeText): string => (x.t.has('home.table') ? x.t('home.table') : 'Table');

const SERIES_1 = '--chart-series-1';
const SERIES_2 = '--chart-series-2';

/** The ageing buckets' ordinal ramp, step 1 (not yet due) to 5 (over ninety days): later is darker. */
const RAMP: Readonly<Record<number, string>> = {
  1: 'var(--chart-ramp-1)',
  2: 'var(--chart-ramp-2)',
  3: 'var(--chart-ramp-3)',
  4: 'var(--chart-ramp-4)',
  5: 'var(--chart-ramp-5)',
};

/**
 * How many rows a ranked chart's loader keeps (`rankedRows` / `balanceRows`, eight). A list shorter than that is
 * every row there is, so each one's share of their sum is its share of the whole; a full list may be the top of a
 * longer one, and a share "of the top eight" would read as a share of everything — so it is not said.
 */
const RANKED_CAP = 8;

function ChartView({
  widget,
  data,
  x,
  served,
  wide,
  asOf,
}: {
  readonly widget: HomeWidget;
  readonly data: ChartData;
  readonly x: HomeText;
  readonly served: (route: string) => boolean;
  /** Takes the whole row: its axis needs the width, or it would otherwise sit alone beside a hole. */
  readonly wide: boolean;
  /** The page's business date: the month it falls in is still going on. */
  readonly asOf?: string | undefined;
}) {
  const title = widgetTitle(x, widget);
  const hint = noteText(x, data.note) ?? undefined;
  const spec = data.chart;
  const link = linkFor(data.href, served);
  const money = (value: string) => formatMoney(value, 'IQD', x.locale);
  const rtl = directionOf(x.locale) === 'rtl';

  if (spec.type === 'columns') {
    // Each series' figure for the whole window, summed as scaled bigints, said in its legend chip and the table's foot.
    const totals = [moneyString(sumMoney(spec.points.map((p) => p.first))), moneyString(sumMoney(spec.points.map((p) => p.second)))] as const;
    const said = totals.map((total) => shortMoney(total, 'IQD', x.locale));
    const first: Series = { label: x.t(`home.value.${spec.firstKey}`), token: SERIES_1, value: said[0]!.text, title: said[0]!.shortened ? said[0]!.exact : undefined };
    const second: Series = { label: x.t(`home.value.${spec.secondKey}`), token: SERIES_2, value: said[1]!.text, title: said[1]!.shortened ? said[1]!.exact : undefined };
    // The month the business date falls in, unless that date is its last day: its point is "so far", not the month.
    const current = asOf && Number(asOf.slice(8, 10)) < daysInMonth(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7))) ? asOf.slice(0, 7) : null;
    const monthTitle = (month: string) => (month === current ? x.t('home.chart.so_far', { month: monthLong(month, x.locale) }) : monthLong(month, x.locale));
    return (
      <Chart
        tableLabel={tableLabel(x)}
        action={link ? <SeeAll href={link} label={x.t('home.see_all')} /> : null}
        hint={hint}
        table={
          <BandTable headings={[x.t('column.date'), { label: first.label, numeric: true }, { label: second.label, numeric: true }]}>
            {spec.points.map((p) => (
              <tr key={p.month}>
                <td>
                  <bdi>{monthTitle(p.month)}</bdi>
                </td>
                <td className={NUMERIC_CELL}>
                  <bdi dir="ltr">{money(p.first)}</bdi>
                </td>
                <td className={NUMERIC_CELL}>
                  <bdi dir="ltr">{money(p.second)}</bdi>
                </td>
              </tr>
            ))}
            <tr className="bg-muted font-semibold">
              <td>{x.t('home.chart.total')}</td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{money(totals[0])}</bdi>
              </td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{money(totals[1])}</bdi>
              </td>
            </tr>
          </BandTable>
        }
        title={title}
        wide={wide}
      >
        <Legend series={[first, second]} />
        <div className="mt-4 min-w-0">
          <AreaTrend
            locale={x.locale}
            partialLast={spec.points.at(-1)?.month === current}
            points={spec.points.map((p) => ({
              label: monthName(p.month, x.locale),
              title: monthTitle(p.month),
              values: [chartNumber(p.first), chartNumber(p.second)],
              texts: [money(p.first), money(p.second)],
            }))}
            rtl={rtl}
            series={[
              { label: first.label, color: `var(${SERIES_1})` },
              { label: second.label, color: `var(${SERIES_2})` },
            ]}
          />
        </div>
      </Chart>
    );
  }

  if (spec.type === 'bars') {
    const label = (row: { label: string; labelKey: boolean }) => (row.labelKey ? x.t(`home.value.${row.label}`) : row.label);
    const shown = (value: string) => (spec.unit === 'money' ? money(value) : formatQuantity(value, x.locale));
    const shares = spec.rows.length < RANKED_CAP ? sharesOf(spec.rows.map((row) => row.value), x.locale) : spec.rows.map(() => null);
    return (
      <Chart
        tableLabel={tableLabel(x)}
        action={link ? <SeeAll href={link} label={x.t('home.see_all')} /> : null}
        hint={hint}
        table={
          <BandTable headings={[x.t('home.col.item'), { label: x.t('home.col.amount'), numeric: true }]}>
            {spec.rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <bdi dir="auto">{label(row)}</bdi>
                </td>
                <td className={NUMERIC_CELL}>
                  <bdi dir="ltr">{shown(row.value)}</bdi>
                </td>
              </tr>
            ))}
          </BandTable>
        }
        title={title}
        wide={wide}
      >
        <BarList
          negativeLabel={x.t('home.chart.overdrawn')}
          rows={spec.rows.map((row, index) => ({ key: row.key, label: label(row), value: chartNumber(row.value), text: shown(row.value), share: shares[index] }))}
        />
      </Chart>
    );
  }

  // Ageing: a donut of ordered buckets around the whole open amount (summed as scaled bigints). The words are the old Home's own.
  const total = moneyString(sumMoney(spec.rows.map((row) => row.value)));
  const whole = shortMoney(total, 'IQD', x.locale);
  const shares = sharesOf(spec.rows.map((row) => row.value), x.locale);
  const invoices = spec.rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <Chart
      tableLabel={tableLabel(x)}
      action={link ? <SeeAll href={link} label={x.t('admin.dashboard.open_invoices')} /> : null}
      hint={hint}
      table={
        <BandTable
          headings={[x.t('admin.dashboard.bucket'), { label: x.t('column.document'), numeric: true }, { label: x.t('admin.dashboard.total_open'), numeric: true }]}
        >
          {spec.rows.map((row) => (
            <tr key={row.key}>
              <td>{x.t(`admin.dashboard.${row.labelKey}`)}</td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{countText(x, row.count)}</bdi>
              </td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{money(row.value)}</bdi>
              </td>
            </tr>
          ))}
          <tr className="bg-muted font-semibold">
            <td>{x.t('home.chart.total')}</td>
            <td className={NUMERIC_CELL}>
              <bdi dir="ltr">{countText(x, invoices)}</bdi>
            </td>
            <td className={NUMERIC_CELL}>
              <bdi dir="ltr">{money(total)}</bdi>
            </td>
          </tr>
        </BandTable>
      }
      title={title}
      wide={wide}
    >
      <Donut
        centreLabel={x.t('admin.dashboard.total_open')}
        centreNote={x.t('home.note.open_invoices', { count: invoices })}
        centreTitle={whole.shortened ? whole.exact : undefined}
        centreValue={whole.text}
        parts={spec.rows.map((row, index) => ({
          key: row.key,
          label: x.t(`admin.dashboard.${row.labelKey}`),
          value: chartNumber(row.value),
          color: RAMP[row.step] ?? RAMP[3]!,
          text: money(row.value),
          share: shares[index] ?? '',
          note: x.t('home.note.open_invoices', { count: row.count }),
        }))}
      />
    </Chart>
  );
}

/**
 * The import journey, as a row of steps: each with its number, its name, how
 * far the imports in progress have got (a thin progress bar) and the count —
 * every import there (approved), some (submitted), none (draft), the same
 * `data-status` the import's own rail uses. The table beneath is the same
 * counts in words. Only the steps the viewer can read evidence for are in
 * `stages`; the rest are not drawn, so a zero never stands for "not allowed".
 */
function JourneyView({ widget, data, x, served }: { readonly widget: HomeWidget; readonly data: JourneyData; readonly x: HomeText; readonly served: (route: string) => boolean }) {
  const link = linkFor(data.href, served);
  const tone = (count: number) => (count >= data.inProgress ? 'approved' : count > 0 ? 'submitted' : 'draft');
  const meaning = (count: number) =>
    count >= data.inProgress ? x.t('home.journey_all') : count > 0 ? x.t('home.journey_some', { count, total: data.inProgress }) : x.t('home.journey_none');
  return (
    <Chart
      tableLabel={tableLabel(x)}
      action={link ? <SeeAll href={link} label={x.t('home.see_all')} /> : null}
      hint={x.t('home.journey_in_progress', { count: data.inProgress })}
      table={
        <BandTable headings={[x.t('home.journey_stage'), { label: x.t('home.journey_reached'), numeric: true }]}>
          {data.stages.map((stage) => (
            <tr key={stage.key}>
              <td>{x.t(`home.journey.${stage.key}`)}</td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{`${countText(x, stage.count)} / ${countText(x, data.inProgress)}`}</bdi>
              </td>
            </tr>
          ))}
        </BandTable>
      }
      title={widgetTitle(x, widget)}
      wide
    >
      <ol className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 xl:grid-cols-9">
        {data.stages.map((stage, index) => {
          const kind = tone(stage.count);
          const share = data.inProgress > 0 ? Math.min(100, (stage.count / data.inProgress) * 100) : 0;
          return (
            <li
              className={cn(
                'flex min-w-0 flex-col gap-2 rounded-lg border p-3',
                kind === 'approved' ? 'border-primary/40 bg-primary-subtle' : 'border-border',
              )}
              data-status={kind}
              key={stage.key}
              title={meaning(stage.count)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full font-semibold text-xs tabular-nums',
                    kind === 'approved' ? 'bg-primary text-primary-fg' : kind === 'submitted' ? cn('bg-primary-subtle', INK.primary) : 'bg-muted text-muted-fg',
                  )}
                >
                  <bdi dir="ltr">{countText(x, index + 1)}</bdi>
                </span>
                <span className="min-w-0 font-medium text-fg text-sm leading-tight">
                  <bdi dir="auto">{x.t(`home.journey.${stage.key}`)}</bdi>
                </span>
              </span>
              <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-secondary">
                <span className="block h-full rounded-full bg-primary" style={{ inlineSize: `${share}%` }} />
              </span>
              <span className={cn('text-xs tabular-nums', kind === 'approved' ? 'text-fg' : 'text-muted-fg')}>
                <bdi dir="ltr">{`${countText(x, stage.count)}/${countText(x, data.inProgress)}`}</bdi>
                <span className="sr-only">{` · ${meaning(stage.count)}`}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {data.read < data.total ? <p className="m-0 mt-3 text-muted-fg text-xs">{x.t('home.journey_partial', { read: data.read, total: data.total })}</p> : null}
      <p className="m-0 mt-3 text-muted-fg text-xs">{x.t('home.journey_unseen')}</p>
    </Chart>
  );
}

/**
 * The trends: only the charts that have something to draw, two to a row on a
 * wide screen (a chart whose axis needs the width takes the whole row). A
 * chart with nothing behind it (or that could not be read) is not drawn as a
 * blank frame; it is named, with its reason, in the quiet band at the foot.
 */
export function ChartsBand({
  widgets,
  x,
  served,
  asOf,
}: {
  readonly widgets: readonly HomeWidget[];
  readonly x: HomeText;
  readonly served: (route: string) => boolean;
  /** The page's business date, so a month still going on is said to be "so far". */
  readonly asOf?: string | undefined;
}) {
  const ready = widgets.filter(
    (widget) => widget.outcome.state === 'ready' && (widget.outcome.data.kind === 'chart' || widget.outcome.data.kind === 'journey'),
  );
  const wide = fullRows(ready.map(({ outcome }) => outcome.state === 'ready' && (outcome.data.kind === 'journey' || (outcome.data.kind === 'chart' && outcome.data.wide))));
  const drawn: ReactNode[] = [];
  ready.forEach((widget, index) => {
    const outcome = widget.outcome;
    if (outcome.state === 'ready' && outcome.data.kind === 'chart') {
      drawn.push(<ChartView asOf={asOf} data={outcome.data} key={widget.key} served={served} wide={wide[index] === true} widget={widget} x={x} />);
    } else if (outcome.state === 'ready' && outcome.data.kind === 'journey') {
      drawn.push(<JourneyView data={outcome.data} key={widget.key} served={served} widget={widget} x={x} />);
    }
  });
  if (drawn.length === 0) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h2 className="m-0 font-semibold text-base text-fg">{x.t('home.section_charts')}</h2>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">{drawn}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// What can be acted on
// ---------------------------------------------------------------------------

function ListRows({ data, x }: { readonly data: TableData; readonly x: HomeText }) {
  return (
    <BandTable headings={data.columns.map((column) => (column.numeric ? { label: x.t(`home.col.${column.key}`), numeric: true as const } : x.t(`home.col.${column.key}`)))}>
      {data.rows.map((row) => (
        <tr key={row.key}>
          {row.cells.map((cell, index) => {
            const numeric = data.columns[index]?.numeric === true;
            const content = <CellView cell={cell} x={x} />;
            return (
              <td className={numeric ? NUMERIC_CELL : index === 0 ? 'font-medium' : undefined} key={index}>
                {index === 0 && row.href ? (
                  <Link
                    className={cn(
                      INK.primary,
                      'rounded-sm no-underline outline-offset-2 hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring',
                    )}
                    href={row.href}
                  >
                    {content}
                  </Link>
                ) : (
                  content
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </BandTable>
  );
}

/** One list, in an Intent card. A list with nothing to show is named in the quiet band instead. */
export function ListBand({
  widget,
  x,
  served,
  className,
}: {
  readonly widget: HomeWidget;
  readonly x: HomeText;
  readonly served: (route: string) => boolean;
  /** Where the card sits in the page's grid. */
  readonly className?: string | undefined;
}) {
  const outcome = widget.outcome;
  if (outcome.state !== 'ready' || outcome.data.kind !== 'table') return null;
  const data = outcome.data;
  const link = linkFor(data.href, served) ?? undefined;
  return (
    <Band className={cn('mb-0', className)} count={data.total} href={link} hrefLabel={link ? x.t('home.see_all') : undefined} title={widgetTitle(x, widget)}>
      <ListRows data={data} x={x} />
    </Band>
  );
}

/** How many columns a list is drawn with — a list of five or more needs a whole row. */
export function listColumns(widget: HomeWidget): number {
  const outcome = widget.outcome;
  return outcome.state === 'ready' && outcome.data.kind === 'table' ? outcome.data.columns.length : 0;
}

/**
 * What this person may see but that has nothing in it — or could not be read —
 * one quiet tile each, with the widget's own sentence. Said once, together,
 * rather than as an empty card of its own per widget.
 */
export function QuietBand({ widgets, x }: { readonly widgets: readonly HomeWidget[]; readonly x: HomeText }) {
  if (widgets.length === 0) return null;
  return (
    <Band className="mb-0" icon={CircleDashed} title={x.t('home.section_quiet')}>
      <ul className="m-0 grid list-none grid-cols-1 gap-2 border-border border-t p-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-3">
        {widgets.map((widget) => {
          const title = widgetTitle(x, widget);
          const unreadable = widget.outcome.state === 'unreadable';
          return (
            <li className="flex min-w-0 items-start gap-3 rounded-lg bg-muted/50 p-3" key={widget.key}>
              <span
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-lg',
                  unreadable ? 'bg-warning-subtle text-warning-subtle-fg' : 'bg-overlay text-muted-fg',
                )}
              >
                {unreadable ? <TriangleAlert aria-hidden="true" className="size-4" /> : <CircleDashed aria-hidden="true" className="size-4" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-fg text-sm">{title}</span>
                <span className="text-muted-fg text-xs">{unreadable ? x.t('admin.dashboard.unreadable', { band: title }) : widgetEmpty(x, widget)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Band>
  );
}

/** What this person's role holds nothing of — said once, per family, in plain words. */
export function UnavailableBand({ families, x }: { readonly families: readonly DataFamily[]; readonly x: HomeText }) {
  if (families.length === 0) return null;
  return (
    <Band className="mb-0" icon={Lock} title={x.t('home.section_unavailable')}>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-6 border-border border-t px-4 py-2 sm:grid-cols-2 sm:px-5 xl:grid-cols-3">
        {families.map((family) => (
          <li className="flex items-center gap-2.5 py-2 text-muted-fg text-sm" key={family}>
            <Lock aria-hidden="true" className="size-3.5 shrink-0" />
            <span>{x.t(`home.unavailable.${family}`)}</span>
          </li>
        ))}
      </ul>
    </Band>
  );
}
