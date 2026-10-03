import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, FilterRow, Flash, Form, Grid, Hidden, Pill, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as psch from '@/server/services/project-schedule';
import * as ps from '@/server/services/project-system';
import {
  addProjectActivity,
  addWbsElement,
  cancelProjectActivity,
  linkActivities,
  raiseStopLine,
  recordActivityActual,
  scheduleProject,
  setWbsElementActive,
  unlinkActivities,
  updateProjectActivity,
  updateWbsElement,
} from '../actions';
import { chipOf } from '../chip';

/**
 * WBS — REQ-PM-001 §13. Copies the Payables workbench: one window, a filter
 * row naming the project, the tree as the register with the five amounts
 * rolled up, and the element dialogs beside each row.
 */
export const dynamic = 'force-dynamic';

export default async function WbsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/wbs')) notFound();
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
  if (!can(principal, 'view', ps.PERMISSION_OBJECT)) {
    return <Denied object={page('wbs')} />;
  }
  const params = await searchParams;
  const asked = typeof params.project === 'string' ? params.project : '';
  const actor = { principal, branchCode: context.scope.branchCode };

  const { choices, view, pickers, plan, calendars } = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = asked || choices.find((c) => c.status !== 'closed')?.code || choices[0]?.code || '';
    const calendars = await psch.calendars(tx);
    try {
      const view = code ? await ps.record(tx, actor, code) : null;
      // PM-4 — the schedule under the tree (§13).
      const plan = view ? await psch.activities(tx, view.project.code) : null;
      return { choices, view, pickers: await ps.pickers(tx), plan, calendars };
    } catch (error) {
      if (isNotFoundError(error)) return { choices, view: null, pickers: await ps.pickers(tx), plan: null, calendars };
      throw error;
    }
  });
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const mayEdit = Boolean(view) && can(principal, 'edit_draft', ps.PERMISSION_OBJECT) && ['draft', 'active', 'on_hold'].includes(view!.project.status);
  const kind = view?.type?.kind ?? 'customer';

  const elementForm = (action: (form: FormData) => Promise<void>, element: NonNullable<typeof view>['tree'][number] | null, parents: NonNullable<typeof view>['tree']) =>
    view ? (
      <Form action={action}>
        <Hidden name="project_code" value={view.project.code} />
        <Hidden name="back" value="wbs" />
        {element ? <Hidden name="wbs_code" value={element.code} /> : null}
        <Grid>
          {element ? null : (
            <Select defaultValue={parents.find((e) => e.level === 1)?.code ?? ''} label={x('parent')} name="parent_code" options={parents.map((e) => ({ value: e.code, label: `${e.code} · ${e.name}` }))} required />
          )}
          {element ? null : <Field hint={x('wbs_code_hint')} label={column('code')} name="code" />}
          <Field defaultValue={element?.name ?? ''} label={column('name')} name="name" required wide />
          <Select defaultValue={element?.responsibleUserId ?? view.project.managerUserId ?? ''} label={x('responsible')} name="responsible_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} />
          <Field defaultValue={element?.plannedStartsOn ?? ''} label={x('planned_starts_on')} name="planned_starts_on" type="date" />
          <Field defaultValue={element?.plannedEndsOn ?? ''} label={x('planned_ends_on')} name="planned_ends_on" type="date" />
        </Grid>
        <Field defaultValue={element?.description ?? ''} label={x('description')} name="description" wide />
        <Checkbox defaultChecked={element ? element.isPlanning : true} label={x('is_planning')} name="is_planning" />
        <Checkbox defaultChecked={element ? element.isAccountAssignment : true} label={x('is_account_assignment')} name="is_account_assignment" />
        {kind === 'customer' ? <Checkbox defaultChecked={element ? element.isBilling : false} label={x('is_billing')} name="is_billing" /> : null}
        <SubmitRow>
          <Submit label={t('save')} />
        </SubmitRow>
      </Form>
    ) : null;

  const parents = view ? view.tree.filter((e) => e.active && e.level < 5) : [];

  return (
    <AdminPage
      actions={
        mayEdit && view ? (
          <>
            {parents.length > 0 ? (
              <NewRecordDialog buttonLabel={x('add_child')} closeLabel={t('close')} openOnLoad={Boolean(outcome.error)} title={x('add_element_title')}>
                {elementForm(addWbsElement, null, parents)}
              </NewRecordDialog>
            ) : null}
            <NewRecordDialog buttonLabel={x('add_activity')} closeLabel={t('close')} title={x('add_activity_title')}>
              <Form action={addProjectActivity}>
                <Hidden name="project_code" value={view.project.code} />
                <Grid>
                  <Select label={x('element')} name="wbs_code" options={view.tree.filter((e) => e.active).map((e) => ({ value: e.code, label: `${e.code} · ${e.name}` }))} required />
                  <Field hint={x('activity_code_hint')} label={column('code')} name="code" />
                  <Field label={column('name')} name="name" required wide />
                  <Select label={x('kind')} name="kind" options={[{ value: 'activity', label: x('kind_activity') }, { value: 'milestone', label: x('kind_milestone') }]} required />
                  <Field defaultValue="1" hint={x('duration_hint')} label={x('duration_days')} name="duration_days" type="number" />
                  <Select emptyLabel="—" label={x('milestone_usage')} name="milestone_usage" options={['billing', 'progress', 'date'].map((value) => ({ value, label: x(`usage_${value}`) }))} />
                  <Field hint={x('progress_percent_hint')} label={x('progress_percent')} name="progress_percent" />
                  <Field hint={x('not_before_hint')} label={x('not_before')} name="not_before" type="date" />
                  <Select emptyLabel="—" label={x('responsible')} name="responsible_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
            {plan && plan.activities.filter((a) => a.status !== 'cancelled').length > 1 ? (
              <NewRecordDialog buttonLabel={x('link_activities')} closeLabel={t('close')} title={x('link_activities_title')}>
                <Form action={linkActivities}>
                  <Hidden name="project_code" value={view.project.code} />
                  <Grid>
                    <Select label={x('predecessor')} name="predecessor_code" options={plan.activities.filter((a) => a.status !== 'cancelled').map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))} required />
                    <Select label={x('successor')} name="successor_code" options={plan.activities.filter((a) => a.status !== 'cancelled').map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))} required />
                    <Select label={x('link_kind')} name="kind" options={[{ value: 'FS', label: x('link_fs') }, { value: 'SS', label: x('link_ss') }]} required />
                    <Field defaultValue="0" hint={x('lag_hint')} label={x('lag_days')} name="lag_days" type="number" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {plan && plan.activities.some((a) => a.status !== 'cancelled') ? (
              <NewRecordDialog buttonLabel={x('schedule')} closeLabel={t('close')} title={x('schedule_title')}>
                <Form action={scheduleProject}>
                  <Hidden name="project_code" value={view.project.code} />
                  <p className={s.sapNote}>{x('schedule_note')}</p>
                  <Grid>
                    <Select defaultValue={view.project.calendarCode ?? ''} emptyLabel={x('calendar_default')} label={x('calendar')} name="calendar_code" options={calendars.map((c) => ({ value: c.code, label: `${c.code} · ${locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn}` }))} />
                    <Field label={t('reason')} name="reason" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('schedule')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/wbs" />}
      subtitle={x('wbs_subtitle')}
      title={page('wbs')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="wbs-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="wbs-title">
            <span>{view ? `${view.project.code} · ${view.project.name}` : page('wbs')}</span>
            {view ? <span className={s.sapTitleMeta}>{t('rows_shown', { count: view.tree.length })}</span> : null}
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view?.project.code ?? ''} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} required />
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
              </p>
              <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
                <table aria-labelledby="wbs-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                  <thead>
                    <tr>
                      <th scope="col">{column('code')}</th>
                      <th scope="col">{column('name')}</th>
                      <th scope="col">{x('responsible')}</th>
                      <th scope="col">{x('planned_starts_on')}</th>
                      <th scope="col">{x('planned_ends_on')}</th>
                      <th scope="col">{x('indicators')}</th>
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
                        {x('available')}
                      </th>
                      <th scope="col">{x('availability')}</th>
                      <th scope="col">{t('active')}</th>
                      {mayEdit ? <th scope="col">{t('actions')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {view.tree.map((element) => (
                      <tr key={element.id}>
                        <td>
                          <bdi dir="ltr">{`${'· '.repeat(Math.max(0, element.level - 1))}${element.code}`}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{element.name}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{element.responsibleName ?? '—'}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(element.plannedStartsOn)}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(element.plannedEndsOn)}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{[element.isPlanning ? x('ind_planning') : null, element.isAccountAssignment ? x('ind_account') : null, element.isBilling ? x('ind_billing') : null].filter(Boolean).join(' · ') || '—'}</bdi>
                        </td>
                        <td className={s.sapNum}>{money(element.budgetIqd)}</td>
                        <td className={s.sapNum}>{money(element.committedIqd)}</td>
                        <td className={s.sapNum}>{money(element.actualIqd)}</td>
                        <td className={s.sapNum}>{money(element.availableIqd)}</td>
                        <td>
                          <Pill label={x(`availability_${element.availability}`)} on={element.availability === 'ok' ? true : element.availability === 'stop' ? false : null} />
                          {element.stopPercentRaised !== null ? <span className="muted"> · {x('raised_to', { percent: element.stopPercentRaised })}</span> : null}
                        </td>
                        <td>
                          <Pill label={element.active ? t('active') : x('inactive')} on={element.active} />
                        </td>
                        {mayEdit ? (
                          <td>
                            <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_element', { code: element.code })}>
                              {elementForm(updateWbsElement, element, [])}
                              {can(principal, 'submit', ps.PERMISSION_OBJECT) ? (
                                <Form action={raiseStopLine}>
                                  <Hidden name="project_code" value={view.project.code} />
                                  <Hidden name="back" value="wbs" />
                                  <Hidden name="wbs_code" value={element.code} />
                                  <p className={s.sapNote}>{x('stop_line_note', { percent: view.profile ? Number(view.profile.stopPercent) : 100 })}</p>
                                  <Grid>
                                    <Field defaultValue={element.stopPercentRaised === null ? '' : String(element.stopPercentRaised)} hint={x('stop_line_hint')} label={x('stop_line')} name="stop_percent" />
                                    <Field label={t('reason')} name="reason" required />
                                  </Grid>
                                  <SubmitRow>
                                    <Submit label={x('raise_stop_line')} tone="secondary" />
                                  </SubmitRow>
                                </Form>
                              ) : null}
                              {element.level > 1 ? (
                                <Form action={setWbsElementActive}>
                                  <Hidden name="project_code" value={view.project.code} />
                                  <Hidden name="back" value="wbs" />
                                  <Hidden name="wbs_code" value={element.code} />
                                  <Hidden name="active" value={element.active ? '0' : '1'} />
                                  <p className={s.sapNote}>{element.active ? x('deactivate_note') : x('activate_note')}</p>
                                  {element.active ? <Field label={t('reason')} name="reason" required wide /> : null}
                                  <SubmitRow>
                                    <Submit label={element.active ? t('deactivate') : x('activate')} tone="secondary" />
                                  </SubmitRow>
                                </Form>
                              ) : null}
                            </NewRecordDialog>
                          </td>
                        ) : null}
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
      {view && plan ? (
        <section aria-labelledby="wbs-schedule-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="wbs-schedule-title">
              <span>{x('schedule_section')}</span>
              <span className={s.sapTitleMeta}>
                {view.project.scheduledFinishOn ? x('scheduled_finish', { day: day(view.project.scheduledFinishOn), run: view.project.scheduleRun }) : x('not_scheduled')}
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="wbs-schedule-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('code')}</th>
                    <th scope="col">{column('name')}</th>
                    <th scope="col">{x('element')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('duration_days')}
                    </th>
                    <th scope="col">{x('earliest_start')}</th>
                    <th scope="col">{x('earliest_finish')}</th>
                    <th scope="col">{x('latest_finish')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('total_float')}
                    </th>
                    <th scope="col">{x('critical')}</th>
                    <th scope="col">{x('actual')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('percent_complete')}
                    </th>
                    <th scope="col">{column('status')}</th>
                    {mayEdit ? <th scope="col">{t('actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {plan.activities.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={mayEdit ? 13 : 12}>
                        {x('no_activities')}
                      </td>
                    </tr>
                  ) : null}
                  {plan.activities.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <bdi dir="ltr">{a.code}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{a.name}</bdi>
                        {a.kind === 'milestone' ? <span className="muted"> · {x(`usage_${a.milestoneUsage}`)}</span> : null}
                      </td>
                      <td>
                        <bdi dir="ltr">{a.wbsCode}</bdi>
                      </td>
                      <td className={s.sapNum}>{a.kind === 'milestone' ? '—' : a.durationDays}</td>
                      <td>
                        <bdi dir="ltr">{day(a.earliestStart)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(a.earliestFinish)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(a.latestFinish)}</bdi>
                      </td>
                      <td className={s.sapNum}>{a.totalFloat ?? '—'}</td>
                      <td>{a.status === 'cancelled' || a.totalFloat === null ? '—' : <Pill label={a.isCritical ? x('critical_yes') : x('critical_no')} on={a.isCritical ? false : true} />}</td>
                      <td>
                        <bdi dir="ltr">{a.kind === 'milestone' ? day(a.reachedOn) : a.actualStart ? `${day(a.actualStart)} → ${day(a.actualFinish)}` : '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>{`${Number(a.percentComplete)} %`}</td>
                      <td>
                        <span className={`status status--${a.status === 'done' ? 'executed' : a.status === 'cancelled' ? 'cancelled' : 'active'} ${s.sapRegisterStatus}`} data-status={a.status === 'done' ? 'executed' : a.status === 'cancelled' ? 'cancelled' : 'active'}>
                          {x(`activity_status_${a.status}`)}
                        </span>
                      </td>
                      {mayEdit ? (
                        <td>
                          {a.status === 'open' ? (
                            <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_activity', { code: a.code })}>
                              <Form action={updateProjectActivity}>
                                <Hidden name="project_code" value={view.project.code} />
                                <Hidden name="activity_code" value={a.code} />
                                <Grid>
                                  <Field defaultValue={a.name} label={column('name')} name="name" required wide />
                                  {a.kind === 'activity' ? <Field defaultValue={String(a.durationDays)} label={x('duration_days')} name="duration_days" type="number" /> : null}
                                  {a.milestoneUsage === 'progress' ? <Field defaultValue={a.progressPercent ? String(Number(a.progressPercent)) : ''} label={x('progress_percent')} name="progress_percent" /> : null}
                                  <Field defaultValue={a.notBefore ?? ''} label={x('not_before')} name="not_before" type="date" />
                                  <Select defaultValue={a.responsibleUserId ?? ''} emptyLabel="—" label={x('responsible')} name="responsible_user_id" options={pickers.managers.map((m) => ({ value: m.id, label: m.name }))} />
                                </Grid>
                                <SubmitRow>
                                  <Submit label={t('save')} />
                                </SubmitRow>
                              </Form>
                              {a.kind === 'activity' && view.project.status === 'active' ? (
                                <Form action={recordActivityActual}>
                                  <Hidden name="project_code" value={view.project.code} />
                                  <Hidden name="activity_code" value={a.code} />
                                  <p className={s.sapNote}>{x('actual_note')}</p>
                                  <Grid>
                                    <Field defaultValue={a.actualStart ?? ''} label={x('actual_start')} name="actual_start" type="date" />
                                    <Field label={x('actual_finish')} name="actual_finish" type="date" />
                                    <Field defaultValue={String(Number(a.percentComplete))} label={x('percent_complete')} name="percent_complete" />
                                  </Grid>
                                  <SubmitRow>
                                    <Submit label={x('record_actual')} tone="secondary" />
                                  </SubmitRow>
                                </Form>
                              ) : null}
                              {!a.reachedOn ? (
                                <Form action={cancelProjectActivity}>
                                  <Hidden name="project_code" value={view.project.code} />
                                  <Hidden name="activity_code" value={a.code} />
                                  <p className={s.sapNote}>{x('cancel_activity_note')}</p>
                                  <Field label={t('reason')} name="reason" required wide />
                                  <SubmitRow>
                                    <Submit label={x('cancel_activity')} tone="secondary" />
                                  </SubmitRow>
                                </Form>
                              ) : null}
                            </NewRecordDialog>
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

      {view && plan && plan.links.length > 0 ? (
        <section aria-labelledby="wbs-links-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="wbs-links-title">
              <span>{x('links')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: plan.links.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="wbs-links-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('predecessor')}</th>
                    <th scope="col">{x('successor')}</th>
                    <th scope="col">{x('link_kind')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('lag_days')}
                    </th>
                    {mayEdit ? <th scope="col">{t('actions')}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {plan.links.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <bdi dir="ltr">{l.predecessor}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{l.successor}</bdi>
                      </td>
                      <td>{l.kind === 'SS' ? x('link_ss') : x('link_fs')}</td>
                      <td className={s.sapNum}>{l.lagDays}</td>
                      {mayEdit ? (
                        <td>
                          <Form action={unlinkActivities}>
                            <Hidden name="project_code" value={view.project.code} />
                            <Hidden name="dependency_id" value={l.id} />
                            <Submit label={x('unlink')} small tone="secondary" />
                          </Form>
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
    </AdminPage>
  );
}
