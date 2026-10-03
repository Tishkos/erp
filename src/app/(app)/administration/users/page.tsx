import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  Select,
  Submit,
  SubmitRow,
  NewRecordDialog,
  ListToolbar,
  admin,
  matches,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can, isCeo } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as departments from '@/server/services/departments';
import * as hrSettings from '@/server/services/hr-settings';
import * as roles from '@/server/services/roles';
import * as users from '@/server/services/users';
import { createUser } from './actions';

/** User Management — Phase 0 requirement 4. */
export const dynamic = 'force-dynamic';

export default async function UsersPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', users.PERMISSION_OBJECT)) {
    return <Denied object={page('users')} />;
  }
  const mayCreate = can(principal, 'create', users.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => ({
    rows: await users.listAll(tx),
    roles: isCeo(principal) ? await roles.listAll(tx) : [],
    branches: mayCreate ? await branches.listAll(tx) : [],
    departments: mayCreate ? await departments.listAll(tx) : [],
    positions: mayCreate ? await hrSettings.positions(tx) : [],
  }));

  const shown = data.rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('users.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('users.new')}
          >
              <Form action={createUser}>
                <Grid>
                  <Field
                    label={t('users.email')}
                    name="email"
                    required
                    requiredLabel={t('required_hint')}
                    type="email"
                  />
                  <Field
                    label={t('users.display_name')}
                    name="displayName"
                    required
                    requiredLabel={t('required_hint')}
                  />
                </Grid>
                <Grid>
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                      {t('users.roles')}
                    </legend>
                    {data.roles.map((r) => (
                      <div key={r.code}>
                        <Checkbox label={`${r.name} (${r.code})`} name="roleCodes" value={r.code} />
                      </div>
                    ))}
                  </fieldset>
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                      {t('users.branches')}
                    </legend>
                    {data.branches
                      .filter((b) => b.active)
                      .map((b) => (
                        <div key={b.code}>
                          <Checkbox label={`${b.code} · ${b.name}`} name="branchCodes" value={b.code} />
                        </div>
                      ))}
                  </fieldset>
                  <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="muted" style={{ fontSize: '0.78rem', fontWeight: 600 }}>
                      {t('users.departments')}
                    </legend>
                    {data.departments
                      .filter((d) => d.active)
                      .map((d) => (
                        <div key={d.code}>
                          <Checkbox label={`${d.code} · ${d.name}`} name="departmentCodes" value={d.code} />
                        </div>
                      ))}
                  </fieldset>
                  <Select
                    emptyLabel={t('none')}
                    label={t('users.default_branch')}
                    name="defaultBranchCode"
                    options={data.branches.filter((b) => b.active).map((b) => ({ value: b.code, label: b.code }))}
                  />
                </Grid>
                {/* REQ-FIX-001 FIX-5 — the person behind the account, in HR with it. */}
                <Checkbox defaultChecked label={t('users.also_employee')} name="alsoEmployee" />
                <Grid>
                  <Select
                    emptyLabel={t('users.employee_department_first')}
                    hint={t('users.also_employee_hint')}
                    label={t('users.employee_department')}
                    name="employeeDepartmentCode"
                    options={data.departments.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                  />
                  <Select
                    emptyLabel={t('none')}
                    label={t('users.employee_position')}
                    name="employeePositionCode"
                    options={data.positions.filter((p) => p.active).map((p) => ({ value: p.code, label: `${p.code} · ${p.titleEn}` }))}
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
      tabs={<SectionTabs route="/administration/users" />}
      subtitle={t('users.subtitle')}
      title={t('users.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <ListToolbar
          clearHref="/administration/users"
          clearLabel={t('clear_search')}
          countLabel={t('rows_shown', { count: shown.length })}
          placeholder={t('search_placeholder')}
          q={outcome.q}
          searchLabel={t('search')}
        />
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('display_name')}</th>
                <th scope="col">{column('email')}</th>
                <th scope="col">{column('super_user')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link className={admin.personCell} href={`/administration/users/${row.id}`}>
                      {row.image ? (
                        <img alt="" className={admin.avatarSmall} src={row.image} />
                      ) : (
                        <span className={admin.avatarSmall}>{row.displayName.slice(0, 1).toUpperCase()}</span>
                      )}
                      <span>{row.displayName}</span>
                    </Link>
                  </td>
                  <td>{row.email}</td>
                  <td>{row.isSuperUser ? t('yes') : t('no')}</td>
                  <td>
                    <Pill label={row.isActive ? t('active') : t('inactive')} on={row.isActive} />
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
