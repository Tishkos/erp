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
 * Monitoring — History, by direction 2026-10-03.
 *
 * Drawn and reading nothing, like its two neighbours: the tab has to be
 * clickable before the screen behind it is written, or the module is a heading
 * over three dead ends.
 */
export const dynamic = 'force-dynamic';

export default async function MonitoringHistoryPage() {
  if (!visibleRoute('/monitoring/history')) notFound();

  const [t, page, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
  ]);

  if (!can(context.principal, 'view', 'monitoring')) {
    return <Denied object={page('history')} />;
  }

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/monitoring/history" />}
      title={page('history')}
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
