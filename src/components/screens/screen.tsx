/**
 * The seven screen shapes — Appendix A, rendered.
 *
 * Every page in the approved tree is one of seven shapes (`domain/screens.ts`),
 * and this file draws all seven. A module does not get a bespoke page until it
 * needs one: it gets its shape, its own title from the catalogue and its own
 * sample rows, and that is enough for the design to be reviewed and for the
 * navigation to stop lying about what exists.
 *
 * These are server components. They take no query and call no service — a
 * screen here cannot widen a permission or leak a row, because it has nothing
 * to leak. What replaces the samples later is a service call in the *page*,
 * passed down as props; the shape does not change.
 */
import { getLocale, getTranslations } from 'next-intl/server';
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CircleAlert,
  ClipboardCheck,
  Coins,
  Columns3,
  Download,
  FileText,
  Inbox,
  Landmark,
  LayoutDashboard,
  PieChart,
  Play,
  Plus,
  Printer,
  Save,
  Search,
  SlidersHorizontal,
  TableProperties,
  Upload,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ScreenRoute } from '@domain/screens';
import {
  columnsFor,
  specFor,
  type FieldKind,
  type ScreenSpec,
} from '@/sample/specs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import {
  sampleCategories,
  sampleEntityRows,
  sampleMetrics,
  sampleRanking,
  sampleSeries,
  sampleSettings,
  sampleTotal,
} from '@/sample/generate';
import {
  BarChart,
  DonutChart,
  RankedList,
  TrendChart,
} from '@/components/ui/charts';
import {
  Button,
  ContextBar,
  DrillHint,
  ReportParameters,
  SaveBar,
  ContextField,
  DataTable,
  EmptyState,
  Pagination,
  Panel,
  PageHeader,
  PeriodPill,
  PresentationBanner,
  PreviewAction,
  SearchBox,
  StatusPill,
  TableFooter,
  Workspace,
  ui,
  type TableColumn,
  type TableRow,
} from '@/components/ui';
import { MATCHING_SCREENS, MatchingShape } from './matching';
import styles from './screen.module.css';

const ARCHETYPE_ICON = {
  dashboard: LayoutDashboard,
  list: TableProperties,
  document: FileText,
  workspace: SlidersHorizontal,
  report: Landmark,
  settings: SlidersHorizontal,
  inbox: Inbox,
} as const;

/* -------------------------------------------------------------------------
 * Shared furniture
 * ---------------------------------------------------------------------- */

async function ScreenContext({ withSearch }: { readonly withSearch: boolean }) {
  const screen = await getTranslations('screen');
  const list = await getTranslations('list');

  return (
    <ContextBar fieldCount={4} label={screen('context')} withSearch={withSearch}>
      <ContextField
        icon={Building2}
        id="screen-company"
        label={screen('company')}
        value={screen('current_company')}
      />
      <ContextField
        icon={Building2}
        id="screen-branch"
        label={screen('branch')}
        value={screen('current_branch')}
      />
      <ContextField
        icon={Coins}
        id="screen-currency"
        label={screen('currency')}
        value={screen('current_currency')}
      />
      <ContextField
        icon={CalendarDays}
        id="screen-period"
        label={screen('period')}
        value={screen('current_period')}
      />
      {withSearch ? (
        <>
          <SearchBox
            label={list('search')}
            placeholder={list('search_placeholder')}
            defaultValue=""
          />
          <Button icon={SlidersHorizontal} label={list('filters')} />
        </>
      ) : null}
    </ContextBar>
  );
}

/**
 * The headline figures above a list, dashboard or report.
 *
 * Which figures depends on the module, not on the archetype: a Purchasing list
 * leads with open value and what is awaiting approval, an ageing report with
 * what is overdue. The names come from the screen's spec; only the numbers are
 * generated. A `count` metric is a quantity, so it is not shown as money.
 */
