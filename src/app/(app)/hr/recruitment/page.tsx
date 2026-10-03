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
import { businessToday } from '@/server/domain/business-date';
import { EMPLOYMENT_KINDS } from '@/server/domain/hr';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as recruitment from '@/server/services/recruitment';
import { createVacancy } from './actions';

/**
 * Recruitment — REQ-HR-001 Stage HR-5. Copies the Purchase Invoices list:
 * the register of vacancies, the New dialog, the View filter, paging. Open
 * vacancies come first; each opens to its applicants.
 */
export const dynamic = 'force-dynamic';

const VACANCY_TONE: Readonly<Record<string, string>> = { draft: 'draft', open: 'open', filled: 'posted', closed: 'closed', cancelled: 'cancelled' };

export default async function RecruitmentPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/recruitment')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.recruitment'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', recruitment.PERMISSION_OBJECT)) return <Denied object={page('recruitment')} />;
  const mayCreate = can(principal, 'create', recruitment.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const { result, positions, departmentRows } = await withCurrentUser(async (tx) => ({
    result: await recruitment.listForScreen(tx, { view: viewParam || null, search: outcome.q, page: outcome.page }),
    positions: mayCreate ? await recruitment.positionsOpen(tx) : [],
    departmentRows: mayCreate ? await departments.listAll(tx) : [],
  }));
  // The document statuses read as the invoices' do; "open" and "filled" are the vacancy's own.
  const statusLabel = (value: string) => (value === 'open' || value === 'filled' ? x(`status_${value}`) : statusOf(value));
  const title = (row: { titleEn: string; titleAr: string | null }) => (locale === 'ar' && row.titleAr ? row.titleAr : row.titleEn);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const query = (p: number) => new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), page: String(p) }).toString();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
            <Form action={createVacancy}>
              <Grid>
                <Select label={x('position')} name="position_code" options={positions.map((p) => ({ value: p.code, label: `${p.code} · ${title(p)}` }))} required />
                <Select
                  emptyLabel={x('department_of_position')}
                  label={x('department')}
                  name="department_code"
                  options={departmentRows.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                />
                <Field defaultValue="1" label={x('headcount')} max={500} min={1} name="headcount" required type="number" />
                <Select defaultValue="permanent" label={x('employment_kind')} name="employment_kind" options={EMPLOYMENT_KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))} required />
                <Field defaultValue={businessToday()} label={x('opens_on')} name="opens_on" required type="date" />
                <Field label={x('closes_on')} name="closes_on" type="date" />
                <Field hint={x('description_hint')} label={x('description')} name="description" required type="textarea" wide />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/recruitment" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="vacancies-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="vacancies-list-title">
            <span>{x('vacancies')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/recruitment"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={['open', 'draft', 'filled', 'closed', 'cancelled'].map((value) => ({ value, label: statusLabel(value) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="vacancies-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('position')}</th>
                  <th scope="col">{x('department')}</th>
                  <th scope="col">{x('employment_kind')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('hired_of')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('applicants')}
                  </th>
                  <th scope="col">{x('opens_on')}</th>
                  <th scope="col">{x('closes_on')}</th>
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
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/recruitment/${encodeURIComponent(row.vacancyNo)}`}>
                        <bdi dir="ltr">{row.vacancyNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{title(row)}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.positionCode}</bdi>
                      </span>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.departmentCode}</bdi>
                    </td>
                    <td>{x(`kind_${row.employmentKind}`)}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${row.hired} / ${row.headcount}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${row.inPipeline} / ${row.applicants}`}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.opensOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.closesOn)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${VACANCY_TONE[row.status] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={VACANCY_TONE[row.status] ?? 'draft'}>
                        {statusLabel(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            count={result.pages}
            current={result.page}
            hrefFor={(p) => `/hr/recruitment?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
