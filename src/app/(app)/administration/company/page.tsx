import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  LinkButton,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { CURRENCIES } from '@domain/currencies';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as company from '@/server/services/company';
import { saveCompany, saveMainBranch } from './actions';

/**
 * Company Setup — Phase 0 requirement 1.
 *
 * Deliberately short: the company's code, legal name, ledger currency and
 * location, then the head office (the first branch) and where it is. Other
 * branches are added under Master Data → Branches.
 */
export const dynamic = 'force-dynamic';

export default async function CompanyPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, page, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'view', company.PERMISSION_OBJECT)) {
    return <Denied object={page('company')} />;
  }
  const mayEditBranch = can(context.principal, 'configure', branches.PERMISSION_OBJECT);

  const { current, main } = await withCurrentUser(async (tx) => {
    const all = await branches.listAll(tx);
    return {
      current: await company.current(tx),
      main: all.find((b) => b.code === 'HQ') ?? all.find((b) => b.active) ?? null,
    };
  });

  return (
    <AdminPage tabs={<SectionTabs route="/administration/company" />} back={{ href: '/', label: t('dashboard_label') }} subtitle={t('company.subtitle')} title={t('company.title')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {current ? null : <p className={s.sectionHint}>{t('company.not_set')}</p>}

      <Panel title={t('details')}>
        <Form action={saveCompany}>
          <Grid>
            <Field
              defaultValue={current?.code}
              hint={t('code_hint')}
              label={t('company.code')}
              name="code"
              readOnly={Boolean(current)}
              required
              requiredLabel={t('required_hint')}
            />
            <Field
              defaultValue={current?.legalName}
              label={t('company.legal_name')}
              name="legalName"
              required
              requiredLabel={t('required_hint')}
            />
            <Select
              defaultValue={current?.baseCurrency ?? 'IQD'}
              hint={t('company.base_currency_hint')}
              label={t('company.base_currency')}
              name="baseCurrency"
              options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.name} (${c.symbol})` }))}
              required
            />
            <Field
              defaultValue={current?.address}
              hint={t('company.address_hint')}
              label={t('company.address')}
              name="address"
              type="textarea"
              wide
            />
          </Grid>
          <SubmitRow>
            <Submit label={current ? t('update') : t('create')} />
          </SubmitRow>
        </Form>
      </Panel>

      <Panel
        actions={<LinkButton href="/master-data/branches" label={t('company.open_branches')} small />}
        title={t('company.main_branch')}
      >
        <p className={s.sectionHint}>{t('company.main_branch_hint')}</p>
        {main ? (
          <Form action={saveMainBranch}>
            <input name="code" type="hidden" value={main.code} />
            <input name="managerUserId" type="hidden" value={main.managerUserId ?? ''} />
            <Grid>
              <Field defaultValue={main.code} label={t('code')} name="code_display" readOnly />
              <Field
                defaultValue={main.name}
                label={t('company.main_branch_name')}
                name="name"
                readOnly={!mayEditBranch}
                required
                requiredLabel={t('required_hint')}
              />
              <Field
                defaultValue={main.address}
                label={t('company.main_branch_location')}
                name="address"
                readOnly={!mayEditBranch}
                type="textarea"
                wide
              />
            </Grid>
            {mayEditBranch ? (
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            ) : null}
          </Form>
        ) : (
          <p className="muted">{t('none')}</p>
        )}
      </Panel>

      {current ? <RecordHistory objectId={current.id} objectType={company.PERMISSION_OBJECT} /> : null}
    </AdminPage>
  );
}
