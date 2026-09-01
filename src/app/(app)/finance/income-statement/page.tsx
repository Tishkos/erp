import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatStatementAmount, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as company from '@/server/services/company';
import * as statements from '@/server/services/financial-statements';

/**
 * The Income Statement — Phase 1 requirement 5, in the form the sponsor
 * presents it (by direction, 2026-09-01, with a template).
 *
 * ── It is a document, not a grid ───────────────────────────────────────────
 * The window around it belongs to the application; what sits inside it is a
 * statement, and a statement is printed on a page. So it has a head — whose
 * accounts these are, what the statement is, over what period, in what money
 * — and then two columns set narrow enough that a figure still belongs to the
 * line beside it. Stretched the width of a monitor, an amount ends so far
 * from its label that the eye has to travel between them, which is the one
 * thing a statement must never ask.
 *
 * There are no column headings. The head names the currency once, the way a
 * printed statement says "in thousands", and everything below it is a figure.
 *
 * ── It runs, and the subtotals are the reason ──────────────────────────────
 * Revenue, what it cost, and the margin between them; then the cost of
 * running the business and what trading left after it; then the result. Each
 * computed figure is ruled *over its own column* — the way a page is ruled
 * before a sum is written under it — rather than across the full width, which
 * reads as a table divider instead of as arithmetic.
 *
 * Every section carries its total on its heading, with the chart's own
 * hierarchy beneath it: Product Revenue above Solar Revenue, because that is
 * where the Chart of Accounts holds them. Nothing here is a second layout to
 * keep in step with the accounts — the shape *is* the chart, and which
 * section an account falls in is the statement line chosen when it was
 * opened.
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

  const { pl, house } = await withCurrentUser(async (tx) => ({
    pl: await statements.incomeStatement(tx, { from, to, currency, allPermittedBranches: true }),
    house: await company.current(tx),
  }));

  // The section headings are level 1; each step down the chart adds one. The
  // ceiling is however deep this company's chart actually goes.
  const maxLevel = pl.depth + 1;
  const level = levelFrom(params.level, maxLevel);
  const figure = (amount: string) => formatStatementAmount(amount, currency, locale as Locale);
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
        title={t('reports.income_statement')}
      >
        <div className={s.sapStatementPage}>
          {/* Whose accounts these are, what this is, over what, in what money. */}
          <header className={s.sapStatementHead}>
            {house?.legalName ? <p className={s.sapStatementCompany}>{house.legalName}</p> : null}
            <h3>{t('reports.income_statement')}</h3>
            <p className={s.sapStatementPeriod}>
              {t('reports.for_the_period', {
                from: formatBusinessDate(from, locale as Locale),
                to: formatBusinessDate(to, locale as Locale),
              })}
              {' · '}
              {t('reports.stated_in', { currency })}
            </p>
          </header>

          <table className={s.sapStatement}>
            <tbody>
              {pl.rows.length === 0 ? (
                <tr>
                  <td className={s.sapStatementEmpty} colSpan={2}>
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
                        : null;

                  return (
                    <tr
                      className={
                        row.kind === 'subtotal'
                          ? s.sapStatementSum
                          : row.kind === 'section'
                            ? s.sapStatementSection
                            : row.kind === 'group'
                              ? s.sapStatementGroup
                              : s.sapStatementAccount
                      }
                      data-rule={row.rule === 'none' ? undefined : row.rule}
                      key={row.key}
                    >
                      <td style={{ paddingInlineStart: `${row.depth * 1.35}rem` }}>
                        {label ?? <bdi dir="auto">{row.name}</bdi>}
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{figure(row.amount)}</bdi>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </ReportWindow>
    </AdminPage>
  );
}
