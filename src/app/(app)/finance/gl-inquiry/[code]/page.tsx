import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportFilter, ReportWindow, currencyFrom } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
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
  const closing = running;

  return (
    <AdminPage
      actions={<ExportMenu exportKey="gl_account" id={code} query={query} />}
      back={{ href: '/finance/gl-inquiry', label: t('back') }}
      title={`${account.code} · ${account.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <ReportWindow
        filter={<ReportFilter action={`/finance/gl-inquiry/${encodeURIComponent(code)}`} currency={currency} from={from} to={to} />}
        foot={
          <div className={s.sapFootTotals}>
            <div className={s.sapFootTotal}>
              <span>{t('reports.running_balance')}</span>
              <strong>
                <bdi dir="ltr">{money(closing.toFixed(4))}</bdi>
              </strong>
            </div>
          </div>
        }
        meta={t('reports.for_the_period', {
          from: formatBusinessDate(from, locale as Locale),
          to: formatBusinessDate(to, locale as Locale),
        })}
        title={`${account.code} · ${account.name}`}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('journals.posting_date')}</th>
              <th scope="col">{t('reports.entry')}</th>
              <th scope="col">{t('journals.description')}</th>
              <th className={s.sapNum} scope="col">
                {t('journals.debit')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('journals.credit')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.running_balance')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={6}>
                  {t('reports.nothing_posted')}
                </td>
              </tr>
            ) : (
              rows.map((line, index) => (
                <tr key={`${line.entryNo}-${line.lineNo}-${index}`}>
                  <td>
                    <bdi dir="ltr">{formatBusinessDate(line.postingDate, locale as Locale)}</bdi>
                  </td>
                  <td>
                    <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(line.entryNo)}`}>
                      <bdi dir="ltr">{line.entryNo}</bdi>
                    </Link>
                  </td>
                  <td>
                    <bdi dir="auto">{line.description ?? '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{Number(line.debit) === 0 ? '' : money(line.debit)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{Number(line.credit) === 0 ? '' : money(line.credit)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(line.running.toFixed(4))}</bdi>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
