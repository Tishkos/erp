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
 * The Statement of Changes in Equity — Phase 1 requirement 5, on a page of its
 * own (by direction, 2026-08-31).
 *
 * The one question the other three statements do not answer: equity was this
 * at the start of the period and that at the end — what happened in between.
 * Three columns say it, and the third is the first two added, so a reader can
 * check the statement against itself without leaving the page.
 *
 * The closing column is the Equity section of a Balance Sheet drawn at the
 * same date. That is not a coincidence to be maintained: both are assembled
 * from the same posted lines by the same code.
 */
export const dynamic = 'force-dynamic';

/** Statement line, then the accounts behind it. */
const LEVELS = 2;

export default async function ChangesInEquityPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/changes-in-equity')) notFound();

  const [t, page, line, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('statement_line'),
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
  const level = levelFrom(params.level, LEVELS);

  const equity = await withCurrentUser((tx) =>
    statements.changesInEquity(tx, { from, to, currency, allPermittedBranches: true }),
  );
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);
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
            level={level}
            maxLevel={LEVELS}
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
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('reports.statement_line')}</th>
              <th className={s.sapNum} scope="col">
                {t('reports.opening_balance')} · {currency}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.movement')} · {currency}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.closing_balance')} · {currency}
              </th>
            </tr>
          </thead>
          <tbody>
            {equity.rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {t('reports.nothing_in_equity')}
                </td>
              </tr>
            ) : (
              equity.rows.map((row) => (
                <Row
                  accounts={level >= 2 ? row.accounts : []}
                  closing={money(row.closing)}
                  key={row.code}
                  money={money}
                  movement={money(row.movement)}
                  opening={money(row.opening)}
                  title={row.kind === 'result' ? t('reports.equity_result') : line(row.code)}
                />
              ))
            )}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td>{t('reports.total_equity')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(equity.opening)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(equity.movement)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(equity.closing)}</bdi>
              </td>
            </tr>
          </tfoot>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}

/** One equity line, with — at the deeper level — the accounts behind it. */
function Row({
  title,
  opening,
  movement,
  closing,
  accounts,
  money,
}: {
  readonly title: string;
  readonly opening: string;
  readonly movement: string;
  readonly closing: string;
  readonly accounts: readonly {
    readonly accountCode: string;
    readonly accountName: string;
    readonly opening: string;
    readonly movement: string;
    readonly closing: string;
  }[];
  readonly money: (amount: string) => string;
}) {
  return (
    <>
      <tr className={s.sapLineRow}>
        <td>{title}</td>
        <td className={s.sapNum}>
          <bdi dir="ltr">{opening}</bdi>
        </td>
        <td className={s.sapNum}>
          <bdi dir="ltr">{movement}</bdi>
        </td>
        <td className={s.sapNum}>
          <bdi dir="ltr">{closing}</bdi>
        </td>
      </tr>
      {accounts.map((account) => (
        <tr className={s.sapAccountRow} key={account.accountCode}>
          <td>
            <bdi dir="ltr">{account.accountCode}</bdi> · <bdi dir="auto">{account.accountName}</bdi>
          </td>
          <td className={s.sapNum}>
            <bdi dir="ltr">{money(account.opening)}</bdi>
          </td>
          <td className={s.sapNum}>
            <bdi dir="ltr">{money(account.movement)}</bdi>
          </td>
          <td className={s.sapNum}>
            <bdi dir="ltr">{money(account.closing)}</bdi>
          </td>
        </tr>
      ))}
    </>
  );
}
