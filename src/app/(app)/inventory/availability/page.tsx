import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as availability from '@/server/services/availability';
import { issueStock } from './actions';

/**
 * Availability — Appendix A menu 5, on Phase 04's §9.5 buckets.
 *
 * REQ-FIX-001 FIX-2: drawn as every register is (the Purchase Invoices list):
 * the Inventory tabs, one register window, the search box and the warehouse
 * filter, the buckets in number columns, fifty rows a page with the true
 * count. Issuing stock — Phase 04.4's UI gate, *"an issue exceeding
 * available stock is rejected via the UI"* — is a dialog in the header, and
 * the refusal comes back on the page in the service's own words.
 */
export const dynamic = 'force-dynamic';

export default async function AvailabilityPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/availability')) notFound();

  const [t, admin, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin.availability'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', availability.PERMISSION_OBJECT)) {
    return <Denied object={page('availability')} />;
  }
  // Issuing is `execute` on the movement, as `inventory.issue` checks it.
  const mayIssue = can(principal, 'execute', availability.PERMISSION_OBJECT);

  const params = await searchParams;
  const warehouseCode = typeof params.warehouse === 'string' && params.warehouse ? params.warehouse : null;
  const inStock = params.in_stock === '1';

  const { result, warehouses, items } = await withCurrentUser(async (tx) => ({
    result: await availability.forScreen(tx, principal, { search: outcome.q, warehouseCode, inStock, page: outcome.page }),
    warehouses: await availability.warehouses(tx, principal),
    items: mayIssue ? await availability.issuableItems(tx, principal) : [],
  }));
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', warehouseCode ? `warehouse=${encodeURIComponent(warehouseCode)}` : '', inStock ? 'in_stock=1' : '', `page=${p}`].filter(Boolean).join('&');
  const qty = (value: string) => formatQuantity(parseQuantity(value));
  const warehouseOptions = warehouses.map((warehouse) => ({ value: warehouse.code, label: `${warehouse.code} · ${warehouse.name}` }));

  return (
    <AdminPage
      actions={
        mayIssue ? (
          <NewRecordDialog buttonLabel={t('issue_stock')} closeLabel={admin('close')} openOnLoad={params.issue === '1' && Boolean(outcome.error)} title={t('issue_stock')}>
            <p className="muted">{t('issue_note')}</p>
            <Form action={issueStock}>
              <Grid>
                <Select label={column('item_code')} name="item_code" options={items.map((item) => ({ value: item.code, label: `${item.code} · ${item.name}` }))} required />
                <Select defaultValue={warehouseCode} label={column('warehouse_code')} name="warehouse_code" options={warehouseOptions} required />
                <Field label={column('batch_number')} name="batch_number" />
                <Field label={column('quantity')} name="quantity" required />
              </Grid>
              <SubmitRow>
                <Submit label={t('issue')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/availability" />}
      subtitle={t('subtitle')}
      title={page('availability')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="availability-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="availability-title">
            <span>{page('availability')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/inventory/availability"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={warehouseCode ?? ''} emptyLabel={t('all_warehouses')} label={column('warehouse')} name="warehouse" options={warehouseOptions} />
              <Checkbox defaultChecked={inStock} label={t('in_stock')} name="in_stock" />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="availability-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('item_code')}</th>
                  <th scope="col">{column('item_name')}</th>
                  <th scope="col">{column('warehouse')}</th>
                  <th scope="col">{column('branch_code')}</th>
                  {(['on_hand', 'available', 'reserved', 'in_transit', 'in_quarantine', 'damaged', 'returns_stock'] as const).map((key) => (
                    <th className={s.sapNum} key={key} scope="col">
                      {column(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={11}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={`${row.itemCode}:${row.warehouseCode}`}>
                    <td>
                      <bdi dir="ltr">{row.itemCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.itemName}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{`${row.warehouseCode} · ${row.warehouseName}`}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${qty(row.onHand)} ${row.baseUomCode}`}</bdi>
                    </td>
                    {[row.available, row.reserved, row.inTransit, row.inQuarantine, row.damaged, row.returnsStock].map((value, index) => (
                      <td className={s.sapNum} key={index}>
                        <bdi dir="ltr">{qty(value)}</bdi>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/inventory/availability?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
