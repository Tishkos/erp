import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as advances from '@/server/services/employee-advances';
import * as payroll from '@/server/services/payroll';
import { approveAdvance, cancelAdvance, endorseAdvance, payAdvance, refuseAdvance, repayAdvance, submitAdvance } from '../actions';

/**
 * One advance or loan — REQ-HR-001 Stage HR-4 (§10). Copies the Purchase
 * Invoice page: the document window with its header fields and status chip,
 * its lines the schedule month by month (the instalment, what was due by
 * then, what came back), the verbs at its foot; what came back stacked under
 * it; the audit log.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  submitted: 'submitted',
  endorsed: 'submitted',
  approved: 'approved',
  paid: 'posted',
  settled: 'settled',
  refused: 'rejected',
  cancelled: 'cancelled',
};

export default async function AdvancePage({ params, searchParams }: { params: Promise<{ advanceNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/advances')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome, { advanceNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.advances'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const advanceNo = decodeURIComponent(rawNo);
  const { principal } = context;
  // Row security decides who sees it: HR by branch, the person, their manager.
  const found = await withCurrentUser(async (tx) => {
    const detail = await advances.byNo(tx, advanceNo);
    if (!detail) return null;
    return { detail, accounts: can(principal, 'execute', advances.PERMISSION_OBJECT) ? await payroll.payingAccounts(tx) : [] };
  });
  if (!found) {
    if (!can(principal, 'view', advances.PERMISSION_OBJECT)) return <Denied object={page('employee_advances')} />;
    notFound();
  }
  const { detail, accounts } = found;
  const { row, person } = detail;
  const self = person.appUserId === principal.userId;
  const step = advances.stepRefusal({ principal }, person, row);
  const mayEdit = row.status === 'draft' && (self || row.requestedBy === principal.userId || can(principal, 'edit_draft', advances.PERMISSION_OBJECT));
  const mayEndorse = row.status === 'submitted' && step === null;
  const mayApprove = row.status === 'endorsed' && step === null;
  const mayPay = row.status === 'approved' && can(principal, 'execute', advances.PERMISSION_OBJECT);
  const mayRepay = row.status === 'paid' && can(principal, 'execute', advances.PERMISSION_OBJECT);
  const mayCancel = ['draft', 'submitted', 'endorsed', 'approved'].includes(row.status) && (self || row.requestedBy === principal.userId || can(principal, 'edit_draft', advances.PERMISSION_OBJECT));
  const tone = STATUS_TONE[row.status] ?? 'draft';
  const statusLabel = (value: string) => (value === 'endorsed' || value === 'paid' ? x(`status_${value}`) : statusOf(value === 'refused' ? 'rejected' : value));
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const name = locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn;
  const mayOpenPerson = can(principal, 'view', 'employee');

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.advanceNo}</bdi> },
    { label: column('status'), value: statusLabel(row.status), status: tone },
    {
      label: x('employee'),
      value: mayOpenPerson ? (
        <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(person.employeeNo)}`}>
          <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>
        </Link>
      ) : (
        <bdi dir="auto">{`${person.employeeNo} · ${name}`}</bdi>
      ),
    },
    { label: x('kind'), value: x(`kind_${row.kind}`) },
    { label: x('amount'), value: <bdi dir="ltr">{iqd(row.amountIqd)}</bdi> },
    { label: x('instalments'), value: <bdi dir="ltr">{row.instalments}</bdi> },
    { label: x('first_month'), value: <bdi dir="ltr">{row.firstRecoveryMonth.slice(0, 7)}</bdi> },
    { label: x('recovered'), value: <bdi dir="ltr">{iqd(row.recoveredIqd)}</bdi> },
    { label: x('owed'), value: <bdi dir="ltr">{iqd(detail.owedIqd)}</bdi> },
    { label: x('requested_by'), value: <bdi dir="auto">{when(detail.requestedByName, row.createdAt)}</bdi> },
    ...(row.endorsedAt ? [{ label: x('endorsed_by'), value: <bdi dir="auto">{when(detail.endorsedByName, row.endorsedAt)}</bdi> }] : []),
    ...(row.approvedAt ? [{ label: x('approved_by'), value: <bdi dir="auto">{when(detail.approvedByName, row.approvedAt)}</bdi> }] : []),
    ...(row.refusedAt ? [{ label: x('refused_by'), value: <bdi dir="auto">{when(detail.refusedByName, row.refusedAt)}</bdi> }] : []),
    ...(row.paidAt
      ? [
          { label: x('paid_by'), value: <bdi dir="auto">{when(detail.paidByName, row.paidAt)}</bdi> },
          { label: x('paid_on'), value: <bdi dir="ltr">{`${day(row.paidOn)} · ${detail.accountCode ?? '—'}${row.paymentReference ? ` · ${row.paymentReference}` : ''}`}</bdi> },
          {
            label: x('journal'),
            value: detail.entryNo ? (
              <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(detail.entryNo)}`}>
                <bdi dir="ltr">{detail.entryNo}</bdi>
              </Link>
            ) : (
              '—'
            ),
          },
        ]
      : []),
    ...(row.cancelledAt
      ? [
          { label: x('cancelled_by'), value: <bdi dir="auto">{when(detail.cancelledByName, row.cancelledAt)}</bdi> },
          { label: x('cancel_reason'), value: <bdi dir="auto">{row.cancelReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    ...(row.decisionNote ? [{ label: x('decision_note'), value: <bdi dir="auto">{row.decisionNote}</bdi>, wide: true }] : []),
    { label: x('reason'), value: <bdi dir="auto">{row.reason}</bdi>, wide: true },
  ];

  const hidden = <input name="advance_no" type="hidden" value={row.advanceNo} />;
  const accountOptions = accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));

  return (
    <AdminPage back={{ href: '/hr/advances', label: t('back') }} title={`${row.advanceNo} · ${name}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {detail.behind ? <p className={s.sapNote}>{x('behind', { since: detail.behind.since.slice(0, 7), bucket: detail.behind.bucket })}</p> : null}
      {(row.status === 'submitted' || row.status === 'endorsed') && step === 'maker' ? <p className={s.sapNote}>{x('maker_checker')}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <form action={submitAdvance}>
                {hidden}
                <Submit label={x('submit')} variant="document" />
              </form>
            ) : null}
            {mayEndorse ? (
              <NewRecordDialog buttonLabel={x('endorse')} closeLabel={t('close')} title={x('endorse_title', { no: row.advanceNo })}>
                <Form action={endorseAdvance}>
                  {hidden}
                  <Grid>
                    <Field label={x('decision_note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('endorse')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayApprove ? (
              <form action={approveAdvance}>
                {hidden}
                <Submit label={x('approve')} variant="document" />
              </form>
            ) : null}
            {mayEndorse || mayApprove ? (
              <form action={refuseAdvance}>
                {hidden}
                <input aria-label={x('refuse_reason')} name="note" placeholder={x('refuse_reason')} required type="text" />
                <Submit label={x('refuse')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayPay ? (
              <NewRecordDialog buttonLabel={x('pay')} closeLabel={t('close')} title={x('pay_title', { no: row.advanceNo })}>
                <Form action={payAdvance}>
                  {hidden}
                  <Grid>
                    <Select label={x('account')} name="account_id" options={accountOptions} required />
                    <Field defaultValue={businessToday()} label={x('paid_on')} name="paid_on" required type="date" />
                    <Field label={x('reference')} name="reference" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('pay')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayRepay ? (
              <NewRecordDialog buttonLabel={x('repay')} closeLabel={t('close')} title={x('repay_title', { no: row.advanceNo })}>
                <Form action={repayAdvance}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={detail.owedIqd.replace(/\.0+$/, '')} hint={x('repay_hint', { owed: iqd(detail.owedIqd) })} label={x('amount')} name="amount" required />
                    <Select label={x('account')} name="account_id" options={accountOptions} required />
                    <Field defaultValue={businessToday()} label={x('repaid_on')} name="repaid_on" required type="date" />
                    <Field label={x('reference')} name="reference" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('repay')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayCancel ? (
              <form action={cancelAdvance}>
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
        id="advance-document"
        linesCount={detail.months.length}
        linesTitle={x('schedule_title')}
        number={row.advanceNo}
        totals={[
          { label: x('amount'), value: iqd(row.amountIqd) },
          { label: x('recovered'), value: iqd(row.recoveredIqd) },
          { label: x('owed'), value: iqd(detail.owedIqd) },
        ]}
      >
        <table aria-labelledby="advance-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('month')}</th>
              <th className={s.sapNum} scope="col">
                {x('instalment')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('due_by')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('recovered')}
              </th>
            </tr>
          </thead>
          <tbody>
            {detail.months.map((m) => (
              <tr key={m.month}>
                <td>
                  <bdi dir="ltr">{m.month.slice(0, 7)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(m.instalmentIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(m.dueByIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(m.recoveredIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <section aria-labelledby="advance-recoveries-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="advance-recoveries-title">
            <span>{x('recoveries_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: detail.recoveries.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="advance-recoveries-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('month')}</th>
                  <th scope="col">{x('source')}</th>
                  <th scope="col">{x('reference')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('amount')}
                  </th>
                  <th scope="col">{x('journal')}</th>
                  <th scope="col">{x('recorded_at')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.recoveries.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {x('recoveries_none')}
                    </td>
                  </tr>
                ) : null}
                {detail.recoveries.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <bdi dir="ltr">{r.month.slice(0, 7)}</bdi>
                    </td>
                    <td>{x(`source_${r.source}`)}</td>
                    <td>
                      <bdi dir="ltr">{r.reference ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(r.amountIqd)}</bdi>
                    </td>
                    <td>
                      {r.entryNo ? (
                        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(r.entryNo)}`}>
                          <bdi dir="ltr">{r.entryNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <bdi dir="ltr">{formatTimestamp(new Date(r.recordedAt).toISOString(), locale as Locale)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <RecordHistory objectId={row.advanceNo} objectType={advances.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
