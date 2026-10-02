import Link from 'next/link';
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
import * as psch from '@/server/services/project-schedule';
import * as ps from '@/server/services/project-system';
import { chipOf } from '../chip';
import { approveMeasurement, approveMilestone, measureProgress, reachMilestone } from './actions';

/**
 * Progress — REQ-PM-001 §10, §13. Copies the WBS workspace: one window with
 * the project and the day as filters, the tree as the register with the
 * earned-value figures to that day; then the measurements, the milestones
 * and the milestone trend stacked underneath.
 */
export const dynamic = 'force-dynamic';

export default async function ProgressPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/progress')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', psch.PERMISSION_OBJECT)) {
    return <Denied object={page('progress')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const asOf = typeof params.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.as_of) ? params.as_of : businessToday();
  const actor = { principal, branchCode: context.scope.branchCode };

  const data = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = asked || choices.find((c) => c.status === 'active')?.code || choices[0]?.code || '';
    if (!code) return { choices, view: null, ev: [], measured: [], plan: null, trend: null };
    try {
      const view = await ps.record(tx, actor, code);
      return {
        choices,
        view,
        ev: await psch.earnedValueTree(tx, code, asOf),
        measured: await psch.measurements(tx, code),
        plan: await psch.activities(tx, code),
        trend: await psch.milestoneTrend(tx, code),
      };
    } catch (error) {
      if (isNotFoundError(error)) return { choices, view: null, ev: [], measured: [], plan: null, trend: null };
      throw error;
    }
  });
  const { choices, view, ev, measured, plan, trend } = data;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const mayMeasure = Boolean(view) && can(principal, 'edit_draft', psch.PERMISSION_OBJECT) && ['active', 'on_hold', 'closing'].includes(view!.project.status);
  const mayApprove = can(principal, 'approve', psch.PERMISSION_OBJECT);
  const mayReach = Boolean(view) && can(principal, 'submit', psch.PERMISSION_OBJECT) && view!.project.status === 'active';
  const milestones = plan ? plan.activities.filter((a) => a.kind === 'milestone') : [];
  const today = businessToday();

  return (
    <AdminPage
      actions={
        mayMeasure && view ? (
          <NewRecordDialog buttonLabel={x('measure')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('measure_title')}>
            <Form action={measureProgress}>
              <Hidden name="project_code" value={view.project.code} />
              <Hidden name="as_of" value={asOf} />
              <Grid>
                <Select label={x('element')} name="wbs_code" options={view.tree.filter((e) => e.active).map((e) => ({ value: e.code, label: `${e.code} · ${e.name}` }))} required />
                <Field defaultValue={today} label={x('measured_on')} name="measured_on" required type="date" />
                <Field label={x('percent_complete')} name="percent_complete" required />
              </Grid>
              <Field label={x('note')} name="note" wide />
              <p className={s.sapNote}>{x('measure_note')}</p>
              <SubmitRow>
                <Submit label={t('save')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/progress" />}
      subtitle={x('progress_subtitle')}
      title={page('progress')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="progress-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="progress-title">
            <span>{view ? `${view.project.code} · ${view.project.name}` : page('progress')}</span>
            <span className={s.sapTitleMeta}>{x('as_of', { day: day(asOf) })}</span>
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view?.project.code ?? ''} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} required />
              <Field defaultValue={asOf} label={x('as_of_label')} name="as_of" type="date" />
              <SubmitRow>
                <Submit label={x('open')} />
              </SubmitRow>
            </FilterRow>
          </form>

          {view ? (
            <>
              <p className={s.sapNote}>
                <span className={`status status--${chipOf(view.project.status)} ${s.sapRegisterStatus}`} data-status={chipOf(view.project.status)}>
                  {x(`status_${view.project.status}`)}
                </span>{' '}
                <Link className={s.sapLink} href={`/projects/${encodeURIComponent(view.project.code)}`}>
                  {x('open_record')}
                </Link>
                {' · '}
                {x('evm_note')}
              </p>
              <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
                <table aria-labelledby="progress-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                  <thead>
                    <tr>
                      <th scope="col">{x('element')}</th>
                      <th className={s.sapNum} scope="col">
                        {x('measured_percent')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('budget')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('bcws')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('bcwp')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('acwp')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('percent_complete')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('cpi')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('spi')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('eac')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {x('vac')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.map((r) => (
                      <tr key={r.code}>
                        <td>
                          <bdi dir="ltr">{`${'· '.repeat(Math.max(0, r.level - 1))}${r.code}`}</bdi> <bdi dir="auto">{r.name}</bdi>
                        </td>
                        <td className={s.sapNum}>{r.measuredPercent === null ? '—' : `${Number(r.measuredPercent)} %`}</td>
                        <td className={s.sapNum}>{money(r.budgetIqd)}</td>
                        <td className={s.sapNum}>{money(r.plannedIqd)}</td>
                        <td className={s.sapNum}>{money(r.earnedIqd)}</td>
                        <td className={s.sapNum}>{money(r.actualIqd)}</td>
                        <td className={s.sapNum}>{r.percentComplete === null ? '—' : `${r.percentComplete} %`}</td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{r.cpi ?? '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{r.spi ?? '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>{money(r.eacIqd)}</td>
                        <td className={s.sapNum}>{money(r.vacIqd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className={s.sapNote}>{x('no_projects')}</p>
          )}
        </div>
      </section>

      {view ? (
        <section aria-labelledby="progress-measurements-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="progress-measurements-title">
              <span>{x('measurements')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: measured.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="progress-measurements-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('measured_on')}</th>
                    <th scope="col">{x('element')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('percent_complete')}
                    </th>
                    <th scope="col">{x('measured_by')}</th>
                    <th scope="col">{x('approved_by')}</th>
                    <th scope="col">{x('note')}</th>
                    {mayApprove ? <th scope="col">{t('actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {measured.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={mayApprove ? 7 : 6}>
                        {x('no_measurements')}
                      </td>
                    </tr>
                  ) : null}
                  {measured.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <bdi dir="ltr">{day(m.measuredOn)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{m.wbsCode}</bdi> <bdi dir="auto">{m.elementName ?? ''}</bdi>
                      </td>
                      <td className={s.sapNum}>{`${Number(m.percentComplete)} %`}</td>
                      <td>
                        <bdi dir="auto">{m.measuredByName ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{m.approvedByName ?? t('none')}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{m.note ?? (m.fromMilestone ? x('from_milestone') : '—')}</bdi>
                      </td>
                      {mayApprove ? (
                        <td>
                          {!m.approvedAt && m.measuredBy !== principal.userId ? (
                            <Form action={approveMeasurement}>
                              <Hidden name="project_code" value={view.project.code} />
                              <Hidden name="as_of" value={asOf} />
                              <Hidden name="progress_id" value={m.id} />
                              <Submit label={x('approve_measurement')} small tone="secondary" />
                            </Form>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {view && milestones.length > 0 ? (
        <section aria-labelledby="progress-milestones-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="progress-milestones-title">
              <span>{x('milestones')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: milestones.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="progress-milestones-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('code')}</th>
                    <th scope="col">{column('name')}</th>
                    <th scope="col">{x('element')}</th>
                    <th scope="col">{x('milestone_usage')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('progress_percent')}
                    </th>
                    <th scope="col">{x('scheduled_on')}</th>
                    <th scope="col">{x('reached_on')}</th>
                    <th scope="col">{column('status')}</th>
                    <th scope="col">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {milestones.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <bdi dir="ltr">{m.code}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{m.name}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{m.wbsCode}</bdi>
                      </td>
                      <td>{x(`usage_${m.milestoneUsage}`)}</td>
                      <td className={s.sapNum}>{m.progressPercent === null ? '—' : `${Number(m.progressPercent)} %`}</td>
                      <td>
                        <bdi dir="ltr">{day(m.earliestFinish)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(m.reachedOn)}</bdi>
                      </td>
                      <td>
                        <span className={`status status--${m.status === 'done' ? 'executed' : m.status === 'cancelled' ? 'cancelled' : m.reachedOn ? 'submitted' : 'active'} ${s.sapRegisterStatus}`} data-status={m.status === 'done' ? 'executed' : m.status === 'cancelled' ? 'cancelled' : m.reachedOn ? 'submitted' : 'active'}>
                          {m.status === 'open' && m.reachedOn ? x('reached_waiting') : x(`activity_status_${m.status}`)}
                        </span>
                      </td>
                      <td>
                        {m.status === 'open' && !m.reachedOn && mayReach ? (
                          <Form action={reachMilestone}>
                            <Hidden name="project_code" value={view.project.code} />
                            <Hidden name="as_of" value={asOf} />
                            <Hidden name="activity_code" value={m.code} />
                            <input aria-label={x('reached_on')} defaultValue={today} name="reached_on" required type="date" />
                            <Submit label={x('reach')} small tone="secondary" />
                          </Form>
                        ) : null}
                        {m.status === 'open' && m.reachedOn && mayApprove && m.reachedBy !== principal.userId ? (
                          <Form action={approveMilestone}>
                            <Hidden name="project_code" value={view.project.code} />
                            <Hidden name="as_of" value={asOf} />
                            <Hidden name="activity_code" value={m.code} />
                            <Submit label={x('approve_reached')} small tone="secondary" />
                          </Form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {view && trend && trend.runs.length > 0 && trend.milestones.length > 0 ? (
        <section aria-labelledby="progress-trend-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="progress-trend-title">
              <span>{x('milestone_trend')}</span>
              <span className={s.sapTitleMeta}>{x('trend_note')}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="progress-trend-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('code')}</th>
                    <th scope="col">{column('name')}</th>
                    {trend.runs.map((run) => (
                      <th key={run} scope="col">
                        {x('run_n', { run })}
                      </th>
                    ))}
                    <th className={s.sapNum} scope="col">
                      {x('slip_days')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {trend.milestones.map((m) => (
                    <tr key={m.code}>
                      <td>
                        <bdi dir="ltr">{m.code}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{m.name}</bdi>
                      </td>
                      {m.dates.map((d, i) => (
                        <td key={trend.runs[i]}>
                          <bdi dir="ltr">{day(d)}</bdi>
                        </td>
                      ))}
                      <td className={s.sapNum}>{m.slipDays}</td>
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