async function MetricStrip({
  screenKey,
  metrics: metricKeys,
}: {
  readonly screenKey: string;
  readonly metrics: readonly string[];
}) {
  const [locale, screen] = await Promise.all([getLocale(), getTranslations('screen')]);
  const metrics = sampleMetrics(screenKey, metricKeys.length);
  const percent = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  // Not every headline figure is money. A count is a count, and a margin or a
  // utilisation is a ratio — rendering either as IQD was the giveaway that the
  // strip was generated rather than designed.
  const QUANTITIES = new Set(['count', 'headcount', 'on_hand', 'committed']);
  const RATIOS = new Set(['margin', 'utilisation']);

  return (
    <section aria-label={screen('summary')} className={styles.metricStrip}>
      {metrics.map((metric, index) => {
        const metricKey = metricKeys[index]!;
        const isQuantity = QUANTITIES.has(metricKey);
        const isRatio = RATIOS.has(metricKey);
        const series = sampleSeries(`${metric.key}`, 14);
        const max = Math.max(...series);
        const min = Math.min(...series);
        const points = series
          .map((value, position) => {
            const x = (position / (series.length - 1)) * 100;
            const y = 30 - ((value - min) / Math.max(max - min, 1)) * 26;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(' ');

        return (
          <article className={styles.metricCard} key={metric.key}>
            <h2 className={styles.metricLabel}>{screen(`metric.${metricKey}`)}</h2>
            <p className={styles.metricValue}>
              <bdi dir="ltr">
                {isRatio
                  ? percent.format((metric.amount % 4_000_000) / 10_000_000)
                  : isQuantity
                    ? number.format(Math.round(metric.amount / 1_000))
                    : formatMoney(metric.amount, 'IQD', locale as Locale)}
              </bdi>
            </p>
            <p
              className={`${styles.metricTrend} ${metric.trend >= 0 ? styles.up : styles.down}`}
            >
              <bdi dir="ltr">{percent.format(metric.trend)}</bdi>
            </p>
            <svg
              aria-hidden="true"
              className={styles.spark}
              focusable="false"
              preserveAspectRatio="none"
              viewBox="0 0 100 30"
            >
              <polyline points={points} />
            </svg>
          </article>
        );
      })}
    </section>
  );
}

/**
 * The row table shared by the list, document, workspace and report shapes.
 *
 * `compact` drops the two widest columns. A workspace puts a detail panel
 * beside the table, leaving it about half the width; the full column set does
 * fit there, but only by scrolling, and a status column sliced down the middle
 * reads as a broken screen rather than a scrollable one.
 */
async function SampleTable({
  screenKey,
  spec,
  compact,
  recordHref,
  withTotals,
}: {
  readonly screenKey: string;
  readonly spec: ScreenSpec;
  readonly compact?: boolean;
  /** Base path of the record behind each row; absent when there is none. */
  readonly recordHref?: string | undefined;
  /** Foot the money columns. A report should not ask the reader to add up. */
  readonly withTotals?: boolean;
}) {
  const [locale, column, status, list, screen] = await Promise.all([
    getLocale(),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('list'),
    getTranslations('screen'),
  ]);

  const specColumns = columnsFor(spec, compact);
  const rows = sampleEntityRows(screenKey, spec.entity);
  const total = sampleTotal(screenKey);
  const number = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const isNumeric = (kind: FieldKind) =>
    kind === 'money' || kind === 'number' || kind === 'percent';

  const columns: readonly TableColumn[] = specColumns.map((specColumn) => ({
    key: specColumn.key,
    label: column(specColumn.key),
    ...(isNumeric(specColumn.kind) ? { numeric: true } : {}),
  }));

  /** One cell, formatted by the kind its column declares. */
  const render = (kind: FieldKind, value: unknown): ReactNode => {
    if (value === null || value === undefined || value === '') return '—';
    switch (kind) {
      case 'money':
        // A ledger shows one side of each entry and leaves the other blank.
        // Printing "IQD 0" in every debit cell of a credit row doubles the
        // figures on screen and reads as data rather than as absence.
        return Number(value) === 0 ? (
          '—'
        ) : (
          <bdi dir="ltr">{formatMoney(Number(value), 'IQD', locale as Locale)}</bdi>
        );
      case 'number':
        return <bdi dir="ltr">{number.format(Number(value))}</bdi>;
      case 'percent':
        return <bdi dir="ltr">{percent.format(Number(value))}</bdi>;
      case 'date':
        return <bdi dir="auto">{formatBusinessDate(String(value), locale as Locale)}</bdi>;
      case 'code':
        return <bdi dir="ltr">{String(value)}</bdi>;
      case 'status':
        return <StatusPill label={status(String(value))} status={String(value)} />;
      default:
        return String(value);
    }
  };

  // A document list leads to the record behind each row. Other shapes have no
  // record page — a stock balance or a budget line is not a document — so their
  // rows stay unlinked rather than leading somewhere that would 404.
  /*
   * Money columns foot — but not every money column is additive. A running
   * balance already contains the rows above it, so summing the column double
   * counts; a unit price is a rate, and the sum of rates means nothing. Both
   * were being totalled, and a wrong total on a trial balance is worse than
   * no total.
   */
  const NON_ADDITIVE = new Set([
    'balance',
    'opening_balance',
    'closing_balance',
    'unit_price',
    'net_book_value',
  ]);
  const totals = {
    label: screen('grand_total'),
    cells: Object.fromEntries(
      specColumns
        .filter((specColumn) => specColumn.kind === 'money' && !NON_ADDITIVE.has(specColumn.key))
        .map((specColumn) => [
          specColumn.key,
          <bdi dir="ltr" key={specColumn.key}>
            {formatMoney(
              rows.reduce((sum, row) => sum + Number(row[specColumn.key] ?? 0), 0),
              'IQD',
              locale as Locale,
            )}
          </bdi>,
        ]),
    ),
  };

  const identifier = specColumns[0]?.key;
  const linksToRecord = recordHref !== undefined && identifier !== undefined;

  const tableRows: readonly TableRow[] = rows.map((row, index) => ({
    id: String(row.id ?? index),
    ...(linksToRecord
      ? { href: `${recordHref}/${encodeURIComponent(String(row[identifier!]))}` }
      : {}),
    cells: Object.fromEntries(
      specColumns.map((specColumn) => [
        specColumn.key,
        render(specColumn.kind, row[specColumn.key]),
      ]),
    ),
  }));

  return (
    <Panel flush>
      <DataTable
        caption={screen('records')}
        columns={columns}
        rows={tableRows}
        {...(withTotals ? { totals } : {})}
      />
      <TableFooter>
        <span>{list('row_count', { count: total })}</span>
        <Pagination
          count={Math.max(1, Math.ceil(total / 10))}
          current={1}
          hrefFor={(page) => `?page=${page}`}
          labels={{
            label: list('page_of', { page: 1, pages: Math.ceil(total / 10) }),
            previous: list('search'),
            next: list('search'),
            page: (page) => number.format(page),
          }}
          locale={locale}
        />
      </TableFooter>
    </Panel>
  );
}

/** Every shape takes the same two things: which screen, and what it shows. */
interface ShapeProps {
  readonly screenKey: string;
  readonly spec: ScreenSpec;
  /** Where a row leads, for the shapes whose rows are documents. */
  readonly recordHref?: string | undefined;
}

/* -------------------------------------------------------------------------
 * The seven shapes
 * ---------------------------------------------------------------------- */

/**
 * A module dashboard — the Dashboard.png shape, generalised.
 *
 * Three panels across, each carrying a different job: change over time, the
 * composition behind it, and two measures compared per period. Then a ranked
 * list and the module's own rows. Every chart form here was chosen for what its
 * data is doing, not to fill the panel.
 */
async function DashboardShape({ screenKey, spec, recordHref }: ShapeProps) {
  const [locale, screen, column] = await Promise.all([
    getLocale(),
    getTranslations('screen'),
    getTranslations('column'),
  ]);
  const charts = await moduleCharts(screenKey, locale);

  return (
    <>
      <MetricStrip metrics={spec.metrics} screenKey={screenKey} />

      <div className={styles.dashboardGrid}>
        <Panel
          actions={<PeriodPill icon={CalendarDays} label={screen('current_period')} />}
          icon={LayoutDashboard}
          title={screen('chart.over_time')}
        >
          <TrendChart
            caption={screen('chart.over_time')}
            periodHeader={column('period')}
            points={charts.trend}
            scale={charts.scale}
            valueHeader={column('amount')}
          />
        </Panel>

        <Panel icon={PieChart} title={screen('chart.composition')}>
          <DonutChart
            caption={screen('chart.composition')}
            centreLabel={screen('current_currency').slice(0, 3)}
            centreValue={charts.donutTotal}
            nameHeader={column('category')}
            slices={charts.slices}
            valueHeader={column('amount')}
          />
        </Panel>

        <Panel icon={TableProperties} title={screen('chart.compare')}>
          <BarChart
            caption={screen('chart.compare')}
            groups={charts.bars}
            periodHeader={column('period')}
            primaryLabel={screen('metric.posted_value')}
            secondaryLabel={screen('metric.open_value')}
          />
        </Panel>
      </div>

      <div className={styles.splitDetail}>
        <SampleTable recordHref={recordHref} screenKey={screenKey} spec={spec} compact />
        <Panel icon={Users} title={screen('chart.top_partners')}>
          <RankedList
            caption={screen('chart.top_partners')}
            entries={charts.ranked}
            locale={locale}
            nameHeader={column('partner')}
            valueHeader={column('amount')}
          />
        </Panel>
      </div>
    </>
  );
}

/** The four chart datasets a module dashboard draws, already formatted. */
async function moduleCharts(screenKey: string, locale: string) {
  const money = (value: number) => formatMoney(value, 'IQD', locale as Locale);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });

  const months = Array.from({ length: 12 }, (_, month) =>
    new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
      Date.UTC(2026, month, 1),
    ),
  );

  const series = sampleSeries(`${screenKey}:trend`, 12);
  const trend = series.map((value, index) => ({
    label: months[index]!,
    value,
    display: money(value * 100_000),
  }));
  const peak = Math.max(...series);
  const scale = [1, 0.75, 0.5, 0.25, 0].map((step) => compact.format(peak * step * 100_000));

  const inflow = sampleSeries(`${screenKey}:inflow`, 12);
  const outflow = sampleSeries(`${screenKey}:outflow`, 12);
  const bars = months.map((label, index) => ({
    label,
    primary: inflow[index]!,
    secondary: outflow[index]!,
    primaryDisplay: money(inflow[index]! * 100_000),
    secondaryDisplay: money(outflow[index]! * 100_000),
  }));

  const parts = sampleSeries(`${screenKey}:mix`, 5);
  const partsTotal = parts.reduce((sum, value) => sum + value, 0);
  const categories = sampleCategories(`${screenKey}:mix`, 5);
  const slices = parts.map((value, index) => ({
    label: categories[index] ?? '',
    value,
    display: money(value * 100_000),
    share: percent.format(value / partsTotal),
  }));

  const ranked = sampleRanking(screenKey, 5).map((entry) => ({
    ...entry,
    display: money(entry.value),
  }));

  return { trend, scale, bars, slices, ranked, donutTotal: compact.format(partsTotal * 100_000) };
}

