import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, currencyFrom } from '@/components/admin/report-filter';
import { StatementRows } from '@/components/admin/statement-rows';
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
 * The Statement of Profit or Loss — Phase 1 requirement 5, on a page of its
 * own (by direction, 2026-08-29).
 *
 * Drawn from the posted journal lines and nothing else, for the period
 * between the two dates. Three levels: the two sections and what they come
 * to, the statement lines, and the accounts behind each line.
 */
export const dynamic = 'force-dynamic';

/** Section, line, account. */
const LEVELS = 3;

export default async function ProfitOrLossPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/profit-or-loss')) notFound();

  const [t, page, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('profit_or_loss')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof params.from === 'string' ? params.from : `${year}-01-01`;
  const to = typeof params.to === 'string' ? params.to : `${year}-12-31`;
  const currency = currencyFrom(params.currency);
  const level = levelFrom(params.level, LEVELS);

  const pl = await withCurrentUser((tx) =>
    statements.profitOrLoss(tx, { from, to, currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);
  const income = pl.lines.filter((line) => !line.line.deduction);
  const expenses = pl.lines.filter((line) => line.line.deduction);

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/profit-or-loss" />}
      subtitle={t('reports.profit_or_loss_subtitle')}
      title={t('reports.profit_or_loss')}
      variant="sap"
    >
      <ReportFilter
        action="/finance/profit-or-loss"
        currency={currency}
        from={from}
        level={level}
        maxLevel={LEVELS}
        to={to}
      />

      <Panel flush title={t('reports.profit_or_loss')}>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">
                  {t('reports.for_the_period', {
                    from: formatBusinessDate(from, locale as Locale),
                    to: formatBusinessDate(to, locale as Locale),
                  })}
                </th>
                <th className="numeric" scope="col">
                  {t('reports.amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {pl.lines.length === 0 ? (
                <tr>
                  <td className="muted" colSpan={2}>
                    {t('reports.nothing_posted')}
                  </td>
                </tr>
              ) : (
                <>
                  <tr>
                    <th className={s.statementSection} scope="row">
                      {t('reports.income')}
                    </th>
                    <td className={`numeric ${s.totalCell}`}>{money(pl.totalIncome)}</td>
                  </tr>
                  <StatementRows level={level} lines={income} money={money} />
                  <tr>
                    <th className={s.statementSection} scope="row">
                      {t('reports.expenses')}
                    </th>
                    <td className={`numeric ${s.totalCell}`}>{money(pl.totalExpenses)}</td>
                  </tr>
                  <StatementRows level={level} lines={expenses} money={money} />
                </>
              )}
            </tbody>
            <tfoot>
              <tr>
                <th className={s.totalCell} scope="row">
                  {Number(pl.result) < 0 ? t('reports.loss') : t('reports.profit')}
                </th>
                <td className={`numeric ${s.totalCell}`}>{money(pl.result)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
