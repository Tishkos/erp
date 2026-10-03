import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Pagination } from '@/components/ui';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { DOCUMENT_TYPES } from '@/server/domain/hr-requests';
import { requireContext, withCurrentUser } from '@/server/session';
import * as documents from '@/server/services/employee-documents';
import * as employees from '@/server/services/employees';
import { createDocument } from './actions';

/**
 * Documents — REQ-HR-001 Stage HR-6. Copies the Purchase Invoices list: the
 * register of the people's papers with their expiry, the New dialog, the
 * Type and View filters (expiring, expired), paging. What expires soonest
 * comes first.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = { valid: 'approved', superseded: 'closed', withdrawn: 'cancelled' };
const EXPIRY_TONE: Readonly<Record<string, string>> = { no_expiry: 'approved', valid: 'approved', expiring: 'submitted', expired: 'rejected' };

export default async function DocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/documents')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_documents'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', documents.PERMISSION_OBJECT)) return <Denied object={page('hr_documents')} />;
  const mayCreate = can(principal, 'create', documents.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const typeParam = typeof params.type === 'string' ? params.type : '';
  const { result, people } = await withCurrentUser(async (tx) => ({
    result: await documents.listForScreen(tx, { view: viewParam || null, docType: typeParam || null, search: outcome.q, page: outcome.page }),
    people: mayCreate ? await employees.managersAvailable(tx) : [],
  }));
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const query = (p: number) =>
    new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), ...(typeParam ? { type: typeParam } : {}), page: String(p) }).toString();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
            <Form action={createDocument}>
              <Grid>
                <Select label={x('employee')} name="employee_id" options={people.map((p) => ({ value: p.id, label: `${p.employeeNo} · ${p.fullNameEn}` }))} required />
                <Select defaultValue="contract" label={x('doc_type')} name="doc_type" options={DOCUMENT_TYPES.map((type) => ({ value: type, label: x(`type_${type}`) }))} required />
                <Field hint={x('title_hint')} label={x('doc_title')} name="title" />
                <Field label={x('reference_no')} name="reference_no" />
                <Field label={x('issued_on')} name="issued_on" type="date" />
                <Field label={x('expires_on')} name="expires_on" type="date" />
                <Field label={x('note')} name="note" wide />
              </Grid>
              <p className={s.sapGridCaption}>{x('scan_caption')}</p>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/documents" />}
      subtitle={x('subtitle', { days: result.warnDays })}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="documents-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="documents-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/documents"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={typeParam} emptyLabel={x('type_all')} label={x('doc_type')} name="type" options={DOCUMENT_TYPES.map((type) => ({ value: type, label: x(`type_${type}`) }))} />
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={['expiring', 'expired', 'valid', 'superseded', 'withdrawn'].map((value) => ({ value, label: x(`view_${value}`) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="documents-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('employee')}</th>
                  <th scope="col">{x('doc_type')}</th>
                  <th scope="col">{x('doc_title')}</th>
                  <th scope="col">{x('reference_no')}</th>
                  <th scope="col">{x('issued_on')}</th>
                  <th scope="col">{x('expires_on')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('files')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => {
                  const tone = row.expiry ? EXPIRY_TONE[row.expiry] : (STATUS_TONE[row.status] ?? 'draft');
                  return (
                    <tr key={row.id}>
                      <td>
                        <Link className={s.sapLink} href={`/hr/documents/${encodeURIComponent(row.documentNo)}`}>
                          <bdi dir="ltr">{row.documentNo}</bdi>
                        </Link>
                      </td>
                      <td>
                        <bdi dir="auto">{locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn}</bdi>{' '}
                        <span className="muted">
                          <bdi dir="ltr">{row.employeeNo}</bdi>
                        </span>
                      </td>
                      <td>{x(`type_${row.docType}`)}</td>
                      <td>
                        <bdi dir="auto">{row.title}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{row.referenceNo ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.issuedOn)}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{day(row.expiresOn)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{row.files}</bdi>
                      </td>
                      <td>
                        <span className={`status status--${tone} ${s.sapRegisterStatus}`} data-status={tone}>
                          {row.expiry ? x(`expiry_${row.expiry}`) : x(`status_${row.status}`)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            count={result.pages}
            current={result.page}
            hrefFor={(p) => `/hr/documents?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
