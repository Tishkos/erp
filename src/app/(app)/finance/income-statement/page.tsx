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
 * The Income Statement — Phase 1 requirement 5, on a page of its own (by
 * direction, 2026-08-29; named as the sponsor names it, 2026-08-31).
 *
 * Drawn from the posted journal lines and nothing else, for the period
 * between the two dates. Three levels: the two sections and what they come
 * to, the statement lines, and the accounts behind each line.
 */
export const dynamic = 'force-dynamic';

/** Section, line, account. */
const LEVELS = 3;

export default async function IncomeStatementPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/income-statement')) notFound();

  const [t, page, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'financial_statement')) {
    return <Denied object={page('income_statement')} />;
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
  const loss = Number(pl.result) < 0;

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/income-statement" />}
      subtitle={t('reports.income_statement_subtitle')}
      title={page('income_statement')}
      variant="sap"
    >
      <ReportWindow
        filter={
          <ReportFilter action="/finance/income-statement" currency={currency} from={from} level={level} maxLevel={LEVELS} to={to} />
        }
        foot={
          <div className={s.sapFootTotals}>
            <div className={s.sapFootTotal}>
              <span>{loss ? t('reports.loss') : t('reports.profit')}</span>
              <strong>
                <bdi dir="ltr">{money(pl.result)}</bdi>
              </strong>
            </div>
          </div>
        }
        meta={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
        title={t('reports.income_statement')}
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
            {pl.lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={2}>
                  {t('reports.nothing_posted')}
                </td>
              </tr>
            ) : (
              <>
                <StatementSection level={level} lines={income} money={money} title={t('reports.income')} total={pl.totalIncome} />
                <StatementSection level={level} lines={expenses} money={money} title={t('reports.expenses')} total={pl.totalExpenses} />
              </>
            )}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td>{loss ? t('reports.loss') : t('reports.profit')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(pl.result)}</bdi>
              </td>
            </tr>
          </tfoot>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
