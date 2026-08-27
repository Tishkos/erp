import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  Boxes,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  FileText,
  Landmark,
  PackageCheck,
  ReceiptText,
  TrendingDown,
  TrendingUp,
  Users,
  WalletCards,
  Warehouse,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import mainLogo from '../../mainLogo.png';
import styles from './dashboard-workspace.module.css';

export interface DashboardLink {
  readonly key: string;
  readonly label: string;
  readonly href: string;
}

export interface DashboardLabels {
  readonly welcome: string;
  readonly welcomeSubtitle: string;
  readonly quickActions: string;
  readonly noQuickActions: string;
  readonly presentationBadge: string;
  readonly presentationNote: string;
  readonly companyLogoAlt: string;
  readonly currentBranch: string;
  readonly today: string;
  readonly currencyIqd: string;
  readonly sampleData: string;
  readonly totalRevenue: string;
  readonly totalExpenses: string;
  readonly cashPosition: string;
  readonly openInvoices: string;
  readonly pendingApprovals: string;
  readonly vsLastPeriod: string;
  readonly requiresAction: string;
  readonly viewInvoices: string;
  readonly viewApprovals: string;
  readonly revenueOverview: string;
  readonly expensesByCategory: string;
  readonly cashFlow: string;
  readonly thisYear: string;
  readonly thisMonth: string;
  readonly ytdRevenue: string;
  readonly ytdTarget: string;
  readonly achievement: string;
  readonly forecast: string;
  readonly operations: string;
  readonly staffCosts: string;
  readonly transportation: string;
  readonly utilities: string;
  readonly otherExpenses: string;
  readonly cashInflow: string;
  readonly cashOutflow: string;
  readonly netCashFlow: string;
  readonly viewFullReport: string;
  readonly warehouseSnapshot: string;
  readonly recentActivity: string;
  readonly recentActivityHint: string;
  readonly topCustomers: string;
  readonly items: string;
  readonly openWorkspace: string;
  readonly noReachablePages: string;
  readonly viewAllWarehouses: string;
  readonly viewAllActivity: string;
  readonly viewAllCustomers: string;
  readonly mainWarehouse: string;
  readonly mainWarehouseCity: string;
  readonly basraWarehouse: string;
  readonly basraWarehouseCity: string;
  readonly erbilWarehouse: string;
  readonly erbilWarehouseCity: string;
  readonly sampleCustomer1: string;
  readonly sampleCustomer2: string;
  readonly sampleCustomer3: string;
  readonly sampleCustomer4: string;
  readonly sampleCustomer5: string;
  readonly footer: string;
  readonly version: string;
}

export interface DashboardWorkspaceProps {
  readonly locale: string;
  readonly branchCode: string;
  readonly dateLabel: string;
  readonly links: readonly DashboardLink[];
  readonly labels: DashboardLabels;
}

interface MetricDefinition {
  readonly key: 'revenue' | 'expenses' | 'cash' | 'invoices' | 'approvals';
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value: number;
  readonly currency?: boolean;
  readonly secondaryValue?: number;
  readonly trend?: number;
  readonly tone: 'blue' | 'red' | 'green' | 'orange' | 'purple';
  readonly spark?: readonly number[];
  readonly action?: { readonly label: string; readonly link?: DashboardLink };
}

interface SampleWarehouse {
  readonly label: string;
  readonly location: string;
  readonly items: number;
  readonly utilization: number;
  readonly tone: 'green' | 'orange' | 'blue';
}

const REVENUE_SERIES = [18, 30, 49, 45, 79, 91, 96, 72, 79, 84, 96, 112] as const;
const CASH_INFLOW = [74, 58, 88, 57, 68, 59, 80, 72, 75, 77, 71, 86] as const;
const CASH_OUTFLOW = [24, 31, 28, 22, 25, 20, 24, 23, 22, 24, 25, 27] as const;
const CASH_NET = CASH_INFLOW.map((value, index) => value - CASH_OUTFLOW[index]!);

const SPARKLINES = {
  revenue: [28, 45, 53, 37, 46, 32, 42, 47, 39, 54, 58, 67, 72, 64, 83],
  expenses: [25, 36, 72, 61, 40, 52, 38, 47, 29, 48, 55, 52, 63, 59, 84],
  cash: [41, 55, 67, 49, 57, 44, 60, 61, 52, 70, 68, 78, 83, 64, 85],
} as const;

interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

