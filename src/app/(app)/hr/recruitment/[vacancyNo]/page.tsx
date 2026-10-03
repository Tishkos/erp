import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { EMPLOYMENT_KINDS } from '@/server/domain/hr';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as recruitment from '@/server/services/recruitment';
import { addApplicant, amendVacancy, cancelVacancy, closeVacancy, openVacancy, updateVacancy } from '../actions';

/**
 * One vacancy — REQ-HR-001 Stage HR-5. Copies the Purchase Invoice page: the
 * document window with its header fields and status chip, its lines the
 * applicants and the stage each is at, the verbs at its foot; the audit log.
 */
export const dynamic = 'force-dynamic';

const VACANCY_TONE: Readonly<Record<string, string>> = { draft: 'draft', open: 'open', filled: 'posted', closed: 'closed', cancelled: 'cancelled' };
const STAGE_TONE: Readonly<Record<string, string>> = {
  applied: 'draft',
  screening: 'submitted',
  interview: 'submitted',
  offer: 'approved',
  hired: 'posted',
  rejected: 'rejected',
  withdrawn: 'cancelled',
};

export default async function VacancyPage({ params, searchParams }: { params: Promise<{ vacancyNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/recruitment')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome, { vacancyNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.recruitment'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', recruitment.PERMISSION_OBJECT)) return <Denied object={page('recruitment')} />;
  const vacancyNo = decodeURIComponent(rawNo);
  const mayEdit = can(principal, 'edit_draft', recruitment.PERMISSION_OBJECT);
  const mayDecide = can(principal, 'approve', recruitment.PERMISSION_OBJECT);
  const mayAdd = can(principal, 'create', recruitment.PERMISSION_OBJECT);
  const found = await withCurrentUser(async (tx) => {
    const detail = await recruitment.vacancyByNo(tx, vacancyNo);
    if (!detail) return null;
    const draft = detail.row.status === 'draft' && mayEdit;
    return {
      detail,
      positions: draft ? await recruitment.positionsOpen(tx) : [],
      departmentRows: draft ? await departments.listAll(tx) : [],
    };
  });
  if (!found) notFound();
  const { detail, positions, departmentRows } = found;
  const { row } = detail;
  const statusLabel = (value: string) => (value === 'open' || value === 'filled' ? x(`status_${value}`) : statusOf(value));
  const tone = VACANCY_TONE[row.status] ?? 'draft';
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const title = locale === 'ar' && detail.titleAr ? detail.titleAr : detail.titleEn;
  const name = (a: { fullNameEn: string; fullNameAr: string | null }) => (locale === 'ar' && a.fullNameAr ? a.fullNameAr : a.fullNameEn);
  const mayOpenPeople = can(principal, 'view', 'employee');
  const inPipeline = detail.applicants.filter((a) => ['applied', 'screening', 'interview', 'offer'].includes(a.stage)).length;

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.vacancyNo}</bdi> },
    { label: column('status'), value: statusLabel(row.status), status: tone },
    { label: column('branch'), value: <bdi dir="auto">{detail.branchName}</bdi> },
    { label: x('position'), value: <bdi dir="auto">{`${row.positionCode} · ${title}`}</bdi> },
    { label: x('department'), value: <bdi dir="auto">{`${row.departmentCode} · ${detail.departmentName}`}</bdi> },
    { label: x('holding'), value: <bdi dir="ltr">{detail.holding}</bdi> },
    { label: x('headcount'), value: <bdi dir="ltr">{row.headcount}</bdi> },
    { label: x('hired'), value: <bdi dir="ltr">{row.hired}</bdi> },
    { label: x('employment_kind'), value: x(`kind_${row.employmentKind}`) },
    { label: x('opens_on'), value: <bdi dir="ltr">{day(row.opensOn)}</bdi> },
    { label: x('closes_on'), value: <bdi dir="ltr">{day(row.closesOn)}</bdi> },
    { label: x('created_by'), value: <bdi dir="auto">{when(detail.createdByName, row.createdAt)}</bdi> },
    ...(row.openedAt ? [{ label: x('opened_by'), value: <bdi dir="auto">{when(detail.openedByName, row.openedAt)}</bdi> }] : []),
    ...(row.closedAt ? [{ label: x('closed_by'), value: <bdi dir="auto">{when(detail.closedByName, row.closedAt)}</bdi> }] : []),
    ...(row.closeReason ? [{ label: x('close_reason'), value: <bdi dir="auto">{row.closeReason}</bdi>, wide: true }] : []),
    { label: x('description'), value: <bdi dir="auto">{row.description}</bdi>, wide: true },
  ];

  const hidden = <input name="vacancy_no" type="hidden" value={row.vacancyNo} />;
  const draft = row.status === 'draft';
  const open = row.status === 'open';

  return (
    <AdminPage back={{ href: '/hr/recruitment', label: t('back') }} title={`${row.vacancyNo} · ${title}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {open && row.closesOn && row.closesOn < businessToday() ? <p className={s.sapNote}>{x('overdue', { day: day(row.closesOn) })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {draft && mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_title', { no: row.vacancyNo })}>
                <Form action={updateVacancy}>
                  {hidden}
                  <Grid>
                    <Select
                      defaultValue={row.positionCode}
                      label={x('position')}
                      name="position_code"
                      options={positions.map((p) => ({ value: p.code, label: `${p.code} · ${locale === 'ar' && p.titleAr ? p.titleAr : p.titleEn}` }))}
                      required
                    />
                    <Select
                      defaultValue={row.departmentCode}
                      label={x('department')}
                      name="department_code"
                      options={departmentRows.filter((d) => d.active || d.code === row.departmentCode).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                      required
                    />
                    <Field defaultValue={String(row.headcount)} label={x('headcount')} max={500} min={1} name="headcount" required type="number" />
                    <Select
                      defaultValue={row.employmentKind}
                      label={x('employment_kind')}
                      name="employment_kind"
                      options={EMPLOYMENT_KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))}
                      required
                    />
                    <Field defaultValue={row.opensOn} label={x('opens_on')} name="opens_on" required type="date" />
                    <Field defaultValue={row.closesOn ?? ''} label={x('closes_on')} name="closes_on" type="date" />
                    <Field defaultValue={row.description} label={x('description')} name="description" required type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {draft && mayDecide ? (
              <form action={openVacancy}>
                {hidden}
                <Submit label={x('open')} variant="document" />
              </form>
            ) : null}
            {draft && mayEdit ? (
              <form action={cancelVacancy}>
                {hidden}
                <input aria-label={x('close_reason')} name="reason" placeholder={x('close_reason')} required type="text" />
                <Submit label={x('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {open && mayAdd ? (
              <NewRecordDialog buttonLabel={x('add_applicant')} closeLabel={t('close')} title={x('add_applicant_title', { no: row.vacancyNo })}>
                <Form action={addApplicant}>
                  {hidden}
                  <Grid>
                    <Field label={x('full_name_en')} name="full_name_en" required />
                    <Field label={x('full_name_ar')} name="full_name_ar" />
                    <Field label={x('phone')} name="phone" />
                    <Field label={x('email')} name="email" type="email" />
                    <Field hint={x('source_hint')} label={x('source')} name="source" />
                    <Field label={x('note')} name="note" type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('create')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {open && mayDecide ? (
              <NewRecordDialog buttonLabel={x('amend')} closeLabel={t('close')} title={x('amend_title', { no: row.vacancyNo })}>
                <Form action={amendVacancy}>
                  {hidden}
                  <Grid>
                    <Field
                      defaultValue={String(row.headcount)}
                      hint={x('amend_headcount_hint', { hired: row.hired })}
                      label={x('headcount')}
                      max={500}
                      min={Math.max(1, row.hired)}
                      name="headcount"
                      required
                      type="number"
                    />
                    <Field defaultValue={row.closesOn ?? ''} label={x('closes_on')} name="closes_on" type="date" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {open && mayDecide ? (
              <form action={closeVacancy}>
                {hidden}
                <input aria-label={x('close_reason')} name="reason" placeholder={x('close_reason')} required type="text" />
                <Submit label={x('close')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('document_type')}
        fields={fields}
        id="vacancy-document"
        linesCount={detail.applicants.length}
        linesTitle={x('applicants_title')}
        number={row.vacancyNo}
        totals={[
          { label: x('headcount'), value: String(row.headcount) },
          { label: x('hired'), value: String(row.hired) },
          { label: x('in_pipeline'), value: String(inPipeline) },
        ]}
      >
        <table aria-labelledby="vacancy-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('reference')}</th>
              <th scope="col">{x('applicant')}</th>
              <th scope="col">{x('phone')}</th>
              <th scope="col">{x('email')}</th>
              <th scope="col">{x('source')}</th>
              <th scope="col">{x('applied_at')}</th>
              <th scope="col">{x('stage')}</th>
              <th scope="col">{x('employee')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.applicants.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={8}>
                  {open ? x('applicants_none_open') : x('applicants_none')}
                </td>
              </tr>
            ) : null}
            {detail.applicants.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link className={s.sapLink} href={`/hr/recruitment/applicants/${encodeURIComponent(a.applicantNo)}`}>
                    <bdi dir="ltr">{a.applicantNo}</bdi>
                  </Link>
                </td>
                <td>
                  <bdi dir="auto">{name(a)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{a.phone ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{a.email ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{a.source ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{formatTimestamp(new Date(a.createdAt).toISOString(), locale as Locale)}</bdi>
                </td>
                <td>
                  <span className={`status status--${STAGE_TONE[a.stage] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={STAGE_TONE[a.stage] ?? 'draft'}>
                    {x(`stage_${a.stage}`)}
                  </span>
                </td>
                <td>
                  {a.employeeNo ? (
                    mayOpenPeople ? (
                      <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(a.employeeNo)}`}>
                        <bdi dir="ltr">{a.employeeNo}</bdi>
                      </Link>
                    ) : (
                      <bdi dir="ltr">{a.employeeNo}</bdi>
                    )
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={row.vacancyNo} objectType={recruitment.VACANCY_OBJECT} />
    </AdminPage>
  );
}