async function ListShape({ screenKey, spec, recordHref }: ShapeProps) {
  return (
    <>
      <MetricStrip metrics={spec.metrics} screenKey={screenKey} />
      <SampleTable recordHref={recordHref} screenKey={screenKey} spec={spec} />
    </>
  );
}

async function WorkspaceShape({ screenKey, spec, recordHref }: ShapeProps) {
  const screen = await getTranslations('screen');
  return (
    <>
      <MetricStrip metrics={spec.metrics} screenKey={screenKey} />
      <div className={styles.splitDetail}>
        <SampleTable compact recordHref={recordHref} screenKey={screenKey} spec={spec} />
        <Panel icon={ClipboardCheck} title={screen('details')}>
          <Breakdown screenKey={`${screenKey}:side`} />
        </Panel>
      </div>
    </>
  );
}

/**
 * A report — parameters, figures, a total, and a way down to the entries.
 *
 * The three things that separate a report from a list, and that the first pass
 * here was missing: it is *run* with parameters rather than merely filtered, it
 * foots to a total the reader does not have to add up, and every figure leads
 * back to the rows behind it.
 */
async function ReportShape({ screenKey, spec, recordHref }: ShapeProps) {
  const [locale, screen, column, shell] = await Promise.all([
    getLocale(),
    getTranslations('screen'),
    getTranslations('column'),
    getTranslations('shell'),
  ]);
  const charts = await moduleCharts(screenKey, locale);

  return (
    <>
      <ReportParameters
        actions={
          <PreviewAction
            badge={screen('preview_action')}
            close={shell('close')}
            icon={<Play aria-hidden="true" />}
            label={screen('run_report')}
            noticeBody={screen('preview_notice_body')}
            noticeTitle={screen('preview_notice_title')}
            tone="primary"
          />
        }
        fields={[
          { id: 'report-from', label: screen('from_date'), value: '2026-01-01' },
          { id: 'report-to', label: screen('to_date'), value: '2026-12-31' },
          {
            id: 'report-group',
            label: screen('group_by'),
            value: column('branch_code'),
            options: [column('branch_code'), column('department'), column('period')],
          },
          {
            id: 'report-compare',
            label: screen('comparison'),
            value: screen('previous_period'),
            options: [screen('no_comparison'), screen('previous_period'), screen('previous_year')],
          },
        ]}
        label={screen('parameters')}
      />

      <MetricStrip metrics={spec.metrics} screenKey={screenKey} />

      <Panel
        actions={<PeriodPill icon={CalendarDays} label={screen('current_period')} />}
        icon={Landmark}
        title={screen('chart.over_time')}
      >
        <TrendChart
          caption={screen('chart.over_time')}
          periodHeader={column('period')}
          points={charts.trend}
          scale={charts.scale}
          valueHeader={column('amount')}
        />
      </Panel>

      <SampleTable recordHref={recordHref} screenKey={screenKey} spec={spec} withTotals />
      <DrillHint icon={Search} text={screen('drill_hint')} />
    </>
  );
}

