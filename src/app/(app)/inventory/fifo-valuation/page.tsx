import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as reports from '@/server/services/inventory-reports';

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

  const itemCode = typeof params.item === 'string' ? params.item.trim() : '';
  const warehouseCode = typeof params.warehouse === 'string' ? params.warehouse.trim() : '';

  const rows = await withCurrentUser((tx) =>
    reports.valuation(tx, context.principal, {
      allPermittedBranches: true,
      ...(itemCode ? { itemCode } : {}),
      ...(warehouseCode ? { warehouseCode } : {}),
    }),
  );

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // The layers carry quantities at six decimal places. A warehouse list reads
  // in whole units where the stock is whole, so trailing zeros are dropped
  // rather than printed.
  const units = (quantity: string) => String(Number(quantity));

  const total = rows.reduce((sum, row) => sum + Number(row.valueIqd), 0);

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('reports.as_it_stands')}
      tabs={<SectionTabs route="/inventory/fifo-valuation" />}
      title={t('reports.warehouses_report')}
      variant="sap"
    >
      <form className="list__toolbar" method="get">
        <input
          className="list__search"
          type="search"
          name="item"
          defaultValue={itemCode}
          placeholder={column('item_code')}
          aria-label={column('item_code')}
        />
        <input
          className="list__search"
          type="search"
          name="warehouse"
          defaultValue={warehouseCode}
          placeholder={column('warehouse_code')}
          aria-label={column('warehouse_code')}
        />
        <button className="action" type="submit">
          {list('search')}
        </button>
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
            <th className={s.sapNum} scope="col">
              {column('total_price')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={s.sapEmptyRow} colSpan={6}>
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
              <td colSpan={5}>{t('reports.totals')}</td>
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
