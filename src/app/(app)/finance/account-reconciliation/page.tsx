import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { ReportWindow } from '@/components/admin/report-filter';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import { glAccountHref } from '@/server/domain/accounting-links';
import * as subledger from '@/server/services/subledger';

/**
 * Account Reconciliation — REQ-ACC-001 Part D-4.
 *
 * Every control account's sub-ledger beside its G/L balance as at a date —
 * receivables, payables, loans, any other — with the difference and where to
 * investigate it; and the inventory layers beside the inventory accounts.
 * The same figures the close checklist asks (`subledger_equals_gl`, check
 * 7), from the same functions, so the two screens cannot disagree. It
 * reports; it corrects nothing. Drawn as the Trial Balance is.
 */
export const dynamic = 'force-dynamic';

const ZERO = /^-?0(\.0+)?$/;

export default async function AccountReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/account-reconciliation')) notFound();

  const [t, admin, page, locale, context, params] = await Promise.all([
    getTranslations('admin.account_reconciliation'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  if (!can(context.principal, 'view', 'trial_balance')) {
    return <Denied object={page('account_reconciliation')} />;
  }

  const asOf = typeof params.to === 'string' && params.to ? params.to : businessToday();
  const result = await withCurrentUser((tx, request) =>
    subledger.accountReconciliation(tx, { principal: request.principal, branchCode: request.scope.branchCode }, asOf),
  );
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const differences = result.rows.filter((row) => !ZERO.test(row.difference));
  const inventoryAgrees = ZERO.test(result.inventory.differenceIqd);
  const state = (agrees: boolean) => (
    <span className={`status status--${agrees ? 'settled' : 'rejected'}`} data-status={agrees ? 'settled' : 'rejected'}>
      {agrees ? t('agrees') : t('differs')}
    </span>
  );

  return (
    <AdminPage
      actions={<ExportMenu exportKey="account_reconciliation" query={params} />}
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/finance/account-reconciliation" />}
      subtitle={t('subtitle')}
      title={page('account_reconciliation')}
      variant="sap"
    >
      <ReportWindow
        filter={
          <form action="/finance/account-reconciliation" className={s.sapFilterBar} method="get">
            <label className={s.sapFilterField} title={admin('reports.as_at_hint')}>
              <span className={s.sapLabel}>{admin('reports.as_at_label')}</span>
              <input defaultValue={asOf} name="to" required type="date" />
            </label>
            <button className={`${s.button} ${s.primary}`} type="submit">
              {admin('reports.run')}
            </button>
          </form>
        }
        foot={
          <div className={s.sapFootActions}>
            {differences.length === 0 ? (
              <span className={s.sapBalanced}>{t('all_agree')}</span>
            ) : (
              <span className={s.sapWarn}>{t('some_differ', { count: differences.length })}</span>
            )}
          </div>
        }
        meta={formatBusinessDate(asOf, locale as Locale)}
        title={t('control_accounts')}
      >
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('account')}</th>
              <th scope="col">{t('subledger')}</th>
              <th className={s.sapNum} scope="col">
                {t('subledger_balance')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('gl_balance')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('difference')}
              </th>
              <th scope="col">{t('status')}</th>
              <th scope="col">{t('investigate')}</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={7}>
                  {t('no_control_accounts')}
                </td>
              </tr>
            ) : null}
            {result.rows.map((row) => {
              const screen = subledger.SUBLEDGER_SCREEN[row.subledgerType as keyof typeof subledger.SUBLEDGER_SCREEN];
              return (
                <tr key={row.accountCode}>
                  <td>
                    <Link className={s.sapLink} href={glAccountHref(row.accountCode)}>
                      <bdi dir="ltr">{row.accountCode}</bdi>
                    </Link>{' '}
                    <bdi dir="auto">{row.accountName}</bdi>
                  </td>
                  <td>{t.has(`kind_${row.subledgerType}`) ? t(`kind_${row.subledgerType}`) : row.subledgerType}</td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(row.subledgerBalance)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(row.generalLedgerBalance)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(row.difference)}</bdi>
                  </td>
                  <td>{state(ZERO.test(row.difference))}</td>
                  <td>
                    <Link className={s.sapLink} href={`/finance/gl-inquiry/${encodeURIComponent(row.accountCode)}?to=${asOf}`}>
                      {t('gl_inquiry')}
                    </Link>
                    {screen ? (
                      <>
                        {' · '}
                        <Link className={s.sapLink} href={screen}>
                          {t('subledger_screen')}
                        </Link>
                      </>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ReportWindow>

      {/* The layers have no history, so this figure is as of now whatever the date above says. */}
      <ReportWindow meta={t('as_of_now', { day: formatBusinessDate(businessToday(), locale as Locale) })} title={t('inventory_title')}>
        <table className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{t('subledger')}</th>
              <th className={s.sapNum} scope="col">
                {t('layers')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('not_yet_posted')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('gl_balance')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('difference')}
              </th>
              <th scope="col">{t('status')}</th>
              <th scope="col">{t('investigate')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{t('kind_inventory')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(result.inventory.layersIqd)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(result.inventory.provisionalIqd)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(result.inventory.accountsIqd)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(result.inventory.differenceIqd)}</bdi>
              </td>
              <td>{state(inventoryAgrees)}</td>
              <td>
                <Link className={s.sapLink} href="/inventory/fifo-valuation">
                  {t('subledger_screen')}
                </Link>
              </td>
            </tr>
          </tbody>
        </table>
      </ReportWindow>
    </AdminPage>
  );
}
