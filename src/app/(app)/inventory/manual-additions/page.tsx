import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as additions from '@/server/services/manual-stock-addition';
import { DatesHidden, RegisterFilter } from '@/components/admin/register-filter';
import { registerDatesOf, registerDatesParams, registerDatesQuery } from '@/server/domain/register-dates';

/**
 * Manual Stock Additions — the register ("view manually added items", by
 * direction 2026-10-06). Copies the Purchase Invoices list: the search, the
 * status and warehouse filters, the register table (number, date, warehouse,
 * lines, value, status, created by), fifty a page with the true count; every
 * number opens its record. "Add items manually" opens the sheet.
 */
export const dynamic = 'force-dynamic';

export default async function ManualAdditionsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/manual-additions')) notFound();
  const [t, admin, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.manual_additions'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', additions.PERMISSION_OBJECT)) {
    return <Denied object={page('manual_stock_additions')} />;
  }
  const mayCreate = can(principal, 'create', additions.PERMISSION_OBJECT);

  const params = await searchParams;
  const statusParam =
    typeof params.status === 'string' && (additions.ADDITION_STATUSES as readonly string[]).includes(params.status) ? params.status : null;
  const warehouseCode = typeof params.warehouse === 'string' && params.warehouse ? params.warehouse : null;

  // The Filter's window of posting dates and the order — newest first unless asked (2026-10-07).
  const dates = registerDatesOf(params);
  const { result, houses } = await withCurrentUser(async (tx) => ({
    result: await additions.listForScreen(tx, principal, { search: outcome.q, status: statusParam, warehouseCode, page: outcome.page, dates }),
    houses: await additions.warehousesFor(tx, context.scope.branchCode),
  }));
  const query = (p: number) =>
    [
      outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '',
      statusParam ? `status=${statusParam}` : '',
      warehouseCode ? `warehouse=${encodeURIComponent(warehouseCode)}` : '',
      registerDatesQuery(dates),
      `page=${p}`,
    ]
      .filter(Boolean)
      .join('&');
  const label = (code: string) => (status.has(code) ? status(code) : code);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/inventory/manual-additions/new">
            {t('new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/inventory/manual-additions" />}
      title={page('manual_stock_additions')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="manual-additions-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="manual-additions-title">
            <span>{page('manual_stock_additions')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/inventory/manual-additions"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            hidden={{
              ...(statusParam ? { status: statusParam } : {}),
              ...(warehouseCode ? { warehouse: warehouseCode } : {}),
              ...registerDatesParams(dates),
            }}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          >
            <RegisterFilter
              dates={dates}
              keep={{ q: outcome.q, status: statusParam, warehouse: warehouseCode }}
              path="/inventory/manual-additions"
            />
          </ListToolbar>

          <form className={s.filterBar} method="get">
            <DatesHidden dates={dates} />
            <FilterRow>
              <Select
                defaultValue={statusParam ?? ''}
                emptyLabel={t('all_statuses')}
                label={column('status')}
                name="status"
                options={additions.ADDITION_STATUSES.map((code) => ({ value: code, label: label(code) }))}
              />
              <Select
                defaultValue={warehouseCode ?? ''}
                emptyLabel={t('all_warehouses')}
                label={t('warehouse')}
                name="warehouse"
                options={houses.map((house) => ({ value: house.code, label: `${house.code} · ${house.name}` }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="manual-additions-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{t('posting_date')}</th>
                  <th scope="col">{t('warehouse')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('lines_count')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('total')}
                  </th>
                  <th scope="col">{column('status')}</th>
                  <th scope="col">{t('created_by')}</th>
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
                      <Link className={s.sapLink} href={`/inventory/manual-additions/${encodeURIComponent(row.additionNo)}`}>
                        <bdi dir="ltr">{row.additionNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.postingDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.warehouseCode} kind="warehouse" name={row.warehouseName} />
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.lines}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.totalIqd, 'IQD', locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {label(row.status)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{row.createdByName ?? '—'}</bdi>
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
              hrefFor={(p) => `/inventory/manual-additions?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
