import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
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
 * The Income Statement — Phase 1 requirement 5, in the form the sponsor
 * presents it (by direction, 2026-09-01, with a template).
 *
 * Drawn in the same window and the same grid as the Balance Sheet: one look
 * for the financial statements rather than one each. What it adds is the
 * running subtotals — the margin, what trading left, the result — ruled where
 * they fall, because those are the figures anyone opens the statement for.
 *
 * ── The shape is the chart ─────────────────────────────────────────────────
 * Every section carries its own total on its heading, with the Chart of
 * Accounts' own hierarchy beneath it: Product Revenue above Solar Revenue,
 * because that is where the chart holds them. There is no second layout to
 * keep in step with the accounts — which section an account falls in is the
 * statement line chosen when it was opened, and everything else follows from
 * the parent it was opened under.
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
              <span>{t('reports.line_gross_profit')}</span>
              <strong>
                <bdi dir="ltr">{money(pl.grossProfit)}</bdi>
              </strong>
            </div>
            <div className={s.sapFootTotal}>
              <span>{loss ? t('reports.net_loss') : t('reports.net_profit')}</span>
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
            {pl.rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={2}>
                  {t('reports.nothing_posted')}
                </td>
              </tr>
            ) : (
              shown.map((row) => {
                // Sections and subtotals are named by the catalogue; headers
                // and posting accounts are named by the chart.
                const label =
                  row.labelKey === 'result'
                    ? loss
                      ? t('reports.net_loss')
                      : t('reports.net_profit')
                    : row.labelKey
                      ? t(`reports.line_${row.labelKey}`)
                      : row.kind === 'account'
                        ? null
                        : row.name;

                return (
                  <tr
                    className={
                      row.kind === 'subtotal'
                        ? s.sapSectionRow
                        : row.kind === 'section'
                          ? s.sapSectionRow
                          : row.kind === 'group'
                            ? s.sapLineRow
                            : s.sapAccountRow
                    }
                    data-rule={row.rule === 'none' ? undefined : row.rule}
                    key={row.key}
                  >
                    <td style={{ paddingInlineStart: `${0.6 + row.depth * 1.25}rem` }}>
                      {label ?? (
                        <>
                          <bdi dir="ltr">{row.code}</bdi> · <bdi dir="auto">{row.name}</bdi>
                        </>
                      )}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amount)}</bdi>
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
