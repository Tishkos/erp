import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
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
 * By direction (2026-08-29, refined 2026-08-31): the ledger is a table of
 * every account with its balance — one figure, marked debit or credit, not a
 * debit column and a credit column — and pressing an account opens the
 * journals posted to it. Nothing is chosen from a list first.
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

  // One column, not two. By direction (2026-08-31) the ledger shows the
  // account's *balance* — the figure itself, marked as the side it falls on —
  // rather than a debit column and a credit column of which one is always
  // blank. The sign is carried by the marker, so no minus sign is printed.
  const balanceOf = (balance: string) => {
    const value = Number(balance);
    return {
      amount: money(value < 0 ? balance.replace('-', '') : balance),
      side: value < 0 ? t('reports.cr') : t('reports.dr'),
      zero: value === 0,
    };
  };
  const href = (code: string) => `/finance/gl-inquiry/${encodeURIComponent(code)}`;

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/gl-inquiry" />}
      subtitle={t('reports.gl_subtitle')}
      title={t('reports.gl')}
      variant="sap"
    >
      <ReportWindow
        filter={<ReportFilter action="/finance/gl-inquiry" asAt={asAt} currency={currency} level={level} maxLevel={deepest} />}
        meta={t('reports.as_at', { date: formatBusinessDate(asAt, locale as Locale) })}
        title={t('reports.gl')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{column('account')}</th>
              <th scope="col">{t('reports.account_name')}</th>
              <th scope="col">{t('reports.account_type')}</th>
              <th className={s.sapNum} scope="col">
                {t('reports.balance')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {t('reports.no_accounts')}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const { amount, side, zero } = balanceOf(row.balance);
                const openable = !row.isGroup && posting.has(row.accountCode);
                return (
                  <tr className={row.isGroup ? s.sapLevelRow : undefined} data-depth={row.depth} key={row.accountCode}>
                    <td style={{ paddingInlineStart: `${0.45 + (row.depth - 1) * 1.1}rem` }}>
                      {openable ? (
                        <Link className={s.sapLink} href={href(row.accountCode)}>
                          <bdi dir="ltr">{row.accountCode}</bdi>
                        </Link>
                      ) : (
                        <bdi dir="ltr">{row.accountCode}</bdi>
                      )}
                    </td>
                    <td>
                      {openable ? (
                        <Link className={s.sapPlainLink} href={href(row.accountCode)}>
                          <bdi dir="auto">{row.accountName}</bdi>
                        </Link>
                      ) : (
                        <bdi dir="auto">{row.accountName}</bdi>
                      )}
                    </td>
                    <td>{t(`reports.type_${row.accountType}`)}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{amount}</bdi>
                      {zero ? null : <span className={s.sapNote}> {side}</span>}
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
