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
import { SearchablePicker } from '@/components/admin/searchable-picker';
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
 * The Stock Ledger — one item, warehouse by warehouse: what was there, every
 * movement carried down, and what is there now.
 *
 * Built for the question that was asked on 2026-09-27: *"the screen says X
 * and my arithmetic says Y"*. The Warehouses Report gives the closing figure;
 * the Stock Movement page gives the rows; neither shows the one leading to
 * the other. This does. Every row is a document, and the number opens it.
 *
 * The closing balance here is the same sum the Warehouses Report shows,
 * because it is made of the same rows — the ledger is not a second opinion
 * about the stock, it is the stock shown a line at a time.
 */
export const dynamic = 'force-dynamic';

export default async function StockLedgerPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/stock-ledger')) notFound();

  const [t, page, column, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);

  if (!can(context.principal, 'view', stock.MOVEMENT_OBJECT)) {
    return <Denied object={page('stock_ledger')} />;
  }

  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '');
  const filter = {
    itemCode: one('item') || null,
    warehouseCode: one('warehouse') || null,
    from: one('from') || null,
    to: one('to') || null,
  };

  const { accounts, itemList, houses } = await withCurrentUser(async (tx, request) => ({
    accounts: filter.itemCode
      ? await stock.ledger(
          tx,
          { principal: request.principal, branchCode: request.scope.branchCode },
          { ...filter, itemCode: filter.itemCode },
        )
      : [],
    itemList: (await items.listAll(tx)).filter((row) => row.isStock),
    houses: (await warehouses.listActive(tx)).filter(
      (house) => house.branchCode === context.scope.branchCode,
    ),
  }));

  const chosen = itemList.find((row) => row.code === filter.itemCode);
  const units = (scaled: string) => formatQuantity(parseQuantity(scaled));
  const signed = (scaled: string) => {
    const value = parseQuantity(scaled);
    return `${value > 0n ? '+' : ''}${formatQuantity(value)}`;
  };

  return (
    <AdminPage
      actions={<ExportMenu exportKey="stock_ledger" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={t('stock_ledger.subtitle')}
      tabs={<SectionTabs route="/inventory/stock-ledger" />}
      title={page('stock_ledger')}
      variant="sap"
    >
      <IntegrityBanner />
      <Panel flush>
        <form className={s.filterBar} method="get">
          <FilterRow>
            {/* The item is required: a ledger is of one thing. Typed and
                matched, as everywhere else in this section. */}
            <SearchablePicker
              defaultValue={filter.itemCode ?? ''}
              label={column('item_name')}
              name="item"
              options={itemList.map((row) => ({ value: row.code, label: `${row.name} · ${row.code}` }))}
              required
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
            <Field defaultValue={filter.from ?? ''} label={t('stock_movements.from')} name="from" type="date" />
            <Field defaultValue={filter.to ?? ''} label={t('stock_movements.to')} name="to" type="date" />
            <SubmitRow>
              <Submit label={t('stock_movements.filter')} />
            </SubmitRow>
          </FilterRow>
        </form>

        {!filter.itemCode ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {t('stock_ledger.choose_item')}
          </p>
        ) : accounts.length === 0 ? (
          <p className="muted" style={{ padding: '0 1rem 1rem' }}>
            {t('stock_ledger.none', { item: chosen?.name ?? filter.itemCode })}
          </p>
        ) : (
          accounts.map((account) => (
            <section key={account.warehouseCode} style={{ padding: '0 0 1rem' }}>
              <h3 style={{ padding: '0.5rem 1rem 0' }}>
                <bdi dir="auto">{chosen?.name ?? filter.itemCode}</bdi>
                {' — '}
                <bdi dir="auto">{account.warehouseName}</bdi> <bdi dir="ltr">({account.warehouseCode})</bdi>
              </h3>
              <div className="table-wrap">
                <table className="list">
                  <thead>
                    <tr>
                      <th scope="col">{column('date')}</th>
                      <th scope="col">{column('entered_at')}</th>
                      <th scope="col">{column('movement')}</th>
                      <th scope="col">{column('document')}</th>
                      <th scope="col">{column('from_warehouse_name')}</th>
                      <th scope="col">{column('to_warehouse_name')}</th>
                      <th scope="col">{column('stock_in')}</th>
                      <th scope="col">{column('stock_out')}</th>
                      <th scope="col">{column('running_balance')}</th>
                      <th scope="col">{column('unit')}</th>
                      <th scope="col">{column('raised_by')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* The opening line: what the warehouse held before the
                        first row shown. Zero when the ledger is read from the
                        beginning, which is a real figure and is printed. */}
                    <tr>
                      <td>
                        <bdi dir="ltr">{filter.from ?? '—'}</bdi>
                      </td>
                      <td />
                      <td>
                        <strong>{column('opening_balance')}</strong>
                      </td>
                      <td colSpan={5} />
                      <td>
                        <strong>
                          <bdi dir="ltr">{units(account.opening)}</bdi>
                        </strong>
                      </td>
                      <td>
                        <bdi dir="ltr">{chosen?.baseUomCode ?? account.rows[0]?.uomCode ?? ''}</bdi>
                      </td>
                      <td />
                    </tr>
                    {account.rows.map((row) => {
                      const href = documentHref(row.documentType, row.documentNo);
                      return (
                        <tr key={row.id}>
                          <td>
                            <bdi dir="ltr">{row.movementDate}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">
                              {row.createdAt ? formatTimestamp(row.createdAt, locale as Locale) : '—'}
                            </bdi>
                          </td>
                          <td>{t(`stock_movements.type.${row.type}`)}</td>
                          <td>
                            {href ? (
                              <Link href={href}>
                                <bdi dir="ltr">{row.documentNo}</bdi>
                              </Link>
                            ) : (
                              <bdi dir="ltr">{row.documentNo ?? '—'}</bdi>
                            )}
                          </td>
                          <td>
                            <bdi dir="auto">{row.fromWarehouseName ?? row.fromWarehouseCode ?? '—'}</bdi>
                          </td>
                          <td>
                            <bdi dir="auto">{row.toWarehouseName ?? row.toWarehouseCode ?? '—'}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">{row.direction === 'in' ? signed(row.signedQuantity) : ''}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">{row.direction === 'out' ? signed(row.signedQuantity) : ''}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">{units(row.balance)}</bdi>
                          </td>
                          <td>
                            <bdi dir="ltr">{row.uomCode}</bdi>
                          </td>
                          <td>
                            <bdi dir="auto">{row.raisedBy ?? '—'}</bdi>
                          </td>
                        </tr>
                      );
                    })}
                    <tr>
                      <td>
                        <bdi dir="ltr">{filter.to ?? '—'}</bdi>
                      </td>
                      <td />
                      <td>
                        <strong>{column('closing_balance')}</strong>
                      </td>
                      <td colSpan={5} />
                      <td>
                        <strong>
                          <bdi dir="ltr">{units(account.closing)}</bdi>
                        </strong>
                      </td>
                      <td>
                        <bdi dir="ltr">{chosen?.baseUomCode ?? account.rows[0]?.uomCode ?? ''}</bdi>
                      </td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </Panel>
    </AdminPage>
  );
}
