import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { daysFrom, showDays } from '@/server/domain/hr-time';
import { printSheet } from '@/server/print/sheet';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payroll from '@/server/services/payroll';

/**
 * One payslip — REQ-HR-001 Stage HR-3 (§9, R5). Copies the Purchase Invoice
 * page: the document window, its header the person and the month as the day
 * sheet read it, its lines the components, its totals gross, deductions and
 * net. Read by the payroll's readers, and by the person it pays — row security
 * decides, and of the run the person sees only what the payslip prints.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = { posted: 'posted', paid: 'settled', reversed: 'reversed' };

export default async function PayslipPage({ params, searchParams }: { params: Promise<{ payslipNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/payroll')) notFound();
  const [t, x, page, column, locale, context, outcome, { payslipNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.payroll'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const payslipNo = decodeURIComponent(rawNo);
  const { principal } = context;
  const found = await withCurrentUser((tx) => payroll.payslip(tx, payslipNo));
  if (!found) {
    if (!can(principal, 'view', payroll.PERMISSION_OBJECT)) return <Denied object={page('payroll')} />;
    notFound();
  }
  const { line, run, components } = found;
  const mayOpenRun = can(principal, 'view', payroll.PERMISSION_OBJECT);
  const mayOpenPerson = can(principal, 'view', 'employee');
  const status = run.status === 'reversed' ? 'reversed' : line.paymentId ? 'paid' : 'posted';
  const tone = STATUS_TONE[status] ?? 'posted';
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const name = locale === 'ar' && line.fullNameAr ? line.fullNameAr : line.fullNameEn;
  const month = run.periodMonth.slice(0, 7);
  const days = (hundredths: string | null) => (hundredths === null ? '' : showDays(daysFrom(hundredths)));

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{payslipNo}</bdi> },
    { label: column('status'), value: x(`payslip_status_${status}`), status: tone },
    {
      label: x('employee'),
      value: mayOpenPerson ? (
        <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(line.employeeNo)}`}>
          <bdi dir="auto">{`${line.employeeNo} · ${name}`}</bdi>
        </Link>
      ) : (
        <bdi dir="auto">{`${line.employeeNo} · ${name}`}</bdi>
      ),
    },
    { label: x('department'), value: <bdi dir="ltr">{line.departmentCode}</bdi> },
    { label: x('position'), value: <bdi dir="auto">{line.positionTitle ?? '—'}</bdi> },
    { label: x('month'), value: <bdi dir="ltr">{month}</bdi> },
    {
      label: x('run'),
      value: mayOpenRun ? (
        <Link className={s.sapLink} href={`/hr/payroll/${encodeURIComponent(run.runNo)}`}>
          <bdi dir="ltr">{run.runNo}</bdi>
        </Link>
      ) : (
        <bdi dir="ltr">{run.runNo}</bdi>
      ),
    },
    { label: x('pay_date'), value: <bdi dir="ltr">{day(run.payDate)}</bdi> },
    { label: x('paid_on'), value: <bdi dir="ltr">{run.paidOn ? `${day(run.paidOn)}${run.paymentReference ? ` · ${run.paymentReference}` : ''}` : '—'}</bdi> },
    { label: x('pay_method'), value: x(`method_${line.payMethod}`) },
    ...(line.payMethod === 'bank' ? [{ label: x('bank_account'), value: <bdi dir="ltr">{[line.bankCode, line.accountNumber ?? line.iban].filter(Boolean).join(' · ') || '—'}</bdi> }] : []),
    { label: x('base_salary'), value: <bdi dir="ltr">{iqd(line.baseSalaryIqd)}</bdi> },
    { label: x('days'), value: <bdi dir="ltr">{`${line.employedDays} / ${line.workingDays}`}</bdi> },
    { label: x('present'), value: <bdi dir="ltr">{line.presentDays}</bdi> },
    { label: x('absent'), value: <bdi dir="ltr">{line.absentDays}</bdi> },
    { label: x('paid_leave'), value: <bdi dir="ltr">{days(line.paidLeaveDays)}</bdi> },
    { label: x('unpaid_leave'), value: <bdi dir="ltr">{days(line.unpaidLeaveDays)}</bdi> },
    { label: x('employer_cost'), value: <bdi dir="ltr">{iqd(line.employerCostIqd)}</bdi> },
  ];
  const sheet = await printSheet('payslip', payslipNo);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="payslip" id={payslipNo} />}
      back={{ href: mayOpenRun ? `/hr/payroll/${encodeURIComponent(run.runNo)}` : '/', label: t('back') }}
      title={`${payslipNo} · ${name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {run.status === 'reversed' ? <p className={s.sapNote}>{x('payslip_reversed', { run: run.runNo })}</p> : null}

      <DocumentWindow
        documentType={x('payslip')}
        fields={fields}
        id="payslip-document"
        linesCount={components.length}
        linesTitle={x('components_title')}
        number={payslipNo}
        totals={[
          { label: x('gross'), value: iqd(line.grossIqd) },
          { label: x('deductions'), value: iqd(line.deductionsIqd) },
          { label: x('net'), value: iqd(line.netIqd) },
        ]}
      >
        <table aria-labelledby="payslip-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('component')}</th>
              <th scope="col">{x('kind')}</th>
              <th className={s.sapNum} scope="col">
                {x('basis')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('amount')}
              </th>
              <th scope="col">{x('typed_note')}</th>
            </tr>
          </thead>
          <tbody>
            {components.map((c) => (
              <tr key={c.id}>
                <td>
                  <bdi dir="auto">{locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn}</bdi>
                </td>
                <td>{x(`kind_${c.kind}`)}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{c.rate !== null ? `${c.rate.replace(/\.?0+$/, '')} %` : c.quantity !== null ? x('basis_days', { days: days(c.quantity) }) : '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{iqd(c.amountIqd)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{c.note ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
