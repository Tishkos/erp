import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { EMPLOYMENT_KINDS } from '@/server/domain/hr';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as employees from '@/server/services/employees';
import * as hrSettings from '@/server/services/hr-settings';
import { createEmployee } from './actions';

/**
 * Employees — REQ-HR-001 Stage HR-1 (§4). Copies the Purchase Invoices list:
 * the register, the New dialog, the View filter, nothing else.
 */
export const dynamic = 'force-dynamic';

export default async function EmployeesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/employees')) notFound();

  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.employees'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', employees.PERMISSION_OBJECT)) {
    return <Denied object={page('employees')} />;
  }
  const mayCreate = can(principal, 'create', employees.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const departmentParam = typeof params.department === 'string' ? params.department : '';

  const { rows, departmentRows, positions, managers } = await withCurrentUser(async (tx) => ({
    rows: await employees.list(tx),
    departmentRows: await departments.listAll(tx),
    positions: mayCreate ? await hrSettings.positions(tx) : [],
    managers: mayCreate ? await employees.managersAvailable(tx) : [],
  }));

  const shown = rows
    .filter((row) => matches(row, outcome.q))
    .filter((row) => (viewParam ? row.status === viewParam : true))
    .filter((row) => (departmentParam ? row.departmentCode === departmentParam : true));
  const kind = (value: string) => x(`kind_${value}`);
  const statusTone = (value: string) => (value === 'active' ? 'approved' : value === 'suspended' ? 'submitted' : 'closed');

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={x('new')}
            closeLabel={t('close')}
            openOnLoad={params.new === '1' && Boolean(outcome.error)}
            title={x('new')}
          >
            <Form action={createEmployee}>
              <Grid>
                <Field label={x('full_name_en')} name="full_name_en" required requiredLabel={t('required_hint')} />
                <Field label={x('full_name_ar')} name="full_name_ar" />
                <Select
                  label={x('department')}
                  name="department_code"
                  options={departmentRows.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                  required
                />
                <Select
                  emptyLabel={x('no_position')}
                  label={x('position')}
                  name="position_code"
                  options={positions.filter((p) => p.active).map((p) => ({ value: p.code, label: `${p.code} · ${p.titleEn}` }))}
                />
                <Select
                  emptyLabel={x('no_manager')}
                  label={x('manager')}
                  name="manager_employee_id"
                  options={managers.map((m) => ({ value: m.id, label: `${m.employeeNo} · ${m.fullNameEn}` }))}
                />
                <Field defaultValue={businessToday()} label={x('hire_date')} name="hire_date" required type="date" />
                <Select
                  defaultValue="permanent"
                  label={x('employment_kind')}
                  name="employment_kind"
                  options={EMPLOYMENT_KINDS.map((value) => ({ value, label: kind(value) }))}
                  required
                />
                <Field hint={x('contract_end_hint')} label={x('contract_end_date')} name="contract_end_date" type="date" />
                <Field label={x('phone')} name="phone" />
                <Field label={x('national_id')} name="national_id" />
                <Field label={x('date_of_birth')} name="date_of_birth" type="date" />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/employees" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="emp-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="emp-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/employees"
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
                  { value: 'suspended', label: x('view_suspended') },
                  { value: 'ended', label: x('view_ended') },
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
            <table aria-labelledby="emp-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{x('department')}</th>
                  <th scope="col">{x('position')}</th>
                  <th scope="col">{x('manager')}</th>
                  <th scope="col">{x('hire_date')}</th>
                  <th scope="col">{x('employment_kind')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(row.employeeNo)}`}>
                        <bdi dir="ltr">{row.employeeNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.departmentName}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.positionTitle ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.managerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.hireDate, locale as Locale)}</bdi>
                    </td>
                    <td>{kind(row.employmentKind)}</td>
                    <td>
                      <span className={`status status--${statusTone(row.status)} ${s.sapRegisterStatus}`} data-status={statusTone(row.status)}>
                        {x(`status_${row.status}`)}
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
