import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { TaskAssignmentFields } from '@/components/admin/task-assignment-fields';
import { Denied } from '@/components/denied';
import { Pagination } from '@/components/ui';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { SCOPE_VIAS, TASK_PRIORITIES, TASK_STATUS_TONE } from '@/server/domain/tasks';
import { registerAllRecords } from '@/server/records';
import { requireContext, withCurrentUser } from '@/server/session';
import * as tasks from '@/server/services/tasks';
import { createTask } from './actions';

/**
 * Tasks — platform phase, Agent 3. Copies the Purchase Invoices list: the
 * register, the New dialog, the filters as a form of Selects, paging. One
 * route, three views behind the View filter — My tasks, Assigned by me, and
 * Team (offered only to somebody who leads people) — and the bucket filter
 * (due today, soon, overdue, blocked, waiting for review, completed) carries
 * its counts in its choices. The team's load by person is a register stacked
 * underneath, as the supplier statement stacks its own.
 */
export const dynamic = 'force-dynamic';

/** Intent's badge: the priority and how near the deadline is read at a glance (the words are the same). */
const BADGE = 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const PRIORITY_LOOK: Record<string, string> = {
  low: 'bg-secondary text-muted-fg',
  normal: 'bg-secondary text-secondary-fg',
  high: 'bg-warning-subtle text-warning-subtle-fg',
  urgent: 'bg-danger-subtle text-danger-subtle-fg',
};
const DUE_LOOK: Record<'overdue' | 'today' | 'soon', string> = {
  overdue: 'bg-danger-subtle text-danger-subtle-fg',
  today: 'bg-warning-subtle text-warning-subtle-fg',
  soon: 'bg-info-subtle text-info-subtle-fg',
};

