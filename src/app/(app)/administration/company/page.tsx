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
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { CURRENCIES } from '@domain/currencies';
import { can } from '@domain/permissions';
import { requireContext, withCurrentUser } from '@/server/session';
import * as branches from '@/server/services/branches';
import * as company from '@/server/services/company';
import { ACCENTS, PALETTES } from '@domain/appearance';
import { saveAppearance, saveCompany, saveMainBranch } from './actions';

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
  const mayConfigure = can(context.principal, 'configure', company.PERMISSION_OBJECT);

  const { current, main, look } = await withCurrentUser(async (tx) => {
    const all = await branches.listAll(tx);
    return {
      current: await company.current(tx),
      look: await company.appearance(tx),
      main: all.find((b) => b.code === 'HQ') ?? all.find((b) => b.active) ?? null,
    };
  });

  return (
    <AdminPage
      actions={current ? <AuditLogButton label={t('history')} /> : null}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('company.subtitle')}
      tabs={<SectionTabs route="/administration/company" />}
      title={t('company.title')}
      variant="sap"
    >
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

      {/* The look of the whole application, chosen once for everybody. Presets
          rather than free colours: each has been checked as a whole — a title
          bar against the text on it, a grid rule against the row behind it —
          and on a company-wide setting one illegible choice is everybody's
          problem, usually not the chooser's. */}
      <Panel title={t('company.appearance')}>
        <p className={s.sectionHint}>{t('company.appearance_hint')}</p>
        {mayConfigure ? (
          <Form action={saveAppearance}>
            <div className={s.paletteChoices}>
              {PALETTES.map((name) => (
                <label className={s.paletteChoice} key={name}>
                  <input
                    defaultChecked={name === look.palette}
                    name="uiPalette"
                    type="radio"
                    value={name}
                  />
                  <span className={s.paletteSwatch} data-palette={name}>
                    <span className={s.paletteSwatchBar} />
                    <span className={s.paletteSwatchBody}>
                      <span className={s.paletteSwatchRow} />
                      <span className={s.paletteSwatchRow} />
                      <span className={s.paletteSwatchButton} />
                    </span>
                  </span>
                  <span className={s.paletteName}>{t(`company.palette_${name}`)}</span>
                </label>
              ))}
            </div>
            {/* The accent: the one colour that marks pressed, selected and
                actionable. Each dot carries its own data-accent, so it is
                painted by the same tokens the application would use — the
                gold dot shows the current palette's own amber. */}
            <p className={s.sectionHint} style={{ marginBlockStart: '0.8rem' }}>
              {t('company.accent_hint')}
            </p>
            <div className={s.accentChoices}>
              {ACCENTS.map((name) => (
                <label className={s.accentChoice} data-accent={name} key={name}>
                  <input
                    defaultChecked={name === look.accent}
                    name="uiAccent"
                    type="radio"
                    value={name}
                  />
                  <span className={s.accentDot} />
                  <span className={s.paletteName}>{t(`company.accent_${name}`)}</span>
                </label>
              ))}
            </div>
            <SubmitRow>
              <Submit label={t('update')} />
            </SubmitRow>
          </Form>
        ) : (
          <p className={s.sectionHint}>{t(`company.palette_${look.palette}`)}</p>
        )}
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
