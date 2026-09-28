import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  KeyValue,
  Submit,
  SubmitRow,
} from '@/components/admin';
import { GrantMatrix } from '@/components/admin/grant-matrix';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can, isCeo } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as roles from '@/server/services/roles';
import { saveRoleGrants, updateRole } from '../actions';

export const dynamic = 'force-dynamic';

export default async function RolePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  const [t, page, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', roles.PERMISSION_OBJECT)) {
    return <Denied object={page('roles')} />;
  }
  const mayEdit = isCeo(principal) && can(principal, 'configure', roles.PERMISSION_OBJECT);
  const mayGrant = isCeo(principal) && can(principal, 'administer', 'permission');

  const row = await withCurrentUser(async (tx) => {
    try {
      return await roles.get(tx, code);
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!row) notFound();
  const held = new Set(row.grants.map((g) => `${g.object}:${g.verb}`));

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/administration/roles', label: t('back') }}
      subtitle={row.description ?? undefined}
      title={`${row.name} (${row.code})`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <Panel title={t('details')}>
        <KeyValue
          rows={[
            { label: t('code'), value: row.code },
            { label: t('roles.system'), value: row.isSystem ? t('yes') : t('no') },
            { label: t('roles.grants'), value: row.grants.length },
          ]}
        />
        {row.isSystem ? <p className="muted">{t('roles.system_note')}</p> : null}
      </Panel>

      {mayEdit && !row.isSystem ? (
        <Panel title={t('update')}>
          <Form action={updateRole}>
            <input name="code" type="hidden" value={row.code} />
            <Grid>
              <Field defaultValue={row.name} label={t('name')} name="name" required requiredLabel={t('required_hint')} />
              <Field defaultValue={row.description} label={t('description')} name="description" type="textarea" wide />
            </Grid>
            <SubmitRow>
              <Submit label={t('save')} />
            </SubmitRow>
          </Form>
        </Panel>
      ) : null}

      <Panel title={t('roles.edit_grants')}>
        <GrantMatrix action={saveRoleGrants} editable={mayGrant} held={held} roleCode={row.code} />
      </Panel>

      <RecordHistory objectId={row.code} objectType={roles.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
