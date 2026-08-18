import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/app-shell';
import { DataList } from '@/components/data-list';
import { chartOfAccountList, registerAllLists } from '@/server/lists';
import { rows } from '@/server/services/list';
import { withCurrentUser } from '@/server/session';
import { Denied } from '@/components/denied';
import { PermissionDeniedError } from '@domain/permissions';

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
    return (
      <AppShell>
        <Denied object={t('page.chart_of_accounts')} />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="page__header">
        <h1 className="page__title">{t('page.chart_of_accounts')}</h1>
      </div>

      <form className="list__toolbar" method="get">
        <input
          className="list__search"
          type="search"
          name="q"
          defaultValue={search ?? ''}
          placeholder={t('list.search_placeholder')}
          aria-label={t('list.search')}
        />
        <button className="action" type="submit">
          {t('list.search')}
        </button>
        <a className="action" href="/master-data/chart-of-accounts/export">
          {t('list.export')}
        </a>
      </form>

      <DataList
        columns={chartOfAccountList.columns}
        rows={result.rows}
        query={result.query}
        total={result.total}
        hrefFor={(row) => `/master-data/chart-of-accounts/${String(row.code)}`}
      />
    </AppShell>
  );
}