export default async function TasksPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/tasks')) notFound();
  registerAllRecords();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.tasks'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', tasks.PERMISSION_OBJECT)) return <Denied object={page('my_tasks')} />;
  const mayCreate = can(principal, 'create', tasks.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : 'mine';
  const bucketParam = typeof params.bucket === 'string' ? params.bucket : '';
  const reader = { principal };

  const found = await withCurrentUser(async (tx) => {
    const showTeam = await tasks.leadsAnyone(tx, reader);
    const view = tasks.isView(viewParam) && (viewParam !== 'team' || showTeam) ? viewParam : 'mine';
    // One after the other: the transaction is one connection and answers one question at a time.
    const result = await tasks.listForScreen(tx, reader, { view, bucket: bucketParam || null, search: outcome.q, page: outcome.page });
    const counts = await tasks.countsFor(tx, reader, view);
    const workload = view === 'team' ? await tasks.teamWorkload(tx, reader) : [];
    const choices = mayCreate ? await tasks.assignmentChoices(tx, reader, context.scope.branchCode) : [];
    return { showTeam, view, result, counts, workload, choices };
  });
  const { showTeam, view, result, counts, workload, choices } = found;
  const bucket = result.bucket;
  const kinds = mayCreate ? tasks.relatedKinds(reader) : [];
  const mayRaise = mayCreate && choices.length > 0;

  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const query = (p: number) =>
    new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), view, ...(bucket !== 'all' ? { bucket } : {}), page: String(p) }).toString();
  const bucketLabel = (b: (typeof tasks.BUCKETS)[number]) => `${x(`bucket_${b}`)} (${counts[b]})`;
  const columnsFor = view === 'assigned' ? 7 : view === 'team' ? 6 : 7;

  return (
    <AdminPage
      actions={
        mayRaise ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new_title')}>
            <Form action={createTask}>
              <Grid>
                <Field label={x('title_field')} maxLength={200} name="title" required wide />
                <TaskAssignmentFields
                  assigneeOptional
                  idPrefix="new-task"
                  labels={{
                    section: x('section'),
                    assignee: x('assignee'),
                    none: x('assignee_none'),
                    hint: x('assignee_hint'),
                    empty: x('assignee_empty'),
                    via: Object.fromEntries(SCOPE_VIAS.map((v) => [v, x(`via_${v}`)])),
                  }}
                  sections={choices}
                />
                <Select defaultValue="normal" label={x('priority')} name="priority" options={TASK_PRIORITIES.map((p) => ({ value: p, label: x(`priority_${p}`) }))} />
                <Field label={x('due')} name="due_date" type="date" />
                <Field label={x('description')} maxLength={4000} name="description" type="textarea" wide />
                <Select emptyLabel={x('related_none')} label={x('related_type')} name="related_type" options={kinds.map((k) => ({ value: k.type, label: k.folderName }))} />
                <Field hint={x('related_hint')} label={x('related_no')} name="related_no" />
                <Field hint={x('tags_hint')} label={x('tags')} name="tags" />
                <div className={s.field}>
                  <label className={s.label} htmlFor="f-task-files">
                    {x('files')}
                  </label>
                  <input
                    className="w-full min-w-0 rounded-lg border border-input bg-[var(--w-field,var(--ui-bg))] p-1 text-sm text-muted-fg shadow-xs file:me-3 file:h-7 file:cursor-pointer file:rounded-md file:border-0 file:bg-secondary file:px-3 file:text-sm file:font-medium file:text-fg hover:file:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    id="f-task-files"
                    multiple
                    name="files"
                    type="file"
                  />
                  <span className={s.hint}>{x('files_hint')}</span>
                </div>
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/tasks" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="tasks-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={`${s.sapWindow} mb-5`}>
          <h2 className={s.sapTitle} id="tasks-list-title">
            <span>{x(`view_${view}`)}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/tasks"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view}
                label={x('view')}
                name="view"
                options={[
                  { value: 'mine', label: x('view_mine') },
                  { value: 'assigned', label: x('view_assigned') },
                  ...(showTeam ? [{ value: 'team', label: x('view_team') }] : []),
                ]}
              />
              <Select
                defaultValue={bucket === 'all' ? '' : bucket}
                emptyLabel={bucketLabel('all')}
                label={x('bucket')}
                name="bucket"
                options={tasks.BUCKETS.filter((b) => b !== 'all').map((b) => ({ value: b, label: bucketLabel(b) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="tasks-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('title_field')}</th>
                  {view === 'mine' ? <th scope="col">{x('assigned_by')}</th> : <th scope="col">{x('assignee')}</th>}
                  {view !== 'assigned' ? <th scope="col">{x('section')}</th> : null}
                  <th scope="col">{x('priority')}</th>
                  <th scope="col">{x('due')}</th>
                  <th scope="col">{column('status')}</th>
                  {view === 'assigned' ? (
                    <th className={s.sapNum} scope="col">
                      {x('progress')}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={columnsFor}>
                      {x(`none_${view}`)}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => {
                  const tone = TASK_STATUS_TONE[row.status] ?? 'draft';
                  const who = view === 'mine' ? { name: row.assignedByName } : { name: row.assigneeName };
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link className={s.sapLink} href={`/tasks/${encodeURIComponent(row.taskNo)}`}>
                          <bdi dir="ltr">{row.taskNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{row.title}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{who.name ?? (row.status === 'draft' ? x('draft_unassigned') : '—')}</bdi>
                      </td>
                      {view !== 'assigned' ? (
                        <td>
                          <bdi dir="auto">{row.departmentName}</bdi>
                        </td>
                      ) : null}
                      <td>
                        <span className={`${BADGE} ${PRIORITY_LOOK[row.priority] ?? PRIORITY_LOOK.normal}`}>{x(`priority_${row.priority}`)}</span>
                      </td>
                      <td>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <bdi className="tabular-nums" dir="ltr">
                            {day(row.dueDate)}
                          </bdi>
                          {row.dueState === 'overdue' || row.dueState === 'today' || row.dueState === 'soon' ? (
                            <span className={`${BADGE} ${DUE_LOOK[row.dueState]}`}>{x(`due_${row.dueState}`)}</span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                          {x(`status_${row.status}`)}
                        </span>
                      </td>
                      {view === 'assigned' ? (
                        <td className={s.sapNum}>
                          <span className="inline-flex items-center justify-end gap-2">
                            <span aria-hidden="true" className="h-1.5 w-14 overflow-hidden rounded-full bg-secondary">
                              <span className="block h-full rounded-full bg-primary" style={{ inlineSize: `${Math.max(0, Math.min(100, Number(row.progress) || 0))}%` }} />
                            </span>
                            <bdi className="tabular-nums" dir="ltr">
                              {row.progress}%
                            </bdi>
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            count={result.pages}
            current={result.page}
            hrefFor={(p) => `/tasks?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>

      {view === 'team' ? (
        <section aria-labelledby="tasks-workload-title" className={`${s.sapDoc} ${s.sapRegister}`}>
          <div className={`${s.sapWindow} mb-5`}>
            <h2 className={s.sapTitle} id="tasks-workload-title">
              <span>{x('workload_title')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: workload.length })}</span>
            </h2>
            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table aria-labelledby="tasks-workload-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{x('section')}</th>
                    <th scope="col">{x('assignee')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('workload_open')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('workload_overdue')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('workload_blocked')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('workload_review')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('workload_completed')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {workload.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {x('workload_none')}
                      </td>
                    </tr>
                  ) : null}
                  {workload.map((w) => (
                    <tr key={`${w.departmentCode}-${w.assigneeId}`}>
                      <td>
                        <bdi dir="auto">{w.departmentName}</bdi>
                      </td>
                      <td>
                        {w.employeeNo && can(principal, 'view', 'employee') ? (
                          <ProfileLink code={w.employeeNo} dir="auto" kind="employee" name={w.assigneeName} />
                        ) : (
                          <bdi dir="auto">{w.assigneeName}</bdi>
                        )}
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{w.open}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{w.overdue}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{w.blocked}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{w.review}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{w.completed}</bdi>
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
