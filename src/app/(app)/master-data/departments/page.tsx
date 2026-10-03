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
  matches,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import { createDepartment } from './actions';

/** Departments — Phase 0 requirement 3. */
export const dynamic = 'force-dynamic';

export default async function DepartmentsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', departments.PERMISSION_OBJECT)) {
    return <Denied object={page('departments')} />;
  }
  const mayCreate = can(principal, 'create', departments.PERMISSION_OBJECT);
  const rows = await withCurrentUser((tx) => departments.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('departments.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('departments.new')}
          >
              <p className="muted">{t('minted_code_note')}</p>
              <Form action={createDepartment}>
                <Grid>
                  <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                  <Select
                    emptyLabel={t('departments.no_parent')}
                    label={t('departments.parent')}
                    name="parentCode"
                    options={rows.map((r) => ({ value: r.code, label: `${r.code} · ${r.name}` }))}
                  />
                </Grid>
                <Checkbox label={t('departments.is_finance')} name="isFinance" />
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
              </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/departments" />}
      subtitle={t('departments.subtitle')}
      title={t('departments.title')}
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
          clearHref="/master-data/departments"
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
                <th scope="col">{column('code')}</th>
                <th scope="col">{column('name')}</th>
                <th scope="col">{column('parent')}</th>
                <th scope="col">{column('manager')}</th>
                <th scope="col">{column('is_finance')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/departments/${encodeURIComponent(row.code)}`}>
                      {row.code}
                    </Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.parentCode ?? t('none')}</td>
                  <td>{row.managerName ?? t('departments.no_manager')}</td>
                  <td>{row.isFinance ? t('yes') : t('no')}</td>
                  <td>
                    <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
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
