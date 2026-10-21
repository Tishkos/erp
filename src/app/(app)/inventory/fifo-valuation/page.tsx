import Link from 'next/link';
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
import { GoodsOnTheWay } from '@/components/admin/goods-on-the-way';
import { IntegrityBanner } from '@/components/admin/integrity-banner';
import { SectionTabs } from '@/components/admin/section-tabs';
import { ProfileLink } from '@/components/admin/profile-link';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { formatQuantity as formatUnits, parseQuantity } from '@domain/uom';
import { sumMoney } from '@/server/print/decimal';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as items from '@/server/services/items';
import * as reports from '@/server/services/inventory-reports';
import * as payables from '@/server/services/payables';
import * as shipments from '@/server/services/shipments';
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
 *
 * IMPROVEMENT-002: above the items, a summary per warehouse — items, units,
 * value, low stock (item.min_stock_level), negative stock, last movement —
 * and the drill-down: a warehouse opens its items, an item its movements.
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

  // The imports' goods that are not stock yet (2026-10-21): shown to whoever may read the containers.
  const mayTrack = can(context.principal, 'view', shipments.CONTAINER_OBJECT);

  const { rows, summary, pickers, onTheWay, chosenPlace } = await withCurrentUser(async (tx) => {
    const houses = await warehouses.listForReports(tx);
    const chosen = warehouseCode ? houses.find((row) => row.code === warehouseCode) : undefined;
    // A stage warehouse shows the goods at its place; any other warehouse none; all warehouses every place.
    const place = chosen ? payables.goodsPlaceOfStage(chosen.shipmentStage) : null;
    const tracked = mayTrack && (!warehouseCode || place !== null);
    return {
      chosenPlace: place,
      onTheWay: tracked ? await payables.goodsOnTheWay(tx, { place, search: itemSearch || null }) : null,
      rows: await reports.valuation(tx, context.principal, {
        allPermittedBranches: true,
        ...(itemSearch ? { itemSearch } : {}),
        ...(warehouseCode ? { warehouseCode } : {}),
      }),
      summary: warehouseCode || itemSearch ? [] : await reports.warehouseSummary(tx, context.principal),
      pickers: {
      // The warehouses stay a picker: a short, known list a person chooses from.
      //
      // The items are searched, not chosen — but a box with no suggestions
      // leaves somebody guessing at spelling, so the names are offered in a
      // `datalist`. It suggests rather than constrains: a partial term is still
      // a valid search, and the matching is done in SQL by the trigram indexes
      // either way. Names only, so the list is the text a person is typing.
        stockItems: (await items.listAll(tx)).filter((row) => row.isStock),
        houses,
      },
    };
  });

  // What a stage warehouse's place holds on the way: containers, imports with none yet, units.
  const onTheWayText = (stage: string | null) => {
    const place = payables.goodsPlaceOfStage(stage);
    if (!place || !onTheWay) return null;
    const tracked = payables.goodsOnTheWayAt(onTheWay.rows, place);
    return tracked.containers === 0 && tracked.imports === 0
      ? { text: t('reports.on_the_way_nothing'), linked: false }
      : {
          text: [
            tracked.containers ? t('reports.on_the_way_containers', { count: tracked.containers }) : null,
            tracked.imports ? t('reports.on_the_way_imports', { count: tracked.imports }) : null,
            tracked.units > 0n ? t('reports.on_the_way_units', { units: formatUnits(tracked.units) }) : null,
          ]
            .filter(Boolean)
            .join(' · '),
          linked: true,
        };
  };

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // The layers carry quantities at six decimal places. A warehouse list reads
  // in whole units where the stock is whole, so trailing zeros are dropped
  // rather than printed — exactly, as a scaled integer, never through a float.
  const units = (quantity: string) => formatUnits(parseQuantity(quantity));

  // The footers are the printed copy's own sums (`print/decimal.sumMoney`):
  // scaled integers, each row rounded half up to four places as it is shown,
  // so the screen and its export can never total a fils apart.
  const total = sumMoney(rows.map((row) => row.valueIqd));
  const summaryTotal = sumMoney(summary.map((row) => row.valueIqd));

  // Stock that came without a purchase is added from here (2026-10-06, by
  // direction): the sheet, with the warehouse the report is filtered to, and
  // the register of what was added by hand — each to whoever holds its grant.
  const mayAddManually = can(context.principal, 'create', 'manual_stock_addition') && visibleRoute('/inventory/manual-additions');
  const mayReadAdditions = can(context.principal, 'view', 'manual_stock_addition') && visibleRoute('/inventory/manual-additions');

  return (
    <AdminPage
      actions={
        <>
          {mayReadAdditions ? (
            <Link className="action" href="/inventory/manual-additions">
              {t('manual_additions.view_list')}
            </Link>
          ) : null}
          {mayAddManually ? (
            <Link
              className="action action--primary"
              href={warehouseCode ? `/inventory/manual-additions/new?warehouse=${encodeURIComponent(warehouseCode)}` : '/inventory/manual-additions/new'}
            >
              {t('manual_additions.new')}
            </Link>
          ) : null}
          <ExportMenu exportKey="warehouses_report" query={params} />
        </>
      }
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
            {[...new Set((onTheWay?.rows ?? []).map((row) => row.description))]
              .filter((text) => !pickers.stockItems.some((item) => item.name === text))
              .map((text) => (
                <option key={`on-the-way:${text}`} value={text} />
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

      {summary.length > 0 ? (
        /* Nine columns scroll inside their own frame on a phone; unframed,
           the summary pushed the whole page sideways (2026-10-04). */
        <div className={s.sapTableWrap}>
        <table aria-label={t('reports.warehouse_summary')} className={`${s.sapTable} ${s.sapReportTable}`}>
          <caption className={s.sapTitleMeta}>{t('reports.warehouse_summary')}</caption>
          <thead>
            <tr>
              <th scope="col">{column('warehouse_code')}</th>
              <th scope="col">{column('warehouse_name')}</th>
              <th scope="col">{column('branch_code')}</th>
              <th className={s.sapNum} scope="col">
                {t('reports.items_count')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.units')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.value')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.low_stock')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reports.negative_stock')}
              </th>
              <th scope="col">{t('reports.last_movement')}</th>
              {onTheWay ? <th scope="col">{t('reports.on_the_way')}</th> : null}
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={row.warehouseCode}>
                <td>
                  {/* Drill-down: the warehouse's items, on this report. */}
                  <Link className={s.sapLink} href={`/inventory/fifo-valuation?warehouse=${encodeURIComponent(row.warehouseCode)}`}>
                    <bdi dir="ltr">{row.warehouseCode}</bdi>
                  </Link>
                </td>
                <td>
                  <ProfileLink code={row.warehouseCode} dir="auto" kind="warehouse">
                    {row.isTransit ? `${row.warehouseName} · ${t('reports.transit')}` : row.warehouseName}
                  </ProfileLink>
                </td>
                <td>
                  <bdi dir="ltr">{row.branchCode}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.items}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{units(row.units)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.valueIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.lowStock}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.negativeStock}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.lastMovementOn ? formatBusinessDate(row.lastMovementOn, locale as Locale) : '—'}</bdi>
                </td>
                {onTheWay ? <OnTheWayCell code={row.warehouseCode} shown={onTheWayText(row.shipmentStage)} /> : null}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td colSpan={5}>{t('reports.totals')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(summaryTotal)}</bdi>
              </td>
              <td colSpan={onTheWay ? 4 : 3} />
            </tr>
          </tfoot>
        </table>
        </div>
      ) : null}

      {/* A stage warehouse holds the imports' goods mostly as tracking, not stock: they come first (2026-10-21). */}
      {onTheWay && chosenPlace ? <GoodsOnTheWay place={chosenPlace} rows={onTheWay.rows} truncated={onTheWay.truncated} /> : null}

      {/* Framed like the summary above: nine columns scroll within the
          frame on a phone rather than widening the page (2026-10-04). */}
      <div className={s.sapTableWrap}>
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
            <th scope="col">{t('reports.movements')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={s.sapEmptyRow} colSpan={9}>
                {itemSearch ? t('reports.nothing_found_anywhere') : t('reports.nothing_in_stock')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={`${row.itemCode}:${row.warehouseCode}:${row.branchCode}`}>
                <td>
                  <ProfileLink code={row.itemCode} dir="auto" kind="item">
                    {row.itemName}
                  </ProfileLink>
                </td>
                <td>
                  <bdi dir="ltr">{row.itemCode}</bdi>
                </td>
                <td>
                  <ProfileLink code={row.warehouseCode} dir="auto" kind="warehouse">
                    {row.warehouseName}
                  </ProfileLink>
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
                <td>
                  {/* Drill-down: the item's movements in this warehouse. */}
                  <Link className={s.sapLink} href={`/inventory/stock-ledger?item=${encodeURIComponent(row.itemCode)}&warehouse=${encodeURIComponent(row.warehouseCode)}`}>
                    {t('reports.movements')}
                  </Link>
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
                <bdi dir="ltr">{money(total)}</bdi>
              </td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
      </div>

      {onTheWay && !chosenPlace ? <GoodsOnTheWay place={null} rows={onTheWay.rows} truncated={onTheWay.truncated} /> : null}
    </AdminPage>
  );
}

/** A stage warehouse's goods on the way in the summary: a link to them; a dash for any other warehouse. */
function OnTheWayCell({ code, shown }: { code: string; shown: { text: string; linked: boolean } | null }) {
  if (!shown) return <td>—</td>;
  return (
    <td data-on-the-way={code}>
      {shown.linked ? (
        <Link className={s.sapLink} href={`/inventory/fifo-valuation?warehouse=${encodeURIComponent(code)}#on-the-way`}>
          {shown.text}
        </Link>
      ) : (
        shown.text
      )}
    </td>
  );
}
