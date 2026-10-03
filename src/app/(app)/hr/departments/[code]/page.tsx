import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departmentService from '@/server/services/departments';
import * as employees from '@/server/services/employees';
import * as structure from '@/server/services/hr-structure';
import { setDepartmentActive, updateDepartment } from '../actions';

/**
 * One department — REQ-FIX-001 FIX-5. Copies the Purchase Invoice page: the
 * document window (header fields, status chip, the actions at its foot),
 * its lines the seats in reporting order with who holds each; the people
 * stacked under it in the supplier-statement manner; then the audit log.
 */
export const dynamic = 'force-dynamic';

export default async function DepartmentPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/departments')) notFound();
  const [t, x, e, page, column, locale, context, outcome, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_structure'),
    getTranslations('admin.employees'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', employees.ORGANISATION_OBJECT)) {
    return <Denied object={page('hr_departments')} />;
  }
  const mayEdit = can(principal, 'configure', departmentService.PERMISSION_OBJECT);
  const mayAdminister = can(principal, 'administer', departmentService.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    const detail = await structure.departmentByCode(tx, code);
    if (!detail) return null;
    return { detail, all: mayEdit ? await structure.departments(tx) : [] };
  });
  if (!found) notFound();
  const { row, seats, unseated, people, children } = found.detail;
  const tone = row.active ? 'approved' : 'closed';
  const personTone = (value: string) => (value === 'active' ? 'approved' : value === 'suspended' ? 'submitted' : 'closed');
  const title = (seat: { titleEn: string; titleAr: string | null }) => (locale === 'ar' && seat.titleAr ? seat.titleAr : seat.titleEn);
  const name = (person: { fullNameEn: string; fullNameAr: string | null }) => (locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn);

  const fields: DocumentField[] = [
    { label: column('code'), value: <bdi dir="ltr">{row.code}</bdi> },
    { label: column('status'), value: row.active ? t('active') : t('inactive'), status: tone },
    { label: x('name'), value: <bdi dir="auto">{row.name}</bdi> },
    { label: x('parent'), value: <bdi dir="auto">{row.parentName ? `${row.parentCode} · ${row.parentName}` : '—'}</bdi> },
    { label: x('manager'), value: <bdi dir="auto">{row.managerName ?? '—'}</bdi> },
    { label: x('headcount'), value: row.headcount },
    { label: x('seats'), value: row.seats },
    { label: x('vacant'), value: row.vacant },
    { label: x('children'), value: <bdi dir="auto">{children.length === 0 ? '—' : children.map((child) => `${child.code} · ${child.name}`).join(', ')}</bdi>, wide: true },
  ];

  return (
    <AdminPage back={{ href: '/hr/departments', label: t('back') }} title={`${row.code} · ${row.name}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit')}>
                <Form action={updateDepartment}>
                  <input name="code" type="hidden" value={row.code} />
                  <Grid>
                    <Field defaultValue={row.name} label={x('name')} name="name" required requiredLabel={t('required_hint')} />
                    <Select
                      defaultValue={row.parentCode ?? ''}
                      emptyLabel={x('no_parent')}
                      label={x('parent')}
                      name="parent_code"
                      options={found.all.filter((d) => d.code !== row.code && (d.active || d.code === row.parentCode)).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayAdminister && row.active ? (
              <form action={setDepartmentActive}>
                <input name="code" type="hidden" value={row.code} />
                <input aria-label={t('reason')} name="reason" placeholder={t('reason_placeholder')} required type="text" />
                <Submit label={t('deactivate')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayAdminister && !row.active ? (
              <form action={setDepartmentActive}>
                <input name="code" type="hidden" value={row.code} />
                <input name="active" type="hidden" value="1" />
                <Submit label={t('reactivate')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('department_document')}
        fields={fields}
        id="department-document"
        linesCount={seats.length}
        linesTitle={x('seats_title')}
        number={row.code}
      >
        <table aria-labelledby="department-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{x('position')}</th>
              <th scope="col">{x('reports_to')}</th>
              <th scope="col">{x('holders')}</th>
            </tr>
          </thead>
          <tbody>
            {seats.length === 0 && unseated.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={3}>
                  {x('seats_none')}
                </td>
              </tr>
            ) : null}
            {seats.map((seat) => (
              <tr key={seat.code}>
                <td>
                  <Link className={s.sapLink} href={`/hr/positions/${encodeURIComponent(seat.code)}`}>
                    <bdi dir="auto">
                      {'— '.repeat(seat.depth)}
                      {title(seat)}
                    </bdi>
                  </Link>{' '}
                  <span className="muted">
                    <bdi dir="ltr">{seat.code}</bdi>
                  </span>
                </td>
                <td>
                  <bdi dir="ltr">{seat.reportsToCode ?? '—'}</bdi>
                </td>
                <td>
                  {seat.holders.length === 0 ? (
                    <span className="muted">{x('vacant_seat')}</span>
                  ) : (
                    seat.holders.map((holder, index) => (
                      <span key={holder.employeeNo}>
                        {index > 0 ? ' · ' : ''}
                        <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(holder.employeeNo)}`}>
                          <bdi dir="auto">{holder.fullNameEn}</bdi>
                        </Link>
                      </span>
                    ))
                  )}
                </td>
              </tr>
            ))}
            {unseated.length > 0 ? (
              <tr>
                <td>
                  <span className="muted">{x('unseated')}</span>
                </td>
                <td>—</td>
                <td>
                  {unseated.map((holder, index) => (
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
      </DocumentWindow>

      <section aria-labelledby="department-people-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="department-people-title">
            <span>{x('people_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: people.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="department-people-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{x('position')}</th>
                  <th scope="col">{column('branch')}</th>
                  <th scope="col">{e('hire_date')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {people.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={6}>
                      {x('people_none')}
                    </td>
                  </tr>
                ) : null}
                {people.map((person) => (
                  <tr key={person.employeeNo}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/employees/${encodeURIComponent(person.employeeNo)}`}>
                        <bdi dir="ltr">{person.employeeNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{name(person)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{person.positionTitle ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{person.branchCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(person.hireDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${personTone(person.status)} ${s.sapRegisterStatus}`} data-status={personTone(person.status)}>
                        {e(`status_${person.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <RecordHistory objectId={row.code} objectType={departmentService.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
