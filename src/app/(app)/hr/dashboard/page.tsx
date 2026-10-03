import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import { Band, BandTable, Figure, Figures } from '@/components/admin/dashboard-band';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as hrReports from '@/server/services/hr-reports';

/**
 * HR Dashboard — REQ-HR-001 Stage HR-6. Copies the Dashboard: bands of
 * figures and short tables, each linking to the screen that proves it —
 * headcount, joiners and leavers, who is on leave today, what waits for a
 * decision, and, under their own grants, the payroll cost and what advances
 * still owe. A band with nothing to show is not drawn.
 */
export const dynamic = 'force-dynamic';

export default async function HrDashboardPage() {
  if (!visibleRoute('/hr/dashboard')) notFound();
  const [t, x, page, column, locale, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_dashboard'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', hrReports.PERMISSION_OBJECT)) return <Denied object={page('hr_dashboard')} />;
  const view = await withCurrentUser((tx) => hrReports.dashboard(tx, { principal }));
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} subtitle={x('subtitle', { day: day(view.asOf) })} tabs={<SectionTabs route="/hr/dashboard" />} title={x('title')} variant="sap">
      <Band href="/hr/employees" hrefLabel={x('open_employees')} title={x('people')}>
        <Figures>
          <Figure href="/hr/employees" label={x('headcount')} value={view.headcount} />
          <Figure href="/hr/reports?report=headcount" label={x('joiners')} value={view.joinersThisMonth} />
          <Figure href="/hr/reports?report=headcount" label={x('leavers')} value={view.leaversThisMonth} />
          <Figure href="/hr/leave" label={x('on_leave_today')} value={view.onLeaveToday.length} />
        </Figures>
        {view.byDepartment.length > 0 ? (
          <BandTable headings={[x('department'), { label: x('headcount'), numeric: true }]}>
            {view.byDepartment.map((d) => (
              <tr key={d.departmentCode}>
                <td className={s.sapAccountCell}>
                  <bdi dir="ltr">{d.departmentCode}</bdi> · <bdi dir="auto">{d.departmentName}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{d.headcount}</bdi>
                </td>
              </tr>
            ))}
          </BandTable>
        ) : null}
      </Band>

      <Band title={x('waiting')}>
        <Figures>
          <Figure href="/hr/leave?view=submitted" label={x('leave_waiting')} tone={view.leaveWaiting > 0 ? 'warn' : undefined} value={view.leaveWaiting} />
          <Figure href="/hr/requests?view=submitted" label={x('requests_waiting')} tone={view.requestsWaiting > 0 ? 'warn' : undefined} value={view.requestsWaiting} />
          <Figure href="/hr/recruitment?view=open" label={x('open_vacancies')} value={view.openVacancies} />
          <Figure href="/hr/performance" label={x('reviews_in_progress')} value={view.reviewsInProgress} />
          <Figure href="/hr/documents?view=expiring" label={x('documents_expiring')} tone={view.documentsExpiring > 0 ? 'warn' : undefined} value={view.documentsExpiring} />
        </Figures>
      </Band>

      {view.onLeaveToday.length > 0 ? (
        <Band count={view.onLeaveToday.length} href="/hr/leave" hrefLabel={x('open_leave')} title={x('on_leave_today')}>
          <BandTable headings={[column('employee'), x('leave_type'), x('back_after')]}>
            {view.onLeaveToday.map((l) => (
              <tr key={l.requestNo}>
                <td className={s.sapAccountCell}>
                  <Link href={`/hr/leave/${encodeURIComponent(l.requestNo)}`}>
                    <bdi dir="ltr">{l.employeeNo}</bdi>
                  </Link>{' '}
                  · <bdi dir="auto">{l.fullNameEn}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{l.typeNameEn}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{day(l.toDate)}</bdi>
                </td>
              </tr>
            ))}
          </BandTable>
        </Band>
      ) : null}

      {view.payrollCost && view.payrollCost.length > 0 ? (
        <Band href="/hr/reports?report=payroll" hrefLabel={x('open_register')} title={x('payroll_cost')}>
          <BandTable headings={[x('month'), { label: x('people_paid'), numeric: true }, { label: x('gross'), numeric: true }, { label: x('employer_cost'), numeric: true }]}>
            {view.payrollCost.map((p) => (
              <tr key={p.month}>
                <td>
                  <Link href={`/hr/reports?report=payroll&month=${p.month}`}>
                    <bdi dir="ltr">{p.month}</bdi>
                  </Link>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{p.people}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(p.grossIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(p.employerCostIqd)}</bdi>
                </td>
              </tr>
            ))}
          </BandTable>
        </Band>
      ) : null}

      {view.advancesOwedIqd !== null ? (
        <Band href="/hr/reports?report=advances" hrefLabel={x('open_advances')} title={x('advances')}>
          <Figures>
            <Figure href="/hr/reports?report=advances" label={x('advances_owed')} value={money(view.advancesOwedIqd)} />
          </Figures>
        </Band>
      ) : null}
    </AdminPage>
  );
}
