import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s, matches } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departmentService from '@/server/services/departments';
import * as employees from '@/server/services/employees';
import * as structure from '@/server/services/hr-structure';
import { createDepartment } from './actions';

/**
 * Departments — REQ-FIX-001 FIX-5. Copies the Purchase Invoices list: the
 * register, the New dialog, the View filter, nothing else. A department is
 * the company's one department row; HR sees its people and its seats.
 */
export const dynamic = 'force-dynamic';

export default async function DepartmentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/departments')) notFound();

  const [t, x, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_structure'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', employees.ORGANISATION_OBJECT)) {
    return <Denied object={page('hr_departments')} />;
  }
  // The row is Finance's master as much as HR's: whoever may create a
  // department may create it here, under the same rule.
  const mayCreate = can(principal, 'create', departmentService.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const rows = await withCurrentUser((tx) => structure.departments(tx));
  const shown = rows.filter((row) => matches(row, outcome.q)).filter((row) => (viewParam === 'active' ? row.active : viewParam === 'inactive' ? !row.active : true));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new_department')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new_department')}>
            <Form action={createDepartment}>
              <Grid>
                <Field label={x('name')} name="name" required requiredLabel={t('required_hint')} />
                <Select emptyLabel={x('no_parent')} label={x('parent')} name="parent_code" options={rows.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))} />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/departments" />}
      subtitle={x('departments_subtitle')}
      title={x('departments_title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="dept-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="dept-list-title">
            <span>{x('departments_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/departments"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={[
                  { value: 'active', label: x('view_active') },
                  { value: 'inactive', label: x('view_inactive') },
                ]}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="dept-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{x('parent')}</th>
                  <th scope="col">{x('manager')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('headcount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('seats')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('vacant')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {x('departments_none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/departments/${encodeURIComponent(row.code)}`}>
                        <bdi dir="ltr">{row.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.parentName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.managerName ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.headcount}</td>
                    <td className={s.sapNum}>{row.seats}</td>
                    <td className={s.sapNum}>{row.vacant}</td>
                    <td>
                      <span className={`status status--${row.active ? 'approved' : 'closed'} ${s.sapRegisterStatus}`} data-status={row.active ? 'approved' : 'closed'}>
                        {row.active ? t('active') : t('inactive')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
