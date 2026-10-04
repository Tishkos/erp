import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as recurring from '@/server/services/recurring-journals';
import { createRecurringAction, raiseDueAction } from './actions';
import { RECURRING_CHIP } from './status';

/**
 * Recurring Journals — REQ-ACC-001 Part D-7.
 *
 * Every template, what it raises and when it is next due, drawn as Purchase
 * Invoices is. A template is written from the dialog, its lines added on its
 * record, agreed by somebody else; "Raise due journals" makes the drafts
 * due up to today, each an ordinary journal entry to submit and approve.
 */
export const dynamic = 'force-dynamic';

export default async function RecurringJournalsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/finance/recurring-journals')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.recurring_journals'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', recurring.PERMISSION_OBJECT)) {
    return <Denied object={page('recurring_journals')} />;
  }
  const mayCreate = can(principal, 'create', recurring.PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (recurring.RECURRING_VIEWS as readonly string[]).includes(String(params.view))
    ? (params.view as recurring.RecurringView)
    : null;
  const today = businessToday();
  const result = await withCurrentUser((tx, request) =>
    recurring.listForScreen(tx, { principal: request.principal, branchCode: request.scope.branchCode }, { view, search: outcome.q, page: outcome.page, asOf: today }),
  );
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', view ? `view=${view}` : '', `page=${p}`].filter(Boolean).join('&');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const every = (row: recurring.RecurringRow) =>
    row.intervalCount === 1 ? t(`frequency_${row.frequency}`) : t('every_n', { n: row.intervalCount, unit: t(`unit_${row.frequency}`) });

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <>
            <form action={raiseDueAction}>
              <input name="template_no" type="hidden" value="" />
              <Submit label={t('raise_all')} tone="secondary" />
            </form>
            <NewRecordDialog
              buttonLabel={t('new')}
              closeLabel={admin('close')}
              openOnLoad={params.template === 'new' && Boolean(outcome.error)}
              title={t('new')}
            >
              <p className="muted">{t('new_note')}</p>
              <Form action={createRecurringAction}>
                <Grid>
                  <Field label={t('name')} name="name" required />
                  <Select
                    label={t('frequency')}
                    name="frequency"
                    options={recurring.RECURRING_FREQUENCIES.map((key) => ({ value: key, label: t(`frequency_${key}`) }))}
                    required
                  />
                  <Field defaultValue="1" hint={t('interval_hint')} label={t('interval')} max={12} min={1} name="interval_count" type="number" />
                  <Field defaultValue={today} label={t('starts_on')} name="starts_on" required type="date" />
                  <Field hint={t('ends_on_hint')} label={t('ends_on')} name="ends_on" type="date" />
                </Grid>
                <Field label={t('description')} name="description" wide />
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          </>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/finance/recurring-journals" />}
      subtitle={t('subtitle')}
      title={page('recurring_journals')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="recurring-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="recurring-list-title">
            <span>{page('recurring_journals')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/finance/recurring-journals"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view ?? ''}
                emptyLabel={t('view_all')}
                label={t('view')}
                name="view"
                options={recurring.RECURRING_VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="recurring-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('name')}</th>
                  <th scope="col">{t('frequency')}</th>
                  <th scope="col">{t('next_due')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('raised')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/finance/recurring-journals/${encodeURIComponent(row.templateNo)}`}>
                        <bdi dir="ltr">{row.templateNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>{every(row)}</td>
                    <td>
                      <bdi dir="ltr">{day(row.nextDueOn)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.totalIqd, 'IQD', locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.runs}</td>
                    <td>
                      <span
                        className={`status status--${RECURRING_CHIP[row.status] ?? 'draft'} ${s.sapRegisterStatus}`}
                        data-status={RECURRING_CHIP[row.status] ?? 'draft'}
                      >
                        {t(`status_${row.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/finance/recurring-journals?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
