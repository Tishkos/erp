import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Attachments } from '@/components/admin/attachments';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { EMPLOYMENT_KINDS } from '@/server/domain/hr';
import { requireContext, withCurrentUser } from '@/server/session';
import * as employees from '@/server/services/employees';
import * as recruitment from '@/server/services/recruitment';
import { attachToApplicant, hireApplicant, moveApplicant, updateApplicant } from '../../actions';

/**
 * One applicant — REQ-HR-001 Stage HR-5. Copies the Purchase Invoice page:
 * the document window with the person's details and the stage chip, its
 * lines every move they made; the verbs at its foot (move on, hire from an
 * offer); their CV and letters filed under it; the audit log.
 */
export const dynamic = 'force-dynamic';

const STAGE_TONE: Readonly<Record<string, string>> = {
  applied: 'draft',
  screening: 'submitted',
  interview: 'submitted',
  offer: 'approved',
  hired: 'posted',
  rejected: 'rejected',
  withdrawn: 'cancelled',
};

export default async function ApplicantPage({ params, searchParams }: { params: Promise<{ applicantNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/recruitment')) notFound();
  const [t, x, page, column, locale, context, outcome, { applicantNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.recruitment'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', recruitment.PERMISSION_OBJECT)) return <Denied object={page('recruitment')} />;
  const applicantNo = decodeURIComponent(rawNo);
  const mayMove = can(principal, 'edit_draft', recruitment.PERMISSION_OBJECT);
  const mayHire = can(principal, 'approve', recruitment.PERMISSION_OBJECT);
  const found = await withCurrentUser(async (tx) => {
    const detail = await recruitment.applicantByNo(tx, applicantNo);
    if (!detail) return null;
    return { detail, managers: detail.row.stage === 'offer' && mayHire ? await employees.managersAvailable(tx) : [] };
  });
  if (!found) notFound();
  const { detail, managers } = found;
  const { row } = detail;
  const tone = STAGE_TONE[row.stage] ?? 'draft';
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const name = locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn;
  const title = locale === 'ar' && detail.titleAr ? detail.titleAr : detail.titleEn;
  const closed = ['hired', 'rejected', 'withdrawn'].includes(row.stage);
  const mayOpenPerson = can(principal, 'view', 'employee');

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.applicantNo}</bdi> },
    { label: x('stage'), value: x(`stage_${row.stage}`), status: tone },
    {
      label: x('vacancy'),
      value: (
        <Link className={s.sapLink} href={`/hr/recruitment/${encodeURIComponent(detail.vacancyNo)}`}>
          <bdi dir="ltr">{detail.vacancyNo}</bdi>
        </Link>
      ),
    },
    { label: x('position'), value: <bdi dir="auto">{`${detail.positionCode} · ${title}`}</bdi> },
    { label: x('full_name_en'), value: <bdi dir="auto">{row.fullNameEn}</bdi> },
    { label: x('full_name_ar'), value: <bdi dir="auto">{row.fullNameAr ?? '—'}</bdi> },
    { label: x('phone'), value: <bdi dir="ltr">{row.phone ?? '—'}</bdi> },
    { label: x('email'), value: <bdi dir="ltr">{row.email ?? '—'}</bdi> },
    { label: x('source'), value: <bdi dir="auto">{row.source ?? '—'}</bdi> },
    { label: x('created_by'), value: <bdi dir="auto">{when(detail.createdByName, row.createdAt)}</bdi> },
    ...(detail.employeeNo
      ? [
          {
            label: x('employee'),
            value: mayOpenPerson ? (
              <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(detail.employeeNo)}`}>
                <bdi dir="ltr">{detail.employeeNo}</bdi>
              </Link>
            ) : (
              <bdi dir="ltr">{detail.employeeNo}</bdi>
            ),
          },
        ]
      : []),
    ...(row.note ? [{ label: x('note'), value: <bdi dir="auto">{row.note}</bdi>, wide: true }] : []),
  ];

  const hidden = <input name="applicant_no" type="hidden" value={row.applicantNo} />;

  return (
    <AdminPage
      back={{ href: `/hr/recruitment/${encodeURIComponent(detail.vacancyNo)}`, label: t('back') }}
      title={`${row.applicantNo} · ${name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {row.stage === 'offer' && detail.vacancyStatus !== 'open' ? <p className={s.sapNote}>{x('offer_vacancy_stopped', { no: detail.vacancyNo })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {!closed && mayMove && detail.next.length > 0 ? (
              <NewRecordDialog buttonLabel={x('move')} closeLabel={t('close')} title={x('move_title', { no: row.applicantNo })}>
                <Form action={moveApplicant}>
                  {hidden}
                  <Grid>
                    <Select label={x('stage')} name="stage" options={detail.next.map((stage) => ({ value: stage, label: x(`stage_${stage}`) }))} required />
                    <Field hint={x('move_note_hint')} label={x('note')} name="note" type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('move')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {row.stage === 'offer' && detail.vacancyStatus === 'open' && mayHire ? (
              <NewRecordDialog buttonLabel={x('hire')} closeLabel={t('close')} title={x('hire_title', { no: row.applicantNo })}>
                <Form action={hireApplicant}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('hire_caption', { position: `${detail.positionCode} · ${title}`, department: detail.departmentCode })}</p>
                  <Grid>
                    <Field defaultValue={businessToday()} label={x('hire_date')} name="hire_date" required type="date" />
                    <Select
                      defaultValue={detail.employmentKind}
                      label={x('employment_kind')}
                      name="employment_kind"
                      options={EMPLOYMENT_KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))}
                      required
                    />
                    <Select emptyLabel={x('no_manager')} label={x('manager')} name="manager_employee_id" options={managers.map((m) => ({ value: m.id, label: `${m.employeeNo} · ${m.fullNameEn}` }))} />
                    <Field label={x('national_id')} name="national_id" />
                    <Field label={x('date_of_birth')} name="date_of_birth" type="date" />
                    <Field hint={x('contract_end_hint')} label={x('contract_end_date')} name="contract_end_date" type="date" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('hire')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {!closed && mayMove ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_applicant_title', { no: row.applicantNo })}>
                <Form action={updateApplicant}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={row.fullNameEn} label={x('full_name_en')} name="full_name_en" required />
                    <Field defaultValue={row.fullNameAr ?? ''} label={x('full_name_ar')} name="full_name_ar" />
                    <Field defaultValue={row.phone ?? ''} label={x('phone')} name="phone" />
                    <Field defaultValue={row.email ?? ''} label={x('email')} name="email" type="email" />
                    <Field defaultValue={row.source ?? ''} label={x('source')} name="source" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('applicant_document_type')}
        fields={fields}
        id="applicant-document"
        linesCount={detail.stages.length}
        linesTitle={x('stages_title')}
        number={row.applicantNo}
      >
        <table aria-labelledby="applicant-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('moved_at')}</th>
              <th scope="col">{x('from_stage')}</th>
              <th scope="col">{x('to_stage')}</th>
              <th scope="col">{x('moved_by')}</th>
              <th scope="col">{x('note')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.stages.map((move) => (
              <tr key={move.id}>
                <td>
                  <bdi dir="ltr">{formatTimestamp(new Date(move.movedAt).toISOString(), locale as Locale)}</bdi>
                </td>
                <td>{move.fromStage ? x(`stage_${move.fromStage}`) : '—'}</td>
                <td>
                  <span className={`status status--${STAGE_TONE[move.toStage] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={STAGE_TONE[move.toStage] ?? 'draft'}>
                    {x(`stage_${move.toStage}`)}
                  </span>
                </td>
                <td>
                  <bdi dir="auto">{move.movedByName ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{move.note ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-label={x('attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            action={attachToApplicant}
            hidden={{ id: row.id, applicant_no: row.applicantNo }}
            mayAttach={can(principal, 'create', 'attachment') && can(principal, 'create', recruitment.PERMISSION_OBJECT)}
            objectId={row.id}
            objectType={recruitment.APPLICANT_OBJECT}
          />
        </div>
      </section>

      <RecordHistory objectId={row.applicantNo} objectType={recruitment.APPLICANT_OBJECT} />
    </AdminPage>
  );
}
