import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { StatementTable } from '@/components/admin/statement-table';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statements from '@/server/services/financial-statements';

/**
 * The Statement of Changes in Equity — Phase 1 requirement 5, on a page of its
 * own (by direction, 2026-08-31).
 *
 * The one question the other three statements do not answer: equity was this
 * at the start of the period and that at the end — what happened in between.
 *
 * Read top to bottom, in the form Mr Issa set out (2026-09-09): what equity
 * was, what was added, what was taken away, what it became. "Add:" and
 * "Subtract:" are headings; the sign comes from the ledger, so income prints
 * plainly and a dividend prints in brackets.
 *
 * The closing line is the Equity section of a Balance Sheet drawn at the same
 * date. That is not a coincidence to be maintained: both are assembled from
 * the same posted lines by the same code.
 */
export const dynamic = 'force-dynamic';

export default async function ChangesInEquityPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/changes-in-equity')) notFound();

  const [t, page, chart, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('chart'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('changes_in_equity')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof params.from === 'string' ? params.from : `${year}-01-01`;
  const to = typeof params.to === 'string' ? params.to : `${year}-12-31`;
  const currency = currencyFrom(params.currency);

  const equity = await withCurrentUser((tx) =>
    statements.changesInEquity(tx, { from, to, currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
  const loss = Number(equity.resultForThePeriod) < 0;

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/changes-in-equity" />}
      subtitle={t('reports.changes_in_equity_subtitle')}
      title={page('changes_in_equity')}
      variant="sap"
    >
      <ReportWindow
        filter={
          <ReportFilter
            action="/finance/changes-in-equity"
            currency={currency}
            from={from}
            to={to}
          />
        }
        foot={
          <div className={s.sapFootTotals}>
            <div className={s.sapFootTotal}>
              <span>{loss ? t('reports.loss') : t('reports.profit')}</span>
              <strong>
                <bdi dir="ltr">{money(equity.resultForThePeriod)}</bdi>
              </strong>
            </div>
            <div className={s.sapFootTotal}>
              <span>{t('reports.total_equity')}</span>
              <strong>
                <bdi dir="ltr">{money(equity.closing)}</bdi>
              </strong>
            </div>
          </div>
        }
        meta={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
        title={t('reports.changes_in_equity')}
      >
        <StatementTable
          columns={[t('reports.statement_line'), `${t('reports.amount')} · ${currency}`]}
          labels={{
            expandAll: chart('expand_all'),
            collapseAll: chart('collapse_all'),
            expand: t('mapping.expand'),
            collapse: t('mapping.collapse'),
            empty: t('reports.nothing_posted'),
          }}
          rows={equity.rows.map((row) => ({
            key: `row:${row.code}`,
            label: row.name,
            depth: row.depth,
            tone: row.kind === 'header' ? ('header' as const) : ('line' as const),
            rule: row.rule,
            cells: [money(row.amount)],
          }))}
        />
      </ReportWindow>
    </AdminPage>
  );
}

/** One equity line, with — at the deeper level — the accounts behind it. */
