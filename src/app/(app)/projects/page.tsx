import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as ps from '@/server/services/project-system';
import { createProject } from './actions';
import { chipOf } from './chip';

/**
 * Project Master — REQ-PM-001 §13. Copies the Purchase Invoices list: the
 * register, the search, the filters, the new-record dialog. The five
 * amounts are sums over the rows each time (R3).
 */
export const dynamic = 'force-dynamic';

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', ps.PERMISSION_OBJECT)) {
    return <Denied object={page('project_master')} />;
  }
  const mayCreate = can(principal, 'create', ps.PERMISSION_OBJECT);
  const params = await searchParams;
  const statusParam = typeof params.status === 'string' ? params.status : '';
  const typeParam = typeof params.type === 'string' ? params.type : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const today = businessToday();

  const { result, pickers, depts } = await withCurrentUser(async (tx) => ({
    result: await ps.list(tx, { status: statusParam || null, typeCode: typeParam || null, search: outcome.q, page: pageNo }),
    pickers: mayCreate ? await ps.pickers(tx) : null,
    depts: mayCreate ? (await departments.listAll(tx)).filter((d) => d.active) : [],
  }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const hrefFor = (p: number) =>
    `/projects?${[outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', statusParam ? `status=${statusParam}` : '', typeParam ? `type=${typeParam}` : '', `page=${p}`].filter(Boolean).join('&')}`;
  const typeLabel = (row: { typeName: string; typeNameAr: string | null }) => (locale === 'ar' && row.typeNameAr ? row.typeNameAr : row.typeName);

  return (
    <AdminPage
      actions={
        mayCreate && pickers ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new_title')}>
            <Form action={createProject}>
              <Grid>
                <Select label={x('type')} name="type_code" options={pickers.types.map((row) => ({ value: row.code, label: locale === 'ar' && row.nameAr ? row.nameAr : row.nameEn }))} required />
                <Field hint={x('code_hint')} label={column('code')} name="code" />
                <Field label={column('name')} name="name" required wide />
                <Select emptyLabel={x('no_customer')} label={x('customer')} name="customer_id" options={pickers.customers.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} />
                <Select label={x('manager')} name="manager_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} required />
                <Select emptyLabel="—" label={x('department')} name="department_code" options={depts.map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))} />
                <Field defaultValue={today} label={x('baseline_starts_on')} name="baseline_starts_on" required type="date" />
                <Field label={x('baseline_ends_on')} name="baseline_ends_on" required type="date" />
                <Field defaultValue="0" label={x('baseline_budget')} name="baseline_budget_iqd" required />
                <Field defaultValue="0" hint={x('contract_value_hint')} label={x('contract_value')} name="contract_value_iqd" />
                <Select
                  label={x('billing_method')}
                  name="billing_method"
                  options={['milestone', 'progress', 'time_and_material', 'lump_sum'].map((value) => ({ value, label: x(`billing_${value}`) }))}
                />
                <Field defaultValue="0" label={x('retention_percent')} name="retention_percent" />
                <Field defaultValue="0" label={x('advance_recovery_percent')} name="advance_recovery_percent" />
                <Select label={x('tolerance_profile')} name="tolerance_profile_code" options={pickers.profiles.map((p) => ({ value: p.code, label: locale === 'ar' && p.nameAr ? p.nameAr : p.nameEn }))} />
              </Grid>
              <Field label={x('description')} name="description" wide />
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="projects-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="projects-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select
                defaultValue={statusParam}
                emptyLabel={x('status_all')}
                label={column('status')}
                name="status"
                options={['draft', 'active', 'on_hold', 'closing', 'closed'].map((value) => ({ value, label: x(`status_${value}`) }))}
              />
              <Select defaultValue={typeParam} emptyLabel={x('type_all')} label={x('type')} name="type" options={(pickers?.types ?? []).map((row) => ({ value: row.code, label: locale === 'ar' && row.nameAr ? row.nameAr : row.nameEn }))} />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="projects-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{x('type')}</th>
                  <th scope="col">{x('customer')}</th>
                  <th scope="col">{x('manager')}</th>
                  <th scope="col">{x('baseline_ends_on')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('budget')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('committed')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('actual')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('available')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={11}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.code)}`}>
                        <bdi dir="ltr">{row.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{typeLabel(row)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.customerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.managerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.baselineEndsOn ? formatBusinessDate(row.baselineEndsOn, locale as Locale) : '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.budgetIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.committedIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.actualIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.availableIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${chipOf(row.status)} ${s.sapRegisterStatus}`} data-status={chipOf(row.status)}>
                        {x(`status_${row.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pagination
              count={pages}
              current={result.page}
              hrefFor={hrefFor}
              labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
