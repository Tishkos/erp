import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import { StatementSection } from '@/components/admin/statement-rows';
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
 * The Financial Statement — the Statement of Financial Position, Phase 1
 * requirement 5, on a page of its own (by direction, 2026-08-29).
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
      title={page('financial_position')}
      variant="sap"
    >
      <ReportWindow
        filter={<ReportFilter action="/finance/financial-position" asAt={asAt} currency={currency} level={level} maxLevel={LEVELS} />}
        foot={
          <>
            <div className={s.sapFootActions}>
              {sfp.balances ? (
                <span className={s.sapBalanced}>{t('reports.sides_agree')}</span>
              ) : (
                <span className={s.sapWarn}>{t('reports.does_not_balance')}</span>
              )}
            </div>
            <div className={s.sapFootTotals}>
              <div className={s.sapFootTotal}>
                <span>{t('reports.total_assets')}</span>
                <strong>
                  <bdi dir="ltr">{money(sfp.totalAssets)}</bdi>
                </strong>
              </div>
              <div className={s.sapFootTotal}>
                <span>{t('reports.total_equity_and_liabilities')}</span>
                <strong>
                  <bdi dir="ltr">{money(sfp.totalEquityAndLiabilities)}</bdi>
                </strong>
              </div>
            </div>
          </>
        }
        meta={t('reports.as_at', { date: formatBusinessDate(asAt, locale as Locale) })}
        title={t('reports.financial_position')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('reports.statement_line')}</th>
              <th className={s.sapNum} scope="col">
                {t('reports.amount')} · {currency}
              </th>
            </tr>
          </thead>
          <tbody>
            <StatementSection level={level} lines={sfp.assets} money={money} title={t('reports.assets')} total={sfp.totalAssets} />
            <StatementSection
              extra={{
                title: t('reports.result_for_the_period'),
                amount: sfp.resultForThePeriod,
                accounts: sfp.resultAccounts,
              }}
              level={level}
              lines={sfp.equity}
              money={money}
              title={t('reports.equity')}
              total={sfp.totalEquity}
            />
            <StatementSection level={level} lines={sfp.liabilities} money={money} title={t('reports.liabilities')} total={sfp.totalLiabilities} />
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td>{t('reports.total_assets')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(sfp.totalAssets)}</bdi>
              </td>
            </tr>
            <tr className={s.sapTotalRow}>
              <td>{t('reports.total_equity_and_liabilities')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(sfp.totalEquityAndLiabilities)}</bdi>
              </td>
            </tr>
          </tfoot>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