/**
 * Configuration, grouped the way a real ERP settings area is.
 *
 * A value that differs from the shipped default is marked. That is the one
 * thing an administrator most often needs from a settings screen — what has
 * been changed here — and it cannot be read off a bare list of values.
 */
async function SettingsShape({ screenKey }: ShapeProps) {
  const screen = await getTranslations('screen');
  const column = await getTranslations('column');
  const list = await getTranslations('list');
  const shell = await getTranslations('shell');
  const groups = [screen('summary'), screen('details'), screen('parameters')];
  const changed = groups.flatMap((_, index) => sampleSettings(screenKey, index)).filter((row) => row.changed);

  return (
    <>
      <div className={styles.settingsSearch}>
        <SearchBox
          label={screen('search_settings')}
          name="setting"
          placeholder={screen('search_settings')}
        />
      </div>
      <div className={styles.settingsGrid}>
      {groups.map((group, groupIndex) => (
        <Panel icon={SlidersHorizontal} key={group} title={group}>
          <dl className={styles.settingList}>
            {sampleSettings(screenKey, groupIndex).map((row) => (
              <div className={styles.settingRow} key={row.id}>
                <dt>
                  {row.setting}
                  {row.changed ? (
                    <small className={styles.settingChanged}>
                      {screen('changed_from_default')}
                    </small>
                  ) : null}
                </dt>
                <dd>
                  <bdi dir="ltr">{row.value}</bdi>
                  {row.changed ? (
                    <small
                      className={styles.settingDefault}
                      title={`${column('default_value')}: ${row.defaultValue}`}
                    >
                      <bdi dir="ltr">{row.defaultValue}</bdi>
                    </small>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      ))}
      </div>

      {/* Shown only when something is unsaved — a save button on an unchanged
          form is furniture people learn to ignore. */}
      {changed.length > 0 ? (
        <SaveBar icon={CircleAlert} note={screen('unsaved_changes')}>
          <PreviewAction
            badge={screen('preview_action')}
            close={shell('close')}
            label={screen('discard_changes')}
            noticeBody={screen('preview_notice_body')}
            noticeTitle={screen('preview_notice_title')}
          />
          <PreviewAction
            badge={screen('preview_action')}
            close={shell('close')}
            icon={<Save aria-hidden="true" />}
            label={screen('save_changes')}
            noticeBody={screen('preview_notice_body')}
            noticeTitle={screen('preview_notice_title')}
            tone="primary"
          />
        </SaveBar>
      ) : null}
    </>
  );
}

async function InboxShape({ screenKey }: ShapeProps) {
  const [locale, screen, status] = await Promise.all([
    getLocale(),
    getTranslations('screen'),
    getTranslations('status'),
  ]);
  // An inbox always reads as documents addressed to me, whatever the module's
  // own row shape is, so it takes the document columns rather than the spec's.
  const rows = sampleEntityRows(screenKey, 'document', 8);

  return (
    <Panel icon={Inbox} title={screen('assigned_to_me')}>
      <ul className={styles.inboxList}>
        {rows.map((row) => (
          <li className={styles.inboxItem} key={String(row.id)}>
            <span className={styles.inboxIcon}>
              <FileText aria-hidden="true" />
            </span>
            <div className={styles.inboxBody}>
              <strong>
                <bdi dir="ltr">{String(row.reference)}</bdi>
              </strong>
              <span>{String(row.description)}</span>
            </div>
            <span className={styles.inboxMeta}>
              <bdi dir="auto">
                {formatBusinessDate(String(row.document_date), locale as Locale)}
              </bdi>
            </span>
            <StatusPill label={status(String(row.status))} status={String(row.status)} />
            <span className={styles.inboxAction}>
              {screen('open_item')}
              <ArrowRight aria-hidden="true" className={ui.directionalIcon} />
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* -------------------------------------------------------------------------
 * Small chart bodies
 * ---------------------------------------------------------------------- */

function Trend({ screenKey }: { readonly screenKey: string }) {
  const series = sampleSeries(screenKey, 12);
  const max = Math.max(...series);
  const min = Math.min(...series);
  const points = series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * 100;
      const y = 100 - ((value - min) / Math.max(max - min, 1)) * 88;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg
      aria-hidden="true"
      className={styles.trend}
      focusable="false"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <polygon className={styles.trendArea} points={`0,100 ${points} 100,100`} />
      <polyline className={styles.trendLine} points={points} />
    </svg>
  );
}

function Breakdown({ screenKey }: { readonly screenKey: string }) {
  const series = sampleSeries(screenKey, 5);
  const total = series.reduce((sum, value) => sum + value, 0);

  return (
    <ul className={styles.breakdown}>
      {series.map((value, index) => (
        <li key={index}>
          <span className={styles.breakdownBar}>
            <span style={{ inlineSize: `${Math.round((value / total) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------
 * The dispatcher
 * ---------------------------------------------------------------------- */

const SHAPES = {
  dashboard: DashboardShape,
  list: ListShape,
  document: ListShape,
  workspace: WorkspaceShape,
  report: ReportShape,
  settings: SettingsShape,
  inbox: InboxShape,
} as const;

export async function ScreenView({ screen }: { readonly screen: ScreenRoute }) {
  const [t, screenLabels] = await Promise.all([getTranslations(), getTranslations('screen')]);
  const { item, section, archetype } = screen;
  const spec = specFor(item.key, section.key);
  // Only a document screen has a record behind each row.
  const recordHref = archetype === 'document' ? screen.route : undefined;
  // Six reconciliation screens are two populations to agree, not a table with
  // a panel beside it; they get their own shape.
  const Shape = MATCHING_SCREENS.has(item.key) ? null : SHAPES[archetype];
  const Icon = ARCHETYPE_ICON[archetype];

  /*
   * Every action opens the preview dialog rather than doing nothing.
   *
   * A button that does not respond to a click is indistinguishable from a
   * broken one, and there are up to four of them on every screen. Answering,
   * and saying in the dialog that nothing was written, is what makes 213
   * preview screens walkable instead of merely viewable.
   */
  const preview = (label: string, icon: ReactNode, tone?: 'primary') => (
    <PreviewAction
      badge={screenLabels('preview_action')}
      close={t('shell.close')}
      icon={icon}
      key={label}
      label={label}
      noticeBody={screenLabels('preview_notice_body')}
      noticeTitle={screenLabels('preview_notice_title')}
      {...(tone ? { tone } : {})}
    />
  );

  const actions =
    archetype === 'report' ? (
      <>
        {preview(screenLabels('print'), <Printer aria-hidden="true" />)}
        {preview(t('action.export'), <Download aria-hidden="true" />)}
        {preview(screenLabels('run_report'), <Play aria-hidden="true" />, 'primary')}
      </>
    ) : archetype === 'settings' ? (
      // Save and discard live in the sticky bar at the foot of the page, which
      // stays with the reader; repeating them in a header that scrolls away
      // just puts two save buttons on screen.
      preview(t('action.export'), <Download aria-hidden="true" />)
    ) : MATCHING_SCREENS.has(item.key) ? (
      <>
        {preview(screenLabels('print'), <Printer aria-hidden="true" />)}
        {preview(t('action.export'), <Download aria-hidden="true" />)}
      </>
    ) : archetype === 'inbox' ? (
      preview(screenLabels('mark_done'), <ClipboardCheck aria-hidden="true" />)
    ) : (
      <>
        {preview(screenLabels('import_records'), <Upload aria-hidden="true" />)}
        {preview(screenLabels('columns'), <Columns3 aria-hidden="true" />)}
        {preview(t('action.export'), <Download aria-hidden="true" />)}
        {preview(screenLabels('new_record'), <Plus aria-hidden="true" />, 'primary')}
      </>
    );

  return (
    <Workspace>
      <PageHeader
        actions={actions}
        subtitle={`${screenLabels(`purpose.${section.key}`)} · ${screenLabels(`about.${archetype}`)}`}
        title={t(`page.${item.key}`)}
      />

      {screen.wired ? null : (
        <PresentationBanner
          badge={screenLabels('preview_badge')}
          note={screenLabels('preview_note')}
        />
      )}

      <ScreenContext withSearch={archetype !== 'settings' && archetype !== 'inbox'} />

      {Shape ? (
        <Shape recordHref={recordHref} screenKey={item.key} spec={spec} />
      ) : (
        <MatchingShape screen={screen} />
      )}

      <p className={styles.footNote}>
        <Icon aria-hidden="true" />
        <span>{screenLabels(`archetype.${archetype}`)}</span>
      </p>
    </Workspace>
  );
}

export { EmptyState };
