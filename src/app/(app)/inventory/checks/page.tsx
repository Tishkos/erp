import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as checks from '@/server/services/inventory-checks';

/**
 * Inventory Checks — IMPROVEMENT-002: the health of the stock ledger, read
 * only, one row per check: healthy, warning or error, the figure, where it
 * comes from, and the rows behind it. Separate from Item Reconciliation,
 * which is the adjustment document. It never repairs.
 */
export const dynamic = 'force-dynamic';

const CHIP: Record<checks.CheckState, string> = { healthy: 'posted', warning: 'submitted', error: 'rejected' };

export default async function InventoryChecksPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/checks')) notFound();
  const [t, admin, page, locale, context, params] = await Promise.all([
    getTranslations('admin.inventory_checks'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', checks.PERMISSION_OBJECT)) {
    return <Denied object={page('inventory_checks')} />;
  }
  const report = await withCurrentUser((tx) => checks.run(tx, principal));
  const counts = { healthy: 0, warning: 0, error: 0 } as Record<checks.CheckState, number>;
  for (const check of report.checks) counts[check.state] += 1;

  return (
    <AdminPage
      actions={<ExportMenu exportKey="inventory_checks" query={params} />}
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/inventory/checks" />}
      title={page('inventory_checks')}
      variant="sap"
    >
      <section aria-labelledby="inventory-checks-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="inventory-checks-title">
            <span>{t('as_of_title', { date: formatBusinessDate(report.asOf, locale as Locale) })}</span>
            <span className={s.sapTitleMeta}>{t('summary', { healthy: counts.healthy, warning: counts.warning, error: counts.error })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="inventory-checks-title" className={`${s.sapTable} ${s.sapReportTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('check')}</th>
                  <th scope="col">{t('state')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('figure')}
                  </th>
                  <th scope="col">{t('source')}</th>
                  <th scope="col">{t('detail')}</th>
                  <th scope="col">{t('screen')}</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((check) => (
                  <tr key={check.code}>
                    <td>
                      <bdi dir="auto">{t(`check_${check.code}`)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${CHIP[check.state]}`} data-status={CHIP[check.state]}>
                        {t(`state_${check.state}`)}
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{check.figure}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{check.source}</bdi>
                    </td>
                    <td>
                      {check.detail.length === 0 ? '—' : null}
                      {check.detail.slice(0, 8).map((line, index) => (
                        <div key={index}>
                          <bdi dir="auto">{line}</bdi>
                        </div>
                      ))}
                      {check.detail.length > 8 ? <div>{t('more', { count: check.detail.length - 8 })}</div> : null}
                    </td>
                    <td>
                      <Link className={s.sapLink} href={check.route}>
                        {t('open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
