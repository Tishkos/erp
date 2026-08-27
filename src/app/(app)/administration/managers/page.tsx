import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, LinkButton, ListToolbar, Pill, matches } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';

/** Department Manager toggles — Phase 0 requirement 6, who finalises what. */
export const dynamic = 'force-dynamic';

export default async function ManagersPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'view', 'user_department_scope')) {
    return <Denied object={page('department_manager_toggles')} />;
  }

  const rows = await withCurrentUser(async (tx) => {
    const all = await departments.listAll(tx);
    const result = [];
    for (const d of all) {
      const members = await departments.members(tx, d.code);
      result.push({ department: d, managers: members.filter((m) => m.isManager), memberCount: members.length });
    }
    return result;
  });

  const shown = rows.filter((r) =>
    matches(
      { ...r.department, managers: r.managers.map((m) => m.displayName).join(' ') },
      outcome.q,
    ),
  );

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/administration/managers" />}
      actions={<LinkButton href="/master-data/departments" label={t('departments.title')} />}
      subtitle={t('managers.subtitle')}
      title={t('managers.title')}
    >
      <Panel flush>
        <ListToolbar
          clearHref="/administration/managers"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        {rows.every((r) => r.managers.length === 0) ? (
          <p className="muted" style={{ padding: '1rem' }}>
            {t('managers.empty')}
          </p>
        ) : null}
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('department')}</th>
                <th scope="col">{column('manager')}</th>
                <th scope="col">{t('departments.members')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ department, managers, memberCount }) => (
                <tr key={department.code}>
                  <td>
                    <Link href={`/master-data/departments/${encodeURIComponent(department.code)}`}>
                      {department.code} · {department.name}
                    </Link>
                  </td>
                  <td>
                    {managers.length === 0
                      ? t('departments.no_manager')
                      : managers.map((m) => (
                          <span key={m.userId} style={{ display: 'block' }}>
                            <Link href={`/administration/users/${m.userId}`}>{m.displayName}</Link>
                          </span>
                        ))}
                  </td>
                  <td>{memberCount}</td>
                  <td>
                    <Pill label={department.active ? t('active') : t('inactive')} on={department.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
