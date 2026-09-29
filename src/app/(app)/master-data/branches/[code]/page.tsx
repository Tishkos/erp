import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Building2 } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { AdminNotFoundError } from '@/server/services/administration';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as users from '@/server/services/users';
import { setBranchActive, updateBranch } from '../actions';

/** One branch — Phase 0 requirement 2, in the two-column record layout. */
export const dynamic = 'force-dynamic';

export default async function BranchPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  const [t, page, locale, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', branches.PERMISSION_OBJECT)) {
    return <Denied object={page('branches')} />;
  }
  const mayEdit = can(principal, 'configure', branches.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', branches.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      const row = await branches.detail(tx, code);
      const people = mayEdit ? await users.listAll(tx) : [];
      return { row, people };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, people } = data;
  const manager = people.find((p) => p.id === row.managerUserId);

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/branches', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        {/* Left: identity, facts, lifecycle */}
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Building2 aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {t('code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{t('branches.manager')}</span>
                <span>{manager?.displayName ?? t('branches.no_manager')}</span>
              </li>
              <li>
                <span>{t('branches.default_warehouse')}</span>
                <span>{row.defaultWarehouseCode ?? t('none')}</span>
              </li>
              <li>
                <span>{t('branches.address')}</span>
                <span>{row.address ?? t('none')}</span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{formatTimestamp(row.createdAt.toISOString(), locale as Locale)}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('branches.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setBranchActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setBranchActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        {/* Right: editing + history */}
        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateBranch}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field defaultValue={row.name} label={t('name')} name="name" required requiredLabel={t('required_hint')} />
                  <Select
                    defaultValue={row.managerUserId ?? ''}
                    emptyLabel={t('branches.no_manager')}
                    label={t('branches.manager')}
                    name="managerUserId"
                    options={people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))}
                  />
                  <Field defaultValue={row.address} label={t('branches.address')} name="address" type="textarea" wide />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          {/* Who was given this branch, and who was made to start in it, is
              written on the person; the branch's log shows it too. */}
          <RecordHistory
            objectId={row.code}
            objectType={branches.PERMISSION_OBJECT}
            related={[{ objectType: 'app_user', field: 'branchCode', value: row.code }]}
          />
        </div>
      </div>
    </AdminPage>
  );
}
