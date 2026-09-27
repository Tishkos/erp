import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  FilterRow,
  Flash,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as shipments from '@/server/services/supplier-shipment';
import * as warehouses from '@/server/services/warehouses';
import * as users from '@/server/services/users';
import { advanceShipment, setShipmentWatchers } from './actions';

/**
 * Invoice Status Tracking — Operations build, block 8.
 *
 *   In Process   A Purchase Invoice is automatically copied here with all its
 *                details, and its items are booked to the In Process warehouse.
 *   On Board     The items move to the On Board warehouse.
 *   On Port      The items move to the On Port warehouse.
 *   In Bounded   A warehouse must be selected, and the items move there.
 *
 * Goods bought abroad are the company's for months before they arrive. They are
 * paid for, they are on a ship, and they are in no warehouse a picker can walk
 * into — but they are stock, and a balance sheet that leaves them out is wrong
 * by whatever is at sea. This is where they are tracked in between.
 *
 * Nothing is created on this page. A shipment appears when a Purchase Invoice
 * posts, which is what "automatically copied to this section" means, and the
 * only thing a person does here is say where the goods have got to.
 */
export const dynamic = 'force-dynamic';

const NEXT: Record<string, shipments.ShipmentStatus | null> = {
  in_process: 'on_board',
  on_board: 'on_port',
  on_port: 'in_bounded',
  in_bounded: null,
};

export default async function InTransitPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/in-transit')) notFound();

  const [t, page, column, list, locale, context, outcome, params] = await Promise.all([
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
  if (!can(principal, 'view', shipments.PERMISSION_OBJECT)) {
    return <Denied object={page('in_transit')} />;
  }
  const mayMove = can(principal, 'execute', shipments.PERMISSION_OBJECT);

  const status =
    typeof params.status === 'string' &&
    (shipments.SHIPMENT_STATUSES as readonly string[]).includes(params.status)
      ? (params.status as shipments.ShipmentStatus)
      : undefined;

  const mayChooseWatchers = can(principal, 'configure', shipments.PERMISSION_OBJECT);
  const { rows, houses, people, watching } = await withCurrentUser(async (tx) => ({
    rows: await shipments.list(tx, status ? { status } : {}),
    houses: await warehouses.listActive(tx),
    people: mayChooseWatchers ? (await users.listAll(tx)).filter((user) => user.isActive) : [],
    watching: new Set(
      (await shipments.watchers(tx, context.scope.branchCode)).map((row) => row.userId),
    ),
  }));

  const shown = rows.filter((row) => matches(row, outcome.q));
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const label = (value: string) => t(`in_transit.status_${value}`);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="invoice_status_tracking" query={params} />}
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/inventory/in-transit" />}
      subtitle={t('in_transit.subtitle')}
      title={t('in_transit.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      {/* One picker rather than five links. Four stages is a list, and a list
          belongs in a control the reader already knows — the same Select every
          other screen filters with.

          In a `Grid` that one picker was given a whole grid column and its
          button a line of its own, so a single filter was the widest thing on
          the screen. A filter is one line to set: the box at its own width and
          the button beside it. */}
      <form method="get">
        <FilterRow>
          <Select
            defaultValue={status ?? ''}
            emptyLabel={t('in_transit.all')}
            label={column('status')}
            name="status"
            options={shipments.SHIPMENT_STATUSES.map((value) => ({
              value,
              label: label(value),
            }))}
          />
          <SubmitRow>
            <Submit label={list('search')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('reference')}</th>
              <th scope="col">{column('posting_date')}</th>
              <th scope="col">{column('supplier_code')}</th>
              <th scope="col">{column('supplier_name')}</th>
              <th className={s.sapNum} scope="col">
                {column('amount')}
              </th>
              <th scope="col">{t('in_transit.where')}</th>
              <th scope="col">{column('status')}</th>
              {mayMove ? <th scope="col" /> : null}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={mayMove ? 8 : 7}>
                  {t('in_transit.none')}
                </td>
              </tr>
            ) : null}
            {shown.map((row) => {
              const next = NEXT[row.status] ?? null;
              return (
                <tr key={row.id}>
                  <td>
                    <Link
                      className={s.sapLink}
                      href={`/purchasing/ap-invoices/${encodeURIComponent(row.invoiceNo)}`}
                    >
                      <bdi dir="ltr">{row.invoiceNo}</bdi>
                    </Link>
                  </td>
                  <td>
                    <bdi dir="ltr">{formatBusinessDate(row.invoiceDate, locale as Locale)}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{row.supplierCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.supplierName}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(row.totalIqd)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{row.warehouseName}</bdi>
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
                            // The last step is the only one that asks: the other
                            // three warehouses are properties of the stage, and
                            // there is exactly one of each.
                            <select
                              aria-label={column('warehouse_name')}
                              className={s.sapCellField}
                              name="warehouse_code"
                              required
                            >
                              {houses.map((house) => (
                                <option key={house.code} value={house.code}>
                                  {house.code} · {house.name}
                                </option>
                              ))}
                            </select>
                          ) : null}
                          <Submit label={`${t('in_transit.advance')} ${label(next)}`} tone="secondary" variant="document" />
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

      {/* Block 8 — "Every status change sends a notification to the selected
          system users." These are the users selected, for this branch. */}
      {mayChooseWatchers ? (
        <form action={setShipmentWatchers} className={s.toolbar}>
          <fieldset>
            <legend>{t('in_transit.notify_title')}</legend>
            {people.map((user) => (
              <label key={user.id} style={{ marginInlineEnd: '1rem' }}>
                <input
                  defaultChecked={watching.has(user.id)}
                  name="watcher"
                  type="checkbox"
                  value={user.id}
                />{' '}
                <bdi dir="auto">{user.displayName}</bdi>
              </label>
            ))}
          </fieldset>
          <Submit label={t('in_transit.notify_save')} tone="secondary" variant="document" />
        </form>
      ) : null}
    </AdminPage>
  );
}
