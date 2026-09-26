import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { StatementTable } from '@/components/admin/statement-table';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import { cashFlowRows } from '@/server/reports/finance-rows';
import * as statements from '@/server/services/financial-statements';

export default async function CashFlowPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/cash-flow')) notFound();

  const [t, page, chart, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('chart'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('cash_flow')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof params.from === 'string' ? params.from : `${year}-01-01`;
  const to = typeof params.to === 'string' ? params.to : `${year}-12-31`;
  const currency = currencyFrom(params.currency);

  const flow = await withCurrentUser((tx) =>
    statements.cashFlow(tx, { from, to, currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="cash_flow" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/cash-flow" />}
      subtitle={t('reports.cash_flow_subtitle')}
      title={page('cash_flow')}
      variant="sap"
    >
      <ReportWindow
        filter={
          <ReportFilter
            action="/finance/cash-flow"
            currency={currency}
            from={from}
            to={to}
          />
        }
        foot={
          <div className={s.sapFootActions}>
            {/* Not the movement and not the closing cash: both are rows of the
                statement already, and by direction (2026-09-09) a figure said
                twice is a figure that can disagree with itself.

                What belongs here is what the statement cannot say about
                itself — whether it agrees with the cash accounts, and whether
                anyone has said which accounts those are. */}
            {!flow.configured ? (
              <span className={s.sapWarn}>{t('reports.cash_not_configured')}</span>
            ) : flow.reconciles ? (
              <span className={s.sapBalanced}>{t('reports.cash_reconciles')}</span>
            ) : (
              <span className={s.sapWarn}>{t('reports.cash_does_not_reconcile')}</span>
            )}
            <span className={s.sapNote}>{t('reports.inflow_hint')}</span>
          </div>
        }
        meta={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
        title={t('reports.cash_flow')}
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
          rows={cashFlowRows(flow).map((row) => ({ ...row, cells: [money(row.amount)] }))}
            />
      </ReportWindow>
    </AdminPage>
  );
}

/**
 * One activity — its heading with what the activity came to, then, unfolded to
 * the chosen level, the lines and the accounts behind them.
 */
