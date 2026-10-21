import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Warehouse } from 'lucide-react';
import { Panel } from '@/components/ui';
import {
  ActionButton,
  AdminPage,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  Pill,
  ReasonForm,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import * as recordNotes from '@/server/services/record-notes';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { formatQuantity as formatUnits, parseQuantity } from '@domain/uom';
import { sumMoney } from '@/server/print/decimal';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as reports from '@/server/services/inventory-reports';
import * as payables from '@/server/services/payables';
import * as shipments from '@/server/services/shipments';
import { GoodsOnTheWay } from '@/components/admin/goods-on-the-way';
import * as warehouses from '@/server/services/warehouses';
import { renameWarehouse, setWarehouseActive } from '../actions';

/**
 * One warehouse — Operations build, block 7.
 *
 * Laid out as a branch is, because it is the same kind of record: identity and
 * facts on the left, editing and history on the right. A person who has learned
 * one master-data screen has learned this one.
 *
 * The history is the part worth having. A warehouse that was renamed, closed
 * and reopened is a warehouse whose stock reports change meaning on those
 * dates, and the audit trail is the only place that is recoverable.
 *
 * The stock panel is the Warehouses Report narrowed to this warehouse, reading
 * the same FIFO layers, so the two can never disagree about what is here.
 */
export const dynamic = 'force-dynamic';

export default async function WarehouseRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/master-data/warehouses')) notFound();

  const [t, page, column, list, locale, context, outcome, query, { code: rawCode }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
    params,
  ]);
  // The item typed into the stock panel's search (2026-10-21), matched as the Warehouses Report matches it.
  const itemSearch = typeof query.item === 'string' ? query.item.trim() : '';

  const code = decodeURIComponent(rawCode);
  const { principal } = context;
  if (!can(principal, 'view', warehouses.PERMISSION_OBJECT)) {
    return <Denied object={page('warehouses')} />;
  }
  const mayEdit = can(principal, 'configure', warehouses.PERMISSION_OBJECT);
  // A stage warehouse (On Process, In Process, On Board, At Port) also shows the imports'
  // goods at its stage that are not stock yet (2026-10-21), to whoever may read containers.
  const mayTrack = can(principal, 'view', shipments.CONTAINER_OBJECT);

  const data = await withCurrentUser(async (tx) => {
    const row = await warehouses.get(tx, code);
    if (!row) return null;
    const place = payables.goodsPlaceOfStage(row.shipmentStage);
    return {
      row,
      place,
      onTheWay: place && mayTrack ? await payables.goodsOnTheWay(tx, { place, search: itemSearch || null }) : null,
      // The stage's figure in Details stays the whole stage's while a search narrows the list.
      allOnTheWay: place && mayTrack && itemSearch ? await payables.goodsOnTheWay(tx, { place }) : null,
      stock: await reports.valuation(tx, principal, {
        warehouseCode: code,
        allPermittedBranches: true,
        ...(itemSearch ? { itemSearch } : {}),
      }),
      // The warehouse's total stays the whole warehouse's while a search narrows the list.
      totalStock: itemSearch ? await reports.valuation(tx, principal, { warehouseCode: code, allPermittedBranches: true }) : null,
      notes: await recordNotes.listNotes(tx, { object: warehouses.PERMISSION_OBJECT, recordId: code }),
    };
  });

  if (!data) notFound();
  const { row, stock, totalStock, notes, place, onTheWay, allOnTheWay } = data;
  const tracked = onTheWay ? payables.goodsOnTheWayAt((allOnTheWay ?? onTheWay).rows, place) : null;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // Exact, as the Warehouses Report is: a scaled integer for the quantity, and
  // the printed copy's own `sumMoney` for the total.
  const units = (quantity: string) => formatUnits(parseQuantity(quantity));
  const total = sumMoney((totalStock ?? stock).map((line) => line.valueIqd));

  return (
    <AdminPage
      actions={
        // Inside `sapDoc`, so the doors wear the same plain icon buttons they
        // wear in a document window's title bar.
        <span className={`${s.sapDoc} inline-flex items-center gap-1`}>
          {/* Notes and the clock — the profile's two doors (shared, 2026-10-04). */}
          <RecordNotesDoor notes={notes} object={warehouses.PERMISSION_OBJECT} recordId={row.code} />
          <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
            <RecordHistory objectId={row.code} objectType={warehouses.PERMISSION_OBJECT} />
          </HistoryButton>
        </span>
      }
      back={{ href: '/master-data/warehouses', label: t('back') }}
      title={`${row.code} · ${row.name}`}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <div className={s.profileGrid}>
        {/* Left: identity, facts, lifecycle */}
        <div className={s.profileStack}>
          <Panel>
            <div className={`${s.profileCard} border-0 bg-transparent shadow-none`}>
              <span className={`${s.avatarLarge} ${s.profileAvatar} rounded-full border-0 bg-primary-subtle text-primary-subtle-fg`}>
                <Warehouse aria-hidden="true" style={{ inlineSize: '2rem', blockSize: '2rem' }} />
              </span>
              <h2>{row.name}</h2>
              <p>
                {column('warehouse_code')}: {row.code}
              </p>
              <Pill label={row.active ? t('active') : t('inactive')} on={row.active} />
            </div>
          </Panel>

          <Panel title={t('details')}>
            <ul className={s.profileFacts}>
              <li>
                <span>{column('branch_code')}</span>
                <span>{row.branchCode}</span>
              </li>
              <li>
                <span>{t('reports.totals')}</span>
                <span>{money(total)}</span>
              </li>
              {tracked ? (
                <li data-on-the-way={row.code}>
                  <span>{t('reports.on_the_way')}</span>
                  <span>
                    {tracked.containers === 0 && tracked.imports === 0
                      ? t('reports.on_the_way_nothing')
                      : [
                          tracked.containers ? t('reports.on_the_way_containers', { count: tracked.containers }) : null,
                          tracked.imports ? t('reports.on_the_way_imports', { count: tracked.imports }) : null,
                          tracked.units > 0n ? t('reports.on_the_way_units', { units: formatUnits(tracked.units) }) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </span>
                </li>
              ) : null}
              <li>
                <span>{t('created_at')}</span>
                <span>{formatTimestamp(row.createdAt.toISOString(), locale as Locale)}</span>
              </li>
            </ul>
          </Panel>

          {mayEdit ? (
            <Panel title={row.active ? t('warehouses.close') : t('warehouses.reopen')}>
              {row.active ? (
                <ReasonForm
                  action={setWarehouseActive}
                  hidden={{ code: row.code }}
                  label={t('warehouses.close')}
                  reasonLabel={t('reason')}
                  reasonPlaceholder={t('reason_placeholder')}
                />
              ) : (
                <ActionButton
                  action={setWarehouseActive}
                  hidden={{ code: row.code, active: '1' }}
                  label={t('warehouses.reopen')}
                  small={false}
                  tone="primary"
                />
              )}
            </Panel>
          ) : null}
        </div>

        {/* Right: editing, what it holds, and history */}
        <div className={s.profileStack}>
          {mayEdit ? (
            <Panel title={t('update')}>
              <Form action={renameWarehouse}>
                <input name="code" type="hidden" value={row.code} />
                <Grid>
                  <Field
                    defaultValue={row.name}
                    label={column('warehouse_name')}
                    name="name"
                    required
                    requiredLabel={t('required_hint')}
                  />
                </Grid>
                <SubmitRow>
                  <Submit label={t('save')} />
                </SubmitRow>
              </Form>
            </Panel>
          ) : null}

          <Panel title={t('reports.warehouses_report')}>
            {/* Find an item in this warehouse by its name or code (2026-10-21). */}
            <form method="get">
              <FilterRow>
                <Field defaultValue={itemSearch} label={column('item_name')} name="item" placeholder={t('reports.search_item_hint')} />
                <SubmitRow>
                  <Submit label={list('search')} />
                </SubmitRow>
              </FilterRow>
            </form>
            <div className="table-wrap">
              <table className="list">
                <thead>
                  <tr>
                    <th scope="col">{column('item_code')}</th>
                    <th scope="col">{column('item_name')}</th>
                    <th className="numeric" scope="col">{column('quantity')}</th>
                    <th className="numeric" scope="col">{column('total_price')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.length === 0 ? (
                    <tr>
                      <td colSpan={4}>{itemSearch ? t('reports.nothing_found_for_item') : t('reports.nothing_in_stock')}</td>
                    </tr>
                  ) : null}
                  {stock.map((line) => (
                    <tr key={line.itemCode}>
                      <td>{line.itemCode}</td>
                      <td>{line.itemName}</td>
                      <td className="numeric">{units(line.quantity)}</td>
                      <td className="numeric">{money(line.valueIqd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

        </div>
      </div>

      {/* The goods at this stage on their way, searched with the panel's item box too. */}
      {onTheWay ? <GoodsOnTheWay place={place} rows={onTheWay.rows} truncated={onTheWay.truncated} /> : null}
    </AdminPage>
  );
}
