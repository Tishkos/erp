import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, LinkButton, ListToolbar, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { visibleRoute } from '@/server/phase-gate';
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
 * Chart of Accounts list — Phase 01.12's first screen on the list framework,
 * drawn in the same window as every other master-data screen.
 *
 * The page itself holds no query logic. It asks the list service for a page of
 * rows under the caller's own principal; permission, column visibility and
 * scope are all decided there, so this file cannot widen them by accident.
 */
export const dynamic = 'force-dynamic';

export default async function ChartOfAccountsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/master-data/chart-of-accounts')) notFound();
  registerAllLists();

  const [t, chart, page, list, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('chart'),
    getTranslations('page'),
    getTranslations('list'),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const search = outcome.q || undefined;
  const pageNo = typeof params.page === 'string' ? Number(params.page) : 1;

  // The permission is enforced by the service, and the refusal is rendered
  // rather than thrown: the 01.2 gate is that a direct URL is denied, and a
  // denial the user can read is the difference between a permission request
  // and a support ticket (§25).
  const result = await withCurrentUser((tx, context) =>
    rows(tx, context.principal, 'chart_of_account', {
      ...(search ? { search } : {}),
      page: Number.isFinite(pageNo) && pageNo > 0 ? pageNo : 1,
    }),
  ).catch((error) => {
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  });

  if (!result) {
    return <Denied object={page('chart_of_accounts')} />;
  }

  // Phase 1 §1 — raising an account. The picker shows the whole chart so a
  // person can see where the new one will sit, and offers only the headers.
  const accounts = await withCurrentUser(async (tx, context) =>
    can(context.principal, 'create', 'chart_of_account') ? await coa.pickerTree(tx) : [],
  );
  const exportHref = search
    ? `/master-data/chart-of-accounts/export?q=${encodeURIComponent(search)}`
    : '/master-data/chart-of-accounts/export';
  const count = result.total ?? result.rows.length;

  return (
    <AdminPage
      actions={
        <>
          <LinkButton href={exportHref} label={list('export')} />
          {accounts.length > 0 ? <NewAccountButton accounts={accounts} /> : null}
        </>
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/chart-of-accounts" />}
      subtitle={chart('subtitle')}
      title={page('chart_of_accounts')}
      variant="sap"
    >
      <section aria-labelledby="chart-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="chart-title">
            <span>{page('chart_of_accounts')}</span>
            <span className={s.sapTitleMeta}>{list('row_count', { count })}</span>
          </h2>
          <ListToolbar
            clearHref="/master-data/chart-of-accounts"
            clearLabel={t('clear_search')}
            countLabel={list('row_count', { count })}
            placeholder={chart('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />
          <ChartOfAccountsWorkspace query={result.query} rows={result.rows} search={search ?? ''} total={result.total} />
        </div>
      </section>
    </AdminPage>
  );
}
