import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage } from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as journal from '@/server/services/journal';

/**
 * The audit log of one journal entry — Phase 0 requirement 10, reached from
 * the entry itself.
 *
 * By direction (2026-08-29): a person reading a transaction opens its audit
 * log from the transaction, and sees only that transaction's events — who
 * raised it, who changed a line, who posted it, who reversed it — rather
 * than searching the company-wide trail for its id.
 */
export const dynamic = 'force-dynamic';

export default async function JournalAuditPage({ params }: { params: Promise<{ entryNo: string }> }) {
  if (!visibleRoute('/finance/journals')) notFound();

  const [t, page, context, { entryNo: raw }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
    params,
  ]);
  const entryNo = decodeURIComponent(raw);
  if (!can(context.principal, 'view', journal.PERMISSION_OBJECT)) {
    return <Denied object={page('journal_entry')} />;
  }

  const header = await withCurrentUser((tx) => journal.byEntryNo(tx, entryNo).catch(() => null));
  if (!header) notFound();

  return (
    <AdminPage
      back={{ href: `/finance/journals/${encodeURIComponent(entryNo)}`, label: t('journals.back_to_entry') }}
      subtitle={t('journals.audit_subtitle', { entryNo })}
      title={t('journals.audit_log')}
      trail={[
        { href: '/', label: t('dashboard_label') },
        { href: '/finance/journals', label: t('journals.title') },
      ]}
      variant="sap"
    >
      <RecordHistory objectId={header.id} objectType={journal.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
