import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as counts from '@/server/services/stock-count';
import { planCount } from './actions';

/**
 * Stock Count — §9.6, IMPROVEMENT-002: the register of counts on the existing
 * engine (`services/stock-count.ts`), drawn as every register is (the
 * Purchase Invoices list): the Inventory tabs, one window, the search box,
 * the status and warehouse filters, fifty rows a page with the true count.
 * A count is planned from the header; everything after that happens on its
 * own page.
 */
export const dynamic = 'force-dynamic';

const STATUSES = ['planned', 'counted', 'recount', 'pending_approval', 'adjusted', 'cancelled'] as const;
const SCOPES = ['full', 'warehouse', 'item', 'category'] as const;

export default async function StockCountPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/stock-count')) notFound();

  const [t, admin, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin.stock_count'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', counts.PERMISSION_OBJECT)) {
    return <Denied object={page('stock_count')} />;
  }
  const mayPlan = can(principal, 'create', counts.PERMISSION_OBJECT);

  const params = await searchParams;
  const statusParam = typeof params.status === 'string' && (STATUSES as readonly string[]).includes(params.status) ? params.status : null;
  const warehouseCode = typeof params.warehouse === 'string' && params.warehouse ? params.warehouse : null;

  const { result, warehouses } = await withCurrentUser(async (tx) => ({
    result: await counts.listForScreen(tx, principal, { search: outcome.q, status: statusParam, warehouseCode, page: outcome.page }),
    warehouses: await counts.warehousesFor(tx, principal),
  }));
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', statusParam ? `status=${statusParam}` : '', warehouseCode ? `warehouse=${encodeURIComponent(warehouseCode)}` : '', `page=${p}`]
      .filter(Boolean)
      .join('&');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const warehouseOptions = warehouses.map((warehouse) => ({ value: warehouse.code, label: `${warehouse.code} · ${warehouse.name}` }));

  return (
    <AdminPage
      actions={
        mayPlan ? (
          <NewRecordDialog buttonLabel={t('new')} closeLabel={admin('close')} openOnLoad={Boolean(outcome.error) && params.plan === '1'} title={t('new')}>
            <p className="muted">{t('new_note')}</p>
            <Form action={planCount}>
              <Grid>
                <Select emptyLabel="" label={column('warehouse')} name="warehouse_code" options={warehouseOptions} required />
                <Field defaultValue={businessToday()} label={t('planned_on')} name="planned_on" required requiredLabel={admin('required_hint')} type="date" />
                <Select defaultValue="warehouse" label={t('scope')} name="scope" options={SCOPES.map((scope) => ({ value: scope, label: t(`scope_${scope}`) }))} required />
                <Field hint={t('scope_filter_hint')} label={t('scope_filter')} name="scope_filter" />
              </Grid>
              <SubmitRow>
                <Submit label={t('plan')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/stock-count" />}
      subtitle={t('subtitle')}
      title={page('stock_count')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="stock-count-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="stock-count-title">
            <span>{page('stock_count')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/inventory/stock-count"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={statusParam ?? ''} emptyLabel={t('all_statuses')} label={column('status')} name="status" options={STATUSES.map((code) => ({ value: code, label: t(`status.${code}`) }))} />
              <Select defaultValue={warehouseCode ?? ''} emptyLabel={t('all_warehouses')} label={column('warehouse')} name="warehouse" options={warehouseOptions} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="stock-count-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{column('warehouse')}</th>
                  <th scope="col">{t('scope')}</th>
                  <th scope="col">{t('planned_on')}</th>
                  <th scope="col">{t('counted_on')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('lines')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('variances')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/inventory/stock-count/${encodeURIComponent(row.countNo)}`}>
                        <bdi dir="ltr">{row.countNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{`${row.warehouseCode} · ${row.warehouseName}`}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{`${t(`scope_${row.scope}`)}${row.scopeFilter ? ` · ${row.scopeFilter}` : ''}`}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.plannedOn)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.countedOn)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.lines}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.variances}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {t(`status.${row.status}`)}
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
              hrefFor={(p) => `/inventory/stock-count?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
