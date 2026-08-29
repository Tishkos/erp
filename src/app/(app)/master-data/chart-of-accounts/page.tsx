import { getTranslations } from 'next-intl/server';
import { admin as s } from '@/components/admin';
import { Workspace } from '@/components/ui';
import { visibleRoute } from '@/server/phase-gate';
import { notFound } from 'next/navigation';
import { ChartOfAccountsWorkspace } from '@/components/chart-of-accounts-workspace';
import { registerAllLists } from '@/server/lists';
import { rows } from '@/server/services/list';
import { withCurrentUser } from '@/server/session';
import { Denied } from '@/components/denied';
import { PermissionDeniedError, can } from '@domain/permissions';
import { NewAccountButton } from '@/components/admin/account-controls';
import { SectionTabs } from '@/components/admin/section-tabs';
import * as coa from '@/server/services/chart-of-accounts';

/**
 * Chart of Accounts list — Phase 01.12's first screen on the list framework.
 *
 * The page itself holds no query logic. It asks the list service for a page of
 * rows under the caller's own principal; permission, column visibility and
 * scope are all decided there, so this file cannot widen them by accident.
 */
export const dynamic = 'force-dynamic';

export default async function ChartOfAccountsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!visibleRoute('/master-data/chart-of-accounts')) notFound();
  registerAllLists();

  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q : undefined;
  const page = typeof params.page === 'string' ? Number(params.page) : 1;

  const t = await getTranslations();

  // The permission is enforced by the service, and the refusal is rendered
  // rather than thrown: the 01.2 gate is that a direct URL is denied, and a
  // denial the user can read is the difference between a permission request
  // and a support ticket (§25).
  const result = await withCurrentUser((tx, context) =>
    rows(tx, context.principal, 'chart_of_account', {
      ...(search ? { search } : {}),
      page: Number.isFinite(page) && page > 0 ? page : 1,
    }),
  ).catch((error) => {
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  });

  if (!result) {
    return <Denied object={t('page.chart_of_accounts')} />;
  }

  // Phase 1 §1 — raising an account. The picker shows the whole chart so a
  // person can see where the new one will sit, and offers only the headers.
  const accounts = await withCurrentUser(async (tx, context) =>
    can(context.principal, 'create', 'chart_of_account') ? await coa.pickerTree(tx) : [],
  );

  return (
    <Workspace className={s.sapPage}>
      <div className="new-account-bar">
        <SectionTabs route="/master-data/chart-of-accounts" />
        {accounts.length > 0 ? <NewAccountButton accounts={accounts} /> : null}
      </div>
      <ChartOfAccountsWorkspace
        rows={result.rows}
        query={result.query}
        total={result.total}
        search={search ?? ''}
      />
    </Workspace>
  );
}
