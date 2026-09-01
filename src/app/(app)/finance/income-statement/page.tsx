import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as statements from '@/server/services/financial-statements';

/**
 * The Income Statement — Phase 1 requirement 5, in the form the sponsor
 * presents it (by direction, 2026-09-01, with a template).
 *
 * It is a running document, not a stack of sections: revenue, what it cost,
 * and the margin between them; then the cost of running the business and what
 * trading left after it; then what sits below the operating line, and the
 * result. The subtotals in between are the reason anyone reads it, so they are
 * ruled and set apart rather than left to be worked out.
 *
 * Every section carries its own total on its heading, with the chart's own
 * hierarchy beneath it — Product Revenue above Solar Revenue because that is
 * how the Chart of Accounts holds them. Nothing here is a second layout to
 * keep in step with the accounts: the shape *is* the chart, and which section
 * an account falls in is the statement line chosen when it was created.
 */
export const dynamic = 'force-dynamic';

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

  const pl = await withCurrentUser((tx) =>
    statements.incomeStatement(tx, { from, to, currency, allPermittedBranches: true }),
  );

  // The section headings are level 1; each step down the chart adds one. The
  // ceiling is however deep this company's chart actually goes.
  const maxLevel = pl.depth + 1;
  const level = levelFrom(params.level, maxLevel);
  // On the face of the statement: no currency on every row, brackets for a
  // negative. The foot keeps the full form, where the currency is the point.
  const figure = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);
  const loss = Number(pl.result) < 0;

  // A section heading is always shown; its accounts unfold with the level.
  const shown = pl.rows.filter((row) => row.kind === 'subtotal' || row.depth < level);

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
          <ReportFilter
            action="/finance/income-statement"
            currency={currency}
            from={from}
            level={level}
            maxLevel={maxLevel}
            to={to}
          />
        }
        foot={
          <div className={s.sapFootTotals}>
            <div className={s.sapFootTotal}>
              <span>{t('reports.gross_profit')}</span>
              <strong>
                <bdi dir="ltr">{money(pl.grossProfit)}</bdi>
              </strong>
            </div>
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
        <table className={`${s.sapTable} ${s.sapReportTable} ${s.sapStatement}`}>
          <thead>
            <tr>
              <th scope="col">{t('reports.statement_line')}</th>
              <th className={s.sapNum} scope="col">
                {t('reports.amount')} · {currency}
              </th>
            </tr>
          </thead>
          <tbody>
            {pl.rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={2}>
                  {t('reports.nothing_posted')}
                </td>
              </tr>
            ) : (
              shown.map((row) => {
                // Sections and subtotals are named by the catalogue; accounts
                // and headers are named by the chart.
                const label =
                  row.labelKey === 'result'
                    ? loss
                      ? t('reports.net_loss')
                      : t('reports.net_profit')
                    : row.labelKey
                      ? t(`reports.line_${row.labelKey}`)
                      : null;

                return (
                  <tr
                    className={
                      row.kind === 'subtotal'
                        ? row.rule === 'double'
                          ? s.sapTotalRow
                          : s.sapSectionRow
                        : row.kind === 'section'
                          ? s.sapSectionRow
                          : row.kind === 'group'
                            ? s.sapLineRow
                            : s.sapAccountRow
                    }
                    data-rule={row.rule === 'none' ? undefined : row.rule}
                    key={row.key}
                  >
                    <td
                      style={{
                        paddingInlineStart: `${0.45 + (row.kind === 'subtotal' ? 1 : row.depth) * 1.1}rem`,
                      }}
                    >
                      {label ? (
                        <strong>{label}</strong>
                      ) : (
                        <>
                          <bdi dir="ltr">{row.code}</bdi> · <bdi dir="auto">{row.name}</bdi>
                        </>
                      )}
                      {/* A section taken away from what stands above it says so
                          once, on its heading, rather than with a minus sign on
                          every figure beneath. */}
                      {row.kind === 'section' && row.deducted ? (
                        <span className={s.sapNote}> ({t('reports.deducted')})</span>
                      ) : null}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {row.kind === 'subtotal' ? <strong>{figure(row.amount)}</strong> : figure(row.amount)}
                      </bdi>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
