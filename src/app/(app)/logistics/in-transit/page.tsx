import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';
import * as tracking from '@/server/services/supplier-shipment';
import * as users from '@/server/services/users';
import * as warehouses from '@/server/services/warehouses';
import { advanceShipment, setShipmentWatchers } from './actions';

/**
 * In-Transit Inventory — REQ-LOG-001 item 18. What the company owns and
 * cannot yet pick: import by import, item by item, from the stock ledger.
 *
 *   In transit   the posted invoice's layers still in a transit warehouse
 *   Received     what the container receipts moved into a real warehouse
 *   On hand      what of that is still there now
 *   Available    the item's figure on the Availability screen — never raised
 *                by anything in transit
 *
 * Under the import rows: the ledger's own balance per transit warehouse
 * (Inventory's `stock_position`), read here as in transit, and whether the
 * import rows add up to it. Last, Invoice Status Tracking — the non-import
 * shipments moved stage by stage — absorbed from `/inventory/in-transit`,
 * which redirects here, with its Advance actions as they were.
 */
export const dynamic = 'force-dynamic';

const NEXT: Record<string, tracking.ShipmentStatus | null> = {
  in_process: 'on_board',
  on_board: 'on_port',
  on_port: 'in_bounded',
  in_bounded: null,
};

export default async function InTransitPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/in-transit')) notFound();

  const [t, admin, page, column, list, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', 'in_transit')) {
    return <Denied object={page('in_transit')} />;
  }
  // Invoice Status Tracking's own grants decide its section and its actions, as they did on its old page.
  const seesTracking = can(principal, 'view', tracking.PERMISSION_OBJECT);
  const mayMove = can(principal, 'execute', tracking.PERMISSION_OBJECT);
  const mayChooseWatchers = can(principal, 'configure', tracking.PERMISSION_OBJECT);
  const status =
    typeof params.status === 'string' && (tracking.SHIPMENT_STATUSES as readonly string[]).includes(params.status)
      ? (params.status as tracking.ShipmentStatus)
      : undefined;

  const view = params.view === 'all' ? 'all' : 'open';
  const found = await withCurrentUser(async (tx) => ({
    imports: await views.inTransitInventory(tx, { search: outcome.q, view }),
    ledger: await views.transitWarehouses(tx),
    gaps: await views.inTransitReconciliation(tx),
    shipments: seesTracking ? await tracking.list(tx, status ? { status } : {}) : [],
    houses: mayMove ? await warehouses.listActive(tx) : [],
    people: mayChooseWatchers ? (await users.listAll(tx)).filter((user) => user.isActive) : [],
    watching: new Set(seesTracking ? (await tracking.watchers(tx, context.scope.branchCode)).map((row) => row.userId) : []),
  }));
  const rows = found.imports.rows;
  const inTransitRows = rows.filter((row) => row.inTransit !== '0');
  const qty = (value: string) => formatQuantity(value, locale as Locale);
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const label = (value: string) => admin(`in_transit.status_${value}`);
  const shipmentsShown = found.shipments.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={seesTracking ? <ExportMenu exportKey="invoice_status_tracking" query={params} /> : null}
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/logistics/in-transit" />}
      subtitle={t('in_transit_subtitle')}
      title={page('in_transit')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      <p className={s.sapNote}>
        <strong>{t('legend_title')}</strong> {t('legend_in_transit')} {t('legend_received')} {t('legend_on_hand')} {t('legend_available')}
      </p>

      {/* ── By import and item — the ledger's layers (item 18) ─────────── */}
      <section aria-labelledby="in-transit-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="in-transit-title">
            <span>{page('in_transit')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: rows.length })}</span>
          </h2>
          <ListToolbar
            clearHref="/logistics/in-transit"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: rows.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view}
                label={t('view')}
                name="view"
                options={[
                  { value: 'open', label: t('view_open') },
                  { value: 'all', label: t('view_all') },
                ]}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="in-transit-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('item')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_ordered')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_shipped')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_in_transit')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_value')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_received')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_on_hand_from_import')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_containers_n')}
                  </th>
                  <th scope="col">{t('col_customs')}</th>
                  <th scope="col">{t('col_declaration')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={12}>
                      {t('none_in_transit')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={`${row.payableId}-${row.itemCode}`}>
                    <td>
                      <ProfileLink code={row.payableNo} kind="import">
                        {row.payableNo}
                      </ProfileLink>
                      {row.invoiceNos ? <div className="muted">{row.invoiceNos}</div> : null}
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.itemCode} kind="item" name={row.itemName} />
                      {row.baseUomCode ? <div className="muted">{row.baseUomCode}</div> : null}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.ordered)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.shipped)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      {row.inTransit === '0' ? (
                        <bdi dir="ltr">{qty(row.inTransit)}</bdi>
                      ) : (
                        <span className="status status--submitted" data-status="submitted">
                          <bdi dir="ltr">{qty(row.inTransit)}</bdi>
                        </span>
                      )}
                      {row.transitWarehouses ? <div className="muted">{row.transitWarehouses}</div> : null}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.inTransitValueIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.received)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.onHandFromImport)}</bdi>
                      {row.receivedWarehouses ? (
                        <div className="muted">
                          {row.receivedWarehouses.split(', ').map((entry, index) => {
                            const [warehouseCode, ...rest] = entry.split(' ');
                            return (
                              <span key={entry}>
                                {index > 0 ? ', ' : ''}
                                <ProfileLink code={warehouseCode} kind="warehouse">
                                  {warehouseCode}
                                </ProfileLink>{' '}
                                {rest.join(' ')}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {row.containersOpen} / {row.containers}
                      </bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.pdSummary ?? '—'}</bdi>
                    </td>
                    <td>{row.declarationStatus ? (t.has(`ds.${row.declarationStatus}`) ? t(`ds.${row.declarationStatus}`) : row.declarationStatus) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── The ledger's balance per transit warehouse ──────────────────── */}
      <section aria-labelledby="transit-ledger-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="transit-ledger-title">
            <span>{t('transit_ledger_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: found.ledger.rows.length })}</span>
          </h2>
          <p className={s.sapNote}>{t('transit_ledger_subtitle')}</p>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="transit-ledger-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('warehouse')}</th>
                  <th scope="col">{t('stage_label')}</th>
                  <th scope="col">{t('branch')}</th>
                  <th scope="col">{t('item')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_ledger_qty')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_available')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_value')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {found.ledger.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none_in_transit')}
                    </td>
                  </tr>
                ) : null}
                {found.ledger.rows.map((row) => (
                  <tr key={`${row.warehouseCode}-${row.itemCode}`}>
                    <td>
                      <ProfileLink code={row.warehouseCode} kind="warehouse" name={row.warehouseName} />
                    </td>
                    <td>{row.shipmentStage ? admin(`in_transit.status_${row.shipmentStage}`) : <span className="muted">{t('col_in_transit')}</span>}</td>
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.itemCode} kind="item" name={row.itemName} />
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.ledgerQuantity)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.available)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.valueIqd)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {found.ledger.rows.length > 0 ? (
            <p className={s.sapNote}>
              {found.gaps.length === 0 ? (
                t('reconciliation_ok')
              ) : (
                <>
                  {t('reconciliation_diff')}{' '}
                  {found.gaps.map((gap, index) => (
                    <span key={gap.itemCode}>
                      {index > 0 ? ' · ' : ''}
                      <bdi dir="ltr">
                        {gap.itemCode}: {t('col_ledger')} {qty(gap.ledger)}, {t('col_imports')} {qty(gap.imports)}, {t('col_difference')} {qty(gap.difference)}
                      </bdi>
                    </span>
                  ))}
                </>
              )}{' '}
              <span className="muted">({t('col_available')}: 0 · {admin('rows_shown', { count: inTransitRows.length })})</span>
            </p>
          ) : null}
        </div>
      </section>

      {/* ── Invoice Status Tracking — absorbed from /inventory/in-transit ── */}
      {seesTracking ? (
        <section aria-labelledby="invoice-tracking-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="invoice-tracking-title">
              <span>{t('invoice_tracking_title')}</span>
              <span className={s.sapTitleMeta}>{admin('rows_shown', { count: shipmentsShown.length })}</span>
            </h2>
            <p className={s.sapNote}>
              {t('invoice_tracking_subtitle')}{' '}
              <Link className={s.sapLink} href="/payables/containers">
                {page('containers')}
              </Link>
            </p>
            <form className={s.filterBar} method="get">
              <FilterRow>
                <Select
                  defaultValue={status ?? ''}
                  emptyLabel={admin('in_transit.all')}
                  label={column('status')}
                  name="status"
                  options={tracking.SHIPMENT_STATUSES.map((value) => ({ value, label: label(value) }))}
                />
                <SubmitRow>
                  <Submit label={list('search')} />
                </SubmitRow>
              </FilterRow>
            </form>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="invoice-tracking-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('reference')}</th>
                    <th scope="col">{column('posting_date')}</th>
                    <th scope="col">{column('supplier_code')}</th>
                    <th scope="col">{column('supplier_name')}</th>
                    <th className={s.sapNum} scope="col">
                      {column('amount')}
                    </th>
                    <th scope="col">{admin('in_transit.where')}</th>
                    <th scope="col">{column('status')}</th>
                    {mayMove ? <th scope="col" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {shipmentsShown.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={mayMove ? 8 : 7}>
                        {admin('in_transit.none')}
                      </td>
                    </tr>
                  ) : null}
                  {shipmentsShown.map((row) => {
                    const next = NEXT[row.status] ?? null;
                    return (
                      <tr key={row.id}>
                        <td>
                          <ProfileLink code={row.invoiceNo} kind="purchase_invoice">
                            {row.invoiceNo}
                          </ProfileLink>
                        </td>
                        <td>
                          <bdi dir="ltr">{formatBusinessDate(row.invoiceDate, locale as Locale)}</bdi>
                        </td>
                        <td>
                          <ProfileLink code={row.supplierCode} kind="supplier">
                            {row.supplierCode}
                          </ProfileLink>
                        </td>
                        <td>
                          <bdi dir="auto">{row.supplierName}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(row.totalIqd)}</bdi>
                        </td>
                        <td>
                          <ProfileLink code={row.warehouseCode} dir="auto" kind="warehouse">
                            {row.warehouseName}
                          </ProfileLink>
                        </td>
                        <td>
                          <span className={`status status--${row.status}`} data-status={row.status}>
                            {label(row.status)}
                          </span>
                        </td>
                        {mayMove ? (
                          <td>
                            {next === null ? null : (
                              <form action={advanceShipment} className={s.fieldWithAction}>
                                <input name="id" type="hidden" value={row.id} />
                                <input name="to" type="hidden" value={next} />
                                {next === 'in_bounded' ? (
                                  <select aria-label={column('warehouse_name')} className={s.sapCellField} name="warehouse_code" required>
                                    {found.houses.map((house) => (
                                      <option key={house.code} value={house.code}>
                                        {house.code} · {house.name}
                                      </option>
                                    ))}
                                  </select>
                                ) : null}
                                <Submit label={`${admin('in_transit.advance')} ${label(next)}`} tone="secondary" variant="document" />
                              </form>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {mayChooseWatchers ? (
              <form action={setShipmentWatchers} className={s.toolbar}>
                <fieldset>
                  <legend>{admin('in_transit.notify_title')}</legend>
                  {found.people.map((user) => (
                    <label key={user.id} style={{ marginInlineEnd: '1rem' }}>
                      <input defaultChecked={found.watching.has(user.id)} name="watcher" type="checkbox" value={user.id} /> <bdi dir="auto">{user.displayName}</bdi>
                    </label>
                  ))}
                </fieldset>
                <Submit label={admin('in_transit.notify_save')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
