import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
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
import { AutoCode } from '@/components/admin/auto-code';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as users from '@/server/services/users';
import { createBranch } from './actions';

/** Branches — Phase 0 requirement 2. */
export const dynamic = 'force-dynamic';

export default async function BranchesPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', branches.PERMISSION_OBJECT)) {
    return <Denied object={page('branches')} />;
  }
  const mayCreate = can(principal, 'create', branches.PERMISSION_OBJECT);

  const { rows, people } = await withCurrentUser(async (tx) => ({
    rows: await branches.listAll(tx),
    people: mayCreate ? await users.listAll(tx) : [],
  }));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('branches.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('branches.new')}
          >
              <p className="muted">{t('branches.created_note')}</p>
              <AutoCode codeId="f-code" mode="upper" nameId="f-name" />
              <Form action={createBranch}>
                <Grid>
                  <Field hint={t('code_auto_hint')} label={t('code')} name="code" />
                  <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                  <Select
                    emptyLabel={t('branches.no_manager')}
                    label={t('branches.manager')}
                    name="managerUserId"
                    options={people
                      .filter((p) => p.isActive)
                      .map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))}
                  />
                  <Field label={t('branches.address')} name="address" type="textarea" wide />
                </Grid>
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
              </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/master-data/branches" />}
      subtitle={t('branches.subtitle')}
      title={t('branches.title')}
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
          clearHref="/master-data/branches"
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
                <th scope="col">{column('manager')}</th>
                <th scope="col">{column('default_warehouse')}</th>
                <th scope="col">{column('active')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/master-data/branches/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.managerName ?? t('none')}</td>
                  <td>{row.defaultWarehouseCode ?? t('none')}</td>
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
