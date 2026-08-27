import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, FilterForm, Select, Submit, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as trialBalance from '@/server/services/trial-balance';

/**
 * The General Ledger — Phase 1 requirement 4.
 *
 * "Posted Journal Entries appear automatically in the General Ledger. Finance
 *  can review account activity…"
 *
 * *Automatically* is the word that matters, and it is met by there being no
 * ledger table at all: the General Ledger is the posted journal lines, read
 * one account at a time. Nothing copies anything anywhere, so nothing can be
 * copied wrongly or fail to be copied at all.
 */
export const dynamic = 'force-dynamic';

export default async function GeneralLedgerPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/gl-inquiry')) notFound();

  const [t, page, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'gl_inquiry')) {
    return <Denied object={page('gl_inquiry')} />;
  }

  const year = new Date().getFullYear();
  const from = typeof params.from === 'string' ? params.from : `${year}-01-01`;
  const to = typeof params.to === 'string' ? params.to : `${year}-12-31`;
  const account = typeof params.account === 'string' ? params.account : '';

  const { accounts, activity } = await withCurrentUser(async (tx) => ({
    accounts: await coa.postableAccounts(tx),
    activity: account
      ? await trialBalance.accountActivity(tx, account, { from, to, allPermittedBranches: true })
      : [],
  }));

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const chosen = accounts.find((a) => a.code === account);

  // The running balance, in the order the entries were posted. Computed here
  // rather than in SQL because it is a property of the *report* — the same
  // rows read for a different period have a different running balance.
  let running = 0;
  const rows = activity.map((line) => {
    running += Number(line.debitIqd) - Number(line.creditIqd);
    return { ...line, running };
  });

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/gl-inquiry" />}
      subtitle={t('reports.gl_subtitle')}
      title={t('reports.gl')}
    >
      <Panel>
        <FilterForm action="/finance/gl-inquiry">
          <Select
            defaultValue={account}
            label={t('journals.account')}
            name="account"
            options={[
              { value: '', label: t('reports.choose_account') },
              ...accounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` })),
            ]}
          />
          <Field defaultValue={from} label={t('reports.from')} name="from" required type="date" />
          <Field defaultValue={to} label={t('reports.to')} name="to" required type="date" />
          <Submit label={t('reports.run')} />
        </FilterForm>
      </Panel>

      <Panel flush title={chosen ? `${chosen.code} · ${chosen.name}` : t('reports.gl')}>
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
                    {account ? t('reports.nothing_posted') : t('reports.choose_account_first')}
                  </td>
                </tr>
              ) : (
                rows.map((line, index) => (
                  <tr key={`${line.entryNo}-${line.lineNo}-${index}`}>
                    <td>{formatBusinessDate(line.postingDate, locale as Locale)}</td>
                    <td>
                      <Link href={`/finance/journals/${encodeURIComponent(line.entryNo)}`}>
                        {line.entryNo}
                      </Link>
                    </td>
                    <td>{line.description ?? '—'}</td>
                    <td className="numeric">
                      {Number(line.debitIqd) === 0 ? '' : money(line.debitIqd)}
                    </td>
                    <td className="numeric">
                      {Number(line.creditIqd) === 0 ? '' : money(line.creditIqd)}
                    </td>
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
