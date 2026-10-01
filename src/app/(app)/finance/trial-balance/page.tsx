import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom, maxLevel, rollUp } from '@domain/report-levels';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as trialBalance from '@/server/services/trial-balance';

/**
 * The Trial Balance — Phase 1 requirement 4.
 *
 * "Finance can review account activity and produce a Trial Balance for a
 *  selected date or period. Total debits and total credits must remain equal."
 *
 * The equality is not asserted here; it is *reported*. Every journal balances
 * in IQD and the trial balance is a sum of journals, so the totals agree by
 * construction — and if they ever did not, hiding the fact behind an assertion
 * would be the worst possible response.
 *
 * The report unfolds along the chart of accounts: level 1 is the five type
 * roots, and each further level opens the headers beneath until the posting
 * accounts themselves are on the page.
 */
export const dynamic = 'force-dynamic';

export default async function TrialBalancePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/trial-balance')) notFound();

  const [t, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'trial_balance')) {
    return <Denied object={page('trial_balance')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof params.from === 'string' ? params.from : `${year}-01-01`;
  const to = typeof params.to === 'string' ? params.to : `${year}-12-31`;
  const currency = currencyFrom(params.currency);

  const { rows, chart } = await withCurrentUser(async (tx) => ({
    rows: await trialBalance.trialBalance(tx, { from, to, currency, allPermittedBranches: true }),
    chart: await trialBalance.chartRows(tx),
  }));
  const deepest = maxLevel(chart);
  const level = levelFrom(params.level, deepest);
  const shown = rollUp(chart, rows, level);
  const totals = trialBalance.totalsOf(rows);
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="trial_balance" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/trial-balance" />}
      subtitle={t('reports.trial_balance_subtitle')}
      title={t('reports.trial_balance')}
      variant="sap"
    >
      <ReportWindow
        filter={
          <ReportFilter action="/finance/trial-balance" currency={currency} from={from} level={level} maxLevel={deepest} to={to} />
        }
        foot={
          <>
            <div className={s.sapFootActions}>
              {totals.balances ? (
                <span className={s.sapBalanced}>{t('reports.balanced')}</span>
              ) : (
                <span className={s.sapWarn}>{t('reports.out_by', { amount: money(totals.difference) })}</span>
              )}
            </div>
            <div className={s.sapFootTotals}>
              <div className={s.sapFootTotal}>
                <span>{t('journals.total_debit')}</span>
                <strong>
                  <bdi dir="ltr">{money(totals.debit)}</bdi>
                </strong>
              </div>
              <div className={s.sapFootTotal}>
                <span>{t('journals.total_credit')}</span>
                <strong>
                  <bdi dir="ltr">{money(totals.credit)}</bdi>
                </strong>
              </div>
            </div>
          </>
        }
        meta={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
        title={t('reports.trial_balance')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{column('account')}</th>
              <th scope="col">{t('reports.account_name')}</th>
              <th scope="col">{t('reports.account_type')}</th>
              <th className={s.sapNum} scope="col">
                {t('journals.debit')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('journals.credit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {t('reports.nothing_posted')}
                </td>
              </tr>
            ) : (
              shown.map((row) => (
                <tr className={row.isGroup ? s.sapLevelRow : undefined} data-depth={row.depth} key={row.code}>
                  <td style={{ paddingInlineStart: `${0.45 + (row.depth - 1) * 1.1}rem` }}>
                    <bdi dir="ltr">{row.code}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.name}</bdi>
                  </td>
                  <td>{t(`reports.type_${row.accountType}`)}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{Number(row.debit) === 0 ? '' : money(row.debit)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{Number(row.credit) === 0 ? '' : money(row.credit)}</bdi>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td colSpan={3}>{t('reports.totals')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(totals.debit)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(totals.credit)}</bdi>
              </td>
            </tr>
          </tfoot>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
