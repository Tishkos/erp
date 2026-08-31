import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Target } from 'lucide-react';
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
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as costCentres from '@/server/services/cost-centres';
import * as users from '@/server/services/users';
import { setCostCentreActive, updateCostCentre } from '../actions';

/** One cost centre — Phase 2 requirement 1, in the two-column record layout. */
export const dynamic = 'force-dynamic';

export default async function CostCentrePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/cost-centres')) notFound();

  const [t, page, column, locale, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', costCentres.PERMISSION_OBJECT)) {
    return <Denied object={page('cost_centres')} />;
  }
  const mayEdit = can(principal, 'configure', costCentres.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', costCentres.PERMISSION_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    try {
      return {
        row: await costCentres.detail(tx, code),
        people: mayEdit ? await users.listAll(tx) : [],
        places: mayEdit ? await branches.listAll(tx) : [],
      };
    } catch (error) {
      if (error instanceof AdminNotFoundError) return null;
      throw error;
    }
  });
  if (!data) notFound();
  const { row, people, places } = data;

  return (
    <AdminPage
      actions={<AuditLogButton label={t('history')} />}
      back={{ href: '/master-data/cost-centres', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <div className={s.profileGrid}>
        <div className={s.profileStack}>
          <Panel>
            <div className={s.profileCard}>
              <span className={`${s.avatarLarge} ${s.profileAvatar}`}>
                <Target aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
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
                <span>{t('cost_centres.owner')}</span>
                <span>{row.ownerName ?? t('cost_centres.no_owner')}</span>
              </li>
              <li>
                <span>{column('branch_code')}</span>
                <span>
                  {row.branchCode
                    ? `${row.branchCode}${row.branchName ? ` · ${row.branchName}` : ''}`
                    : t('cost_centres.company_wide')}
                </span>
              </li>
              <li>
                <span>{t('created_at')}</span>
                <span>{formatTimestamp(row.createdAt.toISOString(), locale as Locale)}</span>
              </li>
            </ul>
          </Panel>

          {mayAdminister ? (
            <Panel title={row.active ? t('cost_centres.deactivate_title') : t('reactivate')}>
              {row.active ? (
                <ReasonForm
                  action={setCostCentreActive}
                  hidden={{ code: row.code }}
                  label={t('deactivate')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setCostCentreActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('reactivate')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={updateCostCentre}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    label={t('name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                  <Select
                    defaultValue={row.ownerUserId ?? ''}
                    emptyLabel={t('cost_centres.no_owner')}
                    label={t('cost_centres.owner')}
                    name="ownerUserId"
                    options={people.map((p) => ({ value: p.id, label: `${p.displayName} · ${p.email}` }))}
                  />
                  <Select
                    defaultValue={row.branchCode ?? ''}
                    emptyLabel={t('cost_centres.company_wide')}
                    hint={t('cost_centres.branch_hint')}
                    label={column('branch_code')}
                    name="branchCode"
                    options={places.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <RecordHistory objectId={row.code} objectType={costCentres.PERMISSION_OBJECT} />
        </div>
      </div>
    </AdminPage>
  );
}
