import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as employees from '@/server/services/employees';

/**
 * Organisation — REQ-HR-001 §5. Copies the Supplier Statements screen's
 * stacked read-only registers: one per department, its positions in
 * reporting order (indented by the dash the register already uses for a
 * missing value), who holds each, the headcount counted.
 */
export const dynamic = 'force-dynamic';

export default async function OrganisationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/organisation')) notFound();
  const [t, x, e, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.organisation'),
    getTranslations('admin.employees'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', employees.ORGANISATION_OBJECT)) {
    return <Denied object={page('organisation')} />;
  }
  const tree = await withCurrentUser((tx) => employees.organisation(tx));
  const title = (position: { titleEn: string; titleAr: string | null }) => (locale === 'ar' && position.titleAr ? position.titleAr : position.titleEn);
  const statusTone = (value: string) => (value === 'active' ? 'approved' : 'submitted');

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/organisation" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {tree.length === 0 ? (
        <section className={s.sapDoc}>
          <div className={s.sapWindow}>
            <p className={s.sapNote}>{x('none')}</p>
          </div>
        </section>
      ) : null}
      {tree.map((dept) => (
        <section aria-labelledby={`org-${dept.departmentCode}`} className={s.sapDoc} key={dept.departmentCode}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id={`org-${dept.departmentCode}`}>
              <span>
                <bdi dir="auto">{dept.departmentName}</bdi>{' '}
                <span className={s.sapTitleMeta}>
                  <bdi dir="ltr">{dept.departmentCode}</bdi>
                </span>
              </span>
              <span className={s.sapTitleMeta}>{x('headcount', { count: dept.headcount })}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby={`org-${dept.departmentCode}`} className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{x('col_position')}</th>
                    <th scope="col">{x('col_reports_to')}</th>
                    <th scope="col">{x('col_holders')}</th>
                  </tr>
                </thead>
                <tbody>
                  {dept.positions.length === 0 && dept.unseated.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={3}>
                        —
                      </td>
                    </tr>
                  ) : null}
                  {dept.positions.map((position) => (
                    <tr key={position.code}>
                      <td>
                        <bdi dir="auto">
                          {'— '.repeat(position.depth)}
                          {title(position)}
                        </bdi>{' '}
                        <span className="muted">
                          <bdi dir="ltr">{position.code}</bdi>
                        </span>
                      </td>
                      <td>
                        <bdi dir="ltr">{position.reportsToCode ?? '—'}</bdi>
                      </td>
                      <td>
                        {position.holders.length === 0 ? (
                          <span className="muted">{x('vacant')}</span>
                        ) : (
                          position.holders.map((holder, index) => (
                            <span key={holder.employeeNo}>
                              {index > 0 ? ' · ' : ''}
                              <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(holder.employeeNo)}`}>
                                <bdi dir="auto">{holder.fullNameEn}</bdi>
                              </Link>
                              {holder.status !== 'active' ? (
                                <>
                                  {' '}
                                  <span className={`status status--${statusTone(holder.status)} ${s.sapRegisterStatus}`} data-status={statusTone(holder.status)}>
                                    {e(`status_${holder.status}`)}
                                  </span>
                                </>
                              ) : null}
                            </span>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                  {dept.unseated.length > 0 ? (
                    <tr>
                      <td>
                        <span className="muted">{x('unseated')}</span>
                      </td>
                      <td>—</td>
                      <td>
                        {dept.unseated.map((holder, index) => (
                          <span key={holder.employeeNo}>
                            {index > 0 ? ' · ' : ''}
                            <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(holder.employeeNo)}`}>
                              <bdi dir="auto">{holder.fullNameEn}</bdi>
                            </Link>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ))}
    </AdminPage>
  );
}
