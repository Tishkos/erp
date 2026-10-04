import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { readAttachments } from '@/components/admin/attachments';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { LETTER_TYPES } from '@/server/domain/hr-requests';
import { requireContext, withCurrentUser } from '@/server/session';
import * as requests from '@/server/services/employee-requests';
import * as payroll from '@/server/services/payroll';
import * as recordNotes from '@/server/services/record-notes';
import {
  approveRequest,
  cancelRequest,
  issueLetter,
  openTravelAdvance,
  payRequest,
  refuseRequest,
  submitRequest,
  updateRequest,
} from '../actions';

/**
 * One employee request — REQ-HR-001 Stage HR-6. Copies the Purchase Invoice
 * page: the document window with its header fields and status chip; its
 * lines a claim's expenses (typed in their cells while it is a draft), a
 * trip's claims, or a letter's text as issued; the verbs at its foot; the
 * receipts and papers filed under it; the audit log.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  submitted: 'submitted',
  approved: 'approved',
  refused: 'rejected',
  paid: 'posted',
  issued: 'posted',
  cancelled: 'cancelled',
};
/** Blank rows offered under a draft claim's lines, for new ones. */
const NEW_LINES = 3;

export default async function RequestPage({ params, searchParams }: { params: Promise<{ requestNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/requests')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome, { requestNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.requests'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const requestNo = decodeURIComponent(rawNo);
  const { principal } = context;
  // Row security decides who sees it: HR by branch, the person, their manager.
  const found = await withCurrentUser(async (tx) => {
    const detail = await requests.byNo(tx, requestNo);
    if (!detail) return null;
    const { row } = detail;
    const draft = row.status === 'draft';
    return {
      detail,
      categories: draft && row.kind === 'expense_claim' ? await requests.categories(tx) : [],
      trips: draft && row.kind === 'expense_claim' ? await requests.tripsOf(tx, row.employeeId) : [],
      accounts: row.status === 'approved' && row.kind === 'expense_claim' && can(principal, 'execute', requests.PERMISSION_OBJECT) ? await payroll.payingAccounts(tx) : [],
      letter: row.status === 'approved' && row.kind === 'letter' && can(principal, 'edit_draft', requests.PERMISSION_OBJECT) ? await requests.draftLetter(tx, row) : null,
      // Notes by number, as its history is; the receipts and papers by its id, as HR's records file them.
      notes: await recordNotes.listNotes(tx, { object: requests.PERMISSION_OBJECT, recordId: row.requestNo }),
      files: await readAttachments(tx, requests.PERMISSION_OBJECT, row.id),
    };
  });
  if (!found) {
    if (!can(principal, 'view', requests.PERMISSION_OBJECT)) return <Denied object={page('employee_requests')} />;
    notFound();
  }
  const { detail, categories, trips, accounts, letter, notes, files } = found;
  const { row, person } = detail;
  const me = principal.userId;
  const self = person.appUserId === me;
  const asker = row.requestedBy === me;
  const kind = row.kind;
  const decision = requests.decisionRefusal({ principal }, person, row);
  const mayEdit = row.status === 'draft' && (self || asker || can(principal, 'edit_draft', requests.PERMISSION_OBJECT));
  const mayDecide = row.status === 'submitted' && decision === null;
  const mayPay = row.status === 'approved' && kind === 'expense_claim' && !self && can(principal, 'execute', requests.PERMISSION_OBJECT);
  const mayIssue = row.status === 'approved' && kind === 'letter' && !self && letter !== null;
  const mayAdvance = row.status === 'approved' && kind === 'travel' && !row.advanceId && /[1-9]/.test(row.estimatedIqd ?? '') && can(principal, 'create', 'employee_advance');
  const mayCancel =
    !row.advanceId &&
    (['draft', 'submitted'].includes(row.status)
      ? self || asker || can(principal, 'edit_draft', requests.PERMISSION_OBJECT)
      : row.status === 'approved' && (kind === 'expense_claim' || kind === 'letter') && can(principal, 'approve', requests.PERMISSION_OBJECT));
  const tone = STATUS_TONE[row.status] ?? 'draft';
  const statusLabel = (value: string) => (value === 'paid' || value === 'issued' ? x(`status_${value}`) : statusOf(value === 'refused' ? 'rejected' : value));
  const iqd = (value: string | null) => (value === null ? '—' : formatMoney(value, 'IQD', locale as Locale));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const name = locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn;
  const mayOpenPerson = can(principal, 'view', 'employee');

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.requestNo}</bdi> },
    { label: column('status'), value: statusLabel(row.status), status: tone },
    { label: x('kind'), value: x(`kind_${kind}`) },
    {
      label: x('employee'),
      value: mayOpenPerson ? <ProfileLink code={person.employeeNo} dir="auto" kind="employee" name={name} /> : <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>,
    },
    { label: x('subject'), value: <bdi dir="auto">{row.subject}</bdi> },
    ...(kind === 'expense_claim'
      ? [
          { label: x('total'), value: <bdi dir="ltr">{iqd(row.amountIqd)}</bdi> },
          { label: x('trip'), value: <ProfileLink code={detail.tripNo} kind="employee_request" /> },
        ]
      : []),
    ...(kind === 'travel'
      ? [
          { label: x('destination'), value: <bdi dir="auto">{row.destination ?? '—'}</bdi> },
          { label: x('travel_dates'), value: <bdi dir="ltr">{`${day(row.travelFrom)} – ${day(row.travelTo)}`}</bdi> },
          { label: x('estimated'), value: <bdi dir="ltr">{iqd(row.estimatedIqd)}</bdi> },
          {
            label: x('advance'),
            value: detail.advanceNo ? (requests.mayOpenAdvance({ principal }) ? <ProfileLink code={detail.advanceNo} kind="employee_advance" /> : <bdi dir="ltr">{detail.advanceNo}</bdi>) : '—',
          },
        ]
      : []),
    ...(kind === 'letter'
      ? [
          { label: x('letter_type'), value: row.letterType ? x(`letter_type_${row.letterType}`) : '—' },
          { label: x('addressed_to'), value: <bdi dir="auto">{row.addressedTo ?? '—'}</bdi> },
        ]
      : []),
    { label: x('requested_by'), value: <bdi dir="auto">{when(detail.requestedByName, row.createdAt)}</bdi> },
    ...(row.decidedAt ? [{ label: row.status === 'refused' ? x('refused_by') : x('approved_by'), value: <bdi dir="auto">{when(detail.decidedByName, row.decidedAt)}</bdi> }] : []),
    ...(row.paidAt
      ? [
          { label: x('paid_by'), value: <bdi dir="auto">{when(detail.paidByName, row.paidAt)}</bdi> },
          { label: x('paid_on'), value: <bdi dir="ltr">{`${day(row.paidOn)}${row.paymentReference ? ` · ${row.paymentReference}` : ''}`}</bdi> },
          { label: x('account'), value: <ProfileLink code={detail.accountCode} kind={detail.accountType === 'cash' ? 'cash_account' : 'bank_account'} /> },
          { label: x('advance_offset'), value: <bdi dir="ltr">{iqd(row.advanceOffsetIqd)}</bdi> },
          { label: x('journal'), value: <ProfileLink code={detail.entryNo} kind="journal" /> },
        ]
      : []),
    ...(row.issuedAt ? [{ label: x('issued_by'), value: <bdi dir="auto">{when(detail.issuedByName, row.issuedAt)}</bdi> }] : []),
    ...(row.cancelledAt
      ? [
          { label: x('cancelled_by'), value: <bdi dir="auto">{when(detail.cancelledByName, row.cancelledAt)}</bdi> },
          { label: x('cancel_reason'), value: <bdi dir="auto">{row.cancelReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    ...(row.decisionNote ? [{ label: x('decision_note'), value: <bdi dir="auto">{row.decisionNote}</bdi>, wide: true }] : []),
    ...(row.details ? [{ label: x('details'), value: <bdi dir="auto">{row.details}</bdi>, wide: true }] : []),
  ];

  const hidden = <input name="request_no" type="hidden" value={row.requestNo} />;
  const claimRows = kind === 'expense_claim' && mayEdit ? [...detail.lines.map((l) => ({ line: l })), ...Array.from({ length: NEW_LINES }, () => ({ line: null }))] : [];
  const linesTitle = kind === 'expense_claim' ? x('lines_title') : kind === 'travel' ? x('claims_title') : kind === 'letter' ? x('letter_title') : x('details');
  const linesCount = kind === 'expense_claim' ? detail.lines.length : kind === 'travel' ? detail.claims.length : 1;

  return (
    <AdminPage
      back={{ href: '/hr/requests', label: t('back') }}
      title={`${row.requestNo} · ${name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {row.status === 'submitted' && decision === 'maker' ? <p className={s.sapNote}>{x('maker_checker')}</p> : null}
      {kind === 'expense_claim' && row.status === 'draft' && detail.lines.some((l) => l.requiresReceipt) ? <p className={s.sapNote}>{x('receipts_wanted')}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit && kind !== 'expense_claim' ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_title', { no: row.requestNo })}>
                <Form action={updateRequest}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={row.subject} label={x('subject')} name="subject" required wide />
                    <Field defaultValue={row.details ?? ''} label={x('details')} name="details" type="textarea" wide />
                    {kind === 'travel' ? (
                      <>
                        <Field defaultValue={row.destination ?? ''} label={x('destination')} name="destination" required />
                        <Field defaultValue={row.travelFrom ?? ''} label={x('travel_from')} name="travel_from" required type="date" />
                        <Field defaultValue={row.travelTo ?? ''} label={x('travel_to')} name="travel_to" required type="date" />
                        <Field defaultValue={row.estimatedIqd ? row.estimatedIqd.replace(/\.0+$/, '') : ''} hint={x('estimated_hint')} label={x('estimated')} name="estimated" />
                      </>
                    ) : null}
                    {kind === 'letter' ? (
                      <>
                        <Select defaultValue={row.letterType ?? 'employment'} label={x('letter_type')} name="letter_type" options={LETTER_TYPES.map((type) => ({ value: type, label: x(`letter_type_${type}`) }))} />
                        <Field defaultValue={row.addressedTo ?? ''} label={x('addressed_to')} name="addressed_to" />
                      </>
                    ) : null}
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit ? (
              <form action={submitRequest}>
                {hidden}
                <Submit label={x('submit')} variant="document" />
              </form>
            ) : null}
            {mayDecide ? (
              <NewRecordDialog buttonLabel={x('approve')} closeLabel={t('close')} title={x('approve_title', { no: row.requestNo })}>
                <Form action={approveRequest}>
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
              <form action={refuseRequest}>
                {hidden}
                <input aria-label={x('refuse_reason')} name="note" placeholder={x('refuse_reason')} required type="text" />
                <Submit label={x('refuse')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayPay ? (
              <NewRecordDialog buttonLabel={x('pay')} closeLabel={t('close')} title={x('pay_title', { no: row.requestNo })}>
                <Form action={payRequest}>
                  {hidden}
                  {detail.tripNo ? <p className={s.sapGridCaption}>{x('pay_offset_caption', { trip: detail.tripNo })}</p> : null}
                  <Grid>
                    <Select emptyLabel={x('account_none')} label={x('account')} name="account_id" options={accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))} />
                    <Field defaultValue={businessToday()} label={x('paid_on')} name="paid_on" required type="date" />
                    <Field label={x('reference')} name="reference" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('pay')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayIssue ? (
              <NewRecordDialog buttonLabel={x('issue')} closeLabel={t('close')} title={x('issue_title', { no: row.requestNo })} wide>
                <Form action={issueLetter}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('issue_caption')}</p>
                  <Grid>
                    <Field defaultValue={letter ?? ''} label={x('letter_text')} name="issued_text" required type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('issue')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayAdvance ? (
              <form action={openTravelAdvance}>
                {hidden}
                <Submit label={x('open_advance')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelRequest}>
                {hidden}
                <input aria-label={x('cancel_reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                <Submit label={x('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the draft on (2026-10-04). An issued letter prints as the letter. */}
            <ExportIcon exportKey="employee_request" id={row.requestNo} title={`${x(`document_type_${kind}`)} ${row.requestNo}`} />
            <RecordAttachmentsDoor files={files} mayAttach={!['cancelled', 'refused', 'paid', 'issued'].includes(row.status)} object={requests.PERMISSION_OBJECT} recordId={row.id} />
            <RecordNotesDoor notes={notes} object={requests.PERMISSION_OBJECT} recordId={row.requestNo} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={row.requestNo} objectType={requests.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={x(`document_type_${kind}`)}
        fields={fields}
        id="request-document"
        linesCount={linesCount}
        linesTitle={linesTitle}
        number={row.requestNo}
        totals={kind === 'expense_claim' ? [{ label: x('total'), value: iqd(row.amountIqd) }] : kind === 'travel' && row.estimatedIqd ? [{ label: x('estimated'), value: iqd(row.estimatedIqd) }] : []}
      >
        {kind === 'expense_claim' && mayEdit ? (
          <Form action={updateRequest}>
            {hidden}
            <Hidden name="line_count" value={String(claimRows.length)} />
            <Grid>
              <Field defaultValue={row.subject} label={x('subject')} name="subject" required />
              <Select
                defaultValue={detail.tripNo ?? ''}
                emptyLabel={x('trip_none')}
                hint={x('trip_hint')}
                label={x('trip')}
                name="travel_request_no"
                options={trips.map((trip) => ({ value: trip.requestNo, label: `${trip.requestNo} · ${trip.destination ?? ''}` }))}
              />
              <Field defaultValue={row.details ?? ''} label={x('details')} name="details" wide />
            </Grid>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="request-document-lines-heading" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{x('spent_on')}</th>
                    <th scope="col">{x('category')}</th>
                    <th scope="col">{x('line_description')}</th>
                    <th className={s.sapNum} scope="col">
                      {column('amount')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {claimRows.map(({ line }, i) => (
                    <tr key={line ? line.id : `new-${i}`}>
                      <td>
                        <bdi dir="ltr">{line ? line.lineNo : '+'}</bdi>
                      </td>
                      <td>
                        <input aria-label={`${x('spent_on')} ${i + 1}`} className={s.sapCellField} defaultValue={line?.spentOn ?? ''} name={`spent_on_${i}`} type="date" />
                      </td>
                      <td>
                        <select aria-label={`${x('category')} ${i + 1}`} className={s.sapCellField} defaultValue={line?.categoryCode ?? ''} name={`category_${i}`}>
                          <option value="">—</option>
                          {categories.map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input aria-label={`${x('line_description')} ${i + 1}`} className={s.sapCellField} defaultValue={line?.description ?? ''} name={`description_${i}`} />
                      </td>
                      <td className={s.sapNum}>
                        <input aria-label={`${column('amount')} ${i + 1}`} className={s.sapCellField} defaultValue={line ? line.amountIqd.replace(/\.0+$/, '') : ''} inputMode="decimal" name={`amount_${i}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.sapNote}>{x('lines_hint')}</p>
            <SubmitRow>
              <Submit label={x('save_lines')} />
            </SubmitRow>
          </Form>
        ) : null}
        {kind === 'expense_claim' && !mayEdit ? (
          <table aria-labelledby="request-document-lines-heading" className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">{x('spent_on')}</th>
                <th scope="col">{x('category')}</th>
                <th scope="col">{x('line_description')}</th>
                <th className={s.sapNum} scope="col">
                  {column('amount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={5}>
                    {x('lines_none')}
                  </td>
                </tr>
              ) : null}
              {detail.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <bdi dir="ltr">{l.lineNo}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{day(l.spentOn)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{l.categoryName}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{l.description}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{iqd(l.amountIqd)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {kind === 'travel' ? (
          <table aria-labelledby="request-document-lines-heading" className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{column('reference')}</th>
                <th className={s.sapNum} scope="col">
                  {column('amount')}
                </th>
                <th scope="col">{column('status')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.claims.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={3}>
                    {x('claims_none')}
                  </td>
                </tr>
              ) : null}
              {detail.claims.map((c) => (
                <tr key={c.requestNo}>
                  <td>
                    <ProfileLink code={c.requestNo} kind="employee_request" />
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{iqd(c.amountIqd)}</bdi>
                  </td>
                  <td>
                    <span className={`status status--${STATUS_TONE[c.status] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={STATUS_TONE[c.status] ?? 'draft'}>
                      {statusLabel(c.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {kind === 'letter' || kind === 'other' ? (
          <table aria-labelledby="request-document-lines-heading" className={s.sapTable}>
            <tbody>
              <tr>
                <td>
                  <bdi dir="auto">{kind === 'letter' ? (row.issuedText ?? x('letter_not_issued')) : (row.details ?? '—')}</bdi>
                </td>
              </tr>
            </tbody>
          </table>
        ) : null}
      </DocumentWindow>
    </AdminPage>
  );
}
