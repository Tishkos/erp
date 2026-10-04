import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  Banknote,
  Bell,
  Boxes,
  ClipboardCheck,
  FolderKanban,
  HandCoins,
  Landmark,
  ListTodo,
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
import { admin as s } from '@/components/admin';
import { BarList, Chart, GroupedColumns, Legend, StackedBands } from '@/components/admin/charts';
import { Band, BandTable } from '@/components/admin/dashboard-band';
import { formatBusinessDate, formatMoney, formatQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { chartNumber } from '@/server/domain/dashboard-charts';
import type { Cell, ChartData, JourneyData, KpiData, Note, TableData } from '@/server/domain/dashboard-data';
import type { DataFamily } from '@/server/domain/dashboard-widgets';
import type { HomeWidget } from '@/server/services/home';

/**
 * Home's widgets, drawn — platform phase, Agent 2.
 *
 * One presenter per *shape* (a figure, a table, a chart, the import journey),
 * all built from pieces the application already has: the stat tile the
 * approvals screen wears, the `Chart` figure with its table twin, the band
 * window and its table, and the status chip. Nothing is styled here. A loader
 * hands over typed cells and these functions turn them into the reader's words
 * and numbers — money through `formatMoney`, dates through `formatBusinessDate`
 * — so a figure is formatted exactly once, last.
 *
 * Server components throughout: no client JavaScript, so the first paint is the
 * whole page and the charts print.
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
        <span className={`status status--${cell.tone} ${s.sapRegisterStatus}`} data-status={cell.tone}>
          {label}
        </span>
      );
    }
    case 'say':
      return x.t.has(`home.say.${cell.v}`) ? <bdi dir="auto">{x.t(`home.say.${cell.v}`, cell.values ?? {})}</bdi> : humanize(cell.v);
    case 'none':
      return '—';
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
const COMPACT_FROM_DIGITS = 8;

function KpiValue({ cell, x }: { readonly cell: Cell; readonly x: HomeText }): ReactNode {
  if (cell.t === 'money') {
    const whole = cell.v.replace(/^-/, '').split('.')[0] ?? '';
    if (whole.length >= COMPACT_FROM_DIGITS) {
      const short = new Intl.NumberFormat(x.locale, { notation: 'compact', maximumFractionDigits: 2 }).format(Number(cell.v));
      return (
        <bdi title={formatMoney(cell.v, cell.currency, x.locale)}>{`${short} ${cell.currency}`}</bdi>
      );
    }
  }
  return <CellView cell={cell} x={x} />;
}

/**
 * The primary figures: a tile each, in the stat tile the approvals screen
 * already wears. A tile whose widget has nothing to say shows a dash and says
 * why in the widget's own words — it never shows a zero that was not counted.
 */
export function KpiRow({ widgets, x, served }: { readonly widgets: readonly HomeWidget[]; readonly x: HomeText; readonly served: (route: string) => boolean }) {
  if (widgets.length === 0) return null;
  return (
    <div className={s.statRow}>
      {widgets.map((widget) => {
        const title = widgetTitle(x, widget);
        const Icon = KPI_ICON[widget.key] ?? ClipboardCheck;
        const outcome = widget.outcome;
        let value: ReactNode = '—';
        let note: string | null = null;
        let href: string | null = null;
        let WarnIcon: LucideIcon | null = null;
        if (outcome.state === 'ready' && outcome.data.kind === 'kpi') {
          const data: KpiData = outcome.data;
          value = <KpiValue cell={data.value} x={x} />;
          note = noteText(x, data.note);
          href = data.href && served(data.href.split('?')[0]!) ? data.href : null;
          if (data.tone === 'warn') WarnIcon = TriangleAlert;
        } else if (outcome.state === 'unreadable') {
          note = x.t('admin.dashboard.unreadable', { band: title });
        } else {
          note = widgetEmpty(x, widget);
        }
        const Glyph = WarnIcon ?? Icon;
        const body = (
          <>
            <span className={s.statIcon}>
              <Glyph aria-hidden="true" />
            </span>
            <div>
              <strong>{value}</strong>
              <span>{note ? `${title} · ${note}` : title}</span>
            </div>
          </>
        );
        return href ? (
          <Link className={s.stat} href={href} key={widget.key}>
            {body}
          </Link>
        ) : (
          <div className={s.stat} key={widget.key}>
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

function ChartView({ widget, data, x, served }: { readonly widget: HomeWidget; readonly data: ChartData; readonly x: HomeText; readonly served: (route: string) => boolean }) {
  const title = widgetTitle(x, widget);
  const hint = noteText(x, data.note) ?? undefined;
  // The marks carry numbers; the table beside each carries the services' own decimal strings, formatted last.
  const drawMoney = (value: number) => formatMoney(value, 'IQD', x.locale);
  const spec = data.chart;
  const link = data.href && served(data.href.split('?')[0]!) ? data.href : null;

  if (spec.type === 'columns') {
    const first = { label: x.t(`home.value.${spec.firstKey}`), token: '--chart-series-1', values: spec.points.map((p) => chartNumber(p.first)) };
    const second = { label: x.t(`home.value.${spec.secondKey}`), token: '--chart-series-2', values: spec.points.map((p) => chartNumber(p.second)) };
    return (
      <Chart
        hint={hint}
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{x.t('column.date')}</th>
                <th scope="col">{first.label}</th>
                <th scope="col">{second.label}</th>
              </tr>
            </thead>
            <tbody>
              {spec.points.map((p) => (
                <tr key={p.month}>
                  <td>{p.month}</td>
                  <td>{formatMoney(p.first, 'IQD', x.locale)}</td>
                  <td>{formatMoney(p.second, 'IQD', x.locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={title}
        wide={data.wide}
      >
        <Legend series={[first, second]} />
        <GroupedColumns format={drawMoney} labels={spec.points.map((p) => monthName(p.month, x.locale))} series={[first, second]} />
        {link ? (
          <Link className={s.sapPlainLink} href={link}>
            {x.t('home.see_all')}
          </Link>
        ) : null}
      </Chart>
    );
  }

  if (spec.type === 'bars') {
    const label = (row: { label: string; labelKey: boolean }) => (row.labelKey ? x.t(`home.value.${row.label}`) : row.label);
    const draw = (value: number) => (spec.unit === 'money' ? drawMoney(value) : countText(x, value));
    const shown = (value: string) => (spec.unit === 'money' ? formatMoney(value, 'IQD', x.locale) : formatQuantity(value, x.locale));
    return (
      <Chart
        hint={hint}
        table={
          <table>
            <thead>
              <tr>
                <th scope="col">{x.t('home.col.item')}</th>
                <th scope="col">{x.t('home.col.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {spec.rows.map((row) => (
                <tr key={row.key}>
                  <td>{label(row)}</td>
                  <td>{shown(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        }
        title={title}
        wide={data.wide}
      >
        <BarList format={draw} rows={spec.rows.map((row) => ({ key: row.key, label: label(row), value: chartNumber(row.value) }))} />
        {link ? (
          <Link className={s.sapPlainLink} href={link}>
            {x.t('home.see_all')}
          </Link>
        ) : null}
      </Chart>
    );
  }

  // Ageing: one stacked bar of ordered bands. The words are the old Home's own.
  return (
    <Chart
      hint={hint}
      table={
        <table>
          <thead>
            <tr>
              <th scope="col">{x.t('admin.dashboard.bucket')}</th>
              <th scope="col">{x.t('column.document')}</th>
              <th scope="col">{x.t('admin.dashboard.total_open')}</th>
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row) => (
              <tr key={row.key}>
                <td>{x.t(`admin.dashboard.${row.labelKey}`)}</td>
                <td>{countText(x, row.count)}</td>
                <td>{formatMoney(row.value, 'IQD', x.locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      title={title}
      wide={data.wide}
    >
      <StackedBands
        bands={spec.rows.map((row) => ({ key: row.key, label: x.t(`admin.dashboard.${row.labelKey}`), value: chartNumber(row.value), step: row.step }))}
        format={drawMoney}
      />
      {link ? (
        <Link className={s.sapPlainLink} href={link}>
          {x.t('admin.dashboard.open_invoices')}
        </Link>
      ) : null}
    </Chart>
  );
}

/**
 * The import journey, drawn the way the import's own page draws its rail: a row
 * of numbered status chips, each toned by how far the imports have got — every
 * import there (approved), some (submitted), none (draft). The table beneath is
 * the same counts in words. Only the steps the viewer can read evidence for
 * are in `stages`; the rest are not drawn, so a zero never stands for "not allowed".
 */
function JourneyView({ widget, data, x, served }: { readonly widget: HomeWidget; readonly data: JourneyData; readonly x: HomeText; readonly served: (route: string) => boolean }) {
  const link = data.href && served(data.href.split('?')[0]!) ? data.href : null;
  const tone = (count: number) => (count >= data.inProgress ? 'approved' : count > 0 ? 'submitted' : 'draft');
  const meaning = (count: number) =>
    count >= data.inProgress ? x.t('home.journey_all') : count > 0 ? x.t('home.journey_some', { count, total: data.inProgress }) : x.t('home.journey_none');
  return (
    <Chart
      hint={x.t('home.journey_in_progress', { count: data.inProgress })}
      table={
        <table>
          <thead>
            <tr>
              <th scope="col">{x.t('home.journey_stage')}</th>
              <th scope="col">{x.t('home.journey_reached')}</th>
            </tr>
          </thead>
          <tbody>
            {data.stages.map((stage) => (
              <tr key={stage.key}>
                <td>{x.t(`home.journey.${stage.key}`)}</td>
                <td>{`${countText(x, stage.count)} / ${countText(x, data.inProgress)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      title={widgetTitle(x, widget)}
      wide
    >
      <span className={s.inlineRow}>
        {data.stages.map((stage, index) => {
          const kind = tone(stage.count);
          return (
            <span className={`status status--${kind}`} data-status={kind} key={stage.key} title={meaning(stage.count)}>
              <bdi dir="auto">{`${index + 1}. ${x.t(`home.journey.${stage.key}`)}`}</bdi>
              {' · '}
              <bdi dir="ltr">{`${countText(x, stage.count)}/${countText(x, data.inProgress)}`}</bdi>
            </span>
          );
        })}
      </span>
      {data.read < data.total ? <p className={s.sectionHint}>{x.t('home.journey_partial', { read: data.read, total: data.total })}</p> : null}
      <p className={s.sectionHint}>{x.t('home.journey_unseen')}</p>
      {link ? (
        <Link className={s.sapPlainLink} href={link}>
          {x.t('home.see_all')}
        </Link>
      ) : null}
    </Chart>
  );
}

/**
 * The trends: only the charts that have something to draw. A chart with
 * nothing behind it (or that could not be read) is not drawn as a blank frame;
 * it is named, with its reason, in the quiet band at the foot of the page.
 */
export function ChartsBand({ widgets, x, served }: { readonly widgets: readonly HomeWidget[]; readonly x: HomeText; readonly served: (route: string) => boolean }) {
  const drawn: ReactNode[] = [];
  for (const widget of widgets) {
    const outcome = widget.outcome;
    if (outcome.state === 'ready' && outcome.data.kind === 'chart') {
      drawn.push(<ChartView data={outcome.data} key={widget.key} served={served} widget={widget} x={x} />);
    } else if (outcome.state === 'ready' && outcome.data.kind === 'journey') {
      drawn.push(<JourneyView data={outcome.data} key={widget.key} served={served} widget={widget} x={x} />);
    }
  }
  if (drawn.length === 0) return null;
  return (
    <Band title={x.t('home.section_charts')}>
      <div className={s.chartGrid}>{drawn}</div>
    </Band>
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
              <td className={numeric ? s.sapNum : index === 0 ? s.sapAccountCell : undefined} key={index}>
                {index === 0 && row.href ? (
                  <Link className={s.sapLink} href={row.href}>
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

/** One list, in the band window. A list with nothing to show is named in the quiet band instead. */
export function ListBand({ widget, x, served }: { readonly widget: HomeWidget; readonly x: HomeText; readonly served: (route: string) => boolean }) {
  const outcome = widget.outcome;
  if (outcome.state !== 'ready' || outcome.data.kind !== 'table') return null;
  const data = outcome.data;
  const link = data.href && served(data.href.split('?')[0]!) ? data.href : undefined;
  return (
    <Band count={data.total} href={link} hrefLabel={link ? x.t('home.see_all') : undefined} title={widgetTitle(x, widget)}>
      <ListRows data={data} x={x} />
    </Band>
  );
}

/**
 * What this person may see but that has nothing in it — or could not be read —
 * one row each, with the widget's own sentence. Said once, in the table every
 * register wears, rather than as a window of its own per widget.
 */
export function QuietBand({ widgets, x }: { readonly widgets: readonly HomeWidget[]; readonly x: HomeText }) {
  if (widgets.length === 0) return null;
  return (
    <Band title={x.t('home.section_quiet')}>
      <BandTable headings={[x.t('home.quiet_what'), x.t('home.quiet_why')]}>
        {widgets.map((widget) => {
          const title = widgetTitle(x, widget);
          return (
            <tr key={widget.key}>
              <td className={s.sapAccountCell}>{title}</td>
              <td>{widget.outcome.state === 'unreadable' ? x.t('admin.dashboard.unreadable', { band: title }) : widgetEmpty(x, widget)}</td>
            </tr>
          );
        })}
      </BandTable>
    </Band>
  );
}

/** What this person's role holds nothing of — said once, per family, in plain words. */
export function UnavailableBand({ families, x }: { readonly families: readonly DataFamily[]; readonly x: HomeText }) {
  if (families.length === 0) return null;
  return (
    <Band title={x.t('home.section_unavailable')}>
      {families.map((family) => (
        <p className={s.sectionHint} key={family}>
          {x.t(`home.unavailable.${family}`)}
        </p>
      ))}
    </Band>
  );
}
