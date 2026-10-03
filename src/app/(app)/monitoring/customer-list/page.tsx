import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { Panel } from '@/components/ui';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext } from '@/server/session';

/**
 * Monitoring — the list of customers, by direction 2026-10-03.
 *
 * It says "coming soon" and reads nothing, which is what was asked for: the
 * module, its three tabs and a page behind each, so the navigation is whole
 * before the screens are.
 *
 * Drawn as every other register is — the section tabs, the title, one window —
 * so that when it does have a table to show, what changes is the inside of the
 * window and not the shape of the page. `emptyState` is the class the
 * Accounting Periods and Exchange Rates screens already say "nothing here"
 * with, which is why it is not a new one.
 */
export const dynamic = 'force-dynamic';

export default async function MonitoringCustomerListPage() {
  if (!visibleRoute('/monitoring/customer-list')) notFound();

  const [t, page, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
  ]);

  if (!can(context.principal, 'view', 'monitoring')) {
    return <Denied object={page('customer_list')} />;
  }

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/monitoring/customer-list" />}
      title={page('customer_list')}
      variant="sap"
    >
      <Panel>
        <div className={s.emptyState}>
          <strong>{t('monitoring.soon')}</strong>
        </div>
      </Panel>
    </AdminPage>
  );
}
