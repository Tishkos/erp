import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import {
  AdminPage,
  Field,
  FilterRow,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
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
      actions={<ExportMenu exportKey="stock_movement" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/stock-movements" />}
      subtitle={t('stock_movements.subtitle')}
      title={page('stock_movements')}
      variant="sap"
    >
      <Panel flush>
        {/* The screen's own filters in the application's fields rather than
            four bare boxes: the date controls then carry the app's calendar
            button, which is what a person is looking for on this screen. */}
        <form className={s.filterBar} method="get">
          <FilterRow>
            <Field
              defaultValue={filter.from ?? ''}
              label={t('stock_movements.from')}
              name="from"
              type="date"
            />
            <Field
              defaultValue={filter.to ?? ''}
              label={t('stock_movements.to')}
              name="to"
              type="date"
            />
            <Select
              defaultValue={filter.itemCode ?? ''}
              emptyLabel={t('stock_movements.all_items')}
              label={column('item_name')}
              name="item"
              options={itemList.map((row) => ({
                value: row.code,
                label: `${row.name} · ${row.code}`,
              }))}
            />
            <Select
              defaultValue={filter.warehouseCode ?? ''}
              emptyLabel={t('stock_movements.all_warehouses')}
              label={column('warehouse')}
              name="warehouse"
              options={houses.map((house) => ({
                value: house.code,
                label: `${house.name} · ${house.code}`,
              }))}
            />
            <SubmitRow>
              <Submit label={t('stock_movements.filter')} />
            </SubmitRow>
          </FilterRow>
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
