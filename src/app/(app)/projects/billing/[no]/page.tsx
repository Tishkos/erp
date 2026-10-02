import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { isNotFoundError } from '@/server/not-found';
import { requireContext, withCurrentUser } from '@/server/session';
import * as billing from '@/server/services/project-billing';
import { approveCertificate, cancelCertificate } from '../actions';

/**
 * One progress certificate — REQ-PM-001 §11, D-PM-11. Copies the Purchase
 * Invoice page: the document window with its fields, the status chip,
 * Approve (somebody other than its raiser; it posts) and Cancel as its
 * actions, the retention and advance movements it made as its lines; then
 * the history.
 */
export const dynamic = 'force-dynamic';

export default async function CertificatePage({ params, searchParams }: { params: Promise<{ no: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/projects/billing')) notFound();
  const [t, x, page, column, status, action, locale, context, outcome, { no: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getTranslations('action'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const certificateNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', billing.PERMISSION_OBJECT)) {
    return <Denied object={page('project_billing')} />;
  }
  const view = await withCurrentUser(async (tx) => {
    try {
      return await billing.certificate(tx, certificateNo);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!view) notFound();
  const cert = view.certificate;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const when = (value: Date | null) => (value ? formatTimestamp(value.toISOString(), locale as Locale) : '—');
  const mayApprove = cert.status === 'draft' && cert.createdBy !== principal.userId && can(principal, 'approve', billing.PERMISSION_OBJECT);
  const mayCancel = cert.status === 'draft' && can(principal, 'edit_draft', billing.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    {
      label: x('certificate'),
      value: <bdi dir="ltr">{cert.certificateNo}</bdi>,
    },
    {
      label: column('status'),
      value: status(cert.status),
      status: cert.status,
    },
    { label: x('certificate_basis'), value: x(`basis_${cert.basis}`) },
    {
      label: x('project'),
      value: (
        <Link className={s.sapLink} href={`/projects/billing?project=${encodeURIComponent(cert.projectCode)}`}>
          <bdi dir="ltr">{cert.projectCode}</bdi>
        </Link>
      ),
    },
    { label: column('name'), value: <bdi dir="auto">{view.project.name}</bdi> },
    {
      label: x('customer'),
      value: <bdi dir="auto">{view.project.customerCode ? `${view.project.customerCode} · ${view.project.customerName ?? ''}` : '—'}</bdi>,
    },
    {
      label: x('certified_on'),
      value: <bdi dir="ltr">{formatBusinessDate(cert.certifiedOn, locale as Locale)}</bdi>,
    },
    {
      label: x('percent_complete'),
      value: <bdi dir="ltr">{`${Number(cert.percentComplete)} %`}</bdi>,
    },
    ...(view.planLine
      ? [
          {
            label: x('billing_line'),
            value: <bdi dir="auto">{`${view.planLine.lineNo} · ${view.planLine.description}`}</bdi>,
          },
        ]
      : []),
    { label: x('journal'), value: <bdi dir="ltr">{view.entryNo ?? '—'}</bdi> },
    {
      label: x('raised_by'),
      value: <bdi dir="auto">{view.people.createdBy ?? '—'}</bdi>,
    },
    ...(cert.approvedAt
      ? [
          {
            label: x('approved_by'),
            value: <bdi dir="auto">{`${view.people.approvedBy ?? '—'} · ${when(cert.approvedAt)}`}</bdi>,
          },
        ]
      : []),
  ];

  return (
    <AdminPage
      back={{
        href: `/projects/billing?project=${encodeURIComponent(cert.projectCode)}`,
        label: t('back'),
      }}
      title={cert.certificateNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {cert.status === 'draft' ? <p className={s.sapNote}>{x('certificate_posting_note')}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveCertificate}>
                <Hidden name="certificate_no" value={cert.certificateNo} />
                <Submit label={action('approve')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelCertificate}>
                <Hidden name="certificate_no" value={cert.certificateNo} />
                <input aria-label={t('reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                <Submit label={action('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('certificate')}
        fields={fields}
        id="project-certificate"
        linesCount={view.movements.length}
        linesTitle={x('balance_movements')}
        number={cert.certificateNo}
        totals={[
          { label: x('gross'), value: money(cert.grossIqd) },
          { label: x('retention'), value: money(cert.retentionIqd) },
          {
            label: x('advance_recovered'),
            value: money(cert.advanceRecoveredIqd),
          },
          { label: x('net'), value: money(cert.netIqd) },
        ]}
      >
        <table aria-labelledby="project-certificate-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('balance_kind')}</th>
              <th scope="col">{column('date')}</th>
              <th scope="col">{column('description')}</th>
              <th className={s.sapNum} scope="col">
                {column('amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.movements.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {x('no_balance_movements')}
                </td>
              </tr>
            ) : null}
            {view.movements.map((m, index) => (
              <tr key={index}>
                <td>{x(`balance_${m.kind}`)}</td>
                <td>
                  <bdi dir="ltr">{formatBusinessDate(m.movedOn, locale as Locale)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{m.description}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(m.amountIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={cert.certificateNo} objectType={billing.CERTIFICATE_DOCUMENT_TYPE} />
    </AdminPage>
  );
}
