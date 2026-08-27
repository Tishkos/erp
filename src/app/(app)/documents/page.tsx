import { getLocale, getTranslations } from 'next-intl/server';
import { visibleRoute } from '@/server/phase-gate';
import { notFound } from 'next/navigation';
import { redirect } from 'next/navigation';
import {
  DocumentCentreWorkspace,
  type DocumentCentreLabels,
  type DocumentWorkspaceItem,
} from './document-centre-workspace';
import { optionalContext } from '@/server/session';
import { visibleMenu } from '@domain/menu';

/**
 * Document Centre — Appendix A menu 17.
 *
 * This route deliberately has no document query or mutation path yet. The
 * authenticated navigation tree is the only source for its workspace cards,
 * so it cannot advertise tools outside the caller's existing permissions.
 */
export const dynamic = 'force-dynamic';

export default async function DocumentsPage() {
  if (!visibleRoute('/documents')) notFound();
  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  const [locale, t, documents] = await Promise.all([
    getLocale(),
    getTranslations(),
    getTranslations('documents'),
  ]);
  const documentSection = visibleMenu(context.principal).find(
    (section) => section.key === 'documents',
  );

  const items: DocumentWorkspaceItem[] = (documentSection?.items ?? []).map((item) => ({
    key: item.key,
    label: t(`page.${item.key}`),
    href: item.href,
    phase: item.phase,
    phaseHint: t('phase.not_built'),
  }));

  const labels: DocumentCentreLabels = {
    module: t('nav.documents'),
    title: t('page.document_centre'),
    subtitle: documents('subtitle'),
    upload: documents('upload'),
    newDocument: documents('new_document'),
    previewBadge: documents('preview_badge'),
    previewNotice: documents('preview_notice'),
    workspaces: documents('workspaces'),
    workspacesHint: documents('workspaces_hint'),
    recent: documents('recent'),
    recentEmpty: documents('recent_empty'),
    recentEmptyHint: documents('recent_empty_hint'),
    openWorkspace: documents('open_workspace'),
    all: documents('all'),
    available: documents('available'),
    planned: documents('planned'),
    search: t('list.search'),
    searchPlaceholder: t('list.search_placeholder'),
    filters: t('list.filters'),
    clearSearch: t('list.clear_filters'),
    noResults: t('list.no_rows'),
    noResultsHint: t('list.no_rows_hint'),
    pending: t('phase.not_built'),
    phaseExplanation: t('phase.explanation'),
    noAccessTitle: t('error.no_permission_title'),
    noAccessDescription: t('error.no_permission'),
    close: t('shell.close'),
  };

  return (
    <>
      <DocumentCentreWorkspace items={items} labels={labels} locale={locale} />
    </>
  );
}
