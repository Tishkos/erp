import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  Flash,
  Form,
  Grid,
  NewRecordDialog,
  Pill,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as periods from '@/server/services/periods';
import { createFiscalYear, setPeriodStatus } from './actions';

/**
 * The accounting calendar.
 *
 * A journal posts into a period, so the year has to be opened before anything
 * can be recorded — which is why this screen is part of Phase 1 even though
 * the phase definition does not name it.
 *
 * The calendar reads; changing a period is one control above it. The obvious
 * alternative — a state picker, a reason box and a Save button on every one of
 * twelve rows — puts thirty-six controls on screen to perform an action that
 * happens once a month, and buries the twelve facts a person came to read.
 */
export const dynamic = 'force-dynamic';

export default async function PeriodsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/periods')) notFound();

  const [t, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', periods.PERMISSION_OBJECT)) {
    return <Denied object={page('soft_close')} />;
  }
  const mayConfigure = can(principal, 'configure', periods.PERMISSION_OBJECT);

  const calendar = await withCurrentUser((tx) => periods.calendar(tx));
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  const current = calendar.find((p) => p.startsOn <= today && today <= p.endsOn);

  const state = (status: string) => ({
    label: t(`periods.state_${status}`),
    on: status === 'open' ? true : status === 'closed' ? false : null,
  });

  return (
    <AdminPage
      actions={
        mayConfigure ? (
          <NewRecordDialog
            buttonLabel={t('periods.new_year')}
            closeLabel={t('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('periods.new_year')}
          >
            <Form action={createFiscalYear}>
              <Grid>
                <Field
                  defaultValue={`FY${year}`}
                  label={t('periods.year_code')}
                  name="code"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field
                  defaultValue={`${year}-01-01`}
                  label={t('periods.starts_on')}
                  name="startsOn"
                  type="date"
                  required
                  requiredLabel={t('required_hint')}
                />
                <Field
                  defaultValue={`${year}-12-31`}
                  hint={t('periods.year_hint')}
                  label={t('periods.ends_on')}
                  name="endsOn"
                  type="date"
                  required
                  requiredLabel={t('required_hint')}
                  wide
                />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/finance/periods" />}
      subtitle={t('periods.subtitle')}
      title={t('periods.title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {calendar.length === 0 ? (
        <Panel>
          <div className={s.emptyState}>
            <strong>{t('periods.none')}</strong>
            <p className="muted">{t('periods.none_detail')}</p>
          </div>
        </Panel>
      ) : (
        <>
          {/* Where the books stand today, before the twelve months of detail. */}
          {current ? (
            <div className={s.docBand}>
              <div className={s.docIdentity}>
                <span className={s.docNumber}>{current.name}</span>
                <Pill {...state(current.status)} />
              </div>
              <div className={s.docTotal}>
                <span>{t('periods.this_month')}</span>
                <strong>
                  {formatBusinessDate(current.startsOn, locale as Locale)} —{' '}
                  {formatBusinessDate(current.endsOn, locale as Locale)}
                </strong>
              </div>
            </div>
          ) : null}

          {mayConfigure ? (
            <Panel title={t('periods.change')}>
              <p className={s.sectionHint}>{t('periods.change_hint')}</p>
              <Form action={setPeriodStatus}>
                <Grid>
                  <Select
                    defaultValue={current?.id ?? calendar[0]!.id}
                    label={t('periods.period')}
                    name="periodId"
                    options={calendar.map((period) => ({
                      value: period.id,
                      label: `${period.name} · ${t(`periods.state_${period.status}`)}`,
                    }))}
                    required
                  />
                  <Select
                    label={t('periods.state')}
                    name="status"
                    options={[
                      { value: 'open', label: t('periods.state_open') },
                      { value: 'soft_closed', label: t('periods.state_soft_closed') },
                      { value: 'closed', label: t('periods.state_closed') },
                    ]}
                    required
                  />
                  <Field
                    hint={t('periods.reason_hint')}
                    label={t('reason')}
                    name="reason"
                    placeholder={t('reason_placeholder')}
                    required
                    requiredLabel={t('required_hint')}
                    wide
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <Panel flush title={t('periods.calendar')}>
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">{t('periods.period')}</th>
                    <th scope="col">{t('periods.year')}</th>
                    <th scope="col">{t('periods.starts_on')}</th>
                    <th scope="col">{t('periods.ends_on')}</th>
                    <th scope="col">{t('periods.state')}</th>
                  </tr>
                </thead>
                <tbody>
                  {calendar.map((period) => (
                    <tr key={period.id}>
                      <td className={s.mono}>{period.name}</td>
                      <td>{period.fiscalYearCode}</td>
                      <td>{formatBusinessDate(period.startsOn, locale as Locale)}</td>
                      <td>{formatBusinessDate(period.endsOn, locale as Locale)}</td>
                      <td>
                        <Pill {...state(period.status)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </AdminPage>
  );
}
