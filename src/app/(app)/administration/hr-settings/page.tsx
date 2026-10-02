import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { PAY_CALCULATIONS, PAY_COMPONENT_KINDS } from '@/server/domain/hr';
import { requireContext, withCurrentUser } from '@/server/session';
import * as settings from '@/server/services/hr-settings';
import {
  addCalendarHoliday,
  removeCalendarHoliday,
  saveCalendar,
  saveLeaveType,
  savePayComponent,
  setLeaveTypeActive,
  setPayComponentActive,
} from './actions';

/**
 * HR settings — REQ-HR-001 §5–§7 (R4). Copies the Payables Settings screen:
 * three stacked windows — pay components, leave types, working calendars —
 * each a register with a new-row form under it. Nothing deletes; a row is
 * deactivated. Positions moved to HR → Positions (REQ-FIX-001 FIX-5).
 */
export const dynamic = 'force-dynamic';

export default async function HrSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/administration/hr-settings')) notFound();
  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.hr_settings'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', settings.PERMISSION_OBJECT)) {
    return <Denied object={page('hr_settings')} />;
  }
  const mayConfigure = can(principal, 'configure', settings.PERMISSION_OBJECT);

  const { components, leaveTypes, calendars } = await withCurrentUser(async (tx) => ({
    components: await settings.payComponents(tx),
    leaveTypes: await settings.leaveTypes(tx),
    calendars: await settings.calendars(tx),
  }));
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);

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
    <AdminPage
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/administration/hr-settings" />}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="hrs-components-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="hrs-components-title">
            <span>{t('components')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name_en')}</th>
                  <th scope="col">{t('name_ar')}</th>
                  <th scope="col">{t('kind')}</th>
                  <th scope="col">{t('calculation')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('default_value')}
                  </th>
                  <th scope="col">{t('taxable')}</th>
                  <th scope="col">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {components.map((row) => (
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
                    <td>{t(`calc_${row.calculation}`)}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.calculation === 'percent_of_base' ? `${Number(row.defaultValue)} %` : iqd(row.defaultValue)}</bdi>
                    </td>
                    <td>{row.taxable ? '✓' : '—'}</td>
                    <td>{activeForm(setPayComponentActive, row.code, row.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayConfigure ? (
            <Form action={savePayComponent}>
              <p className={s.sapGridCaption}>{t('new_component')}</p>
              <Grid>
                <Field hint={admin('code_hint')} label={t('code')} name="code" required />
                <Field label={t('name_en')} name="name_en" required />
                <Field label={t('name_ar')} name="name_ar" />
                <Select label={t('kind')} name="kind" options={PAY_COMPONENT_KINDS.map((value) => ({ value, label: t(`kind_${value}`) }))} required />
                <Select label={t('calculation')} name="calculation" options={PAY_CALCULATIONS.map((value) => ({ value, label: t(`calc_${value}`) }))} required />
                <Field defaultValue="0" label={t('default_value')} name="default_value" />
              </Grid>
              <Checkbox defaultChecked label={t('taxable')} name="taxable" />
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="hrs-leave-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="hrs-leave-title">
            <span>{t('leave_types')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name_en')}</th>
                  <th scope="col">{t('name_ar')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('days_per_year')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('carry_over')}
                  </th>
                  <th scope="col">{t('paid')}</th>
                  <th scope="col">{t('requires_attachment')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('allowed_negative')}
                  </th>
                  <th scope="col">{t('active')}</th>
                </tr>
              </thead>
              <tbody>
                {leaveTypes.map((row) => (
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
                    <td className={s.sapNum}>{Number(row.daysPerYear)}</td>
                    <td className={s.sapNum}>{Number(row.carryOverDays)}</td>
                    <td>{row.paid ? '✓' : '—'}</td>
                    <td>{row.requiresAttachment ? '✓' : '—'}</td>
                    <td className={s.sapNum}>{Number(row.allowedNegativeDays)}</td>
                    <td>{activeForm(setLeaveTypeActive, row.code, row.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayConfigure ? (
            <Form action={saveLeaveType}>
              <p className={s.sapGridCaption}>{t('new_leave_type')}</p>
              <Grid>
                <Field hint={admin('code_hint')} label={t('code')} name="code" required />
                <Field label={t('name_en')} name="name_en" required />
                <Field label={t('name_ar')} name="name_ar" />
                <Field defaultValue="0" label={t('days_per_year')} name="days_per_year" required />
                <Field defaultValue="0" label={t('carry_over')} name="carry_over_days" />
                <Field defaultValue="0" label={t('allowed_negative')} name="allowed_negative_days" />
              </Grid>
              <Checkbox defaultChecked label={t('paid')} name="paid" />
              <Checkbox label={t('requires_attachment')} name="requires_attachment" />
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="hrs-calendars-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="hrs-calendars-title">
            <span>{t('calendars')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('code')}</th>
                  <th scope="col">{t('name_en')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('year')}
                  </th>
                  <th scope="col">{t('working_days')}</th>
                  <th scope="col">{t('holidays')}</th>
                </tr>
              </thead>
              <tbody>
                {calendars.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <bdi dir="ltr">{row.code}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{locale === 'ar' && row.nameAr ? row.nameAr : row.nameEn}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.year}</td>
                    <td>
                      <bdi dir="ltr">{row.workingDays}</bdi>
                    </td>
                    <td>
                      {row.holidays.length === 0 ? '—' : null}
                      {row.holidays.map((holiday, index) => (
                        <span key={holiday.id}>
                          {index > 0 ? ' · ' : ''}
                          <bdi dir="ltr">{formatBusinessDate(holiday.holidayDate, locale as Locale)}</bdi> <bdi dir="auto">{locale === 'ar' && holiday.nameAr ? holiday.nameAr : holiday.nameEn}</bdi>
                          {mayConfigure ? (
                            <Form action={removeCalendarHoliday}>
                              <Hidden name="calendar_code" value={row.code} />
                              <Hidden name="holiday_date" value={holiday.holidayDate} />
                              <Submit label={t('remove')} small tone="secondary" />
                            </Form>
                          ) : null}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mayConfigure ? (
            <>
              <Form action={saveCalendar}>
                <p className={s.sapGridCaption}>{t('new_calendar')}</p>
                <Grid>
                  <Field hint={admin('code_hint')} label={t('code')} name="code" required />
                  <Field label={t('name_en')} name="name_en" required />
                  <Field label={t('name_ar')} name="name_ar" />
                  <Field label={t('year')} max={2100} min={2000} name="year" required type="number" />
                  <Field defaultValue="sun,mon,tue,wed,thu" hint={t('working_days_hint')} label={t('working_days')} name="working_days" required />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
              <Form action={addCalendarHoliday}>
                <p className={s.sapGridCaption}>{t('add_holiday')}</p>
                <Grid>
                  <Select label={t('calendars')} name="calendar_code" options={calendars.map((c) => ({ value: c.code, label: `${c.code} · ${c.year}` }))} required />
                  <Field label={t('holiday_date')} name="holiday_date" required type="date" />
                  <Field label={t('name_en')} name="name_en" required />
                  <Field label={t('name_ar')} name="name_ar" />
                </Grid>
                <SubmitRow>
                  <Submit label={t('add_holiday')} />
                </SubmitRow>
              </Form>
            </>
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
