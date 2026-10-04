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
 * Document Centre — Appendix A menu 17, coming soon (by direction,
 * 2026-10-04: "make document center coming soon, delete that weird design,
 * mocked stuff").
 *
 * It used to draw a workspace of its own — cards, a search, a recent list —
 * over nothing: no document was ever read. It is now the house's "coming
 * soon" screen, the Monitoring screens' own, until the centre is built. A
 * record's files stay behind its paperclip door.
 */
export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  if (!visibleRoute('/documents')) notFound();

  const [t, page, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
  ]);

  if (!can(context.principal, 'view', 'attachment')) {
    return <Denied object={page('document_centre')} />;
  }

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/documents" />}
      title={page('document_centre')}
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
