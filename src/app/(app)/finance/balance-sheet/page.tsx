import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import { StatementTable } from '@/components/admin/statement-table';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import { BALANCE_SHEET_LEVELS, balanceSheetRows } from '@/server/reports/finance-rows';
import * as statements from '@/server/services/financial-statements';

/**
 * The Balance Sheet — the Statement of Financial Position, Phase 1
 * requirement 5, on a page of its own (by direction, 2026-08-29; named as the
 * sponsor names it, 2026-08-31).
 *
 * As at one date, counting everything posted up to it. Under Equity sits the
 * accumulated result — every profit or loss no year-end close has yet moved
 * into retained earnings — and at the deepest level the revenue and expense
 * accounts that make it up, so the reader can see where the revenue went.
 */
export const dynamic = 'force-dynamic';

/** Section, line, account. */
const LEVELS = BALANCE_SHEET_LEVELS;

export default async function BalanceSheetPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/balance-sheet')) notFound();

  const [t, page, chart, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('chart'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('balance_sheet')} />;
  }

  const today = new Date().toISOString().slice(0, 10);
  const asAt = typeof params.to === 'string' ? params.to : today;
  const currency = currencyFrom(params.currency);
  const level = levelFrom(params.level, LEVELS);

  const sfp = await withCurrentUser((tx) =>
    statements.financialPosition(tx, asAt, { currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="balance_sheet" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/balance-sheet" />}
      subtitle={t('reports.balance_sheet_subtitle')}
      title={page('balance_sheet')}
      variant="sap"
    >
      <ReportWindow
        filter={<ReportFilter action="/finance/balance-sheet" asAt={asAt} currency={currency} level={level} maxLevel={LEVELS} />}
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
        title={t('reports.balance_sheet')}
      >
        <StatementTable
          columns={[t('reports.statement_line'), `${t('reports.amount')} \u00b7 ${currency}`]}
          labels={{
            expandAll: chart('expand_all'),
            collapseAll: chart('collapse_all'),
            expand: t('mapping.expand'),
            collapse: t('mapping.collapse'),
            empty: t('reports.nothing_posted'),
          }}
          rows={balanceSheetRows(sfp, level, {
            assets: t('reports.assets'),
            equity: t('reports.equity'),
            liabilities: t('reports.liabilities'),
            resultForThePeriod: t('reports.result_for_the_period'),
          }).map((row) => ({ ...row, cells: [money(row.amount)] }))}
        />
      </ReportWindow>
    </AdminPage>
  );
}
