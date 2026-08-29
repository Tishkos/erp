import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as trialBalance from '@/server/services/trial-balance';

/**
 * One account of the General Ledger: every journal posted to it, entry by
 * entry, with a running balance.
 *
 * Reached by pressing the account on the ledger's table — never by choosing
 * it from a list (by direction, 2026-08-29).
 */
export const dynamic = 'force-dynamic';

export default async function LedgerAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/finance/gl-inquiry')) notFound();

  const [t, page, locale, context, query, { code: raw }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
    params,
  ]);
  if (!can(context.principal, 'view', 'gl_inquiry')) {
    return <Denied object={page('gl_inquiry')} />;
  }
  const code = decodeURIComponent(raw);

  const year = new Date().getFullYear();
  const from = typeof query.from === 'string' ? query.from : `${year}-01-01`;
  const to = typeof query.to === 'string' ? query.to : `${year}-12-31`;
  const currency = currencyFrom(query.currency);

  const data = await withCurrentUser(async (tx) => {
    const account = await coa.loadAccountByCode(tx, code).catch(() => null);
    if (!account) return null;
    return {
      account,
      activity: await trialBalance.accountActivity(tx, code, { from, to, allPermittedBranches: true }),
    };
  });
  if (!data) notFound();
  const { account, activity } = data;

  const money = (amount: string) => formatMoney(amount, currency, locale as Locale);
  const usd = currency === 'USD';

  // The running balance, in the order the entries were posted. Computed here
  // rather than in SQL because it is a property of the *report* — the same
  // rows read for a different period have a different running balance.
  let running = 0;
  const rows = activity.map((line) => {
    const debit = usd ? line.debitUsd : line.debitIqd;
    const credit = usd ? line.creditUsd : line.creditIqd;
    running += Number(debit) - Number(credit);
    return { ...line, debit, credit, running };
  });

  return (
    <AdminPage
      back={{ href: '/finance/gl-inquiry', label: t('back') }}
      title={`${account.code} · ${account.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <ReportFilter
        action={`/finance/gl-inquiry/${encodeURIComponent(code)}`}
        currency={currency}
        from={from}
        to={to}
      />

      <Panel flush title={t('reports.gl_account_title', { code: account.code, name: account.name })}>
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('journals.posting_date')}</th>
                <th scope="col">{t('reports.entry')}</th>
                <th scope="col">{t('journals.description')}</th>
                <th className="numeric" scope="col">
                  {t('journals.debit')}
                </th>
                <th className="numeric" scope="col">
                  {t('journals.credit')}
                </th>
                <th className="numeric" scope="col">
                  {t('reports.running_balance')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className="muted" colSpan={6}>
                    {t('reports.nothing_posted')}
                  </td>
                </tr>
              ) : (
                rows.map((line, index) => (
                  <tr key={`${line.entryNo}-${line.lineNo}-${index}`}>
                    <td>{formatBusinessDate(line.postingDate, locale as Locale)}</td>
                    <td>
                      <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(line.entryNo)}`}>
                        <bdi dir="ltr">{line.entryNo}</bdi>
                      </Link>
                    </td>
                    <td>{line.description ?? '—'}</td>
                    <td className="numeric">{Number(line.debit) === 0 ? '' : money(line.debit)}</td>
                    <td className="numeric">{Number(line.credit) === 0 ? '' : money(line.credit)}</td>
                    <td className={`numeric ${s.mono}`}>{money(line.running.toFixed(4))}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