function pointsAttribute(points: readonly ChartPoint[]): string {
  return points.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
}

function chartCoordinates(
  values: readonly number[],
  width: number,
  height: number,
  maximum: number,
  startIndex = 0,
  totalPoints = values.length,
  inlineInset = 0,
): ChartPoint[] {
  const usableWidth = width - inlineInset * 2;
  const usableHeight = height - 16;
  return values.map((value, index) => ({
    x: inlineInset + ((startIndex + index) / Math.max(totalPoints - 1, 1)) * usableWidth,
    y: height - 8 - (value / maximum) * usableHeight,
  }));
}

function centeredChartCoordinates(
  values: readonly number[],
  width: number,
  height: number,
): ChartPoint[] {
  const maximum = Math.max(...values, 1);
  const usableHeight = height - 18;
  return values.map((value, index) => ({
    x: ((index + 0.5) / values.length) * width,
    y: height - 9 - (value / maximum) * usableHeight,
  }));
}

function sparklineCoordinates(values: readonly number[]): ChartPoint[] {
  const width = 140;
  const height = 36;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(maximum - minimum, 1);
  return values.map((value, index) => ({
    x: (index / Math.max(values.length - 1, 1)) * width,
    y: height - 3 - ((value - minimum) / range) * (height - 7),
  }));
}

function Sparkline({ values }: { readonly values: readonly number[] }) {
  const points = sparklineCoordinates(values);
  const line = pointsAttribute(points);
  return (
    <div className={styles.sparkline} aria-hidden="true">
      <svg viewBox="0 0 140 36" preserveAspectRatio="none" focusable="false">
        <polygon className={styles.sparkArea} points={`0,36 ${line} 140,36`} />
        <polyline className={styles.sparkLine} points={line} />
      </svg>
    </div>
  );
}

function matchingLink(links: readonly DashboardLink[], keys: readonly string[]): DashboardLink | undefined {
  return (
    links.find((link) => keys.includes(link.key)) ??
    links.find((link) => keys.some((key) => link.key.includes(key)))
  );
}

function DirectionalLink({ link, children }: { link: DashboardLink; children: ReactNode }) {
  return (
    <Link className={styles.inlineLink} href={link.href}>
      <span>{children}</span>
      <ArrowRight className={styles.directionalIcon} aria-hidden="true" />
    </Link>
  );
}

