import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Pill, admin as s } from '@/components/admin';
import { ReportFilter, currencyFrom } from '@/components/admin/report-filter';
import { StatementLine, StatementRows } from '@/components/admin/statement-rows';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statements from '@/server/services/financial-statements';

/**
 * The Statement of Financial Position — Phase 1 requirement 5, on a page of
 * its own (by direction, 2026-08-29).
 *
 * As at one date, counting everything posted up to it. Under Equity sits the
 * accumulated result — every profit or loss no year-end close has yet moved
 * into retained earnings — and at the deepest level the revenue and expense
 * accounts that make it up, so the reader can see where the revenue went.
 */
export const dynamic = 'force-dynamic';

/** Section, line, account. */
const LEVELS = 3;

export default async function FinancialPositionPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/financial-position')) notFound();

  const [t, page, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('financial_position')} />;
  }

  const today = new Date().toISOString().slice(0, 10);
  const asAt = typeof params.to === 'string' ? params.to : today;
  const currency = currencyFrom(params.currency);
  const level = levelFrom(params.level, LEVELS);

  const sfp = await withCurrentUser((tx) =>
    statements.financialPosition(tx, asAt, { currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/financial-position" />}
      subtitle={t('reports.financial_position_subtitle')}
      title={t('reports.financial_position')}
      variant="sap"
    >
      <ReportFilter
        action="/finance/financial-position"
        asAt={asAt}
        currency={currency}
        level={level}
        maxLevel={LEVELS}
      />

      <Panel flush title={t('reports.financial_position')}>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('reports.as_at', { date: formatBusinessDate(asAt, locale as Locale) })}</th>
                <th className="numeric" scope="col">
                  {t('reports.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th className={s.statementSection} scope="row">
                  {t('reports.assets')}
                </th>
                <td className={`numeric ${s.totalCell}`}>{money(sfp.totalAssets)}</td>
              </tr>
              <StatementRows level={level} lines={sfp.assets} money={money} />

              <tr>
                <th className={s.statementSection} scope="row">
                  {t('reports.equity')}
                </th>
                <td className={`numeric ${s.totalCell}`}>{money(sfp.totalEquity)}</td>
              </tr>
              <StatementRows level={level} lines={sfp.equity} money={money} />
              {/* The result the revenue and expense accounts come to, which a
                  year-end close has not yet carried into retained earnings. */}
              {level >= 2 ? (
                <StatementLine
                  accounts={level >= 3 ? sfp.resultAccounts : []}
                  amount={money(sfp.resultForThePeriod)}
                  money={money}
                  note={null}
                  title={t('reports.result_for_the_period')}
                />
              ) : null}

              <tr>
                <th className={s.statementSection} scope="row">
                  {t('reports.liabilities')}
                </th>
                <td className={`numeric ${s.totalCell}`}>{money(sfp.totalLiabilities)}</td>
              </tr>
              <StatementRows level={level} lines={sfp.liabilities} money={money} />
            </tbody>
            <tfoot>
              <tr>
                <th className={s.totalCell} scope="row">
                  {t('reports.total_assets')}
                </th>
                <td className={`numeric ${s.totalCell}`}>{money(sfp.totalAssets)}</td>
              </tr>
              <tr>
                <th className={s.totalCell} scope="row">
                  {t('reports.total_equity_and_liabilities')}
                </th>
                <td className={`numeric ${s.totalCell}`}>{money(sfp.totalEquityAndLiabilities)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style={{ padding: '1rem 1.5rem' }}>
          <Pill
            label={sfp.balances ? t('reports.sides_agree') : t('reports.does_not_balance')}
            on={sfp.balances}
          />
        </div>
      </Panel>
    </AdminPage>
  );
}
