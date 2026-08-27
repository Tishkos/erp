import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Field, Flash, Form, Grid, ListToolbar, NewRecordDialog, Submit, SubmitRow, matches } from '@/components/admin';
import { AutoCode } from '@/components/admin/auto-code';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as roles from '@/server/services/roles';
import { createRole } from './actions';

/** Roles — Phase 0 requirement 5. */
export const dynamic = 'force-dynamic';

export default async function RolesPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', roles.PERMISSION_OBJECT)) {
    return <Denied object={page('roles')} />;
  }
  const mayCreate = can(principal, 'create', roles.PERMISSION_OBJECT);
  const rows = await withCurrentUser((tx) => roles.listAll(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog
            buttonLabel={t('roles.new')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('roles.new')}
          >
              <AutoCode codeId="f-code" mode="lower" nameId="f-name" />
              <Form action={createRole}>
                <Grid>
                  <Field hint={t('code_auto_hint')} label={t('code')} name="code" />
                  <Field label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                  <Field label={t('description')} name="description" type="textarea" wide />
                </Grid>
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
              </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/administration/roles" />}
      subtitle={t('roles.subtitle')}
      title={t('roles.title')}
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
          clearHref="/administration/roles"
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
                <th scope="col">{column('description')}</th>
                <th className="numeric" scope="col">
                  {column('grants')}
                </th>
                <th className="numeric" scope="col">
                  {column('holders')}
                </th>
                <th scope="col">{column('is_system')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.code}>
                  <td>
                    <Link href={`/administration/roles/${encodeURIComponent(row.code)}`}>{row.code}</Link>
                  </td>
                  <td>{row.name}</td>
                  <td>{row.description ?? t('none')}</td>
                  <td className="numeric">{row.grantCount}</td>
                  <td className="numeric">{row.holderCount}</td>
                  <td>{row.isSystem ? t('yes') : t('no')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

    </AdminPage>
  );
}
