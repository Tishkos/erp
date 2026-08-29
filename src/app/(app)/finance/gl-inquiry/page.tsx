import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { levelFrom, maxLevel, rollUp } from '@domain/report-levels';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as trialBalance from '@/server/services/trial-balance';

/**
 * The General Ledger — Phase 1 requirement 4.
 *
 * "Posted Journal Entries appear automatically in the General Ledger. Finance
 *  can review account activity…"
 *
 * By direction (2026-08-29): the ledger is a table of every account with its
 * balance, debit or credit, and pressing an account opens the journals posted
 * to it. Nothing is chosen from a list first.
 *
 * *Automatically* is met by there being no ledger table at all: the General
 * Ledger is the posted journal lines, summed here per account and read there
 * one account at a time. Nothing copies anything anywhere, so nothing can be
 * copied wrongly or fail to be copied at all.
 */
export const dynamic = 'force-dynamic';

export default async function GeneralLedgerPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/gl-inquiry')) notFound();

  const [t, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'gl_inquiry')) {
    return <Denied object={page('gl_inquiry')} />;
  }

  const today = new Date().toISOString().slice(0, 10);
  const asAt = typeof params.to === 'string' ? params.to : today;
  const currency = currencyFrom(params.currency);

  const { balances, chart } = await withCurrentUser(async (tx) => ({
    balances: await trialBalance.ledgerBalances(tx, { asAt, currency, allPermittedBranches: true }),
    chart: await trialBalance.chartRows(tx),
  }));
  const deepest = maxLevel(chart);
  const level = levelFrom(params.level, deepest);
  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);

  // At the deepest level every posting account is its own row, movement or
  // not; above it the chart's headers carry the sums of what is beneath them.
  const posting = new Map(balances.map((row) => [row.accountCode, row]));
  const rows =
    level >= deepest
      ? balances.map((row) => ({ ...row, depth: deepest, isGroup: false }))
      : rollUp(chart, balances, level).map((row) => ({
          accountCode: row.code,
          accountName: row.name,
          accountType: row.accountType,
          debit: row.debit,
          credit: row.credit,
          balance: (Number(row.debit) - Number(row.credit)).toFixed(4),
          depth: row.depth,
          isGroup: row.isGroup,
        }));

  const sides = (balance: string) => {
    const value = Number(balance);
    return {
      debit: value > 0 ? money(balance) : '',
      credit: value < 0 ? money(balance.replace('-', '')) : '',
    };
  };

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/gl-inquiry" />}
      subtitle={t('reports.gl_subtitle')}
      title={t('reports.gl')}
      variant="sap"
    >
      <ReportFilter
        action="/finance/gl-inquiry"
        asAt={asAt}
        currency={currency}
        level={level}
        maxLevel={deepest}
      />

      <Panel flush title={t('reports.as_at', { date: formatBusinessDate(asAt, locale as Locale) })}>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('account')}</th>
                <th scope="col">{t('reports.account_name')}</th>
                <th scope="col">{t('reports.account_type')}</th>
                <th className="numeric" scope="col">
                  {t('reports.debit_balance')}
                </th>
                <th className="numeric" scope="col">
                  {t('reports.credit_balance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="muted" colSpan={5}>
                    {t('reports.no_accounts')}
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const { debit, credit } = sides(row.balance);
                  const openable = !row.isGroup && posting.has(row.accountCode);
                  return (
                    <tr
                      className={row.isGroup ? s.levelHeader : undefined}
                      data-depth={row.depth}
                      key={row.accountCode}
                    >
                      <td
                        className={s.mono}
                        style={{ paddingInlineStart: `${0.75 + (row.depth - 1) * 1.1}rem` }}
                      >
                        {openable ? (
                          <Link
                            className={s.sapLink}
                            href={`/finance/gl-inquiry/${encodeURIComponent(row.accountCode)}`}
                          >
                            <bdi dir="ltr">{row.accountCode}</bdi>
                          </Link>
                        ) : (
                          <bdi dir="ltr">{row.accountCode}</bdi>
                        )}
                      </td>
                      <td>
                        {openable ? (
                          <Link href={`/finance/gl-inquiry/${encodeURIComponent(row.accountCode)}`}>
                            {row.accountName}
                          </Link>
                        ) : (
                          row.accountName
                        )}
                      </td>
                      <td>{t(`reports.type_${row.accountType}`)}</td>
                      <td className="numeric">{debit}</td>
                      <td className="numeric">{credit}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
