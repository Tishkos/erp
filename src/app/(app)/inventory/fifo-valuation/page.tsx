import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  FilterRow,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { IntegrityBanner } from '@/components/admin/integrity-banner';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as reports from '@/server/services/inventory-reports';
import * as warehouses from '@/server/services/warehouses';

/**
 * The Warehouses Report — Operations build, block 7.
 *
 *   Item Name; Item Code; Warehouse Name; Warehouse Code; Quantity; Total
 *   Price.
 *
 * Six columns, and the sponsor names them in that order, so that is the order
 * they are in.
 *
 * The figures are the FIFO cost layers summed, which is the same thing the
 * valuation the ledger carries is made of — not a stored total that could have
 * drifted from the movements underneath it. A row exists only while stock does:
 * an item counted down to nothing leaves the report rather than sitting at
 * zero, because a warehouse list is a list of what is there.
 */
export const dynamic = 'force-dynamic';

export default async function WarehousesReportPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/fifo-valuation')) notFound();

  const [t, page, column, list, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', reports.PERMISSION_OBJECT)) {
    return <Denied object={page('fifo_valuation')} />;
  }

  const itemSearch = typeof params.item === 'string' ? params.item.trim() : '';
  const warehouseCode = typeof params.warehouse === 'string' ? params.warehouse.trim() : '';

  const { rows, pickers } = await withCurrentUser(async (tx) => ({
    rows: await reports.valuation(tx, context.principal, {
      allPermittedBranches: true,
      ...(itemSearch ? { itemSearch } : {}),
      ...(warehouseCode ? { warehouseCode } : {}),
    }),
    pickers: {
      // The warehouses stay a picker: a short, known list a person chooses from.
      //
      // The items are searched, not chosen — but a box with no suggestions
      // leaves somebody guessing at spelling, so the names are offered in a
      // `datalist`. It suggests rather than constrains: a partial term is still
      // a valid search, and the matching is done in SQL by the trigram indexes
      // either way. Names only, so the list is the text a person is typing.
      stockItems: (await items.listAll(tx)).filter((row) => row.isStock),
      houses: await warehouses.listActive(tx),
    },
  }));

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // The layers carry quantities at six decimal places. A warehouse list reads
  // in whole units where the stock is whole, so trailing zeros are dropped
  // rather than printed.
  const units = (quantity: string) => String(Number(quantity));

  const total = rows.reduce((sum, row) => sum + Number(row.valueIqd), 0);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="warehouses_report" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      // Two figures side by side, one in units and one in dinars, and the
      // second was read as the first on 2026-09-27 — 250,350 IQD of stock at
      // cost taken for 250,350 units. The subtitle says which is which.
      subtitle={`${t('reports.as_it_stands')} — ${t('reports.units_and_value')}`}
      tabs={<SectionTabs route="/inventory/fifo-valuation" />}
      title={t('reports.warehouses_report')}
      variant="sap"
    >
      <IntegrityBanner />
      {/* The report's own filters, on one line with their button.

          The item is typed rather than chosen. A drop-down of every stock item
          asked a person holding a name to read past the code to find it, and it
          grew with the catalogue. What is typed is matched against the name and
          the code, anywhere in either, and served by the trigram indexes in
          migration 0212 — so it stays fast as the catalogue grows rather than
          scanning the item table each time. The warehouse stays a picker: it is
          a short list that a person chooses from, not one they search. */}
      <form method="get">
        <FilterRow>
          <Field
            defaultValue={itemSearch}
            label={column('item_name')}
            list="warehouses-report-items"
            name="item"
            placeholder={t('reports.search_item_hint')}
          />
          <datalist id="warehouses-report-items">
            {pickers.stockItems.map((row) => (
              <option key={row.code} value={row.name} />
            ))}
          </datalist>
          <Select
            defaultValue={warehouseCode}
            emptyLabel={t('reports.all_warehouses')}
            label={column('warehouse_name')}
            name="warehouse"
            options={pickers.houses.map((row) => ({
              value: row.code,
              label: `${row.name} · ${row.code}`,
            }))}
          />
          <SubmitRow>
            <Submit label={list('search')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <table className={`${s.sapTable} ${s.sapReportTable}`}>
        <thead>
          <tr>
            <th scope="col">{column('item_name')}</th>
            <th scope="col">{column('item_code')}</th>
            <th scope="col">{column('warehouse_name')}</th>
            <th scope="col">{column('warehouse_code')}</th>
            <th className={s.sapNum} scope="col">
              {column('quantity')}
            </th>
            {/* The sponsor's six columns, and two the 2026-09-27 reading
                asked for: the unit the quantity is counted in, and what one
                of those units cost — so quantity × cost = value can be seen
                on the row rather than the third figure taken for one of the
                other two. */}
            <th scope="col">{column('unit')}</th>
            <th className={s.sapNum} scope="col">
              {column('average_unit_cost')}
            </th>
            <th className={s.sapNum} scope="col">
              {column('total_price')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={s.sapEmptyRow} colSpan={8}>
                {t('reports.nothing_in_stock')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={`${row.itemCode}:${row.warehouseCode}:${row.branchCode}`}>
                <td>
                  <bdi dir="auto">{row.itemName}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.itemCode}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{row.warehouseName}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.warehouseCode}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{units(row.quantity)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.uomCode}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.averageUnitCostIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.valueIqd)}</bdi>
                </td>
              </tr>
            ))
          )}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td colSpan={7}>{t('reports.totals')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(String(total))}</bdi>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </AdminPage>
  );
}
