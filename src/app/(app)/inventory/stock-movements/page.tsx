import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
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
import { documentHref } from '@/components/admin/document-link';
import { IntegrityBanner } from '@/components/admin/integrity-banner';
import { SectionTabs } from '@/components/admin/section-tabs';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { can } from '@domain/permissions';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { formatTimestamp, type Locale } from '@/i18n/config';
import { visibleRoute } from '@/server/delivered';
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

  const [t, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
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
    itemSearch: one('item') || null,
    warehouseCode: one('warehouse') || null,
    documentNo: one('document') || null,
  };
  // A page at a time, and the page says so. The list used to stop at a
  // thousand rows without a word, which at real volume is a ledger with its
  // oldest months missing.
  const PAGE_SIZE = 200;
  const pageNo = Math.max(1, Number.parseInt(one('page') || '1', 10) || 1);

  const { rows, total, itemList, houses } = await withCurrentUser(async (tx, request) => {
    const actor = { principal: request.principal, branchCode: request.scope.branchCode };
    return {
      rows: await stock.movements(tx, actor, {
        ...filter,
        limit: PAGE_SIZE,
        offset: (pageNo - 1) * PAGE_SIZE,
      }),
      total: await stock.countMovements(tx, actor, filter),
      itemList: (await items.listAll(tx)).filter((row) => row.isStock),
      houses: (await warehouses.listActive(tx)).filter(
        (house) => house.branchCode === context.scope.branchCode,
      ),
    };
  });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : (pageNo - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, pageNo * PAGE_SIZE);
  const pageHref = (n: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({
      from: filter.from,
      to: filter.to,
      item: filter.itemSearch,
      warehouse: filter.warehouseCode,
      document: filter.documentNo,
    })) {
      if (value) query.set(key, value);
    }
    if (n > 1) query.set('page', String(n));
    const text = query.toString();
    return `/inventory/stock-movements${text ? `?${text}` : ''}`;
  };

  return (
    <AdminPage
      actions={<ExportMenu exportKey="stock_movement" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/stock-movements" />}
      subtitle={t('stock_movements.subtitle')}
      title={page('stock_movements')}
      variant="sap"
    >
      <IntegrityBanner />
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
            {/* Typed, not chosen. The catalogue will run to thousands and
                nobody picks an item out of a list that long; what is typed is
                matched against the name and the code in SQL, by the trigram
                indexes from migration 0212. The names are offered as
                suggestions so a person need not know the spelling. */}
            <Field
              defaultValue={filter.itemSearch ?? ''}
              label={column('item_name')}
              list="stock-movements-items"
              name="item"
              placeholder={t('reports.search_item_hint')}
            />
            <datalist id="stock-movements-items">
              {itemList.map((row) => (
                <option key={row.code} value={row.name} />
              ))}
            </datalist>
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
            {/* The document behind the movement — the number a person is
                holding when they ask "where did this go?". */}
            <Field
              defaultValue={filter.documentNo ?? ''}
              label={column('document')}
              name="document"
              placeholder={t('stock_movements.document_hint')}
            />
            <SubmitRow>
              <Submit label={t('stock_movements.filter')} />
            </SubmitRow>
          </FilterRow>
        </form>
        <p className="muted" style={{ padding: '0 1rem' }}>
          {t('stock_movements.showing', { first, last, total })}
          {pages > 1 ? (
            <>
              {' · '}
              {pageNo > 1 ? <Link href={pageHref(pageNo - 1)}>{t('stock_movements.newer')}</Link> : null}
              {pageNo > 1 && pageNo < pages ? ' · ' : null}
              {pageNo < pages ? <Link href={pageHref(pageNo + 1)}>{t('stock_movements.older')}</Link> : null}
            </>
          ) : null}
        </p>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('date')}</th>
                <th scope="col">{column('item_code')}</th>
                <th scope="col">{column('item_name')}</th>
                <th scope="col">{column('entered_at')}</th>
                <th scope="col">{column('warehouse_code')}</th>
                <th scope="col">{column('warehouse_name')}</th>
                <th scope="col">{column('from_warehouse_name')}</th>
                <th scope="col">{column('to_warehouse_name')}</th>
                <th scope="col">{column('movement')}</th>
                <th scope="col">{column('stock_in')}</th>
                <th scope="col">{column('stock_out')}</th>
                <th scope="col">{column('unit')}</th>
                <th scope="col">{column('document')}</th>
                <th scope="col">{column('raised_by')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={14}>{t('stock_movements.none')}</td>
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
                      {/* When it was entered, so two movements on one date read in
                        the order they happened. */}
                    <td>
                      <bdi dir="ltr">{row.createdAt ? formatTimestamp(row.createdAt, locale as Locale) : '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.warehouseCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.warehouseName}</bdi>
                    </td>
                    {/* Both ends of a transfer; a dash where the other side is a
                        document rather than a warehouse. */}
                    <td>
                      <bdi dir="auto">{row.fromWarehouseName ?? row.fromWarehouseCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.toWarehouseName ?? row.toWarehouseCode ?? '—'}</bdi>
                    </td>
                    <td>{t(`stock_movements.type.${row.type}`)}</td>
                    <td>
                      <bdi dir="ltr">{row.direction === 'in' ? quantity : ''}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.direction === 'out' ? quantity : ''}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.uomCode}</bdi>
                    </td>
                    <td>
                      {(() => {
                        const href = documentHref(row.documentType, row.documentNo);
                        return href ? (
                          <Link href={href}>
                            <bdi dir="ltr">{row.documentNo}</bdi>
                          </Link>
                        ) : (
                          <bdi dir="ltr">{row.documentNo ?? ''}</bdi>
                        );
                      })()}
                    </td>
                    <td>
                      <bdi dir="auto">{row.raisedBy ?? '—'}</bdi>
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
