import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as ps from '@/server/services/project-system';
import * as billing from '@/server/services/project-billing';
import { ratifyRecognition, saveCostCode, saveProjectType, saveToleranceProfile, setCostCodeActive, setProjectTypeActive, setToleranceProfileActive } from './actions';

/**
 * Project settings — REQ-PM-001 R4. Copies the HR Settings screen: stacked
 * windows — project types, tolerance profiles, cost codes, and (PM-5) the
 * revenue-recognition method Finance ratifies — each a register with its
 * form under it. Nothing deletes; a row is deactivated.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/administration/project-settings')) notFound();
  const [t, admin, page, context, outcome] = await Promise.all([
    getTranslations('admin.project_settings'),
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', ps.SETTINGS_OBJECT)) {
    return <Denied object={page('project_settings')} />;
  }
  const mayConfigure = can(principal, 'configure', ps.SETTINGS_OBJECT);

  const { types, profiles, codes, accounts, policy } = await withCurrentUser(async (tx) => ({
    policy: await billing.policy(tx),
    types: await ps.types(tx),
    profiles: await ps.toleranceProfiles(tx),
    codes: await ps.costCodes(tx),
    accounts: mayConfigure ? await coa.postableAccounts(tx) : [],
  }));
  const activeForm = (action: (form: FormData) => Promise<void>, code: string, active: boolean) =>
    mayConfigure ? (
      <Form action={action}>
        <Hidden name="code" value={code} />
        <Hidden name="active" value={active ? '0' : '1'} />
        {active ? <input aria-label={admin('reason')} name="reason" placeholder={admin('reason')} required type="text" /> : null}
        <Submit label={active ? t('deactivate') : t('activate')} small tone="secondary" />
      </Form>
    ) : active ? (
      '✓'
    ) : (
      '—'
    );

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route="/administration/project-settings" />} subtitle={t('subtitle')} title={t('title')} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="pst-types-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pst-types-title">
            <span>{t('types')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name_en')}</th>
                  <th scope="col">{t('name_ar')}</th>
                  <th scope="col">{t('kind')}</th>
                  <th scope="col">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {types.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <bdi dir="ltr">{row.code}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.nameEn}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.nameAr ?? '—'}</bdi>
                    </td>
                    <td>{t(`kind_${row.kind}`)}</td>
                    <td>{activeForm(setProjectTypeActive, row.code, row.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayConfigure ? (
            <Form action={saveProjectType}>
              <p className={s.sapGridCaption}>{t('new_type')}</p>
              <Grid>
                <Field hint={admin('code_hint')} label={t('code')} name="code" required />
                <Field label={t('name_en')} name="name_en" required />
                <Field label={t('name_ar')} name="name_ar" />
                <Select label={t('kind')} name="kind" options={['customer', 'internal', 'investment'].map((value) => ({ value, label: t(`kind_${value}`) }))} required />
              </Grid>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="pst-profiles-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pst-profiles-title">
            <span>{t('profiles')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name_en')}</th>
                  <th scope="col">{t('name_ar')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('warn_percent')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('stop_percent')}
                  </th>
                  <th scope="col">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <bdi dir="ltr">{row.code}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.nameEn}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.nameAr ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>{Number(row.warnPercent)}</td>
                    <td className={s.sapNum}>{Number(row.stopPercent)}</td>
                    <td>{activeForm(setToleranceProfileActive, row.code, row.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayConfigure ? (
            <Form action={saveToleranceProfile}>
              <p className={s.sapGridCaption}>{t('new_profile')}</p>
              <Grid>
                <Field hint={admin('code_hint')} label={t('code')} name="code" required />
                <Field label={t('name_en')} name="name_en" required />
                <Field label={t('name_ar')} name="name_ar" />
                <Field defaultValue="90" label={t('warn_percent')} name="warn_percent" required />
                <Field defaultValue="100" label={t('stop_percent')} name="stop_percent" required />
              </Grid>
              <p className={s.sapNote}>{t('profile_note')}</p>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="pst-codes-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pst-codes-title">
            <span>{t('cost_codes')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name_en')}</th>
                  <th scope="col">{t('name_ar')}</th>
                  <th scope="col">{t('account')}</th>
                  <th scope="col">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <bdi dir="ltr">{row.code}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.nameEn}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.nameAr ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{accounts.find((a) => a.id === row.accountId)?.code ?? (row.accountId ? '…' : '—')}</bdi>
                    </td>
                    <td>{activeForm(setCostCodeActive, row.code, row.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayConfigure ? (
            <Form action={saveCostCode}>
              <p className={s.sapGridCaption}>{t('new_cost_code')}</p>
              <Grid>
                <Field hint={admin('code_hint')} label={t('code')} name="code" required />
                <Field label={t('name_en')} name="name_en" required />
                <Field label={t('name_ar')} name="name_ar" />
                <Select emptyLabel="—" label={t('account')} name="account_id" options={accounts.filter((a) => a.accountType === 'expense' || a.accountType === 'asset').map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />
              </Grid>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="pst-recognition-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pst-recognition-title">
            <span>{t('recognition')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('recognition_method')}</th>
                  <th scope="col">{t('recognition_ratified')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <bdi dir="ltr">{policy.code}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{t(`method_${policy.method}`)}</bdi>
                  </td>
                  <td>
                    <span className={`status status--${policy.ratified ? 'approved' : 'draft'} ${s.sapRegisterStatus}`} data-status={policy.ratified ? 'approved' : 'draft'}>
                      {policy.ratified ? t('ratified') : t('not_ratified')}
                    </span>{' '}
                    {policy.ratified ? <bdi dir="auto">{`${policy.ratifiedByName ?? '—'} · ${policy.ratifiedNote ?? ''}`}</bdi> : null}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={s.sapNote}>{t('recognition_note')}</p>
          {mayConfigure && !policy.ratified ? (
            <Form action={ratifyRecognition}>
              <Grid>
                <Field hint={t('ratify_hint')} label={admin('reason')} name="note" required wide />
              </Grid>
              <SubmitRow>
                <Submit label={t('ratify')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