export function DashboardWorkspace({
  locale,
  branchCode,
  dateLabel,
  links,
  labels,
}: DashboardWorkspaceProps) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const currencyCode = labels.currencyIqd.match(/[A-Z]{3}/)?.[0] ?? labels.currencyIqd;
  const revenuePoints = chartCoordinates(REVENUE_SERIES, 720, 190, 120, 0, 12, 8);
  const revenueActualPoints = revenuePoints.slice(0, 6);
  const revenueForecastPoints = revenuePoints.slice(5);
  const cashNetPoints = centeredChartCoordinates(CASH_NET, 720, 100);
  const months = Array.from({ length: 12 }, (_, month) =>
    new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(
      Date.UTC(2026, month, 1),
    ),
  );

  const invoiceLink = matchingLink(links, ['ar_invoices', 'ap_invoices', 'invoice']);
  const approvalLink = matchingLink(links, ['my_approvals', 'approval']);
  const warehouseLink = matchingLink(links, ['warehouses', 'warehouse']);
  const customerLink = matchingLink(links, ['business_partners', 'customer_ledger', 'customer']);
  const reportLink = matchingLink(links, ['financial_reports', 'executive_reports', 'report']);

  const metrics: readonly MetricDefinition[] = [
    {
      key: 'revenue',
      icon: BarChart3,
      label: labels.totalRevenue,
      value: 1_284_750,
      currency: true,
      trend: 0.186,
      tone: 'blue',
      spark: SPARKLINES.revenue,
    },
    {
      key: 'expenses',
      icon: TrendingDown,
      label: labels.totalExpenses,
      value: 832_410,
      currency: true,
      trend: 0.093,
      tone: 'red',
      spark: SPARKLINES.expenses,
    },
    {
      key: 'cash',
      icon: WalletCards,
      label: labels.cashPosition,
      value: 2_156_890,
      currency: true,
      trend: 0.221,
      tone: 'green',
      spark: SPARKLINES.cash,
    },
    {
      key: 'invoices',
      icon: ReceiptText,
      label: labels.openInvoices,
      value: 24,
      secondaryValue: 1_125_600,
      tone: 'orange',
      action: { label: labels.viewInvoices, ...(invoiceLink ? { link: invoiceLink } : {}) },
    },
    {
      key: 'approvals',
      icon: ClipboardCheck,
      label: labels.pendingApprovals,
      value: 13,
      tone: 'purple',
      action: { label: labels.viewApprovals, ...(approvalLink ? { link: approvalLink } : {}) },
    },
  ];

  const expenses = [
    { label: labels.operations, value: 352_140, share: 42.3, color: '#2f69ee' },
    { label: labels.staffCosts, value: 213_560, share: 25.6, color: '#2899ec' },
    { label: labels.transportation, value: 128_750, share: 15.5, color: '#ff6f72' },
    { label: labels.utilities, value: 74_320, share: 8.9, color: '#53cdb7' },
    { label: labels.otherExpenses, value: 63_640, share: 7.7, color: '#cbd3df' },
  ] as const;

  const warehouses: readonly SampleWarehouse[] = [
    {
      label: labels.mainWarehouse,
      location: labels.mainWarehouseCity,
      items: 1_248,
      utilization: 78,
      tone: 'green',
    },
    {
      label: labels.basraWarehouse,
      location: labels.basraWarehouseCity,
      items: 856,
      utilization: 65,
      tone: 'orange',
    },
    {
      label: labels.erbilWarehouse,
      location: labels.erbilWarehouseCity,
      items: 632,
      utilization: 40,
      tone: 'blue',
    },
  ];

  const customers = [
    { label: labels.sampleCustomer1, amount: 350_000, width: 100 },
    { label: labels.sampleCustomer2, amount: 245_600, width: 70 },
    { label: labels.sampleCustomer3, amount: 189_750, width: 54 },
    { label: labels.sampleCustomer4, amount: 142_300, width: 41 },
    { label: labels.sampleCustomer5, amount: 98_950, width: 28 },
  ] as const;

  const quickLinks = links.filter((link) => link.href !== '/').slice(0, 6);
  const activityLinks = links.filter((link) => link.href !== '/').slice(0, 5);
  const activityIcons = [PackageCheck, FileText, CheckCircle2, CircleDollarSign, Users] as const;

  return (
    <div className={styles.workspace}>
      <section className={styles.hero} aria-labelledby="dashboard-welcome-title">
        <div className={styles.heroCopy}>
          <h1 id="dashboard-welcome-title">{labels.welcome}</h1>
          <p>{labels.welcomeSubtitle}</p>
          <div className={styles.contextRow}>
            <span className={styles.contextPill}>
              <CalendarDays aria-hidden="true" />
              <span className={styles.contextLabel}>{labels.today}</span>
              <bdi dir="auto">{dateLabel}</bdi>
            </span>
            <span className={styles.contextPill}>
              <Building2 aria-hidden="true" />
              <span className={styles.contextLabel}>{labels.currentBranch}</span>
              <bdi dir="ltr">{branchCode || '—'}</bdi>
            </span>
            <details className={styles.quickActions}>
              <summary>
                <Zap aria-hidden="true" />
                <span>{labels.quickActions}</span>
                <ChevronDown aria-hidden="true" />
              </summary>
              <div className={styles.quickMenu}>
                {quickLinks.length > 0 ? (
                  quickLinks.map((link) => (
                    <Link href={link.href} key={link.key}>
                      {link.label}
                    </Link>
                  ))
                ) : (
                  <span>{labels.noQuickActions}</span>
                )}
              </div>
            </details>
          </div>
          <p className={styles.presentationNote} role="note">
            <Landmark aria-hidden="true" />
            <strong>{labels.presentationBadge}</strong>
            <span aria-hidden="true">&middot;</span>
            <span>{labels.presentationNote}</span>
          </p>
        </div>
        <span className={styles.heroShip} aria-hidden="true" />
        <div className={styles.heroBrand}>
          <span className={styles.brandGlow} aria-hidden="true" />
          <Image
            className={styles.heroLogo}
            src={mainLogo}
            alt={labels.companyLogoAlt}
            preload
            sizes="(max-width: 608px) 0px, 150px"
          />
        </div>
      </section>

      <section className={styles.metricsGrid} aria-label={labels.sampleData}>
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <article className={`${styles.metricCard} ${styles[metric.tone]!}`} key={metric.key}>
              <div className={styles.metricContent}>
                <span className={styles.metricIcon}>
                  <Icon aria-hidden="true" />
                </span>
                <div className={styles.metricBody}>
                  <h2>{metric.label}</h2>
                  <p className={styles.metricValue}>
                    <strong>
                      <bdi dir="ltr">{number.format(metric.value)}</bdi>
                    </strong>
                    {metric.currency ? (
                      <bdi dir="ltr" title={labels.currencyIqd}>{currencyCode}</bdi>
                    ) : null}
                  </p>
                  {metric.trend !== undefined ? (
                    <p className={styles.metricTrend}>
                      <TrendingUp aria-hidden="true" />
                      <bdi dir="ltr">{percent.format(metric.trend)}</bdi>
                      <span>{labels.vsLastPeriod}</span>
                    </p>
                  ) : metric.secondaryValue !== undefined ? (
                    <p className={styles.metricSecondary}>
                      <bdi dir="ltr">
                        {number.format(metric.secondaryValue)} {currencyCode}
                      </bdi>
                    </p>
                  ) : (
                    <p className={styles.metricSecondary}>{labels.requiresAction}</p>
                  )}
                </div>
              </div>
              {metric.spark ? (
                <Sparkline values={metric.spark} />
              ) : metric.action?.link ? (
                <DirectionalLink link={metric.action.link}>{metric.action.label}</DirectionalLink>
              ) : (
                <span className={styles.actionPlaceholder}>{metric.action?.label}</span>
              )}
            </article>
          );
        })}
      </section>

      <section className={styles.analyticsGrid} aria-label={labels.presentationBadge}>
        <article className={`${styles.panel} ${styles.revenuePanel}`}>
          <header className={styles.panelHeader}>
            <div>
              <h2>{labels.revenueOverview}</h2>
            </div>
            <span className={styles.periodPill}>{labels.thisYear}</span>
          </header>
          <p className={styles.chartTotal}>
            <strong>
              <bdi dir="ltr">{number.format(1_284_750)}</bdi>
            </strong>
            <bdi dir="ltr" title={labels.currencyIqd}>{currencyCode}</bdi>
          </p>
          <p className={styles.chartTrend}>
            <TrendingUp aria-hidden="true" />
            <bdi dir="ltr">{percent.format(0.186)}</bdi>
            <span>{labels.vsLastPeriod}</span>
          </p>
          <div
            className={styles.linePlot}
            role="img"
            aria-label={`${labels.revenueOverview}: ${labels.sampleData}`}
          >
            <div className={styles.chartScale} aria-hidden="true">
              <span>1.5M</span>
              <span>1.25M</span>
              <span>1M</span>
              <span>750K</span>
              <span>500K</span>
              <span>250K</span>
              <span>0</span>
            </div>
            <svg
              className={styles.revenueChart}
              viewBox="0 0 720 190"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <defs>
                <linearGradient id="dashboard-revenue-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2260ec" stopOpacity="0.24" />
                  <stop offset="100%" stopColor="#2260ec" stopOpacity="0.015" />
                </linearGradient>
              </defs>
              {[38, 76, 114, 152].map((y) => (
                <line className={styles.chartGridLine} key={y} x1="0" x2="720" y1={y} y2={y} />
              ))}
              <polygon
                className={styles.revenueArea}
                points={`8,190 ${pointsAttribute(revenuePoints)} 712,190`}
              />
              <polyline
                className={styles.revenueLine}
                points={pointsAttribute(revenueActualPoints)}
              />
              <polyline
                className={styles.revenueForecastLine}
                points={pointsAttribute(revenueForecastPoints)}
              />
              {revenueActualPoints.map((point, index) => (
                <circle
                  className={styles.revenuePoint}
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r="3.2"
                />
              ))}
            </svg>
            <div className={styles.monthAxis} aria-hidden="true">
              {months.map((month) => (
                <span key={month}>{month}</span>
              ))}
            </div>
          </div>
          <ul className={styles.srOnly}>
            {REVENUE_SERIES.map((value, index) => (
              <li key={months[index]}>
                {months[index]}: {number.format(value * 10_000)} {currencyCode}
              </li>
            ))}
          </ul>
          <dl className={styles.summaryStrip}>
            <div>
              <dt>{labels.ytdRevenue}</dt>
              <dd>
                <bdi dir="ltr">{number.format(6_842_320)} {currencyCode}</bdi>
              </dd>
            </div>
            <div>
              <dt>{labels.ytdTarget}</dt>
              <dd>
                <bdi dir="ltr">{number.format(7_200_000)} {currencyCode}</bdi>
              </dd>
            </div>
            <div>
              <dt>{labels.achievement}</dt>
              <dd>
                <bdi dir="ltr">{decimal.format(95)}%</bdi>
              </dd>
            </div>
            <div>
              <dt>{labels.forecast}</dt>
              <dd>
                <bdi dir="ltr">{number.format(7_650_000)} {currencyCode}</bdi>
              </dd>
            </div>
          </dl>
        </article>

        <article className={`${styles.panel} ${styles.expensePanel}`}>
          <header className={styles.panelHeader}>
            <div>
              <h2>{labels.expensesByCategory}</h2>
            </div>
            <span className={styles.periodPill}>{labels.thisMonth}</span>
          </header>
          <div className={styles.donutLayout}>
            <div
              className={styles.donut}
              role="img"
              aria-label={`${labels.expensesByCategory}: ${labels.sampleData}`}
            >
              <div>
                <strong>
                  <bdi dir="ltr">{number.format(832_410)}</bdi>
                </strong>
                <bdi dir="ltr" title={labels.currencyIqd}>{currencyCode}</bdi>
              </div>
            </div>
            <ul className={styles.legend}>
              {expenses.map((expense) => (
                <li key={expense.label}>
                  <span style={{ backgroundColor: expense.color }} aria-hidden="true" />
                  <p>
                    <strong>{expense.label}</strong>
                    <small>
                      <bdi dir="ltr">
                        {number.format(expense.value)} ({decimal.format(expense.share)}%)
                      </bdi>
                    </small>
                  </p>
                </li>
              ))}
            </ul>
          </div>
          {reportLink ? (
            <DirectionalLink link={reportLink}>{labels.viewFullReport}</DirectionalLink>
          ) : null}
        </article>

        <article className={`${styles.panel} ${styles.cashPanel}`}>
          <header className={styles.panelHeader}>
            <div>
              <h2>{labels.cashFlow}</h2>
            </div>
            <span className={styles.periodPill}>{labels.thisYear}</span>
          </header>
          <dl className={styles.cashSummary}>
            <div>
              <dt>{labels.cashInflow}</dt>
              <dd className={styles.positive}>
                <bdi dir="ltr">{number.format(3_854_250)} {currencyCode}</bdi>
              </dd>
            </div>
            <div>
              <dt>{labels.cashOutflow}</dt>
              <dd className={styles.negative}>
                <bdi dir="ltr">{number.format(1_697_360)} {currencyCode}</bdi>
              </dd>
            </div>
            <div>
              <dt>{labels.netCashFlow}</dt>
              <dd className={styles.primaryValue}>
                <bdi dir="ltr">{number.format(2_156_890)} {currencyCode}</bdi>
              </dd>
            </div>
          </dl>
          <ul className={styles.cashLegend} aria-label={labels.cashFlow}>
            <li>
              <span className={styles.inflowSwatch} aria-hidden="true" />
              {labels.cashInflow}
            </li>
            <li>
              <span className={styles.outflowSwatch} aria-hidden="true" />
              {labels.cashOutflow}
            </li>
            <li>
              <span className={styles.netSwatch} aria-hidden="true" />
              {labels.netCashFlow}
            </li>
          </ul>
          <div
            className={styles.cashPlot}
            role="img"
            aria-label={`${labels.cashFlow}: ${labels.sampleData}`}
          >
            <svg
              className={styles.cashNetChart}
              viewBox="0 0 720 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <polyline className={styles.cashNetLine} points={pointsAttribute(cashNetPoints)} />
              {cashNetPoints.map((point, index) => (
                <circle
                  className={styles.cashNetPoint}
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r="2.7"
                />
              ))}
            </svg>
            {months.map((month, index) => (
              <div className={styles.cashMonth} key={month}>
                <span className={styles.cashBars} aria-hidden="true">
                  <span
                    className={styles.inflowBar}
                    style={{ blockSize: `${CASH_INFLOW[index]}%` }}
                  />
                  <span
                    className={styles.outflowBar}
                    style={{ blockSize: `${CASH_OUTFLOW[index]}%` }}
                  />
                </span>
                <span>{month}</span>
              </div>
            ))}
          </div>
          <ul className={styles.srOnly}>
            {months.map((month, index) => (
              <li key={month}>
                {month}: {labels.cashInflow} {CASH_INFLOW[index]}, {labels.cashOutflow}{' '}
                {CASH_OUTFLOW[index]}, {labels.netCashFlow} {CASH_NET[index]}
              </li>
            ))}
          </ul>
          {reportLink ? (
            <DirectionalLink link={reportLink}>{labels.viewFullReport}</DirectionalLink>
          ) : null}
        </article>
      </section>

      <section className={styles.operationalGrid} aria-label={labels.sampleData}>
        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div className={styles.headingWithIcon}>
              <Warehouse aria-hidden="true" />
              <h2>{labels.warehouseSnapshot}</h2>
            </div>
          </header>
          <ul className={styles.warehouseList}>
            {warehouses.map((warehouse, index) => {
              const warehouseNameId = `dashboard-warehouse-${index}-name`;
              const warehouseUtilizationId = `dashboard-warehouse-${index}-utilization`;
              return (
                <li key={warehouse.label}>
                  <span className={styles.listIcon}>
                    <Boxes aria-hidden="true" />
                  </span>
                  <div className={styles.warehouseName}>
                    <strong id={warehouseNameId}>{warehouse.label}</strong>
                    <span>{warehouse.location}</span>
                  </div>
                  <div className={styles.itemCount}>
                    <strong>
                      <bdi dir="ltr">{number.format(warehouse.items)}</bdi>
                    </strong>
                    <span>{labels.items}</span>
                  </div>
                  <div className={styles.utilization}>
                    <strong id={warehouseUtilizationId}>
                      <bdi dir="ltr">{number.format(warehouse.utilization)}%</bdi>
                    </strong>
                    <progress
                      className={styles[`${warehouse.tone}Progress`]!}
                      value={warehouse.utilization}
                      max={100}
                      aria-labelledby={`${warehouseNameId} ${warehouseUtilizationId}`}
                    >
                      {warehouse.utilization}%
                    </progress>
                  </div>
                </li>
              );
            })}
          </ul>
          {warehouseLink ? (
            <DirectionalLink link={warehouseLink}>{labels.viewAllWarehouses}</DirectionalLink>
          ) : null}
        </article>

        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div className={styles.headingWithIcon}>
              <Zap aria-hidden="true" />
              <div>
                <h2>{labels.recentActivity}</h2>
                <p className={styles.srOnly}>{labels.recentActivityHint}</p>
              </div>
            </div>
          </header>
          {activityLinks.length > 0 ? (
            <ul className={styles.activityList}>
              {activityLinks.map((link, index) => {
                const Icon = activityIcons[index % activityIcons.length]!;
                return (
                  <li key={link.key}>
                    <span className={styles.activityIcon}>
                      <Icon aria-hidden="true" />
                    </span>
                    <Link href={link.href}>
                      <strong>{link.label}</strong>
                      <span>{labels.openWorkspace}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={styles.emptyState}>{labels.noReachablePages}</p>
          )}
          {activityLinks[0] ? (
            <DirectionalLink link={activityLinks[0]}>{labels.viewAllActivity}</DirectionalLink>
          ) : null}
        </article>

        <article className={styles.panel}>
          <header className={styles.panelHeader}>
            <div className={styles.headingWithIcon}>
              <Users aria-hidden="true" />
              <h2>{labels.topCustomers}</h2>
            </div>
            <span className={styles.periodPill}>{labels.thisMonth}</span>
          </header>
          <ol className={styles.customerList}>
            {customers.map((customer, index) => (
              <li key={customer.label}>
                <span className={styles.customerRank}>
                  <bdi dir="ltr">{number.format(index + 1)}</bdi>
                </span>
                <span className={styles.customerName}>{customer.label}</span>
                <span className={styles.customerBar} aria-hidden="true">
                  <span style={{ inlineSize: `${customer.width}%` }} />
                </span>
                <strong>
                  <bdi dir="ltr">
                    {number.format(customer.amount)} {currencyCode}
                  </bdi>
                </strong>
              </li>
            ))}
          </ol>
          {customerLink ? (
            <DirectionalLink link={customerLink}>{labels.viewAllCustomers}</DirectionalLink>
          ) : null}
        </article>
      </section>

      <footer className={styles.footer}>
        <span>{labels.footer}</span>
        <bdi dir="ltr">{labels.version}</bdi>
      </footer>
    </div>
  );
}
