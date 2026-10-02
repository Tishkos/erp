import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s, matches } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as employees from '@/server/services/employees';
import * as hrSettings from '@/server/services/hr-settings';
import * as structure from '@/server/services/hr-structure';
import { createPosition } from './actions';

/**
 * Positions — REQ-FIX-001 FIX-5. Copies the Purchase Invoices list: the
 * register, the New dialog (a title and a department; the code is minted),
 * the filters, nothing else.
 */
export const dynamic = 'force-dynamic';

export default async function PositionsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/positions')) notFound();

  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_structure'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', employees.ORGANISATION_OBJECT)) {
    return <Denied object={page('hr_positions')} />;
  }
  const mayCreate = can(principal, 'configure', hrSettings.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const departmentParam = typeof params.department === 'string' ? params.department : '';
  const { rows, departmentRows } = await withCurrentUser(async (tx) => ({
    rows: await structure.positions(tx),
    departmentRows: await structure.departments(tx),
  }));
  const shown = rows
    .filter((row) => matches(row, outcome.q))
    .filter((row) => (viewParam === 'active' ? row.active : viewParam === 'inactive' ? !row.active : viewParam === 'vacant' ? row.active && row.holders === 0 : true))
    .filter((row) => (departmentParam ? row.departmentCode === departmentParam : true));
  const title = (row: { titleEn: string; titleAr: string | null }) => (locale === 'ar' && row.titleAr ? row.titleAr : row.titleEn);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new_position')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new_position')}>
            <Form action={createPosition}>
              <Grid>
                <Field label={x('title_en')} name="title_en" required requiredLabel={t('required_hint')} />
                <Field label={x('title_ar')} name="title_ar" />
                <Select label={x('department')} name="department_code" options={departmentRows.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))} required />
                <Select
                  emptyLabel={x('reports_to_none')}
                  label={x('reports_to')}
                  name="reports_to_code"
                  options={rows.filter((p) => p.active).map((p) => ({ value: p.code, label: `${p.code} · ${p.titleEn}` }))}
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/positions" />}
      subtitle={x('positions_subtitle')}
      title={x('positions_title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="pos-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pos-list-title">
            <span>{x('positions_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/positions"
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
                  { value: 'vacant', label: x('view_vacant') },
                  { value: 'inactive', label: x('view_inactive') },
                ]}
              />
              <Select
                defaultValue={departmentParam}
                emptyLabel={x('view_all')}
                label={x('department')}
                name="department"
                options={departmentRows.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="pos-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{x('position')}</th>
                  <th scope="col">{x('department')}</th>
                  <th scope="col">{x('reports_to')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('holders')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {x('positions_none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/positions/${encodeURIComponent(row.code)}`}>
                        <bdi dir="ltr">{row.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{title(row)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.departmentName}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.reportsToTitle ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.holders}</td>
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
