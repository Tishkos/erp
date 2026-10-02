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
import * as employees from '@/server/services/employees';
import * as hrSettings from '@/server/services/hr-settings';
import * as structure from '@/server/services/hr-structure';
import { setPositionActive, updatePosition } from '../actions';

/**
 * One position — REQ-FIX-001 FIX-5. Copies the Purchase Invoice page: the
 * document window, its lines the people who hold the seat; the seats that
 * report to it stacked under it; then the audit log.
 */
export const dynamic = 'force-dynamic';

export default async function PositionPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/hr/positions')) notFound();
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
    return <Denied object={page('hr_positions')} />;
  }
  const mayEdit = can(principal, 'configure', hrSettings.PERMISSION_OBJECT);

  const found = await withCurrentUser(async (tx) => {
    const detail = await structure.positionByCode(tx, code);
    if (!detail) return null;
    return {
      detail,
      departmentRows: mayEdit ? await structure.departments(tx) : [],
      seats: mayEdit ? await structure.positions(tx) : [],
    };
  });
  if (!found) notFound();
  const { row, holders, reports } = found.detail;
  const tone = row.active ? 'approved' : 'closed';
  const personTone = (value: string) => (value === 'active' ? 'approved' : value === 'suspended' ? 'submitted' : 'closed');
  const title = (seat: { titleEn: string; titleAr: string | null }) => (locale === 'ar' && seat.titleAr ? seat.titleAr : seat.titleEn);
  const name = (person: { fullNameEn: string; fullNameAr: string | null }) => (locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn);

  const fields: DocumentField[] = [
    { label: column('code'), value: <bdi dir="ltr">{row.code}</bdi> },
    { label: column('status'), value: row.active ? t('active') : t('inactive'), status: tone },
    { label: x('title_en'), value: <bdi dir="auto">{row.titleEn}</bdi> },
    { label: x('title_ar'), value: <bdi dir="auto">{row.titleAr ?? '—'}</bdi> },
    {
      label: x('department'),
      value: (
        <Link className={s.sapLink} href={`/hr/departments/${encodeURIComponent(row.departmentCode)}`}>
          <bdi dir="auto">{`${row.departmentCode} · ${row.departmentName}`}</bdi>
        </Link>
      ),
    },
    {
      label: x('reports_to'),
      value: row.reportsToCode ? (
        <Link className={s.sapLink} href={`/hr/positions/${encodeURIComponent(row.reportsToCode)}`}>
          <bdi dir="auto">{`${row.reportsToCode} · ${row.reportsToTitle ?? ''}`}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    { label: x('holders'), value: row.holders },
  ];

  return (
    <AdminPage back={{ href: '/hr/positions', label: t('back') }} title={`${row.code} · ${title(row)}`} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <NewRecordDialog buttonLabel={x('edit')} closeLabel={t('close')} title={x('edit')}>
                <Form action={updatePosition}>
                  <input name="code" type="hidden" value={row.code} />
                  <Grid>
                    <Field defaultValue={row.titleEn} label={x('title_en')} name="title_en" required requiredLabel={t('required_hint')} />
                    <Field defaultValue={row.titleAr ?? ''} label={x('title_ar')} name="title_ar" />
                    <Select
                      defaultValue={row.departmentCode}
                      label={x('department')}
                      name="department_code"
                      options={found.departmentRows.filter((d) => d.active || d.code === row.departmentCode).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                      required
                    />
                    <Select
                      defaultValue={row.reportsToCode ?? ''}
                      emptyLabel={x('reports_to_none')}
                      label={x('reports_to')}
                      name="reports_to_code"
                      options={found.seats.filter((p) => p.code !== row.code && (p.active || p.code === row.reportsToCode)).map((p) => ({ value: p.code, label: `${p.code} · ${p.titleEn}` }))}
                    />
                  </Grid>
                  <SubmitRow>
                    <Submit label={x('save')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
            {mayEdit && row.active ? (
              <form action={setPositionActive}>
                <input name="code" type="hidden" value={row.code} />
                <input aria-label={t('reason')} name="reason" placeholder={t('reason_placeholder')} required type="text" />
                <Submit label={t('deactivate')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayEdit && !row.active ? (
              <form action={setPositionActive}>
                <input name="code" type="hidden" value={row.code} />
                <input name="active" type="hidden" value="1" />
                <Submit label={t('reactivate')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={x('position_document')}
        fields={fields}
        id="position-document"
        linesCount={holders.length}
        linesTitle={x('holders_title')}
        number={row.code}
      >
        <table aria-labelledby="position-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('reference')}</th>
              <th scope="col">{column('name')}</th>
              <th scope="col">{column('branch')}</th>
              <th scope="col">{e('hire_date')}</th>
              <th scope="col">{column('status')}</th>
            </tr>
          </thead>
          <tbody>
            {holders.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={5}>
                  {x('vacant_seat')}
                </td>
              </tr>
            ) : null}
            {holders.map((person) => (
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
      </DocumentWindow>

      <section aria-labelledby="position-reports-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="position-reports-title">
            <span>{x('reports_title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: reports.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="position-reports-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{x('position')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {reports.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={3}>
                      {x('reports_none')}
                    </td>
                  </tr>
                ) : null}
                {reports.map((seat) => (
                  <tr key={seat.code}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/positions/${encodeURIComponent(seat.code)}`}>
                        <bdi dir="ltr">{seat.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{title(seat)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${seat.active ? 'approved' : 'closed'} ${s.sapRegisterStatus}`} data-status={seat.active ? 'approved' : 'closed'}>
                        {seat.active ? t('active') : t('inactive')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <RecordHistory objectId={row.code} objectType="position" />
    </AdminPage>
  );
}
