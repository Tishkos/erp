import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportWindow } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import { addDays } from '@/server/domain/dates';
import * as forecasts from '@/server/services/cash-forecast';

/**
 * Cash Forecast — REQ-ACC-001 Part D-4, over Phase 07's `cash-forecast.ts`.
 *
 * Where the money stands now (by currency, never summed across them as if it
 * were one), and what is expected to come in and go out from here: supplier
 * invoices by due date, customer invoices by due date, loan instalments
 * (grace rows ask for nothing), loan drawdowns on the bank's expected date,
 * payroll and capital calls — each period opening where the last one closed.
 * Paid documents are gone from it; the engine says which sources it could
 * not read yet rather than reporting nought. Drawn as the Trial Balance is.
 */
export const dynamic = 'force-dynamic';

export default async function CashForecastPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/cash-forecast')) notFound();

  const [t, admin, page, locale, context, params] = await Promise.all([
    getTranslations('admin.cash_forecast'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', forecasts.PERMISSION_OBJECT)) {
    return <Denied object={page('cash_forecast')} />;
  }

  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const today = businessToday();
  const from = one('from') || today;
  const to = one('to') || addDays(from, 90);
  const bucket = (forecasts.FORECAST_BUCKETS as readonly string[]).includes(one('bucket'))
    ? (one('bucket') as forecasts.ForecastBucket)
    : 'week';

  const { forecast, position } = await withCurrentUser(async (tx, request) => {
    const actor = { principal: request.principal, branchCode: request.scope.branchCode };
    return {
      forecast: await forecasts.forecast(tx, actor, { from, to, bucket }),
      position: await forecasts.dailyPosition(tx, actor, addDays(from, -1)),
    };
  });
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const sourceName = (source: string) => t(`source_${source}`);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="cash_forecast" query={params} />}
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/treasury/cash-forecast" />}
      subtitle={t('subtitle')}
      title={page('cash_forecast')}
      variant="sap"
    >
      <ReportWindow
        filter={
          <form action="/treasury/cash-forecast" className={s.sapFilterBar} method="get">
            <label className={s.sapFilterField}>
              <span className={s.sapLabel}>{admin('reports.from')}</span>
              <input defaultValue={from} name="from" required type="date" />
            </label>
            <label className={s.sapFilterField}>
              <span className={s.sapLabel}>{admin('reports.to')}</span>
              <input defaultValue={to} name="to" required type="date" />
            </label>
            <label className={s.sapFilterField}>
              <span className={s.sapLabel}>{t('bucket')}</span>
              <select defaultValue={bucket} name="bucket">
                {forecasts.FORECAST_BUCKETS.map((key) => (
                  <option key={key} value={key}>
                    {t(`bucket_${key}`)}
                  </option>
                ))}
              </select>
            </label>
            <button className={`${s.button} ${s.primary}`} type="submit">
              {admin('reports.run')}
            </button>
          </form>
        }
        foot={
          <div className={s.sapFootTotals}>
            <div className={s.sapFootTotal}>
              <span>{t('opening')}</span>
              <strong>
                <bdi dir="ltr">{money(forecast.openingIqd)}</bdi>
              </strong>
            </div>
            <div className={s.sapFootTotal}>
              <span>{t('closing')}</span>
              <strong>
                <bdi dir="ltr">{money(forecast.closingIqd)}</bdi>
              </strong>
            </div>
          </div>
        }
        meta={admin('reports.for_the_period', { from: day(from), to: day(to) })}
        title={t('by_period')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('period')}</th>
              <th className={s.sapNum} scope="col">
                {t('opening')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('inflow')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('outflow')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('closing')}
              </th>
            </tr>
          </thead>
          <tbody>
            {forecast.periods.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {t('nothing_expected')}
                </td>
              </tr>
            ) : null}
            {forecast.periods.map((period) => (
              <tr key={period.periodStart}>
                <td>
                  <bdi dir="ltr">{day(period.periodStart)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(period.openingIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(period.inflowIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(period.outflowIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(period.closingIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportWindow>

      <ReportWindow meta={day(position.asOf)} title={t('position_title')}>
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('currency')}</th>
              <th className={s.sapNum} scope="col">
                {t('accounts')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('balance')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('available')}
              </th>
            </tr>
          </thead>
          <tbody>
            {position.byCurrency.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {t('no_accounts')}
                </td>
              </tr>
            ) : null}
            {position.byCurrency.map((row) => (
              <tr key={row.currency}>
                <td>
                  <bdi dir="ltr">{row.currency}</bdi>
                </td>
                <td className={s.sapNum}>{row.accounts}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.balanceIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.availableIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportWindow>

      <ReportWindow title={t('by_source')}>
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('period')}</th>
              <th scope="col">{t('source')}</th>
              <th className={s.sapNum} scope="col">
                {t('inflow')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('outflow')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('net')}
              </th>
            </tr>
          </thead>
          <tbody>
            {forecast.lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {t('nothing_expected')}
                </td>
              </tr>
            ) : null}
            {forecast.lines.map((line) => (
              <tr key={`${line.periodStart}-${line.source}`}>
                <td>
                  <bdi dir="ltr">{day(line.periodStart)}</bdi>
                </td>
                <td>{sourceName(line.source)}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.inflowIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.outflowIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.netIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportWindow>

      {/* What the forecast drew on, and what it could not read yet — so a
          nought is never mistaken for "nothing is due". */}
      <ReportWindow title={t('sources_title')}>
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('source')}</th>
              <th scope="col">{t('included')}</th>
            </tr>
          </thead>
          <tbody>
            {forecast.sources.map((source) => (
              <tr key={source.source}>
                <td>{sourceName(source.source)}</td>
                <td>
                  <span
                    className={`status status--${source.available ? 'settled' : 'draft'}`}
                    data-status={source.available ? 'settled' : 'draft'}
                  >
                    {source.available ? t('source_in') : t('source_not_yet')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
