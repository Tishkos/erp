import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, ReasonForm, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { Attachments } from '@/components/admin/attachments';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { isNotFoundError } from '@/server/not-found';
import { businessToday } from '@/server/domain/business-date';
import * as attachmentsService from '@/server/services/attachments';
import * as recordNotes from '@/server/services/record-notes';
import * as chart from '@/server/services/chart-of-accounts';
import * as departments from '@/server/services/departments';
import * as recurring from '@/server/services/recurring-journals';
import {
  activateRecurringAction,
  addRecurringLineAction,
  attachToRecurring,
  endRecurringAction,
  pauseRecurringAction,
  raiseDueAction,
  removeRecurringLineAction,
  updateRecurringAction,
} from '../actions';
import { RECURRING_CHIP } from '../status';

/**
 * One Recurring Journal — REQ-ACC-001 Part D-7.
 *
 * The record model's window: the template's boxes (schedule, next due date,
 * who wrote and agreed it), its lines as the journal it raises (each account
 * a link), and at the foot what may be done — add or remove lines while a
 * draft, agree it, raise the journals due, pause, end. Under it, every
 * journal it raised, each opening its own page. The four doors from the
 * draft on.
 */
export const dynamic = 'force-dynamic';

export default async function RecurringJournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ templateNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/finance/recurring-journals')) notFound();
  const { templateNo: raw } = await params;
  const templateNo = decodeURIComponent(raw);

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.recurring_journals'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', recurring.PERMISSION_OBJECT)) {
    return <Denied object={page('recurring_journals')} />;
  }

  const found = await withCurrentUser(async (tx, request) => {
    try {
      const view = await recurring.view(tx, { principal: request.principal, branchCode: request.scope.branchCode }, templateNo);
      const draft = view.template.status === 'draft';
      return {
        view,
        attached: (await attachmentsService.currentFor(tx, recurring.DOCUMENT_TYPE, view.template.id)).length,
        notes: await recordNotes.listNotes(tx, { object: recurring.DOCUMENT_TYPE, recordId: view.template.id }),
        accounts: draft ? await chart.postableAccounts(tx) : [],
        depts: draft ? (await departments.listAll(tx)).filter((d) => d.active) : [],
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) notFound();
  const { view, attached, notes, accounts, depts } = found;
  const { template, lines, runs, totals } = view;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const hidden = { template_no: template.templateNo };
  const chip = RECURRING_CHIP[template.status] ?? 'draft';
  const isDraft = template.status === 'draft';
  const mine = template.createdBy === principal.userId && !principal.isSuperUser;
  const mayEdit = isDraft && can(principal, 'edit_draft', recurring.PERMISSION_OBJECT);
  const mayActivate =
    (isDraft || template.status === 'paused') && can(principal, 'approve', recurring.PERMISSION_OBJECT) && !(isDraft && mine);
  const mayRaise =
    template.status === 'active' && template.nextDueOn !== null && template.nextDueOn <= businessToday() && can(principal, 'create', recurring.PERMISSION_OBJECT);
  const mayPause = template.status === 'active' && can(principal, 'approve', recurring.PERMISSION_OBJECT);
  const mayEnd = template.status !== 'ended' && can(principal, 'approve', recurring.PERMISSION_OBJECT);
  const every =
    template.intervalCount === 1
      ? t(`frequency_${template.frequency}`)
      : t('every_n', { n: template.intervalCount, unit: t(`unit_${template.frequency}`) });

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{template.templateNo}</bdi> },
    { label: t('col_status'), value: t(`status_${template.status}`), status: chip },
    { label: t('name'), value: <bdi dir="auto">{template.name}</bdi> },
    { label: t('frequency'), value: every },
    { label: t('starts_on'), value: <bdi dir="ltr">{day(template.startsOn)}</bdi> },
    { label: t('ends_on'), value: <bdi dir="ltr">{day(template.endsOn)}</bdi> },
    { label: t('next_due'), value: <bdi dir="ltr">{day(template.nextDueOn)}</bdi> },
    { label: t('branch'), value: <bdi dir="ltr">{template.branchCode}</bdi> },
    { label: t('written_by'), value: <bdi dir="auto">{view.createdByName ?? '—'}</bdi> },
    { label: t('agreed_by'), value: <bdi dir="auto">{view.activatedByName ?? admin('none')}</bdi> },
    ...(template.description ? [{ label: t('description'), value: <bdi dir="auto">{template.description}</bdi>, wide: true }] : []),
    ...(template.endReason
      ? [{ label: t('end_reason'), value: <bdi dir="auto">{`${view.endedByName ?? '—'} — ${template.endReason}`}</bdi>, status: 'closed', wide: true }]
      : []),
  ];

  return (
    <AdminPage
      back={{ href: '/finance/recurring-journals', label: page('recurring_journals') }}
      tabs={<SectionTabs route="/finance/recurring-journals" />}
      title={`${template.templateNo} · ${template.name}`}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={t('add_line')} closeLabel={admin('close')} title={t('add_line')}>
                <Form action={addRecurringLineAction}>
                  <Hidden name="template_no" value={template.templateNo} />
                  <Grid>
                    <Select
                      label={t('account')}
                      name="account_id"
                      options={accounts.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }))}
                      required
                    />
                    <Select
                      label={t('side')}
                      name="side"
                      options={[
                        { value: 'debit', label: t('debit') },
                        { value: 'credit', label: t('credit') },
                      ]}
                      required
                    />
                    <Field label={t('amount')} name="amount" required />
                    <Select
                      emptyLabel="—"
                      label={t('department')}
                      name="department_code"
                      options={depts.map((dept) => ({ value: dept.code, label: `${dept.code} · ${dept.name}` }))}
                    />
                  </Grid>
                  <Field label={t('line_note')} name="line_description" wide />
                  <SubmitRow>
                    <Submit label={t('add_line')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit ? (
              <NewRecordDialog buttonLabel={t('edit')} closeLabel={admin('close')} title={t('edit')}>
                <Form action={updateRecurringAction}>
                  <Hidden name="template_no" value={template.templateNo} />
                  <Grid>
                    <Field defaultValue={template.name} label={t('name')} name="name" required />
                    <Select
                      defaultValue={template.frequency}
                      label={t('frequency')}
                      name="frequency"
                      options={recurring.RECURRING_FREQUENCIES.map((key) => ({ value: key, label: t(`frequency_${key}`) }))}
                      required
                    />
                    <Field defaultValue={template.intervalCount} hint={t('interval_hint')} label={t('interval')} max={12} min={1} name="interval_count" type="number" />
                    <Field defaultValue={template.startsOn} label={t('starts_on')} name="starts_on" required type="date" />
                    <Field defaultValue={template.endsOn} hint={t('ends_on_hint')} label={t('ends_on')} name="ends_on" type="date" />
                  </Grid>
                  <Field defaultValue={template.description} label={t('description')} name="description" wide />
                  <SubmitRow>
                    <Submit label={admin('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayActivate ? (
              <form action={activateRecurringAction} title={t('activate_hint')}>
                <Hidden name="template_no" value={template.templateNo} />
                <Submit label={isDraft ? t('activate') : t('resume')} variant="document" />
              </form>
            ) : null}
            {mayRaise ? (
              <form action={raiseDueAction}>
                <Hidden name="template_no" value={template.templateNo} />
                <Submit label={t('raise_due')} variant="document" />
              </form>
            ) : null}
            {mayPause ? <ReasonForm action={pauseRecurringAction} hidden={hidden} label={t('pause')} reasonLabel={t('pause_reason')} tone="secondary" /> : null}
            {mayEnd ? <ReasonForm action={endRecurringAction} hidden={hidden} label={t('end')} reasonLabel={t('end_reason')} /> : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the moment the draft exists. */}
            <ExportIcon exportKey="recurring_journal" id={template.templateNo} title={`${t('document_type')} ${template.templateNo}`} />
            <AttachmentsButton
              closeLabel={admin('close')}
              count={attached}
              label={admin('attachments.title')}
              title={admin('attachments.title')}
            >
              <Attachments
                action={attachToRecurring}
                hidden={hidden}
                mayAttach={can(principal, 'create', 'attachment')}
                objectId={template.id}
                objectType={recurring.DOCUMENT_TYPE}
              />
            </AttachmentsButton>
            <RecordNotesDoor notes={notes} object={recurring.DOCUMENT_TYPE} recordId={template.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={template.id} objectType={recurring.DOCUMENT_TYPE} />
            </HistoryButton>
          </>
        }
        documentType={t('document_type')}
        fields={fields}
        id="recurring-journal-document"
        linesCount={lines.length}
        linesTitle={t('lines')}
        number={template.templateNo}
        totals={[
          { label: t('debit'), value: money(totals.debit) },
          { label: t('credit'), value: money(totals.credit) },
        ]}
      >
        <table aria-labelledby="recurring-journal-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t('account')}</th>
              <th scope="col">{t('department')}</th>
              <th scope="col">{t('line_note')}</th>
              <th className={s.sapNum} scope="col">
                {t('debit')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('credit')}
              </th>
              {mayEdit ? <th scope="col" /> : null}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={mayEdit ? 7 : 6}>
                  {t('no_lines')}
                </td>
              </tr>
            ) : null}
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td className={s.sapAccountCell}>
                  <ProfileLink code={line.accountCode} kind="gl_account" name={line.accountName} />
                </td>
                <td>
                  <bdi dir="ltr">{line.departmentCode ?? ''}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description ?? ''}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{Number(line.debit) === 0 ? '' : money(line.debit)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{Number(line.credit) === 0 ? '' : money(line.credit)}</bdi>
                </td>
                {mayEdit ? (
                  <td>
                    <form action={removeRecurringLineAction}>
                      <Hidden name="template_no" value={template.templateNo} />
                      <Hidden name="line_id" value={line.id} />
                      <Submit label={t('remove_line')} small tone="secondary" />
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td colSpan={4}>{totals.balanced ? t('balanced') : t('out_of_balance')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(totals.debit)}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(totals.credit)}</bdi>
              </td>
              {mayEdit ? <td /> : null}
            </tr>
          </tfoot>
        </table>
      </DocumentWindow>

      {/* ── Every journal it raised ── */}
      <section aria-labelledby="recurring-runs-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="recurring-runs-title">
            <span>{t('runs_title')}</span>
            <span className={s.sapTitleMeta}>{runs.length}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="recurring-runs-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('due_on')}</th>
                  <th scope="col">{t('journal')}</th>
                  <th scope="col">{t('col_status')}</th>
                  <th scope="col">{t('raised_by')}</th>
                  <th scope="col">{t('raised_at')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {t('no_runs')}
                    </td>
                  </tr>
                ) : null}
                {runs.map((run) => (
                  <tr key={run.entryNo}>
                    <td>
                      <bdi dir="ltr">{day(run.dueOn)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={run.entryNo} kind="journal" />
                    </td>
                    <td>
                      <span className={`status status--${run.status}`} data-status={run.status}>
                        {status.has(run.status) ? status(run.status) : run.status}
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{run.raisedBy ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatTimestamp(run.raisedAt.toISOString(), locale as Locale)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
