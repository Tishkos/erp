import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Attachments } from '@/components/admin/attachments';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { daysFrom, showDays, weekdayOf } from '@/server/domain/hr-time';
import { requireContext, withCurrentUser } from '@/server/session';
import * as leave from '@/server/services/leave';
import { approveLeave, attachToLeave, cancelLeave, refuseLeave, submitLeave, updateLeaveDraft } from '../actions';

/**
 * One leave request — REQ-HR-001 Stage HR-2 (§8). Copies the Purchase
 * Invoice page: the document window with its header fields and status chip,
 * its lines the days the span covers (each counted, a rest day or a
 * holiday), the verbs at its foot; the paper filed with it; the audit log.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = { draft: 'draft', submitted: 'submitted', approved: 'approved', refused: 'rejected', cancelled: 'cancelled' };

export default async function LeaveRequestPage({ params, searchParams }: { params: Promise<{ requestNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/leave')) notFound();
  const [t, x, page, column, locale, context, outcome, { requestNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.leave'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const requestNo = decodeURIComponent(rawNo);
  const { principal } = context;
  const actor = { principal, branchCode: context.scope.branchCode };

  // Row security decides who sees it: HR by branch, the person, their manager.
  const found = await withCurrentUser(async (tx) => {
    const detail = await leave.byNo(tx, requestNo);
    if (!detail) return null;
    return { detail, types: await leave.activeTypes(tx) };
  });
  if (!found) {
    if (!can(principal, 'view', leave.PERMISSION_OBJECT)) return <Denied object={page('leave')} />;
    notFound();
  }
  const { row, person, type, count, balance } = found.detail;
  const self = person.appUserId === principal.userId;
  const mayEdit = row.status === 'draft' && (self || can(principal, 'edit_draft', leave.PERMISSION_OBJECT));
  const mayDecide = leave.mayDecide(actor, person, row);
  const mayCancel =
    row.status === 'draft' || row.status === 'submitted'
      ? self || can(principal, 'edit_draft', leave.PERMISSION_OBJECT)
      : row.status === 'approved' && can(principal, 'administer', leave.PERMISSION_OBJECT);
  const tone = STATUS_TONE[row.status] ?? 'draft';
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const when = (value: Date | string | null) => (value ? formatTimestamp(new Date(value).toISOString(), locale as Locale) : '—');
  const typeLabel = locale === 'ar' && row.typeNameAr ? row.typeNameAr : row.typeName;
  const year = row.fromDate.slice(0, 4);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.requestNo}</bdi> },
    { label: column('status'), value: x(`status_${row.status}`), status: tone },
    {
      label: x('employee'),
      value: (
        <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(person.employeeNo)}`}>
          <bdi dir="auto">{`${person.employeeNo} · ${person.fullNameEn}`}</bdi>
        </Link>
      ),
    },
    { label: x('manager'), value: <bdi dir="auto">{person.managerName ?? '—'}</bdi> },
    { label: x('leave_type'), value: <bdi dir="auto">{typeLabel}</bdi> },
    { label: x('from_date'), value: <bdi dir="ltr">{`${day(row.fromDate)}${row.halfDayStart ? ` · ${x('half')}` : ''}`}</bdi> },
    { label: x('to_date'), value: <bdi dir="ltr">{`${day(row.toDate)}${row.halfDayEnd ? ` · ${x('half')}` : ''}`}</bdi> },
    { label: x('days'), value: <bdi dir="ltr">{showDays(count.total)}</bdi> },
    {
      label: x('balance_year', { year }),
      value: balance.limited ? <bdi dir="ltr">{x('balance_value', { balance: showDays(balance.balance), pending: showDays(balance.pending) })}</bdi> : x('not_limited'),
    },
    { label: x('requested_by'), value: <bdi dir="auto">{`${row.requestedByName ?? '—'} · ${when(row.createdAt)}`}</bdi> },
    { label: x('submitted_at'), value: <bdi dir="ltr">{when(row.submittedAt)}</bdi> },
    ...(row.decidedAt ? [{ label: x('decided_by'), value: <bdi dir="auto">{`${row.decidedByName ?? '—'} · ${when(row.decidedAt)}`}</bdi> }] : []),
    ...(row.decisionNote ? [{ label: x('decision_note'), value: <bdi dir="auto">{row.decisionNote}</bdi>, wide: true }] : []),
    ...(row.cancelledAt ? [{ label: x('cancelled_by'), value: <bdi dir="auto">{`${row.cancelledByName ?? '—'} · ${when(row.cancelledAt)}`}</bdi> }] : []),
    ...(row.cancelReason ? [{ label: x('cancel_reason'), value: <bdi dir="auto">{row.cancelReason}</bdi>, wide: true }] : []),
    { label: x('reason'), value: <bdi dir="auto">{row.reason ?? '—'}</bdi>, wide: true },
  ];

  const hidden = (
    <>
      <input name="id" type="hidden" value={row.id} />
      <input name="request_no" type="hidden" value={row.requestNo} />
    </>
  );

  return (
    <AdminPage back={{ href: '/hr/leave', label: t('back') }} title={`${row.requestNo} · ${person.fullNameEn}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {type.requiresAttachment && row.status === 'draft' ? <p className={s.sapNote}>{x('needs_attachment', { type: typeLabel })}</p> : null}
      {daysFrom(row.days) !== count.total && row.status !== 'draft' ? <p className={s.sapNote}>{x('recounted', { stored: showDays(daysFrom(row.days)), now: showDays(count.total) })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit')}>
                <Form action={updateLeaveDraft}>
                  {hidden}
                  <Grid>
                    <Select
                      defaultValue={row.leaveTypeCode}
                      label={x('leave_type')}
                      name="leave_type_code"
                      options={found.types.map((option) => ({ value: option.code, label: locale === 'ar' && option.nameAr ? option.nameAr : option.nameEn }))}
                      required
                    />
                    <Field defaultValue={row.fromDate} label={x('from_date')} name="from_date" required type="date" />
                    <Field defaultValue={row.toDate} label={x('to_date')} name="to_date" required type="date" />
                  </Grid>
                  <Checkbox defaultChecked={row.halfDayStart} label={x('half_day_start')} name="half_day_start" />
                  <Checkbox defaultChecked={row.halfDayEnd} label={x('half_day_end')} name="half_day_end" />
                  <Grid>
                    <Field defaultValue={row.reason ?? ''} label={x('reason')} name="reason" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit ? (
              <form action={submitLeave}>
                {hidden}
                <Submit label={x('submit')} variant="document" />
              </form>
            ) : null}
            {mayDecide ? (
              <NewRecordDialog buttonLabel={x('approve')} closeLabel={t('close')} title={x('approve_title', { no: row.requestNo })}>
                <Form action={approveLeave}>
                  {hidden}
                  <Grid>
                    <Field label={x('decision_note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('approve')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayDecide ? (
              <form action={refuseLeave}>
                {hidden}
                <input aria-label={x('refuse_reason')} name="note" placeholder={x('refuse_reason')} required type="text" />
                <Submit label={x('refuse')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelLeave}>
                {hidden}
                <input aria-label={x('cancel_reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                <Submit label={x('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('document_type')}
        fields={fields}
        id="leave-document"
        linesCount={count.days.length}
        linesTitle={x('days_title')}
        number={row.requestNo}
        totals={[{ label: x('days'), value: showDays(count.total) }]}
      >
        <table aria-labelledby="leave-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('day')}</th>
              <th scope="col">{x('weekday')}</th>
              <th scope="col">{x('counted_as')}</th>
              <th className={s.sapNum} scope="col">
                {x('days')}
              </th>
            </tr>
          </thead>
          <tbody>
            {count.days.map((entry) => (
              <tr key={entry.day}>
                <td>
                  <bdi dir="ltr">{day(entry.day)}</bdi>
                </td>
                <td>{x(`weekday_${weekdayOf(entry.day)}`)}</td>
                <td>{x(`kind_${entry.kind}`)}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{showDays(entry.portion)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-label={x('attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            action={attachToLeave}
            hidden={{ id: row.id, request_no: row.requestNo }}
            mayAttach={row.status !== 'cancelled' && row.status !== 'refused' && can(principal, 'create', 'attachment')}
            objectId={row.id}
            objectType={leave.PERMISSION_OBJECT}
          />
        </div>
      </section>

      <RecordHistory objectId={row.requestNo} objectType={leave.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
