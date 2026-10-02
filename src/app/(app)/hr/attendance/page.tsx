import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as attendance from '@/server/services/attendance';
import * as departments from '@/server/services/departments';
import { saveAttendanceSheet } from './actions';

/**
 * Attendance — REQ-HR-001 Stage HR-2 (§8, D-HR-8). The day sheet of one
 * branch: the list model, its filter the branch, the department and the day;
 * its register the people who work there, each line present or absent with
 * the optional in and out times (cells as the budget lines have them). A
 * person on approved leave, a rest day and a holiday read as such.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = { present: 'approved', absent: 'rejected', leave: 'submitted', holiday: 'closed', rest: 'closed', unrecorded: 'draft' };

export default async function AttendancePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/attendance')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.attendance'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', attendance.PERMISSION_OBJECT)) return <Denied object={page('attendance')} />;
  const mayRecord = can(principal, 'create', attendance.PERMISSION_OBJECT);

  const params = await searchParams;
  const today = businessToday();
  const branchCodes = principal.branchCodes;
  const branchParam = typeof params.branch === 'string' && branchCodes.includes(params.branch) ? params.branch : (context.scope.branchCode ?? branchCodes[0] ?? '');
  const departmentParam = typeof params.department === 'string' ? params.department : '';
  const dayParam = typeof params.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.day) ? params.day : today;

  const { day, departmentRows } = await withCurrentUser(async (tx) => ({
    day: branchParam ? await attendance.sheet(tx, { branchCode: branchParam, day: dayParam, departmentCode: departmentParam || null }) : { day: dayParam, kind: 'working' as const, rows: [] },
    departmentRows: await departments.listAll(tx),
  }));
  const future = dayParam > today;
  const editable = mayRecord && !future;
  const recordedCount = day.rows.filter((r) => r.recorded !== null).length;

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} tabs={<SectionTabs route="/hr/attendance" />} subtitle={x('subtitle')} title={x('title')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {day.kind !== 'working' ? <p className={s.sapNote}>{x(`day_is_${day.kind}`, { day: formatBusinessDate(day.day, locale as Locale) })}</p> : null}
      {future ? <p className={s.sapNote}>{x('future_day')}</p> : null}

      <section aria-labelledby="att-sheet-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="att-sheet-title">
            <span>{x('sheet_title', { day: formatBusinessDate(day.day, locale as Locale), branch: branchParam })}</span>
            <span className={s.sapTitleMeta}>{x('recorded_of', { recorded: recordedCount, total: day.rows.length })}</span>
          </h2>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={branchParam} label={column('branch')} name="branch" options={branchCodes.map((code) => ({ value: code, label: code }))} />
              <Select
                defaultValue={departmentParam}
                emptyLabel={x('all_departments')}
                label={x('department')}
                name="department"
                options={departmentRows.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
              />
              <Field defaultValue={dayParam} label={x('day')} name="day" type="date" />
              <SubmitRow>
                <Submit label={x('show')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <Form action={saveAttendanceSheet}>
            <input name="branch" type="hidden" value={branchParam} />
            <input name="day" type="hidden" value={day.day} />
            <input name="department" type="hidden" value={departmentParam} />
            <input name="rows" type="hidden" value={day.rows.length} />
            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table aria-labelledby="att-sheet-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{column('reference')}</th>
                    <th scope="col">{column('name')}</th>
                    <th scope="col">{x('department')}</th>
                    <th scope="col">{x('day_reads')}</th>
                    <th scope="col">{x('status')}</th>
                    <th scope="col">{x('check_in')}</th>
                    <th scope="col">{x('check_out')}</th>
                    <th scope="col">{x('note')}</th>
                  </tr>
                </thead>
                <tbody>
                  {day.rows.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={8}>
                        {x('none')}
                      </td>
                    </tr>
                  ) : null}
                  {day.rows.map((row, index) => {
                    const name = locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn;
                    const onLeave = row.leaveRequestNo !== null;
                    const tone = STATUS_TONE[row.status] ?? 'draft';
                    return (
                      <tr key={row.employeeId}>
                        <td>
                          <input name={`employee_${index}`} type="hidden" value={onLeave ? '' : row.employeeId} />
                          <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(row.employeeNo)}`}>
                            <bdi dir="ltr">{row.employeeNo}</bdi>
                          </Link>
                        </td>
                        <td>
                          <bdi dir="auto">{name}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{row.departmentName}</bdi>
                        </td>
                        <td>
                          <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                            {x(`status_${row.status}`)}
                          </span>
                          {onLeave ? (
                            <>
                              {' '}
                              <Link className={s.sapLink} href={`/hr/leave/${encodeURIComponent(row.leaveRequestNo!)}`}>
                                <bdi dir="ltr">{row.leaveRequestNo}</bdi>
                              </Link>{' '}
                              <bdi dir="auto">{locale === 'ar' && row.leaveTypeNameAr ? row.leaveTypeNameAr : row.leaveTypeName}</bdi>
                            </>
                          ) : null}
                        </td>
                        {onLeave || !editable ? (
                          <>
                            <td>{row.recorded ? x(`status_${row.recorded}`) : '—'}</td>
                            <td>
                              <bdi dir="ltr">{row.checkIn ?? '—'}</bdi>
                            </td>
                            <td>
                              <bdi dir="ltr">{row.checkOut ?? '—'}</bdi>
                            </td>
                            <td>
                              <bdi dir="auto">{row.note ?? '—'}</bdi>
                            </td>
                          </>
                        ) : (
                          <>
                            <td>
                              <select aria-label={`${x('status')} ${row.employeeNo}`} className={s.sapCellField} defaultValue={row.recorded ?? ''} name={`status_${index}`}>
                                <option value="">—</option>
                                <option value="present">{x('status_present')}</option>
                                <option value="absent">{x('status_absent')}</option>
                              </select>
                            </td>
                            <td>
                              <input aria-label={`${x('check_in')} ${row.employeeNo}`} className={s.sapCellField} defaultValue={row.checkIn ?? ''} name={`check_in_${index}`} type="time" />
                            </td>
                            <td>
                              <input aria-label={`${x('check_out')} ${row.employeeNo}`} className={s.sapCellField} defaultValue={row.checkOut ?? ''} name={`check_out_${index}`} type="time" />
                            </td>
                            <td>
                              <input aria-label={`${x('note')} ${row.employeeNo}`} className={s.sapCellField} defaultValue={row.note ?? ''} name={`note_${index}`} />
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {editable && day.rows.some((r) => r.leaveRequestNo === null) ? (
              <SubmitRow>
                <Submit label={x('save')} />
              </SubmitRow>
            ) : null}
          </Form>
        </div>
      </section>
    </AdminPage>
  );
}
