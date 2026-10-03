import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { EMPLOYMENT_KINDS } from '@/server/domain/hr';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/banks';
import * as departments from '@/server/services/departments';
import * as employees from '@/server/services/employees';
import * as hrSettings from '@/server/services/hr-settings';
import * as attendance from '@/server/services/attendance';
import * as leave from '@/server/services/leave';
import { showDays, daysFrom, weekdayOf } from '@/server/domain/hr-time';
import {
  adjustLeaveBalance,
  linkEmployeeUser,
  moveEmployee,
  setEmployeeCompensation,
  setEmployeeStatus,
  updateEmployeeIdentity,
} from '../actions';

/**
 * One employee — REQ-HR-001 §4. Copies the Purchase Invoice page: the
 * document window with the header fields, its "lines" the dated history,
 * the verbs at the foot; the compensation register stacked under it in the
 * supplier-statement manner, drawn only under its own grant (R5); then the
 * audit log.
 */
export const dynamic = 'force-dynamic';

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ employeeNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/employees')) notFound();
  const [t, x, page, column, locale, context, outcome, { employeeNo: rawNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.employees'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const employeeNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', employees.PERMISSION_OBJECT)) {
    return <Denied object={page('employees')} />;
  }
  const mayEdit = can(principal, 'edit_draft', employees.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', employees.PERMISSION_OBJECT);
  const maySeePay = can(principal, 'view', employees.COMPENSATION_OBJECT);
  const maySetPay = can(principal, 'create', employees.COMPENSATION_OBJECT);
  const actor = { principal, branchCode: context.scope.branchCode };
  const maySeeLeave = can(principal, 'view', leave.PERMISSION_OBJECT);
  const mayAdjustLeave = can(principal, 'administer', leave.PERMISSION_OBJECT);
  const maySeeAttendance = can(principal, 'view', attendance.PERMISSION_OBJECT);
  const query = await searchParams;
  const today = businessToday();
  const monthParam = typeof query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month) ? query.month : today.slice(0, 7);
  // The month picker: this month and the twelve before it, and the one asked for.
  const months = (() => {
    const [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
    const list = Array.from({ length: 13 }, (_, i) => {
      const at = new Date(Date.UTC(y, m - 1 - i, 1));
      return at.toISOString().slice(0, 7);
    });
    return list.includes(monthParam) ? list : [monthParam, ...list];
  })();
  const leaveYear = Number(typeof query.year === 'string' && /^\d{4}$/.test(query.year) ? query.year : today.slice(0, 4));

  const found = await withCurrentUser(async (tx) => {
    const row = await employees.byNo(tx, employeeNo);
    if (!row) return null;
    return {
      row,
      history: await employees.historyOf(tx, row.id),
      compensation: maySeePay ? await employees.compensationOf(tx, actor, row.id) : [],
      departmentRows: mayEdit ? await departments.listAll(tx) : [],
      positions: mayEdit ? await hrSettings.positions(tx) : [],
      managers: mayEdit ? await employees.managersAvailable(tx) : [],
      users: mayAdminister ? await employees.usersAvailable(tx) : [],
      bankRows: maySetPay ? await banks.listActive(tx) : [],
      // HR-2 — the person's leave and days, read as the screens read them.
      balances: maySeeLeave ? await leave.balances(tx, row.id, leaveYear) : [],
      requests: maySeeLeave ? await leave.requestsOf(tx, row.id) : [],
      leaveTypes: mayAdjustLeave ? await leave.activeTypes(tx) : [],
      month: maySeeAttendance ? await attendance.daysOf(tx, row.id, attendance.monthSpan(monthParam).fromDate, attendance.monthSpan(monthParam).toDate) : [],
    };
  });
  if (!found) notFound();
  const { row, history, compensation } = found;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (value: Date | string) => formatTimestamp(new Date(value).toISOString(), locale as Locale);
  const statusTone = row.status === 'active' ? 'approved' : row.status === 'suspended' ? 'submitted' : 'closed';
  const name = locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn;
  const label = (field: string) => x(`field_${field}`);
  const value = (field: string, raw: string | null) => {
    if (raw === null) return '—';
    if (field === 'employment_kind') return x(`kind_${raw}`);
    if (field === 'status') return x(`status_${raw}`);
    if (field === 'manager_employee_id') return found.managers.find((m) => m.id === raw)?.fullNameEn ?? raw.slice(0, 8);
    return raw;
  };

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{row.employeeNo}</bdi> },
    { label: column('status'), value: x(`status_${row.status}`), status: statusTone },
    { label: x('full_name_en'), value: <bdi dir="auto">{row.fullNameEn}</bdi> },
    { label: x('full_name_ar'), value: <bdi dir="auto">{row.fullNameAr ?? '—'}</bdi> },
    { label: x('national_id'), value: <bdi dir="ltr">{row.nationalId ?? '—'}</bdi> },
    { label: x('date_of_birth'), value: <bdi dir="ltr">{day(row.dateOfBirth)}</bdi> },
    { label: x('phone'), value: <bdi dir="ltr">{row.phone ?? '—'}</bdi> },
    { label: column('branch'), value: <bdi dir="auto">{row.branchName}</bdi> },
    { label: x('department'), value: <bdi dir="auto">{row.departmentName}</bdi> },
    { label: x('position'), value: <bdi dir="auto">{row.positionTitle ?? '—'}</bdi> },
    { label: x('manager'), value: <bdi dir="auto">{row.managerName ? `${row.managerNo} · ${row.managerName}` : '—'}</bdi> },
    { label: x('hire_date'), value: <bdi dir="ltr">{day(row.hireDate)}</bdi> },
    { label: x('employment_kind'), value: x(`kind_${row.employmentKind}`) },
    ...(row.contractEndDate ? [{ label: x('contract_end_date'), value: <bdi dir="ltr">{day(row.contractEndDate)}</bdi> }] : []),
    ...(row.status === 'ended'
      ? [
          { label: x('end_date'), value: <bdi dir="ltr">{day(row.endDate)}</bdi> },
          { label: x('end_reason'), value: <bdi dir="auto">{row.endReason ?? '—'}</bdi>, wide: true },
        ]
      : []),
    { label: x('user_account'), value: <bdi dir="ltr">{row.userEmail ?? x('no_user')}</bdi> },
    { label: x('address'), value: <bdi dir="auto">{row.address ?? '—'}</bdi>, wide: true },
    { label: x('emergency_contact'), value: <bdi dir="auto">{row.emergencyContact ?? '—'}</bdi>, wide: true },
  ];

  const hidden = (
    <>
      <input name="id" type="hidden" value={row.id} />
      <input name="employee_no" type="hidden" value={row.employeeNo} />
    </>
  );

  return (
    <AdminPage
      back={{ href: '/hr/employees', label: t('back') }}
      title={`${row.employeeNo} · ${name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit_identity')} closeLabel={t('close')} title={x('edit_identity')}>
                <Form action={updateEmployeeIdentity}>
                  {hidden}
                  <Grid>
                    <Field defaultValue={row.fullNameEn} label={x('full_name_en')} name="full_name_en" required requiredLabel={t('required_hint')} />
                    <Field defaultValue={row.fullNameAr ?? ''} label={x('full_name_ar')} name="full_name_ar" />
                    <Field defaultValue={row.nationalId ?? ''} label={x('national_id')} name="national_id" />
                    <Field defaultValue={row.dateOfBirth ?? ''} label={x('date_of_birth')} name="date_of_birth" type="date" />
                    <Field defaultValue={row.phone ?? ''} label={x('phone')} name="phone" />
                    <Field defaultValue={row.emergencyContact ?? ''} label={x('emergency_contact')} name="emergency_contact" />
                    <Field defaultValue={row.address ?? ''} label={x('address')} name="address" type="textarea" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && row.status !== 'ended' ? (
              <NewRecordDialog buttonLabel={x('move')} closeLabel={t('close')} title={x('move_title', { name })}>
                <Form action={moveEmployee}>
                  {hidden}
                  <p className="muted">{x('move_hint')}</p>
                  <Grid>
                    <Select
                      defaultValue={row.departmentCode}
                      label={x('department')}
                      name="department_code"
                      options={found.departmentRows.filter((d) => d.active || d.code === row.departmentCode).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                    />
                    <Select
                      defaultValue={row.positionCode ?? ''}
                      emptyLabel={x('no_position')}
                      label={x('position')}
                      name="position_code"
                      options={found.positions.filter((p) => p.active || p.code === row.positionCode).map((p) => ({ value: p.code, label: `${p.code} · ${p.titleEn}` }))}
                    />
                    <Select
                      defaultValue={row.managerEmployeeId ?? ''}
                      emptyLabel={x('no_manager')}
                      label={x('manager')}
                      name="manager_employee_id"
                      options={found.managers.filter((m) => m.id !== row.id).map((m) => ({ value: m.id, label: `${m.employeeNo} · ${m.fullNameEn}` }))}
                    />
                    <Select
                      defaultValue={row.employmentKind}
                      label={x('employment_kind')}
                      name="employment_kind"
                      options={EMPLOYMENT_KINDS.map((value) => ({ value, label: x(`kind_${value}`) }))}
                    />
                    <Field defaultValue={row.contractEndDate ?? ''} hint={x('contract_end_hint')} label={x('contract_end_date')} name="contract_end_date" type="date" />
                    <Field defaultValue={today} label={x('effective_from')} name="effective_from" required type="date" />
                    <Field label={x('reason')} name="reason" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayAdminister && row.status === 'active' ? (
              <form action={setEmployeeStatus}>
                {hidden}
                <input name="status" type="hidden" value="suspended" />
                <input aria-label={x('reason')} name="reason" placeholder={x('reason')} required type="text" />
                <Submit label={x('suspend')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayAdminister && row.status !== 'active' ? (
              <form action={setEmployeeStatus}>
                {hidden}
                <input name="status" type="hidden" value="active" />
                <input aria-label={x('reason')} name="reason" placeholder={x('reason')} type="text" />
                <Submit label={x('reinstate')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayAdminister && row.status !== 'ended' ? (
              <NewRecordDialog buttonLabel={x('end')} closeLabel={t('close')} title={x('end_title', { name })}>
                <Form action={setEmployeeStatus}>
                  {hidden}
                  <input name="status" type="hidden" value="ended" />
                  <p className="muted">{x('end_hint')}</p>
                  <Grid>
                    <Field defaultValue={today} label={x('end_date')} name="effective_from" required type="date" />
                    <Field label={x('end_reason')} name="reason" required requiredLabel={t('required_hint')} />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('end')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayAdminister ? (
              <NewRecordDialog buttonLabel={x('link_user')} closeLabel={t('close')} title={x('link_user_title', { name })}>
                <Form action={linkEmployeeUser}>
                  {hidden}
                  <p className="muted">{x('link_user_hint')}</p>
                  <Grid>
                    <Select
                      defaultValue={row.appUserId ?? ''}
                      emptyLabel={x('no_user')}
                      label={x('user_account')}
                      name="app_user_id"
                      options={[
                        ...(row.appUserId ? [{ value: row.appUserId, label: row.userEmail ?? row.appUserId }] : []),
                        ...found.users.map((u) => ({ value: u.id, label: `${u.displayName} · ${u.email}` })),
                      ]}
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('employees')}
        fields={fields}
        id="employee-document"
        linesCount={history.length}
        linesTitle={x('history')}
        number={row.employeeNo}
      >
        <table aria-labelledby="employee-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('col_effective')}</th>
              <th scope="col">{x('col_field')}</th>
              <th scope="col">{x('col_before')}</th>
              <th scope="col">{x('col_after')}</th>
              <th scope="col">{x('col_reason')}</th>
              <th scope="col">{x('col_recorded')}</th>
              <th scope="col">{x('col_by')}</th>
            </tr>
          </thead>
          <tbody>
            {history.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={7}>
                  {x('history_none')}
                </td>
              </tr>
            ) : null}
            {history.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <bdi dir="ltr">{day(entry.effectiveFrom)}</bdi>
                </td>
                <td>{label(entry.field)}</td>
                <td>
                  <bdi dir="auto">{value(entry.field, entry.beforeValue)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{value(entry.field, entry.afterValue)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{entry.reason ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{when(entry.recordedAt)}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{entry.recordedBy ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {maySeePay ? (
        <section aria-labelledby="employee-pay-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="employee-pay-title">
              <span>{x('compensation')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: compensation.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="employee-pay-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('effective_from')}</th>
                    <th className={s.sapNum} scope="col">
                      {x('col_salary')}
                    </th>
                    <th scope="col">{x('col_method')}</th>
                    <th scope="col">{x('col_bank')}</th>
                    <th scope="col">{x('note')}</th>
                    <th scope="col">{x('col_recorded')}</th>
                    <th scope="col">{x('col_by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {compensation.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={7}>
                        {x('compensation_none')}
                      </td>
                    </tr>
                  ) : null}
                  {compensation.map((pay) => (
                    <tr key={pay.id}>
                      <td>
                        <bdi dir="ltr">{day(pay.effectiveFrom)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{formatMoney(pay.baseSalaryIqd, 'IQD', locale as Locale)}</bdi>
                      </td>
                      <td>{pay.payMethod === 'bank' ? x('pay_bank') : x('pay_cash')}</td>
                      <td>
                        <bdi dir="ltr">{pay.payMethod === 'bank' ? [pay.bankCode, pay.accountNumber ?? pay.iban].filter(Boolean).join(' · ') || '—' : '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{pay.note ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{when(pay.recordedAt)}</bdi>
                      </td>
                      <td>
                        <bdi dir="auto">{pay.recordedBy ?? '—'}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {maySetPay && row.status !== 'ended' ? (
              <div className={s.sapBody}>
                <Form action={setEmployeeCompensation}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('compensation_new')}</p>
                  <p className="muted">{x('compensation_hint')}</p>
                  <Grid>
                    <Field defaultValue={today} label={x('effective_from')} name="effective_from" required type="date" />
                    <Field label={x('base_salary')} name="base_salary_iqd" required requiredLabel={t('required_hint')} />
                    <Select
                      defaultValue="bank"
                      label={x('pay_method')}
                      name="pay_method"
                      options={[
                        { value: 'bank', label: x('pay_bank') },
                        { value: 'cash', label: x('pay_cash') },
                      ]}
                    />
                    <Select emptyLabel="—" label={x('bank')} name="bank_code" options={found.bankRows.map((b) => ({ value: b.code, label: `${b.code} · ${b.name}` }))} />
                    <Field label={x('account_number')} name="account_number" />
                    <Field label={x('iban')} name="iban" />
                    <Field label={x('note')} name="note" wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} small tone="secondary" />
                  </SubmitRow>
                </Form>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* REQ-HR-001 HR-2 — the person's leave: balances by type for the year, the requests, an opening balance or a correction. */}
      {maySeeLeave ? (
        <section aria-labelledby="employee-leave-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="employee-leave-title">
              <span>{x('leave_title', { year: leaveYear })}</span>
              <span className={s.sapTitleMeta}>
                <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(row.employeeNo)}?year=${leaveYear - 1}`}>
                  <bdi dir="ltr">{leaveYear - 1}</bdi>
                </Link>{' '}
                ·{' '}
                <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(row.employeeNo)}?year=${leaveYear + 1}`}>
                  <bdi dir="ltr">{leaveYear + 1}</bdi>
                </Link>
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="employee-leave-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('leave_type')}</th>
                    <th className={s.sapNum} scope="col">{x('col_carry_in')}</th>
                    <th className={s.sapNum} scope="col">{x('col_entitlement')}</th>
                    <th className={s.sapNum} scope="col">{x('col_adjustments')}</th>
                    <th className={s.sapNum} scope="col">{x('col_taken')}</th>
                    <th className={s.sapNum} scope="col">{x('col_pending')}</th>
                    <th className={s.sapNum} scope="col">{x('col_balance')}</th>
                  </tr>
                </thead>
                <tbody>
                  {found.balances.map((b) => (
                    <tr key={b.leaveTypeCode}>
                      <td>
                        <bdi dir="auto">{locale === 'ar' && b.nameAr ? b.nameAr : b.nameEn}</bdi>
                      </td>
                      <td className={s.sapNum}>{b.limited ? showDays(b.carryIn) : '—'}</td>
                      <td className={s.sapNum}>{b.limited ? showDays(b.entitlement) : '—'}</td>
                      <td className={s.sapNum}>{showDays(b.adjustments)}</td>
                      <td className={s.sapNum}>{showDays(b.taken)}</td>
                      <td className={s.sapNum}>{showDays(b.pending)}</td>
                      <td className={s.sapNum}>{b.limited ? showDays(b.balance) : x('not_limited')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {mayAdjustLeave ? (
              <div className={s.sapBody}>
                <Form action={adjustLeaveBalance}>
                  {hidden}
                  <p className={s.sapGridCaption}>{x('leave_adjust')}</p>
                  <p className="muted">{x('leave_adjust_hint')}</p>
                  <Grid>
                    <Select
                      label={x('leave_type')}
                      name="leave_type_code"
                      options={found.leaveTypes.map((type) => ({ value: type.code, label: locale === 'ar' && type.nameAr ? type.nameAr : type.nameEn }))}
                      required
                    />
                    <Field defaultValue={String(leaveYear)} label={x('leave_year')} name="year" required />
                    <Field hint={x('leave_days_hint')} label={x('leave_days')} name="days" required requiredLabel={t('required_hint')} />
                    <Select
                      defaultValue="adjustment"
                      label={x('leave_kind')}
                      name="kind"
                      options={[
                        { value: 'opening', label: x('leave_kind_opening') },
                        { value: 'adjustment', label: x('leave_kind_adjustment') },
                      ]}
                    />
                    <Field label={x('reason')} name="reason" required requiredLabel={t('required_hint')} wide />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} small tone="secondary" />
                  </SubmitRow>
                </Form>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {maySeeLeave ? (
        <section aria-labelledby="employee-requests-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="employee-requests-title">
              <span>{x('requests_title')}</span>
              <span className={s.sapTitleMeta}>{t('rows_shown', { count: found.requests.length })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="employee-requests-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('reference')}</th>
                    <th scope="col">{x('leave_type')}</th>
                    <th scope="col">{x('col_from')}</th>
                    <th scope="col">{x('col_to')}</th>
                    <th className={s.sapNum} scope="col">{x('leave_days')}</th>
                    <th scope="col">{column('status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {found.requests.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={6}>
                        {x('requests_none')}
                      </td>
                    </tr>
                  ) : null}
                  {found.requests.map((r) => {
                    const tone = ({ draft: 'draft', submitted: 'submitted', approved: 'approved', refused: 'rejected', cancelled: 'cancelled' } as Record<string, string>)[r.status] ?? 'draft';
                    return (
                      <tr key={r.requestNo}>
                        <td>
                          <Link className={s.sapLink} href={`/hr/leave/${encodeURIComponent(r.requestNo)}`}>
                            <bdi dir="ltr">{r.requestNo}</bdi>
                          </Link>
                        </td>
                        <td>
                          <bdi dir="auto">{locale === 'ar' && r.typeNameAr ? r.typeNameAr : r.typeName}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(r.fromDate)}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{day(r.toDate)}</bdi>
                        </td>
                        <td className={s.sapNum}>{showDays(daysFrom(r.days))}</td>
                        <td>
                          <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                            {x(`leave_status_${r.status}`)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {/* REQ-HR-001 HR-2 — the month, each day as it reads: leave, the sheet, the calendar. */}
      {maySeeAttendance ? (
        <section aria-labelledby="employee-month-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="employee-month-title">
              <span>{x('month_title', { month: monthParam })}</span>
              <span className={s.sapTitleMeta}>
                {x('month_counts', {
                  present: found.month.filter((d) => d.status === 'present').length,
                  absent: found.month.filter((d) => d.status === 'absent').length,
                  leave: found.month.filter((d) => d.status === 'leave').length,
                })}
              </span>
            </h2>
            <form className={s.filterBar} method="get">
              <FilterRow>
                <Select defaultValue={monthParam} label={x('month')} name="month" options={months.map((m) => ({ value: m, label: m }))} />
                <SubmitRow>
                  <Submit label={x('show')} />
                </SubmitRow>
              </FilterRow>
            </form>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="employee-month-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('col_day')}</th>
                    <th scope="col">{x('col_weekday')}</th>
                    <th scope="col">{column('status')}</th>
                    <th scope="col">{x('col_in')}</th>
                    <th scope="col">{x('col_out')}</th>
                    <th scope="col">{x('note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {found.month.map((d) => {
                    const tone = ({ present: 'approved', absent: 'rejected', leave: 'submitted', holiday: 'closed', rest: 'closed', unrecorded: 'draft' } as Record<string, string>)[d.status] ?? 'draft';
                    return (
                      <tr key={d.day}>
                        <td>
                          <bdi dir="ltr">{day(d.day)}</bdi>
                        </td>
                        <td>{x(`weekday_${weekdayOf(d.day)}`)}</td>
                        <td>
                          <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                            {x(`day_${d.status}`)}
                          </span>
                          {d.leaveRequestNo ? (
                            <>
                              {' '}
                              <Link className={s.sapLink} href={`/hr/leave/${encodeURIComponent(d.leaveRequestNo)}`}>
                                <bdi dir="ltr">{d.leaveRequestNo}</bdi>
                              </Link>
                            </>
                          ) : null}
                        </td>
                        <td>
                          <bdi dir="ltr">{d.checkIn ?? '—'}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{d.checkOut ?? '—'}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{d.leaveRequestNo ? (locale === 'ar' && d.leaveTypeNameAr ? d.leaveTypeNameAr : d.leaveTypeName) : (d.note ?? '—')}</bdi>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      <RecordHistory objectId={row.employeeNo} objectType={employees.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
