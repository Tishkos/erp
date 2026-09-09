import Link from 'next/link';
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
import { levelFrom } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statements from '@/server/services/financial-statements';

/**
 * The Statement of Cash Flows — Phase 1 requirement 5, on a page of its own
 * (by direction, 2026-08-31).
 *
 * Cash moved by an amount the Balance Sheet already shows. What this page adds
 * is why, and the why is read from the journals themselves: each entry that
 * touched cash has its cash attributed to the accounts opposite it, and those
 * accounts say whether it was trading, investing or financing.
 *
 * Money in is positive and money out is negative — one convention, stated on
 * the page, rather than brackets a reader has to decode. The foot shows the
 * opening and closing cash and whether the three sections bridge them, because
 * a cash flow statement that does not bridge is not a cash flow statement.
 */
export const dynamic = 'force-dynamic';

/** Section, statement line, account. */
const LEVELS = 3;

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
  const level = levelFrom(params.level, LEVELS);

  const flow = await withCurrentUser((tx) =>
    statements.cashFlow(tx, { from, to, currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
  const moved = flow.sections.some((section) => section.lines.length > 0);

  return (
    <AdminPage
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
            level={level}
            maxLevel={LEVELS}
            to={to}
          />
        }
        foot={
          <>
            <div className={s.sapFootActions}>
              {flow.reconciles ? (
                <span className={s.sapBalanced}>{t('reports.cash_reconciles')}</span>
              ) : (
                <span className={s.sapWarn}>{t('reports.cash_does_not_reconcile')}</span>
              )}
              <span className={s.sapNote}>{t('reports.inflow_hint')}</span>
            </div>
            <div className={s.sapFootTotals}>
              <div className={s.sapFootTotal}>
                <span>{t('reports.net_movement')}</span>
                <strong>
                  <bdi dir="ltr">{money(flow.netMovement)}</bdi>
                </strong>
              </div>
              <div className={s.sapFootTotal}>
                <span>{t('reports.closing_cash')}</span>
                <strong>
                  <bdi dir="ltr">{money(flow.closingCash)}</bdi>
                </strong>
              </div>
            </div>
          </>
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
              rows={[
                {
                  key: 'opening',
                  label: t('reports.opening_cash'),
                  depth: 0,
                  tone: 'subtotal' as const,
                  cells: [money(flow.openingCash)],
                },
                ...flow.sections.flatMap((section) => [
                  {
                    key: `section:${section.category}`,
                    label: t(`reports.cash_${section.category}`),
                    depth: 0,
                    tone: 'header' as const,
                    cells: [money(section.total)],
                  },
                  ...(level >= 2
                    ? section.lines.flatMap((entry) => [
                        {
                          key: `line:${section.category}:${entry.line.code}`,
                          label: entry.line.name,
                          depth: entry.depth + 1,
                          tone: entry.line.isHeader ? ('header' as const) : ('line' as const),
                          cells: [money(entry.amount)],
                        },
                        ...(level >= 3
                          ? entry.accounts.map((account) => ({
                              key: `account:${section.category}:${entry.line.code}:${account.accountCode}`,
                              label: `${account.accountCode} \u00b7 ${account.accountName}`,
                              depth: entry.depth + 2,
                              tone: 'account' as const,
                              cells: [money(account.amount)],
                            }))
                          : []),
                      ])
                    : []),
                ]),
                {
                  key: 'closing',
                  label: t('reports.closing_cash'),
                  depth: 0,
                  tone: 'subtotal' as const,
                  cells: [money(flow.closingCash)],
                  rule: 'double' as const,
                },
              ]}
            />
      </ReportWindow>
    </AdminPage>
  );
}

/**
 * One activity — its heading with what the activity came to, then, unfolded to
 * the chosen level, the lines and the accounts behind them.
 */
