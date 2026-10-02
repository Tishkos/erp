import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { daysFrom, showDays } from '@/server/domain/hr-time';
import { printSheet } from '@/server/print/sheet';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payroll from '@/server/services/payroll';
import { approvePayroll, cancelPayroll, payPayroll, postPayroll, recomputePayroll, returnPayroll, reversePayroll, savePayrollTyped, submitPayroll, updatePayrollDraft } from '../actions';

/**
 * One payroll run — REQ-HR-001 Stage HR-3 (§9). Copies the Purchase Invoice
 * page: the document window with its header fields, status chip and the
 * verbs at its foot; its lines the people, each line its payslip once posted;
 * stacked under it in the supplier-statement manner, the figures typed on the
 * draft, what each component came to, the payments; then the audit log.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  submitted: 'submitted',
  approved: 'approved',
  posted: 'posted',
  paid: 'settled',
  reversed: 'reversed',
  cancelled: 'cancelled',
};

export default async function PayrollRunPage({ params, searchParams }: { params: Promise<{ runNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/payroll')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome, { runNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.payroll'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const runNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', payroll.PERMISSION_OBJECT)) return <Denied object={page('payroll')} />;
  const actor = { principal, branchCode: context.scope.branchCode };

  const found = await withCurrentUser(async (tx) => {
    const detail = await payroll.byNo(tx, runNo);
    if (!detail) return null;
    return {
      detail,
      manual: (await payroll.componentRules(tx)).rules.filter((r) => r.calculation === 'manual'),
      accounts: can(principal, 'execute', payroll.PERMISSION_OBJECT) ? await payroll.payingAccounts(tx) : [],
    };
  });
  if (!found) notFound();
  const { detail, manual, accounts } = found;
  const run = detail.run;
  const status = run.status;
  const mayEdit = status === 'draft' && can(principal, 'edit_draft', payroll.PERMISSION_OBJECT) && can(principal, 'view', 'employee_compensation');
  const maySubmit = status === 'draft' && can(principal, 'submit', payroll.PERMISSION_OBJECT);
  const approval = payroll.approvalRefusal(actor, run);
  const mayApprove = approval === null;
  const mayReturn = (status === 'submitted' && can(principal, 'approve', payroll.PERMISSION_OBJECT)) || (status === 'approved' && can(principal, 'post', payroll.PERMISSION_OBJECT));
  const mayPost = status === 'approved' && can(principal, 'post', payroll.PERMISSION_OBJECT);
  const mayPay = status === 'posted' && can(principal, 'execute', payroll.PERMISSION_OBJECT) && detail.unpaid.length > 0;
  const mayReverse = status === 'posted' && detail.payments.length === 0 && can(principal, 'reverse_cancel', payroll.PERMISSION_OBJECT);
  const mayCancel =
    (status === 'draft' && can(principal, 'edit_draft', payroll.PERMISSION_OBJECT)) ||
    (status === 'submitted' && can(principal, 'approve', payroll.PERMISSION_OBJECT)) ||
    (status === 'approved' && can(principal, 'post', payroll.PERMISSION_OBJECT));
  const tone = STATUS_TONE[status] ?? 'draft';
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (name: string | null, value: Date | string | null) => (value ? `${name ?? '—'} · ${formatTimestamp(new Date(value).toISOString(), locale as Locale)}` : '—');
  const nameOf = (line: { fullNameEn: string; fullNameAr: string | null }) => (locale === 'ar' && line.fullNameAr ? line.fullNameAr : line.fullNameEn);
  const componentName = (c: { nameEn: string; nameAr: string | null }) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);
  const missing = detail.lines.filter(({ line }) => line.compensationId === null).map(({ line }) => line.employeeNo);
  const unrecorded = detail.lines.filter(({ line }) => line.unrecordedDays > 0);
  const month = run.periodMonth.slice(0, 7);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{run.runNo}</bdi> },
    { label: column('status'), value: status === 'paid' ? x('status_paid') : statusOf(status), status: tone },
    { label: column('branch'), value: <bdi dir="ltr">{run.branchCode}</bdi> },
    { label: x('month'), value: <bdi dir="ltr">{month}</bdi> },
    { label: x('pay_date'), value: <bdi dir="ltr">{day(run.payDate)}</bdi> },
    { label: x('working_days'), value: <bdi dir="ltr">{run.workingDays}</bdi> },
    { label: x('employees'), value: <bdi dir="ltr">{run.employees}</bdi> },
    { label: x('gross'), value: <bdi dir="ltr">{iqd(run.grossIqd)}</bdi> },
    { label: x('deductions'), value: <bdi dir="ltr">{iqd(run.deductionsIqd)}</bdi> },
    { label: x('net'), value: <bdi dir="ltr">{iqd(run.netIqd)}</bdi> },
    { label: x('employer_cost'), value: <bdi dir="ltr">{iqd(run.employerCostIqd)}</bdi> },
    { label: x('paid'), value: <bdi dir="ltr">{iqd(run.paidIqd)}</bdi> },
    { label: x('prepared_by'), value: <bdi dir="auto">{when(detail.createdByName, run.createdAt)}</bdi> },
    { label: x('computed_at'), value: <bdi dir="ltr">{formatTimestamp(new Date(run.computedAt).toISOString(), locale as Locale)}</bdi> },
    ...(run.submittedAt ? [{ label: x('submitted_by'), value: <bdi dir="auto">{when(detail.submittedByName, run.submittedAt)}</bdi> }] : []),
    ...(run.approvedAt ? [{ label: x('approved_by'), value: <bdi dir="auto">{when(detail.approvedByName, run.approvedAt)}</bdi> }] : []),
    ...(run.postedAt
      ? [
          { label: x('posted_by'), value: <bdi dir="auto">{when(detail.postedByName, run.postedAt)}</bdi> },
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
    ...(run.returnNote && status === 'draft' ? [{ label: x('returned_by'), value: <bdi dir="auto">{`${when(detail.returnedByName, run.returnedAt)} — ${run.returnNote}`}</bdi>, wide: true }] : []),
    ...(run.reversedAt
      ? [
          { label: x('reversed_by'), value: <bdi dir="auto">{when(detail.reversedByName, run.reversedAt)}</bdi> },
          {
            label: x('reversal_journal'),
            value: detail.reversalEntryNo ? (
              <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(detail.reversalEntryNo)}`}>
                <bdi dir="ltr">{detail.reversalEntryNo}</bdi>
              </Link>
            ) : (
              '—'
            ),
          },
          { label: x('reversal_reason'), value: <bdi dir="auto">{run.reversalReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    ...(run.cancelledAt
      ? [
          { label: x('cancelled_by'), value: <bdi dir="auto">{when(detail.cancelledByName, run.cancelledAt)}</bdi> },
          { label: x('cancel_reason'), value: <bdi dir="auto">{run.cancelReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    { label: x('note'), value: <bdi dir="auto">{run.note ?? '—'}</bdi>, wide: true },
  ];

  const hidden = <input name="run_no" type="hidden" value={run.runNo} />;
  const sheet = await printSheet('payroll_run', run.runNo);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="payroll_run" id={run.runNo} />}
      back={{ href: '/hr/payroll', label: t('back') }}
      title={`${run.runNo} · ${run.branchCode} ${month}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {missing.length > 0 && status === 'draft' ? <p className={s.sapNote}>{x('missing_compensation', { people: missing.join(', ') })}</p> : null}
      {unrecorded.length > 0 && (status === 'draft' || status === 'submitted') ? (
        <p className={s.sapNote}>{x('unrecorded_days', { people: unrecorded.length, days: unrecorded.reduce((sum, { line }) => sum + line.unrecordedDays, 0) })}</p>
      ) : null}
      {status === 'submitted' && approval === 'maker' ? <p className={s.sapNote}>{x('maker_checker')}</p> : null}
      {run.payDate < businessToday() && status === 'posted' ? <p className={s.sapNote}>{x('pay_overdue', { day: day(run.payDate) })}</p> : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit')}>
                <Form action={updatePayrollDraft}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={run.payDate} label={x('pay_date')} name="pay_date" required type="date" />
                    <Field defaultValue={run.note ?? ''} label={x('note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit ? (
              <form action={recomputePayroll}>
                {hidden}
                <Submit label={x('recompute')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {maySubmit ? (
              <form action={submitPayroll}>
                {hidden}
                <Submit label={x('submit')} variant="document" />
              </form>
            ) : null}
            {mayApprove ? (
              <form action={approvePayroll}>
                {hidden}
                <Submit label={x('approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postPayroll}>
                {hidden}
                <Submit label={x('post')} variant="document" />
              </form>
            ) : null}
            {mayPay ? (
              <NewRecordDialog buttonLabel={x('pay')} closeLabel={t('close')} title={x('pay_title', { no: run.runNo })}>
                <Form action={payPayroll}>
                  {hidden}
                  <Grid>
                    <Select label={x('pay_method')} name="pay_method" options={detail.unpaid.map((u) => ({ value: u.method, label: `${x(`method_${u.method}`)} — ${iqd(u.amountIqd)}` }))} required />
                    <Select label={x('pay_account')} name="account_id" options={accounts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name} (${x(`method_${a.accountType}`)})` }))} required />
                    <Field defaultValue={businessToday()} label={x('paid_on')} name="paid_on" required type="date" />
                    <Field label={x('reference')} name="reference" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('pay')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayReturn ? (
              <form action={returnPayroll}>
                {hidden}
                <input aria-label={x('return_note')} name="note" placeholder={x('return_note')} required type="text" />
                <Submit label={x('return')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayReverse ? (
              <form action={reversePayroll}>
                {hidden}
                <input aria-label={x('reversal_reason')} name="reason" placeholder={x('reversal_reason')} required type="text" />
                <Submit label={x('reverse')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelPayroll}>
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
        id="payroll-document"
        linesCount={detail.lines.length}
        linesTitle={x('lines_title')}
        number={run.runNo}
        totals={[
          { label: x('gross'), value: iqd(run.grossIqd) },
          { label: x('deductions'), value: iqd(run.deductionsIqd) },
          { label: x('net'), value: iqd(run.netIqd) },
        ]}
      >
        <table aria-labelledby="payroll-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('employee')}</th>
              <th scope="col">{x('department')}</th>
              <th className={s.sapNum} scope="col">
                {x('days')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('absent')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('unpaid_leave')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('gross')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('deductions')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('net')}
              </th>
              <th scope="col">{x('pay_method')}</th>
              <th scope="col">{x('payslip')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={10}>
                  {x('no_lines')}
                </td>
              </tr>
            ) : null}
            {detail.lines.map(({ line }) => (
              <tr key={line.id}>
                <td>
                  <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(line.employeeNo)}`}>
                    <bdi dir="ltr">{line.employeeNo}</bdi>
                  </Link>{' '}
                  <bdi dir="auto">{nameOf(line)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.departmentCode}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{`${line.employedDays} / ${line.workingDays}`}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{line.absentDays}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{showDays(daysFrom(line.unpaidLeaveDays))}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(line.grossIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(line.deductionsIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(line.netIqd)}</bdi>
                </td>
                <td>
                  {x(`method_${line.payMethod}`)}
                  {line.paymentId ? ` · ${x('paid_mark')}` : ''}
                </td>
                <td>
                  {line.payslipNo ? (
                    <Link className={s.sapLink} href={`/hr/payroll/payslips/${encodeURIComponent(line.payslipNo)}`}>
                      <bdi dir="ltr">{line.payslipNo}</bdi>
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {mayEdit && manual.length > 0 && detail.lines.length > 0 ? (
        <section aria-labelledby="payroll-typed-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payroll-typed-title">
              <span>{x('typed_title')}</span>
              <span className={s.sapTitleMeta}>{x('typed_hint')}</span>
            </h2>
            <Form action={savePayrollTyped}>
              {hidden}
              <input name="rows" type="hidden" value={detail.lines.length} />
              <input name="codes" type="hidden" value={manual.map((m) => m.code).join(',')} />
              <div className={s.sapTableWrap}>
                <table aria-labelledby="payroll-typed-title" className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{x('employee')}</th>
                      {manual.map((m) => (
                        <th className={s.sapNum} key={m.code} scope="col">
                          {componentName(m)}
                        </th>
                      ))}
                      <th scope="col">{x('typed_note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map(({ line, components }, index) => {
                      const typed = components.filter((c) => c.calculation === 'manual');
                      const note = typed.find((c) => c.note)?.note ?? '';
                      return (
                        <tr key={line.id}>
                          <td>
                            <input name={`employee_${index}`} type="hidden" value={line.employeeId} />
                            <bdi dir="ltr">{line.employeeNo}</bdi> <bdi dir="auto">{nameOf(line)}</bdi>
                          </td>
                          {manual.map((m) => {
                            const current = typed.find((c) => c.componentCode === m.code);
                            const amount = current ? current.amountIqd.replace(/\.0+$/, '') : '0';
                            return (
                              <td className={s.sapNum} key={m.code}>
                                <input aria-label={`${componentName(m)} ${line.employeeNo}`} className={s.sapCellField} defaultValue={amount} inputMode="decimal" name={`${m.code}_${index}`} />
                              </td>
                            );
                          })}
                          <td>
                            <input aria-label={`${x('typed_note')} ${line.employeeNo}`} className={s.sapCellField} defaultValue={note} name={`note_${index}`} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <SubmitRow>
                <Submit label={x('save_typed')} />
              </SubmitRow>
            </Form>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="payroll-components-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payroll-components-title">
            <span>{x('components_title')}</span>
            <span className={s.sapTitleMeta}>{x('components_hint')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="payroll-components-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('component')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('people')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.components.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {x('no_lines')}
                    </td>
                  </tr>
                ) : null}
                {detail.components.map((c) => (
                  <tr key={c.code}>
                    <td>
                      <bdi dir="ltr">{c.code}</bdi> <bdi dir="auto">{componentName(c)}</bdi>
                    </td>
                    <td>{x(`kind_${c.kind}`)}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{c.people}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(c.amountIqd)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {detail.payments.length > 0 ? (
        <section aria-labelledby="payroll-payments-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="payroll-payments-title">
              <span>{x('payments_title')}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="payroll-payments-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('pay_method')}</th>
                    <th scope="col">{x('pay_account')}</th>
                    <th scope="col">{x('paid_on')}</th>
                    <th scope="col">{x('reference')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('employees')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {x('amount')}
                    </th>
                    <th scope="col">{x('journal')}</th>
                    <th scope="col">{x('paid_by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{x(`method_${p.payMethod}`)}</td>
                      <td>
                        <bdi dir="ltr">{p.accountCode}</bdi> <bdi dir="auto">{p.accountName}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(p.paidOn)}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{p.reference ?? '—'}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{p.lines}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{iqd(p.amountIqd)}</bdi>
                      </td>
                      <td>
                        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(p.entryNo)}`}>
                          <bdi dir="ltr">{p.entryNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{p.paidByName}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <RecordHistory objectId={run.runNo} objectType={payroll.PERMISSION_OBJECT} />
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
