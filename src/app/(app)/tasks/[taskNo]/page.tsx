import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { readAttachments } from '@/components/admin/attachments';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { TaskAssignmentFields } from '@/components/admin/task-assignment-fields';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { SCOPE_VIAS, TASK_PRIORITIES, TASK_STATUS_TONE, type TaskAction } from '@/server/domain/tasks';
import { registerAllRecords } from '@/server/records';
import { requireContext, withCurrentUser } from '@/server/session';
import * as recordNotes from '@/server/services/record-notes';
import * as tasks from '@/server/services/tasks';
import { addWatcher, removeWatcher, replyInChat, stepTask, updateTask } from '../actions';

/**
 * One task — platform phase, Agent 3. Copies the HR request page: the
 * document window with its header fields and status chip; its lines the
 * road the task has walked, with who took each step and when; the verbs at
 * its foot — and only the ones this person may take now (the service says
 * which, the same function the step itself asks); the four doors in the
 * title bar; the people watching it as a register stacked underneath.
 */
export const dynamic = 'force-dynamic';

/** The priority as Intent's badge (the same word, read at a glance) — as on My Tasks. */
const BADGE = 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const PRIORITY_LOOK: Record<string, string> = {
  low: 'bg-secondary text-muted-fg',
  normal: 'bg-secondary text-secondary-fg',
  high: 'bg-warning-subtle text-warning-subtle-fg',
  urgent: 'bg-danger-subtle text-danger-subtle-fg',
};

/** The steps taken without saying anything; a step that must say why gets its own box. */
const PLAIN: readonly TaskAction[] = ['accept', 'start', 'resume', 'submit', 'complete'];
/** The steps that cannot be taken without a reason. */
const WITH_REASON: readonly TaskAction[] = ['reject', 'block', 'return', 'cancel'];

