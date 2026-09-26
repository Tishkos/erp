import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, admin as s } from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as stock from '@/server/services/stock-operations';
import * as warehouses from '@/server/services/warehouses';

/**
 * Stock Movement — Operations build, block 7.
 *
 *   Purchases are recorded as stock In. Sales are recorded as stock Out.
 *   Warehouse transfers move stock Out from one warehouse and In to another.
 *   Reconciliation adjusts stock as In or Out.
 *
 * Every movement, read from the movements themselves, with the document that
 * made it. The Warehouses Report is these rows summed, so the two cannot
 * disagree.
 */
export const dynamic = 'force-dynamic';

export default async function StockMovementsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/stock-movements')) notFound();

  const [t, page, column, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', stock.MOVEMENT_OBJECT)) {
    return <Denied object={page('stock_movements')} />;
  }

  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const filter = {
    from: one('from') || null,
    to: one('to') || null,
    itemCode: one('item') || null,
    warehouseCode: one('warehouse') || null,
  };

  const { rows, itemList, houses } = await withCurrentUser(async (tx, request) => ({
    rows: await stock.movements(
      tx,
      { principal: request.principal, branchCode: request.scope.branchCode },
      filter,
    ),
    itemList: (await items.listAll(tx)).filter((row) => row.isStock),
    houses: (await warehouses.listActive(tx)).filter(
      (house) => house.branchCode === context.scope.branchCode,
    ),
  }));

  return (
    <AdminPage
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/stock-movements" />}
      subtitle={t('stock_movements.subtitle')}
      title={page('stock_movements')}
      variant="sap"
    >
      <Panel flush>
        <form className={s.toolbar} method="get">
          <label>
            {t('stock_movements.from')}{' '}
            <input defaultValue={filter.from ?? ''} name="from" type="date" />
          </label>
          <label>
            {t('stock_movements.to')}{' '}
            <input defaultValue={filter.to ?? ''} name="to" type="date" />
          </label>
          <select aria-label={column('item_code')} defaultValue={filter.itemCode ?? ''} name="item">
            <option value="">{t('stock_movements.all_items')}</option>
            {itemList.map((row) => (
              <option key={row.code} value={row.code}>
                {`${row.code} · ${row.name}`}
              </option>
            ))}
          </select>
          <select
            aria-label={column('warehouse')}
            defaultValue={filter.warehouseCode ?? ''}
            name="warehouse"
          >
            <option value="">{t('stock_movements.all_warehouses')}</option>
            {houses.map((house) => (
              <option key={house.code} value={house.code}>
                {`${house.code} · ${house.name}`}
              </option>
            ))}
          </select>
          <button className="action" type="submit">
            {t('stock_movements.filter')}
          </button>
        </form>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('date')}</th>
                <th scope="col">{column('item_code')}</th>
                <th scope="col">{column('item_name')}</th>
                <th scope="col">{column('warehouse_code')}</th>
                <th scope="col">{column('warehouse_name')}</th>
                <th scope="col">{column('movement')}</th>
                <th scope="col">{column('stock_in')}</th>
                <th scope="col">{column('stock_out')}</th>
                <th scope="col">{column('document')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9}>{t('stock_movements.none')}</td>
                </tr>
              ) : null}
              {rows.map((row) => {
                const quantity = formatQuantity(parseQuantity(row.quantity));
                return (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="ltr">{row.movementDate}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.itemCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.itemName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.warehouseCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.warehouseName}</bdi>
                    </td>
                    <td>{t(`stock_movements.type.${row.type}`)}</td>
                    <td>
                      <bdi dir="ltr">{row.direction === 'in' ? quantity : ''}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.direction === 'out' ? quantity : ''}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.documentNo ?? ''}</bdi>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </AdminPage>
  );
}
