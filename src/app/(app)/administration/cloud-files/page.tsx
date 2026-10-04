import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Checkbox,
  Field,
  Flash,
  Form,
  Grid,
  Inline,
  KeyValue,
  Mono,
  NewRecordDialog,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
} from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { secretKeyProblem } from '@/server/secret-box';
import { requireContext, withCurrentUser } from '@/server/session';
import * as settings from '@/server/services/cloud-settings';
import { deactivateMappingAction, saveMappingAction, saveSettingsAction, testConnectionAction } from './actions';

/**
 * QS Cloud Files — settings (Platform phase, Agent 4; IM2-6: everything the
 * integration needs is configured here, none of it in a file).
 *
 * Copies the Numbering screen: the page, a panel of fields, a table of what is
 * mapped. Whether the Document Center is on, where the cloud is, where it
 * starts and where record folders are made, and which Nextcloud group each
 * ERP role belongs to. Nothing here is a credential; the people's app
 * passwords are never on this screen.
 */
export const dynamic = 'force-dynamic';

export default async function CloudFilesSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, a, page, locale, context, outcome, params] = await Promise.all([
    getTranslations('cloudFiles'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', settings.PERMISSION_OBJECT)) return <Denied object={page('cloud_files_settings')} />;
  const mayConfigure = can(principal, 'configure', settings.PERMISSION_OBJECT);

  const { current, mappings, roles } = await withCurrentUser(async (tx) => ({
    current: await settings.get(tx),
    mappings: await settings.listMappings(tx),
    roles: mayConfigure ? await settings.listRoles(tx) : [],
  }));
  const keyProblem = secretKeyProblem();
  const test = typeof params.test === 'string' ? params.test : '';
  const version = typeof params.version === 'string' ? params.version : '';
  const reason = typeof params.reason === 'string' ? params.reason : '';

  return (
    <AdminPage
      actions={
        mayConfigure ? (
          <NewRecordDialog buttonLabel={t('map_role')} closeLabel={a('close')} openOnLoad={false} title={t('map_role')}>
            <Form action={saveMappingAction}>
              <Grid>
                <Select label={t('map_role_label')} name="role_code" options={roles.map((role) => ({ value: role.code, label: role.name }))} required />
                <Field hint={t('map_group_hint')} label={t('map_group')} maxLength={64} name="group_name" required requiredLabel={a('required_hint')} />
              </Grid>
              <Inline>
                <Checkbox label={t('map_write')} name="can_write" />
                <Checkbox label={t('map_share')} name="can_share" />
              </Inline>
              <SubmitRow>
                <Submit label={a('save')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: a('dashboard_label') }}
      subtitle={t('settings_subtitle')}
      tabs={<SectionTabs route="/administration/cloud-files" />}
      title={page('cloud_files_settings')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={a('error_title')} saved={outcome.saved} savedLabel={a('saved')} />
      {test === 'ok' ? <Flash error={null} errorTitle="" saved savedLabel={t('test_ok', { version: version || '—' })} /> : null}
      {test === 'failed' ? <Flash error={reason || t('test_failed')} errorTitle={t('test_failed_title')} saved={false} savedLabel="" /> : null}
      {test === 'maintenance' ? <Flash error={t('test_maintenance')} errorTitle={t('test_failed_title')} saved={false} savedLabel="" /> : null}
      {test === 'not_installed' ? <Flash error={t('test_not_installed')} errorTitle={t('test_failed_title')} saved={false} savedLabel="" /> : null}
      {keyProblem ? <Flash error={t('key_missing', { problem: keyProblem })} errorTitle={t('key_title')} saved={false} savedLabel="" /> : null}

      <Panel title={t('settings_connection')}>
        {mayConfigure ? (
          <Form action={saveSettingsAction}>
            <Grid>
              <Field defaultValue={current.baseUrl ?? ''} hint={t('address_hint')} label={t('address')} name="address" placeholder="https://files.qs-groups.com" required requiredLabel={a('required_hint')} type="text" wide />
              <Field defaultValue={current.rootPath} hint={t('root_hint')} label={t('root_path')} name="root_path" required requiredLabel={a('required_hint')} />
              <Field defaultValue={current.recordRoot} hint={t('record_root_hint')} label={t('record_root')} name="record_root" required requiredLabel={a('required_hint')} />
            </Grid>
            <Inline>
              <Checkbox defaultChecked={current.enabled} label={t('enabled')} name="enabled" />
            </Inline>
            <SubmitRow>
              <Submit label={a('save')} />
              <Submit formAction={testConnectionAction} label={t('test_connection')} tone="secondary" />
            </SubmitRow>
          </Form>
        ) : (
          <KeyValue
            rows={[
              { label: t('enabled'), value: <Pill label={current.enabled ? a('active') : a('inactive')} on={current.enabled} /> },
              { label: t('address'), value: <Mono>{current.baseUrl ?? '—'}</Mono> },
              { label: t('root_path'), value: <Mono>{current.rootPath}</Mono> },
              { label: t('record_root'), value: <Mono>{current.recordRoot}</Mono> },
            ]}
          />
        )}
        <p className="muted">{t('settings_updated', { time: formatTimestamp(current.updatedAt.toISOString(), locale as Locale) })}</p>
      </Panel>

      <Panel title={t('mappings_title')}>
        <p className="muted">{t('mappings_hint')}</p>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{t('col_role')}</th>
                <th scope="col">{t('col_group')}</th>
                <th scope="col">{t('col_write')}</th>
                <th scope="col">{t('col_share')}</th>
                <th scope="col">{a('active')}</th>
                {mayConfigure ? <th scope="col">{t('col_actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {mappings.length === 0 ? (
                <tr>
                  <td colSpan={mayConfigure ? 6 : 5}>{t('mappings_none')}</td>
                </tr>
              ) : null}
              {mappings.map((row) => (
                <tr key={row.roleCode}>
                  <td>{row.roleName}</td>
                  <td>
                    <Mono>{row.groupName}</Mono>
                  </td>
                  <td>{row.canWrite ? a('yes') : a('no')}</td>
                  <td>{row.canShare ? a('yes') : a('no')}</td>
                  <td>
                    <Pill label={row.active ? a('active') : a('inactive')} on={row.active} />
                    {row.deactivatedReason ? <div className="muted">{row.deactivatedReason}</div> : null}
                  </td>
                  {mayConfigure ? (
                    <td>
                      {row.active ? (
                        <ReasonForm action={deactivateMappingAction} hidden={{ role_code: row.roleCode }} label={a('deactivate')} reasonLabel={`${t('deactivate_reason')} (${row.roleName})`} />
                      ) : (
                        <ActionButton
                          action={saveMappingAction}
                          hidden={{ role_code: row.roleCode, group_name: row.groupName, ...(row.canWrite ? { can_write: '1' } : {}), ...(row.canShare ? { can_share: '1' } : {}) }}
                          label={t('reactivate')}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <RecordHistory objectId="1" objectType={settings.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
