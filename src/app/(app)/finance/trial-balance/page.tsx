import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Pill, admin as s } from '@/components/admin';
import { ReportFilter, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom, maxLevel, rollUp } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
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
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/trial-balance" />}
      subtitle={t('reports.trial_balance_subtitle')}
      title={t('reports.trial_balance')}
      variant="sap"
    >
      <ReportFilter
        action="/finance/trial-balance"
        currency={currency}
        from={from}
        level={level}
        maxLevel={deepest}
        to={to}
      />

      <Panel
        flush
        title={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
      >
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('account')}</th>
                <th scope="col">{t('reports.account_name')}</th>
                <th scope="col">{t('reports.account_type')}</th>
                <th className="numeric" scope="col">
                  {t('journals.debit')}
                </th>
                <th className="numeric" scope="col">
                  {t('journals.credit')}
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td className="muted" colSpan={5}>
                    {t('reports.nothing_posted')}
                  </td>
                </tr>
              ) : (
                shown.map((row) => (
                  <tr
                    className={row.isGroup ? s.levelHeader : undefined}
                    data-depth={row.depth}
                    key={row.code}
                  >
                    <td className={s.mono} style={{ paddingInlineStart: `${0.75 + (row.depth - 1) * 1.1}rem` }}>
                      {row.code}
                    </td>
                    <td>{row.name}</td>
                    <td>{t(`reports.type_${row.accountType}`)}</td>
                    <td className="numeric">{Number(row.debit) === 0 ? '' : money(row.debit)}</td>
                    <td className="numeric">{Number(row.credit) === 0 ? '' : money(row.credit)}</td>
                  </tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr>
                <td className={s.totalCell} colSpan={3}>
                  {t('reports.totals')}{' '}
                  <Pill
                    label={
                      totals.balances
                        ? t('reports.balanced')
                        : t('reports.out_by', { amount: money(totals.difference) })
                    }
                    on={totals.balances}
                  />
                </td>
                <td className={`numeric ${s.totalCell}`}>{money(totals.debit)}</td>
                <td className={`numeric ${s.totalCell}`}>{money(totals.credit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
