import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Attachments } from '@/components/admin/attachments';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as documents from '@/server/services/employee-documents';
import { attachToDocument, renewDocument, updateDocument, withdrawDocument } from '../actions';

/**
 * One employee document — REQ-HR-001 Stage HR-6. Copies the Purchase Invoice
 * page: the document window with its header fields and its expiry as the
 * status chip, its lines the person's papers of the same type (each renewal
 * in turn), the verbs at its foot; the scan filed under it; the audit log.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = { valid: 'approved', superseded: 'closed', withdrawn: 'cancelled' };
const EXPIRY_TONE: Readonly<Record<string, string>> = { no_expiry: 'approved', valid: 'approved', expiring: 'submitted', expired: 'rejected' };

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ documentNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/documents')) notFound();
  const [t, x, page, column, locale, context, outcome, { documentNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_documents'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const documentNo = decodeURIComponent(rawNo);
  const { principal } = context;
  // Row security decides who sees it: HR by grant and branch, and the person.
  const detail = await withCurrentUser((tx) => documents.byNo(tx, documentNo));
  if (!detail) {
    if (!can(principal, 'view', documents.PERMISSION_OBJECT)) return <Denied object={page('hr_documents')} />;
    notFound();
  }
  const { row, person } = detail;
  const valid = row.status === 'valid';
  const mayEdit = valid && can(principal, 'edit_draft', documents.PERMISSION_OBJECT);
  const mayRenew = valid && can(principal, 'create', documents.PERMISSION_OBJECT);
  const tone = detail.expiry ? EXPIRY_TONE[detail.expiry]! : (STATUS_TONE[row.status] ?? 'draft');
  const statusText = detail.expiry ? x(`expiry_${detail.expiry}`) : x(`status_${row.status}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const name = locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn;
  const link = (no: string) => (
    <Link className={s.sapLink} href={`/hr/documents/${encodeURIComponent(no)}`}>
      <bdi dir="ltr">{no}</bdi>
    </Link>
  );

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.documentNo}</bdi> },
    { label: column('status'), value: statusText, status: tone },
    {
      label: x('employee'),
      value: can(principal, 'view', 'employee') ? (
        <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(person.employeeNo)}`}>
          <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>
        </Link>
      ) : (
        <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>
      ),
    },
    { label: x('doc_type'), value: x(`type_${row.docType}`) },
    { label: x('doc_title'), value: <bdi dir="auto">{row.title}</bdi> },
    { label: x('reference_no'), value: <bdi dir="ltr">{row.referenceNo ?? '—'}</bdi> },
    { label: x('issued_on'), value: <bdi dir="ltr">{day(row.issuedOn)}</bdi> },
    { label: x('expires_on'), value: <bdi dir="ltr">{day(row.expiresOn)}</bdi> },
    ...(valid && detail.daysLeft !== null ? [{ label: x('days_left'), value: <bdi dir="ltr">{detail.daysLeft}</bdi> }] : []),
    ...(detail.replacesNo ? [{ label: x('replaces'), value: link(detail.replacesNo) }] : []),
    ...(detail.replacedByNo ? [{ label: x('replaced_by'), value: link(detail.replacedByNo) }] : []),
    { label: x('created_by'), value: <bdi dir="auto">{when(detail.createdByName, row.createdAt)}</bdi> },
    ...(row.withdrawnAt
      ? [
          { label: x('withdrawn_by'), value: <bdi dir="auto">{when(detail.withdrawnByName, row.withdrawnAt)}</bdi> },
          { label: x('withdraw_reason'), value: <bdi dir="auto">{row.withdrawReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    ...(row.note ? [{ label: x('note'), value: <bdi dir="auto">{row.note}</bdi>, wide: true }] : []),
  ];

  const hidden = <input name="document_no" type="hidden" value={row.documentNo} />;

  return (
    <AdminPage back={{ href: '/hr/documents', label: t('back') }} title={`${row.documentNo} · ${name}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {detail.expiry === 'expired' || detail.expiry === 'expiring' ? <p className={s.sapNote}>{x(`note_${detail.expiry}`, { day: day(row.expiresOn) })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit_title', { no: row.documentNo })}>
                <Form action={updateDocument}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={row.title} label={x('doc_title')} name="title" required />
                    <Field defaultValue={row.referenceNo ?? ''} label={x('reference_no')} name="reference_no" />
                    <Field defaultValue={row.issuedOn ?? ''} label={x('issued_on')} name="issued_on" type="date" />
                    <Field defaultValue={row.expiresOn ?? ''} label={x('expires_on')} name="expires_on" type="date" />
                    <Field defaultValue={row.note ?? ''} label={x('note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayRenew ? (
              <NewRecordDialog buttonLabel={x('renew')} closeLabel={t('close')} title={x('renew_title', { no: row.documentNo })}>
                <Form action={renewDocument}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('renew_caption')}</p>
                  <Grid>
                    <Field defaultValue={row.title} id="f-renew-title" label={x('doc_title')} name="title" required />
                    <Field id="f-renew-reference" label={x('reference_no')} name="reference_no" />
                    <Field id="f-renew-issued" label={x('issued_on')} name="issued_on" type="date" />
                    <Field id="f-renew-expires" label={x('expires_on')} name="expires_on" type="date" />
                    <Field id="f-renew-note" label={x('note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('renew')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit ? (
              <form action={withdrawDocument}>
                {hidden}
                <input aria-label={x('withdraw_reason')} name="reason" placeholder={x('withdraw_reason')} required type="text" />
                <Submit label={x('withdraw')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('document_type')}
        fields={fields}
        id="employee-document"
        linesCount={detail.chain.length}
        linesTitle={x('chain_title', { type: x(`type_${row.docType}`) })}
        number={row.documentNo}
      >
        <table aria-labelledby="employee-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('reference')}</th>
              <th scope="col">{x('reference_no')}</th>
              <th scope="col">{x('issued_on')}</th>
              <th scope="col">{x('expires_on')}</th>
              <th scope="col">{column('status')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.chain.map((c) => {
              const chainTone = STATUS_TONE[c.status] ?? 'draft';
              return (
                <tr key={c.documentNo}>
                  <td>{c.documentNo === row.documentNo ? <bdi dir="ltr">{c.documentNo}</bdi> : link(c.documentNo)}</td>
                  <td>
                    <bdi dir="ltr">{c.referenceNo ?? '—'}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{day(c.issuedOn)}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{day(c.expiresOn)}</bdi>
                  </td>
                  <td>
                    <span className={`status status--${chainTone} ${s.sapRegisterStatus}`} data-status={chainTone}>
                      {x(`status_${c.status}`)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-label={x('attachments')} className={s.sapDoc}>
        <div className={s.sapWindow}>
          <Attachments
            action={attachToDocument}
            hidden={{ id: row.id, document_no: row.documentNo }}
            mayAttach={valid && can(principal, 'create', 'attachment') && can(principal, 'create', documents.PERMISSION_OBJECT)}
            objectId={row.id}
            objectType={documents.PERMISSION_OBJECT}
          />
        </div>
      </section>

      <RecordHistory objectId={row.documentNo} objectType={documents.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
