import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Chart } from '@/components/admin/charts';
import { BandTable, NUMERIC_CELL } from '@/components/admin/dashboard-band';
import { AreaTrend, type AreaTrendPoint } from '@/components/charts/area-trend';
import { directionOf, formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { businessToday } from '@/server/domain/business-date';
import { chartNumber, daysInMonth, moneyOf, moneyString, monthWindows } from '@/server/domain/dashboard-charts';

/**
 * An account's balance over time, as a smooth area in the accent — the G/L
 * account, its ledger, a bank or cash account.
 *
 * Drawn from the very ledger lines the page already read (posting date,
 * debit, credit; debit is positive, as the page's own balance is), added up
 * as scaled bigints in posting order. Two ways to read them:
 *
 *   months  the balance at the end of each of the last N months, every line
 *           before the first month carried in as its opening — so the last
 *           point is the balance today, the figure the page states;
 *   days    the running balance at the end of each posting day of the
 *           window, starting from nought on its first day — exactly the
 *           running balance the ledger's own register shows beside each line.
 *
 * With no line at all, nothing is drawn. The table under the card says every
 * point again in words.
 */

export interface LedgerLine {
  /** `YYYY-MM-DD`. */
  readonly postingDate: string;
  /** Decimal strings. */
  readonly debit: string;
  readonly credit: string;
}

const monthShort = (month: string, locale: Locale) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString(locale, { month: 'short', timeZone: 'UTC' });
const monthLong = (month: string, locale: Locale) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayShort = (date: string, locale: Locale) =>
  new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

interface Step {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly balance: bigint;
  /** For `days`: the day as an instant, so the time axis is to scale. */
  readonly at?: number;
}

const instantOf = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

export async function BalanceTrend({
  lines,
  asOf,
  currency = 'IQD',
  mode = 'months',
  months = 12,
  from,
  title,
  hint,
  inDinars = false,
  action,
  className,
}: {
  /** In posting order, as the ledger reads them. */
  readonly lines: readonly LedgerLine[];
  /** The business date the months run up to. */
  readonly asOf: string;
  readonly currency?: string;
  readonly mode?: 'months' | 'days';
  readonly months?: number;
  /** For `days`: the window's first day, where the running balance starts at nought. */
  readonly from?: string | undefined;
  readonly title?: string | undefined;
  /** Replaces the sentence that says how the points are read. */
  readonly hint?: string | undefined;
  /** The account is kept in another currency: say that these month-ends are its dinars, as the ledger holds them. */
  readonly inDinars?: boolean;
  readonly action?: ReactNode;
  readonly className?: string | undefined;
}) {
  if (lines.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const lang = locale as Locale;
  const sorted = [...lines].sort((a, b) => (a.postingDate < b.postingDate ? -1 : a.postingDate > b.postingDate ? 1 : 0));
  const net = (line: LedgerLine) => moneyOf(line.debit) - moneyOf(line.credit);

  const steps: Step[] = [];
  if (mode === 'months') {
    const windows = monthWindows(asOf, months);
    const lastDay = Number(asOf.slice(8, 10)) >= daysInMonth(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)));
    let at = 0;
    let running = 0n;
    for (const window of windows) {
      while (at < sorted.length && sorted[at]!.postingDate <= window.to) {
        running += net(sorted[at]!);
        at += 1;
      }
      const name = monthLong(window.month, lang);
      steps.push({
        key: window.month,
        label: monthShort(window.month, lang),
        title: window.to === asOf && !lastDay ? t('home.chart.so_far', { month: name }) : name,
        balance: running,
      });
    }
  } else {
    // The window opens at nought, as the register's running balance does.
    const start = from ?? sorted[0]!.postingDate;
    steps.push({ key: `open-${start}`, label: dayShort(start, lang), title: formatBusinessDate(start, lang), balance: 0n, at: instantOf(start) });
    let running = 0n;
    for (let at = 0; at < sorted.length; at += 1) {
      running += net(sorted[at]!);
      const date = sorted[at]!.postingDate;
      if (sorted[at + 1]?.postingDate === date) continue; // the day's last line closes it
      steps.push({ key: date, label: dayShort(date, lang), title: formatBusinessDate(date, lang), balance: running, at: instantOf(date) });
    }
    // Nothing posted since the last line: the balance has stood where it is until today (or the window's end).
    const today = businessToday();
    const end = asOf < today ? asOf : today;
    const lastDate = sorted[sorted.length - 1]!.postingDate;
    if (end > lastDate) {
      steps.push({ key: `close-${end}`, label: dayShort(end, lang), title: formatBusinessDate(end, lang), balance: running, at: instantOf(end) });
    }
  }
  if (steps.every((step) => step.balance === 0n)) return null;

  const money = (amount: bigint) => formatMoney(moneyString(amount), currency, lang);
  const points: AreaTrendPoint[] = steps.map((step) => ({
    label: step.label,
    title: step.title,
    values: [chartNumber(moneyString(step.balance))],
    texts: [money(step.balance)],
    at: step.at,
  }));
  const balanceLabel = t('column.balance');
  const said =
    hint ??
    (mode === 'months'
      ? t(inDinars ? 'home.chart.in_dinars' : 'home.chart.balance_months', { count: months })
      : t('home.chart.balance_days', { date: formatBusinessDate(from ?? sorted[0]!.postingDate, lang) }));

  return (
    <Chart
      action={action}
      className={className}
      hint={said}
      table={
        <BandTable headings={[t(mode === 'months' ? 'column.period' : 'column.date'), { label: balanceLabel, numeric: true }]}>
          {/* The nought the window opens at is the chart's starting point, not a balance anybody reported. */}
          {steps.filter((step) => !step.key.startsWith('open-')).map((step) => (
            <tr key={step.key}>
              <td>
                <bdi>{step.title}</bdi>
              </td>
              <td className={NUMERIC_CELL}>
                <bdi dir="ltr">{money(step.balance)}</bdi>
              </td>
            </tr>
          ))}
        </BandTable>
      }
      tableLabel={t('home.table')}
      title={title ?? t('home.chart.balance_title')}
    >
      <AreaTrend
        curve={mode === 'days' ? 'stepAfter' : 'monotone'}
        height={220}
        locale={lang}
        points={points}
        rtl={directionOf(lang) === 'rtl'}
        series={[{ label: balanceLabel, color: 'var(--ui-primary)' }]}
      />
    </Chart>
  );
}
