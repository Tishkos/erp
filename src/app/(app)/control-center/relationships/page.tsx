import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { RelatedRecords } from '@/components/admin/related-records';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { ROOT_OBJECT, isRootKind } from '@/server/domain/relationships';
import { requireContext, withCurrentUser } from '@/server/session';
import * as relationships from '@/server/services/relationships';

/**
 * Related records — the whole chain around one import, supplier, customer or item (platform phase, Agent 9).
 *
 * `?type=import|supplier|customer|item&id=<payable no | partner code | item code>`. A report-style page
 * over the same stacked section the record pages carry. It is open to whoever may open the record the chain
 * starts from — not to the Control Center's audience: the chain is a way into the record, so the record's own
 * grant, branch and access rule decide, and the section shows only the steps and records the viewer may open
 * (`services/relationships`). A record the viewer may not open is "not found", the same answer as one that does
 * not exist.
 */
export const dynamic = 'force-dynamic';

export default async function RelationshipsPage({ searchParams }: { searchParams: SearchParams }) {
  const [r, context, params] = await Promise.all([getTranslations('admin.relationships'), requireContext(), searchParams]);
  const { principal } = context;
  const type = typeof params.type === 'string' ? params.type : '';
  const id = typeof params.id === 'string' ? params.id.trim() : '';
  if (!isRootKind(type) || id === '') notFound();
  if (!can(principal, 'view', ROOT_OBJECT[type])) return <Denied object={r('title')} />;

  const graph = await withCurrentUser((tx) => relationships.graphFor(tx, { principal, branchCode: context.scope.branchCode }, type, id));
  if (!graph) notFound();

  return (
    <AdminPage
      back={{ href: graph.root.href, label: r('back', { label: graph.root.label }) }}
      subtitle={r('subtitle')}
      title={r('page_title', { kind: r(`kind.${type}`), label: graph.root.label })}
      variant="sap"
    >
      <RelatedRecords graph={graph} linkToChain={false} variant="window" />
    </AdminPage>
  );
}
