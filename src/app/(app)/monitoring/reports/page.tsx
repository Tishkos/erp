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
 * Monitoring — Reports, by direction 2026-10-03.
 *
 * Drawn and reading nothing, like its two neighbours. When it has figures they
 * will come from `print/*-reports.ts` like every other report here, so that the
 * screen and the export are one set of numbers rather than two.
 */
export const dynamic = 'force-dynamic';

export default async function MonitoringReportsPage() {
  if (!visibleRoute('/monitoring/reports')) notFound();

  const [t, page, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
  ]);

  if (!can(context.principal, 'view', 'monitoring')) {
    return <Denied object={page('reports')} />;
  }

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/monitoring/reports" />}
      title={page('reports')}
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
