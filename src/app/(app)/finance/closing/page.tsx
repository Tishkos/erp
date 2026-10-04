import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Hidden, Select, Submit, admin as s } from '@/components/admin';
import { ReportWindow } from '@/components/admin/report-filter';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as periods from '@/server/services/periods';
import { closePeriodAction } from './actions';

/**
 * Period / Year-End Closing — REQ-ACC-001 Part D-6.
 *
 * One period at a time: its checklist (the same `periods.closeReport` the
 * Accounting Periods screen and the nightly job read — sub-ledgers against
 * the G/L, unposted journals, the stock ledger, the banks reconciled, the
 * rate, the clearing accounts, payroll, recognition), the close itself
 * through `periods.setPeriodStatus` (which asks the checklist again and
 * refuses on a blocking failure), soft close and its controlled reopening,
 * and the history of every close. The year is closed by closing its months
 * in order; the lock is Accounting Periods' — there is no second one here.
 *
 * Decided by default (owner to confirm, REQ-ACC-001): no retained-earnings
 * roll. Moving the year's profit into retained earnings by journal would
 * change the four protected statements; they already carry the year's result
 * to equity as they are.
 */
export const dynamic = 'force-dynamic';

export default async function ClosingPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/closing')) notFound();

  const [t, p, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.closing'),
    getTranslations('admin.periods'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', periods.PERMISSION_OBJECT)) {
    return <Denied object={page('year_end_close')} />;
  }
  const mayClose = can(principal, 'configure', periods.PERMISSION_OBJECT);

  const params = await searchParams;
  const asked = typeof params.period === 'string' ? params.period : '';
  const { calendar, report, history } = await withCurrentUser(async (tx, request) => {
    const calendar = await periods.calendar(tx);
    const today = businessToday();
    // The one asked for, else the next to close — the earliest not yet closed.
    const chosen =
      calendar.find((period) => period.id === asked) ??
      calendar.find((period) => period.status !== 'closed') ??
      calendar.find((period) => period.startsOn <= today && today <= period.endsOn) ??
      calendar[calendar.length - 1];
    return {
      calendar,
      report: chosen ? await periods.closeReport(tx, chosen.id) : null,
      history: await periods.closeHistory(tx, { principal: request.principal, branchCode: request.scope.branchCode }),
    };
  });
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const stateChip = (status: string) => (status === 'open' ? 'posted' : status === 'closed' ? 'closed' : 'submitted');
  const checkChip = (state: string) => (state === 'pass' ? 'settled' : state === 'fail' ? 'rejected' : 'submitted');

  const period = report?.period ?? null;
  const yearPeriods = period ? calendar.filter((row) => row.fiscalYearCode === period.fiscalYearCode) : [];
  const yearClosed = yearPeriods.filter((row) => row.status === 'closed').length;
  const hidden = period ? { period_id: period.id } : {};

  return (
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/finance/closing" />}
      subtitle={t('subtitle')}
      title={page('year_end_close')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      {report && period ? (
        <ReportWindow
          filter={
            <form action="/finance/closing" className={s.sapFilterBar} method="get">
              <label className={s.sapFilterField}>
                <span className={s.sapLabel}>{p('period')}</span>
                <select defaultValue={period.id} name="period">
                  {calendar.map((row) => (
                    <option key={row.id} value={row.id}>
                      {`${row.name} · ${p(`state_${row.status}`)}`}
                    </option>
                  ))}
                </select>
              </label>
              <button className={`${s.button} ${s.primary}`} type="submit">
                {p('run_checks')}
              </button>
            </form>
          }
          foot={
            <>
              <div className={s.sapFootActions}>
                {mayClose && period.status !== 'closed' ? (
                  <form action={closePeriodAction} className={s.inline}>
                    {Object.entries(hidden).map(([name, value]) => (
                      <Hidden key={name} name={name} value={value} />
                    ))}
                    <Select
                      defaultValue={report.mayClose ? 'closed' : 'soft_closed'}
                      label={p('state')}
                      name="status"
                      options={[
                        ...(period.status === 'soft_closed' ? [{ value: 'open', label: t('reopen') }] : []),
                        ...(period.status === 'open' ? [{ value: 'soft_closed', label: t('soft_close') }] : []),
                        { value: 'closed', label: t('close') },
                      ]}
                      required
                    />
                    <Field id="closing-reason" label={admin('reason')} name="reason" required />
                    <Submit label={t('apply')} />
                  </form>
                ) : null}
                {report.mayClose ? (
                  <span className={s.sapBalanced}>{p('close_checks_pass', { period: period.name, asOf: day(report.asOf) })}</span>
                ) : (
                  <span className={s.sapWarn}>{p('close_checks_fail', { period: period.name, count: report.blockingFailures.length })}</span>
                )}
              </div>
              <div className={s.sapFootTotals}>
                <div className={s.sapFootTotal}>
                  <span>{t('period_state')}</span>
                  <strong>
                    <span className={`status status--${stateChip(period.status)}`} data-status={stateChip(period.status)}>
                      {p(`state_${period.status}`)}
                    </span>
                  </strong>
                </div>
                <div className={s.sapFootTotal}>
                  <span>{t('year_progress', { year: period.fiscalYearCode })}</span>
                  <strong>
                    <bdi dir="ltr">{`${yearClosed} / ${yearPeriods.length}`}</bdi>
                  </strong>
                </div>
              </div>
            </>
          }
          meta={`${day(period.startsOn)} – ${day(period.endsOn)}`}
          title={t('checklist', { period: period.name })}
        >
          <table className={`${s.sapTable} ${s.sapReportTable}`}>
            <thead>
              <tr>
                <th scope="col">{p('check')}</th>
                <th scope="col">{p('check_severity')}</th>
                <th scope="col">{p('check_figure')}</th>
                <th scope="col">{p('check_detail')}</th>
                <th scope="col">{p('state')}</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((check) => (
                <tr key={check.code}>
                  <td>
                    <Link className={s.sapLink} href={check.route}>
                      {p(`check_${check.code}`)}
                    </Link>
                  </td>
                  <td>{p(`check_severity_${check.severity}`)}</td>
                  <td>
                    <bdi dir="ltr">{check.figure}</bdi>
                  </td>
                  <td>
                    {check.detail.length === 0 ? '—' : null}
                    {check.detail.slice(0, 8).map((line) => (
                      <div key={line}>
                        <bdi dir="auto">{line}</bdi>
                      </div>
                    ))}
                    {check.detail.length > 8 ? <div className="muted">{p('check_more', { count: check.detail.length - 8 })}</div> : null}
                  </td>
                  <td>
                    <span className={`status status--${checkChip(check.state)}`} data-status={checkChip(check.state)}>
                      {p(`check_state_${check.state}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ReportWindow>
      ) : (
        <ReportWindow title={t('no_calendar_title')}>
          <p className={s.sectionHint}>
            {t('no_calendar')}{' '}
            <Link className={s.sapLink} href="/finance/periods">
              {page('soft_close')}
            </Link>
          </p>
        </ReportWindow>
      )}

      <ReportWindow meta={String(history.length)} title={t('history_title')}>
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('when')}</th>
              <th scope="col">{p('period')}</th>
              <th scope="col">{t('change')}</th>
              <th scope="col">{t('who')}</th>
              <th scope="col">{admin('reason')}</th>
              <th scope="col">{t('warnings')}</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={6}>
                  {t('no_history')}
                </td>
              </tr>
            ) : null}
            {history.map((row) => (
              <tr key={row.id}>
                <td>
                  <bdi dir="ltr">{formatTimestamp(new Date(row.occurredAt).toISOString(), locale as Locale)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{`${row.periodName} · ${row.yearCode}`}</bdi>
                </td>
                <td>
                  {row.fromStatus ? p(`state_${row.fromStatus}`) : '—'} → {row.toStatus ? p(`state_${row.toStatus}`) : '—'}
                </td>
                <td>
                  <bdi dir="auto">{row.actorName ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{row.reason ?? '—'}</bdi>
                </td>
                <td>
                  {row.warnings.length === 0
                    ? '—'
                    : row.warnings.map((code) => (
                        <div key={code}>{p.has(`check_${code}`) ? p(`check_${code}`) : code}</div>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
