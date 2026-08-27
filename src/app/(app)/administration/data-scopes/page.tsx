import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { asc, eq } from 'drizzle-orm';
import { Panel } from '@/components/ui';
import { AdminPage, ListToolbar, Pill, matches } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { appUser, branch, userBranchScope } from '@/server/db/schema';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';

/** Data Scopes — which branches each person may work in (§4.1, D10). */
export const dynamic = 'force-dynamic';

export default async function DataScopesPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'view', 'data_scope')) {
    return <Denied object={page('data_scopes')} />;
  }

  const rows = await withCurrentUser((tx) =>
    tx
      .select({
        userId: appUser.id,
        displayName: appUser.displayName,
        email: appUser.email,
        isActive: appUser.isActive,
        branchCode: userBranchScope.branchCode,
        branchName: branch.name,
        isDefault: userBranchScope.isDefault,
      })
      .from(userBranchScope)
      .innerJoin(appUser, eq(appUser.id, userBranchScope.userId))
      .innerJoin(branch, eq(branch.code, userBranchScope.branchCode))
      .orderBy(asc(appUser.displayName), asc(userBranchScope.branchCode)),
  );

  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage tabs={<SectionTabs route="/administration/data-scopes" />} back={{ href: '/', label: t('dashboard_label') }} subtitle={t('data_scopes.subtitle')} title={t('data_scopes.title')}>
      <Panel flush>
        <ListToolbar
          clearHref="/administration/data-scopes"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        {rows.length === 0 ? (
          <p className="muted" style={{ padding: '1rem' }}>
            {t('data_scopes.empty')}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th scope="col">{column('display_name')}</th>
                  <th scope="col">{column('email')}</th>
                  <th scope="col">{column('branch_code')}</th>
                  <th scope="col">{column('is_default')}</th>
                  <th scope="col">{column('active')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={`${row.userId}-${row.branchCode}`}>
                    <td>
                      <Link href={`/administration/users/${row.userId}`}>{row.displayName}</Link>
                    </td>
                    <td>{row.email}</td>
                    <td>
                      {row.branchCode} · {row.branchName}
                    </td>
                    <td>{row.isDefault ? t('yes') : t('no')}</td>
                    <td>
                      <Pill label={row.isActive ? t('active') : t('inactive')} on={row.isActive} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </AdminPage>
  );
}
