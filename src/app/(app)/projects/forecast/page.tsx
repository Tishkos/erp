import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as billing from '@/server/services/project-billing';
import * as ps from '@/server/services/project-system';
import { setEtc } from './actions';

/**
 * Forecast — REQ-PM-001 §11, §13. Copies the Warehouses Report: the
 * report's filters on one line (the project and the day), the report table
 * with its totals row — per element the plan, the budget, the open
 * commitment, the actual, the estimate to complete, the estimate at
 * completion and the variance — and the typed estimates underneath.
 */
export const dynamic = 'force-dynamic';

export default async function ForecastPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/forecast')) notFound();
  const [t, x, page, column, list, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', billing.PERMISSION_OBJECT)) {
    return <Denied object={page('project_forecast')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const today = businessToday();
  const asOf = typeof params.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.as_of) ? params.as_of : today;
  const actor = { principal, branchCode: context.scope.branchCode };

  const data = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = asked || choices.find((c) => c.status === 'active')?.code || choices[0]?.code || '';
    if (!code) return { choices, view: null, rows: [], typed: [] };
    try {
      const view = await ps.record(tx, actor, code);
      return {
        choices,
        view,
        rows: await billing.forecast(tx, code, asOf),
        typed: await billing.etcHistory(tx, code),
      };
    } catch (error) {
      if (isNotFoundError(error)) return { choices, view: null, rows: [], typed: [] };
      throw error;
    }
  });
  const { choices, view, rows, typed } = data;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const root = rows.find((r) => r.level === 1);
  const mayEstimate = Boolean(view) && can(principal, 'edit_draft', billing.PERMISSION_OBJECT) && ['active', 'on_hold', 'closing'].includes(view!.project.status);

  return (
    <AdminPage
      actions={
        mayEstimate && view ? (
          <NewRecordDialog buttonLabel={x('set_etc')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('set_etc_title')}>
            <Form action={setEtc}>
              <Hidden name="project_code" value={view.project.code} />
              <Hidden name="return_as_of" value={asOf} />
              <Grid>
                <Select
                  label={x('element')}
                  name="wbs_code"
                  options={view.tree
                    .filter((e) => e.active)
                    .map((e) => ({
                      value: e.code,
                      label: `${e.code} · ${e.name}`,
                    }))}
                  required
                />
                <Field defaultValue={today} label={x('as_of_label')} name="as_of" required type="date" />
                <Field label={x('etc')} name="etc" required />
                <Field label={t('reason')} name="reason" required wide />
              </Grid>
              <p className={s.sapNote}>{x('etc_note')}</p>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={x('forecast_subtitle')}
      tabs={<SectionTabs route="/projects/forecast" />}
      title={page('project_forecast')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      <form method="get">
        <FilterRow>
          <Select
            defaultValue={view?.project.code ?? ''}
            label={x('project')}
            name="project"
            options={choices.map((c) => ({
              value: c.code,
              label: `${c.code} · ${c.name}`,
            }))}
            required
          />
          <Field defaultValue={asOf} label={x('as_of_label')} name="as_of" type="date" />
          <SubmitRow>
            <Submit label={list('search')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <div className={s.sapTableWrap}>
        <table aria-label={page('project_forecast')} className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              <th scope="col">{x('element')}</th>
              <th className={s.sapNum} scope="col">
                {x('plan')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('budget')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('committed')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('actual')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('etc')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('eac')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('vac')}
              </th>
              <th scope="col">{x('etc_source')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={9}>
                  {x('no_projects')}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.code}>
                  <td>
                    <bdi dir="ltr">{`${'· '.repeat(Math.max(0, r.level - 1))}${r.code}`}</bdi> <bdi dir="auto">{r.name}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.planIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.budgetIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.committedIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.actualIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.etcIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.eacIqd)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(r.vacIqd)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{r.typedEtc ? x('etc_typed', { day: day(r.typedEtc.asOf) }) : x('etc_formula')}</bdi>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {root ? (
            <tfoot>
              <tr className={s.sapTotalRow}>
                <td>{t('reports.totals')}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.planIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.budgetIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.committedIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.actualIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.etcIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.eacIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(root.vacIqd)}</bdi>
                </td>
                <td />
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>

      {view ? (
        <section aria-labelledby="forecast-etc-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="forecast-etc-title">
              <span>{x('typed_etc')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: typed.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="forecast-etc-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('as_of_label')}</th>
                    <th scope="col">{x('element')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('etc')}
                    </th>
                    <th scope="col">{t('reason')}</th>
                    <th scope="col">{x('raised_by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {typed.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={5}>
                        {x('no_typed_etc')}
                      </td>
                    </tr>
                  ) : null}
                  {typed.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <bdi dir="ltr">{day(e.asOf)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{e.wbsCode}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(e.etcIqd)}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{e.reason}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{e.createdByName ?? '—'}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
