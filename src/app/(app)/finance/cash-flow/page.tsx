import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Fragment } from 'react';
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

  const [t, page, line, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('statement_line'),
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
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);
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
            {/* Which accounts are cash is a decision Finance makes in the
                Chart of Accounts. Until it has been made there is nothing to
                report, and saying why is more use than an empty table. */}
            {!flow.configured ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={2}>
                  {t('reports.cash_not_configured')}{' '}
                  <Link className={s.sapLink} href="/master-data/chart-of-accounts">
                    {page('chart_of_accounts')}
                  </Link>
                </td>
              </tr>
            ) : !moved ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={2}>
                  {t('reports.no_cash_moved')}
                </td>
              </tr>
            ) : (
              <>
                <tr className={s.sapLineRow}>
                  <td>{t('reports.opening_cash')}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(flow.openingCash)}</bdi>
                  </td>
                </tr>
                {flow.sections.map((section) => (
                  <Section
                    key={section.category}
                    level={level}
                    lines={section.lines.map((entry) => ({
                      title: line.has(entry.line.code) ? line(entry.line.code) : entry.line.name,
                      amount: entry.amount,
                      accounts: entry.accounts,
                    }))}
                    money={money}
                    title={t(`reports.cash_${section.category}`)}
                    total={section.total}
                  />
                ))}
              </>
            )}
          </tbody>
          {flow.configured && moved ? (
            <tfoot>
              <tr className={s.sapTotalRow}>
                <td>{t('reports.net_movement')}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(flow.netMovement)}</bdi>
                </td>
              </tr>
              <tr className={s.sapTotalRow}>
                <td>{t('reports.closing_cash')}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(flow.closingCash)}</bdi>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </ReportWindow>
    </AdminPage>
  );
}

/**
 * One activity — its heading with what the activity came to, then, unfolded to
 * the chosen level, the lines and the accounts behind them.
 */
function Section({
  title,
  total,
  lines,
  level,
  money,
}: {
  readonly title: string;
  readonly total: string;
  readonly lines: readonly {
    readonly title: string;
    readonly amount: string;
    readonly accounts: readonly {
      readonly accountCode: string;
      readonly accountName: string;
      readonly amount: string;
    }[];
  }[];
  readonly level: number;
  readonly money: (amount: string) => string;
}) {
  return (
    <>
      <tr className={s.sapSectionRow}>
        <td>{title}</td>
        <td className={s.sapNum}>
          <bdi dir="ltr">{money(total)}</bdi>
        </td>
      </tr>
      {level >= 2
        ? lines.map((entry) => (
            <Fragment key={entry.title}>
              <tr className={s.sapLineRow}>
                <td>{entry.title}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(entry.amount)}</bdi>
                </td>
              </tr>
              {level >= 3
                ? entry.accounts.map((account) => (
                    <tr className={s.sapAccountRow} key={account.accountCode}>
                      <td>
                        <bdi dir="ltr">{account.accountCode}</bdi> ·{' '}
                        <bdi dir="auto">{account.accountName}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(account.amount)}</bdi>
                      </td>
                    </tr>
                  ))
                : null}
            </Fragment>
          ))
        : null}
    </>
  );
}
