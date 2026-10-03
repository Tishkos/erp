import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Pagination } from '@/components/ui';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as departments from '@/server/services/departments';
import * as performance from '@/server/services/performance';
import { createReview, startReviews } from './actions';

/**
 * Performance — REQ-HR-001 Stage HR-5. Copies the Purchase Invoices list:
 * the register of reviews, the New dialogs (one person, or a cycle's people
 * at once), the View and Cycle filters, paging. Reviews waiting for a
 * sign-off come first.
 */
export const dynamic = 'force-dynamic';

const REVIEW_TONE: Readonly<Record<string, string>> = { draft: 'draft', rated: 'submitted', signed_off: 'posted', cancelled: 'cancelled' };

export default async function PerformancePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/performance')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.performance'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', performance.PERMISSION_OBJECT)) return <Denied object={page('performance')} />;
  const mayCreate = can(principal, 'create', performance.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const cycleParam = typeof params.cycle === 'string' ? params.cycle : '';
  const { result, cycles, people, reviewers, departmentRows } = await withCurrentUser(async (tx) => ({
    result: await performance.listForScreen(tx, { view: viewParam || null, cycle: cycleParam || null, search: outcome.q, page: outcome.page }),
    cycles: await performance.cycles(tx),
    people: mayCreate ? await performance.reviewable(tx) : [],
    reviewers: mayCreate ? await performance.reviewers(tx) : [],
    departmentRows: mayCreate ? await departments.listAll(tx) : [],
  }));
  const openCycles = cycles.filter((c) => c.status === 'open');
  // The document statuses read as the invoices' do; "rated" and "signed off" are the review's own.
  const statusLabel = (value: string) => (value === 'rated' || value === 'signed_off' ? x(`status_${value}`) : statusOf(value));
  const cycleName = (c: { code: string; nameEn: string; nameAr: string | null }) => `${c.code} · ${locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn}`;
  const query = (p: number) =>
    new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), ...(cycleParam ? { cycle: cycleParam } : {}), page: String(p) }).toString();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <>
            <NewRecordDialog buttonLabel={x('start')} closeLabel={t('close')} title={x('start_title')}>
              <Form action={startReviews}>
                <p className={s.sapGridCaption}>{x('start_caption')}</p>
                <Grid>
                  <Select label={x('cycle')} name="start_cycle_code" options={openCycles.map((c) => ({ value: c.code, label: cycleName(c) }))} required />
                  <Select
                    emptyLabel={x('every_department')}
                    label={x('department')}
                    name="start_department_code"
                    options={departmentRows.filter((d) => d.active).map((d) => ({ value: d.code, label: `${d.code} · ${d.name}` }))}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={x('start')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
            <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
              <Form action={createReview}>
                <Grid>
                  <Select label={x('cycle')} name="cycle_code" options={openCycles.map((c) => ({ value: c.code, label: cycleName(c) }))} required />
                  <Select label={x('employee')} name="employee_id" options={people.map((p) => ({ value: p.id, label: `${p.employeeNo} · ${p.fullNameEn}` }))} required />
                  <Select
                    emptyLabel={x('reviewer_manager')}
                    hint={x('reviewer_hint')}
                    label={x('reviewer')}
                    name="reviewer_user_id"
                    options={reviewers.map((u) => ({ value: u.id, label: `${u.displayName} · ${u.email}` }))}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          </>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/performance" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />
      {mayCreate && openCycles.length === 0 ? <p className={s.sapNote}>{x('no_open_cycle')}</p> : null}
      {typeof params.made === 'string' ? <p className={s.sapNote}>{x('started', { made: Number(params.made) || 0 })}</p> : null}
      {typeof params.skipped === 'string' && params.skipped ? (
        <p className={s.sapNote}>
          {x('started_skipped')} <bdi dir="ltr">{params.skipped.split(',').join(' · ')}</bdi>
        </p>
      ) : null}

      <section aria-labelledby="reviews-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="reviews-list-title">
            <span>{x('reviews')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/performance"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={cycleParam} emptyLabel={x('every_cycle')} label={x('cycle')} name="cycle" options={cycles.map((c) => ({ value: c.code, label: cycleName(c) }))} />
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={['rated', 'draft', 'signed_off', 'cancelled'].map((value) => ({ value, label: statusLabel(value) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="reviews-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('employee')}</th>
                  <th scope="col">{x('cycle')}</th>
                  <th scope="col">{x('reviewer')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('goals')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('weight')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('overall')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/performance/${encodeURIComponent(row.reviewNo)}`}>
                        <bdi dir="ltr">{row.reviewNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.employeeNo}</bdi>
                      </span>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.cycleCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.reviewerName ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.goals}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${row.weight}%`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.overall ?? '—'}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${REVIEW_TONE[row.status] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={REVIEW_TONE[row.status] ?? 'draft'}>
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
            hrefFor={(p) => `/hr/performance?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