export default async function TaskPage({ params, searchParams }: { params: Promise<{ taskNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/tasks')) notFound();
  registerAllRecords();
  const [t, x, page, column, locale, context, outcome, { taskNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.tasks'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const taskNo = decodeURIComponent(rawNo);
  const { principal } = context;
  const reader = { principal };
  if (!can(principal, 'view', tasks.PERMISSION_OBJECT)) return <Denied object={page('my_tasks')} />;

  // Row security decides who sees it: the people on it, the watchers, and the leads of its section.
  const found = await withCurrentUser(async (tx) => {
    const detail = await tasks.byNo(tx, reader, taskNo);
    if (!detail) return null;
    const { row } = detail;
    const needsChoices = detail.actions.includes('assign') || detail.actions.includes('reassign');
    return {
      detail,
      choices: needsChoices ? await tasks.assignmentChoices(tx, reader, row.branchCode) : [],
      watcherChoices: detail.mayWatch ? await tasks.watcherChoices(tx, row.branchCode) : [],
      // Notes by number, as its history is; the files by its id, as every record files them.
      notes: await recordNotes.listNotes(tx, { object: tasks.PERMISSION_OBJECT, recordId: row.taskNo }),
      files: await readAttachments(tx, tasks.PERMISSION_OBJECT, row.id),
    };
  });
  if (!found) notFound();
  const { detail, choices, watcherChoices, notes, files } = found;
  const { row } = detail;

  const tone = TASK_STATUS_TONE[row.status] ?? 'draft';
  const live = row.status !== 'completed' && row.status !== 'cancelled';
  const mayOpenPerson = can(principal, 'view', 'employee');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const moment = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const person = (p: { name: string; employeeNo: string | null } | null) =>
    p === null ? '—' : p.employeeNo && mayOpenPerson ? <ProfileLink code={p.employeeNo} dir="auto" kind="employee" name={p.name} /> : <bdi dir="auto">{p.name}</bdi>;
  const hasAction = (action: TaskAction) => detail.actions.includes(action);
  const via = Object.fromEntries(SCOPE_VIAS.map((v) => [v, x(`via_${v}`)]));
  const labels = { section: x('section'), assignee: x('assignee'), none: x('assignee_none'), hint: x('assignee_hint'), empty: x('assignee_empty'), via };
  const kinds = detail.mayEdit ? tasks.relatedKinds(reader) : [];
  const counterpart = [row.assigneeId, row.assignedBy, row.createdBy].some((id) => id && id !== principal.userId);
  const mayChat = visibleRoute('/chat') && can(principal, 'create', 'chat') && counterpart;

  const dueText =
    detail.dueState === 'overdue' || detail.dueState === 'today' || detail.dueState === 'soon'
      ? `${day(row.dueDate)} · ${x(`due_${detail.dueState}`)}`
      : day(row.dueDate);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.taskNo}</bdi> },
    { label: column('status'), value: x(`status_${row.status}`), status: tone },
    { label: x('title_field'), value: <bdi dir="auto">{row.title}</bdi> },
    {
      label: x('priority'),
      value: <span className={`${BADGE} ${PRIORITY_LOOK[row.priority] ?? PRIORITY_LOOK.normal}`}>{x(`priority_${row.priority}`)}</span>,
    },
    { label: x('section'), value: <bdi dir="auto">{detail.departmentName}</bdi> },
    { label: x('assignee'), value: person(detail.assignee) },
    { label: x('assigned_by'), value: person(detail.assignedBy) },
    { label: x('created_by'), value: person(detail.createdBy) },
    { label: x('due'), value: <bdi dir="ltr">{dueText}</bdi> },
    {
      label: x('progress'),
      value: (
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="h-1.5 w-20 overflow-hidden rounded-full bg-secondary">
            <span className="block h-full rounded-full bg-primary" style={{ inlineSize: `${Math.max(0, Math.min(100, Number(detail.progress) || 0))}%` }} />
          </span>
          <bdi className="tabular-nums" dir="ltr">
            {detail.progress}%
          </bdi>
        </span>
      ),
    },
    ...(detail.related
      ? [
          {
            label: x('related'),
            value: detail.related.href ? (
              <Link className={s.sapLink} href={detail.related.href}>
                <bdi dir="ltr">{detail.related.label}</bdi>
              </Link>
            ) : (
              <bdi dir="ltr">{detail.related.label}</bdi>
            ),
          },
        ]
      : []),
    ...(row.tags.length > 0 ? [{ label: x('tags'), value: <bdi dir="auto">{row.tags.join(', ')}</bdi> }] : []),
    ...(row.statusNote ? [{ label: x('latest_note'), value: <bdi dir="auto">{row.statusNote}</bdi>, wide: true }] : []),
    ...(row.description ? [{ label: x('description'), value: <bdi dir="auto">{row.description}</bdi>, wide: true }] : []),
  ];

  // The road walked so far: each step that has a time, in the order it happened.
  const steps: { key: string; by: { name: string; employeeNo: string | null } | null; at: Date | null }[] = [
    { key: 'created', by: detail.createdBy, at: row.createdAt },
    { key: 'assigned', by: detail.assignedBy, at: row.assignedAt },
    { key: 'accepted', by: detail.assignee, at: row.acceptedAt },
    { key: 'started', by: detail.assignee, at: row.startedAt },
    { key: 'blocked', by: detail.assignee, at: row.blockedAt },
    { key: 'submitted', by: detail.assignee, at: row.submittedAt },
    { key: 'completed', by: detail.assignedBy, at: row.completedAt },
    { key: 'cancelled', by: null, at: row.cancelledAt },
  ];
  const reached = steps.filter((step) => step.at !== null);

  const hidden = <input name="task_no" type="hidden" value={row.taskNo} />;
  const step = (action: TaskAction) => <input name="action" type="hidden" value={action} />;
  const addable = watcherChoices.filter((w) => !row.watcherIds.includes(w.id) && w.id !== row.createdBy && w.id !== row.assigneeId);
  const mayAssignNow = hasAction('assign') && choices.length > 0;
  const mayReassignNow = hasAction('reassign') && choices.length > 0;

  return (
    <AdminPage back={{ href: '/tasks', label: t('back') }} title={`${row.taskNo} · ${row.title}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {row.status === 'draft' ? <p className={s.sapNote}>{x('draft_note')}</p> : null}
      {detail.dueState === 'overdue' ? <p className={s.sapNote}>{x('overdue_note', { days: Math.abs(detail.daysLeft ?? 0) })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {detail.mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_title', { no: row.taskNo })}>
                <Form action={updateTask}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={row.title} label={x('title_field')} maxLength={200} name="title" required wide />
                    <Select defaultValue={row.priority} label={x('priority')} name="priority" options={TASK_PRIORITIES.map((p) => ({ value: p, label: x(`priority_${p}`) }))} />
                    <Field defaultValue={row.dueDate ?? ''} label={x('due')} name="due_date" type="date" />
                    <Field defaultValue={row.description ?? ''} label={x('description')} maxLength={4000} name="description" type="textarea" wide />
                    <Select
                      defaultValue={row.relatedType ?? ''}
                      emptyLabel={x('related_none')}
                      label={x('related_type')}
                      name="related_type"
                      options={kinds.map((k) => ({ value: k.type, label: k.folderName }))}
                    />
                    <Field defaultValue={row.relatedLabel ?? ''} hint={x('related_hint')} label={x('related_no')} name="related_no" />
                    <Field defaultValue={row.tags.join(', ')} hint={x('tags_hint')} label={x('tags')} name="tags" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}

            {mayAssignNow ? (
              <NewRecordDialog buttonLabel={x('action_assign')} closeLabel={t('close')} title={x('assign_title', { no: row.taskNo })}>
                <Form action={stepTask}>
                  {hidden}
                  {step('assign')}
                  <Grid>
                    <TaskAssignmentFields defaultSection={row.departmentCode} idPrefix="assign-task" labels={labels} sections={choices} />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('action_assign')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}

            {PLAIN.filter(hasAction).map((action) => (
              <form action={stepTask} key={action}>
                {hidden}
                {step(action)}
                <Submit label={x(`action_${action}`)} variant="document" />
              </form>
            ))}

            {WITH_REASON.filter(hasAction).map((action) => (
              <form action={stepTask} key={action}>
                {hidden}
                {step(action)}
                <input aria-label={x(`reason_${action}`)} maxLength={1000} name="reason" placeholder={x(`reason_${action}`)} required type="text" />
                <Submit label={x(`action_${action}`)} tone="secondary" variant="document" />
              </form>
            ))}

            {mayReassignNow ? (
              <NewRecordDialog buttonLabel={x('action_reassign')} closeLabel={t('close')} title={x('reassign_title', { no: row.taskNo })}>
                <Form action={stepTask}>
                  {hidden}
                  {step('reassign')}
                  <Grid>
                    <TaskAssignmentFields
                      defaultAssignee={row.assigneeId ?? undefined}
                      defaultSection={row.departmentCode}
                      idPrefix="reassign-task"
                      labels={labels}
                      sections={choices}
                    />
                    <Field hint={x('reason_reassign_hint')} label={x('reason_reassign')} maxLength={1000} name="reason" required wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('action_reassign')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}

            {mayChat ? (
              <form action={replyInChat}>
                {hidden}
                <Submit label={x('reply_in_chat')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the four doors every record wears. */}
            <ExportIcon exportKey="task" id={row.taskNo} title={`${x('document_type')} ${row.taskNo}`} />
            <RecordAttachmentsDoor files={files} mayAttach={live} object={tasks.PERMISSION_OBJECT} recordId={row.id} />
            <RecordNotesDoor notes={notes} object={tasks.PERMISSION_OBJECT} recordId={row.taskNo} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={row.taskNo} objectType={tasks.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={x('document_type')}
        fields={fields}
        id="task-document"
        linesCount={reached.length}
        linesTitle={x('timeline')}
        number={row.taskNo}
      >
        <table aria-labelledby="task-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('timeline_step')}</th>
              <th scope="col">{x('timeline_by')}</th>
              <th scope="col">{x('timeline_at')}</th>
            </tr>
          </thead>
          <tbody>
            {reached.map((entry) => (
              <tr key={entry.key}>
                <td>{x(`timeline_${entry.key}`)}</td>
                <td>{entry.by ? person(entry.by) : '—'}</td>
                <td>
                  <bdi dir="ltr">{moment(entry.at)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-labelledby="task-watchers-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={`${s.sapWindow} mb-5`}>
          <h2 className={s.sapTitle} id="task-watchers-title">
            <span>{x('watchers')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: detail.watchers.length })}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="task-watchers-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('watcher')}</th>
                  {detail.mayWatch ? <th scope="col">{x('watcher_action')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {detail.watchers.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={detail.mayWatch ? 2 : 1}>
                      {x('watchers_none')}
                    </td>
                  </tr>
                ) : null}
                {detail.watchers.map((w) => (
                  <tr key={w.id}>
                    <td>{person(w)}</td>
                    {detail.mayWatch ? (
                      <td>
                        <form action={removeWatcher}>
                          {hidden}
                          <input name="watcher_id" type="hidden" value={w.id} />
                          <Submit label={x('watcher_remove')} small tone="secondary" />
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.mayWatch && live && addable.length > 0 ? (
            <Form action={addWatcher}>
              {hidden}
              <Grid>
                <Select
                  emptyLabel="—"
                  label={x('watcher_add')}
                  name="watcher_id"
                  options={addable.map((w) => ({ value: w.id, label: w.name }))}
                />
              </Grid>
              <SubmitRow>
                <Submit label={x('watcher_add_submit')} />
              </SubmitRow>
            </Form>
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
