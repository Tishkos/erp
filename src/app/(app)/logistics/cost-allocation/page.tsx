import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';

/**
 * Cost Allocation — REQ-LOG-001 item 22. Lock → layer adjustment →
 * inventory / cost of sales → journal, from the landed-cost engine's own
 * rows: the locks newest first, and under them every layer each lock
 * touched — the layer's quantity, its cost before and after, what went into
 * stock and what to cost of sales, and the layer it followed when the stock
 * had moved on. Read only, and no second arithmetic. Departures
 * (`landed_cost_departure`) arrive with the Inventory module (Q7).
 */
export const dynamic = 'force-dynamic';

export default async function CostAllocationPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/cost-allocation')) notFound();

  const [t, lc, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.landed_cost'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', 'cost_allocation')) {
    return <Denied object={page('cost_allocation')} />;
  }
  const params = await searchParams;
  const lockId = typeof params.lock === 'string' && /^[0-9a-f-]{36}$/i.test(params.lock) ? params.lock : null;

  const { locks, rows } = await withCurrentUser(async (tx) => ({
    locks: await views.locks(tx),
    rows: (await views.costAllocation(tx, { search: outcome.q, lockId })).rows,
  }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const unit = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const qty = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const basis = (code: string, name: string) => (lc.has(`basis_name.${code}`) ? lc(`basis_name.${code}`) : name);

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route="/logistics/cost-allocation" />} subtitle={t('allocation_subtitle')} title={page('cost_allocation')} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      <p className={`${s.sapNote} mb-4`}>{t('departures_note')}</p>

      {/* ── The locks ──────────────────────────────────────────────────── */}
      <section aria-labelledby="locks-title" className={`${s.sapDoc} ${s.sapRegister} mb-5`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="locks-title">
            <span>{t('locks_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: locks.length })}</span>
          </h2>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="locks-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_lock_no')}</th>
                  <th scope="col">{t('date')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('col_basis')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_total')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_inventory')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_cogs')}
                  </th>
                  <th scope="col">{t('col_journal')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_layers')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_charges_n')}
                  </th>
                  <th scope="col">{t('by')}</th>
                </tr>
              </thead>
              <tbody>
                {locks.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={12}>
                      {t('none_allocation')}
                    </td>
                  </tr>
                ) : null}
                {locks.map((lock) => (
                  <tr key={lock.id}>
                    <td>
                      <Link className={s.sapLink} href={`/logistics/cost-allocation?lock=${lock.id}`}>
                        <bdi dir="ltr">{t('lock_sequence', { sequence: lock.sequence })}</bdi>
                      </Link>
                      {lock.note ? <div className="muted">{lock.note}</div> : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(lock.lockDate)}</bdi>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(lock.payableNo)}#landed-cost`}>
                        <bdi dir="ltr">{lock.payableNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{lock.supplierName}</bdi>
                    </td>
                    <td>{basis(lock.basisCode, lock.basisName)}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(lock.totalIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(lock.inventoryIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(lock.cogsIqd)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={lock.entryNo} kind="journal">
                        {lock.entryNo ?? '—'}
                      </ProfileLink>
                    </td>
                    <td className={s.sapNum}>{lock.layers}</td>
                    <td className={s.sapNum}>{lock.charges}</td>
                    <td>
                      <bdi dir="auto">{lock.lockedBy ?? '—'}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Layer by layer ──────────────────────────────────────────────── */}
      <section aria-labelledby="adjustments-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="adjustments-title">
            <span>{t('adjustments_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: rows.length })}</span>
          </h2>
          <ListToolbar clearHref="/logistics/cost-allocation" clearLabel={admin('clear_search')} countLabel={admin('rows_shown', { count: rows.length })} placeholder={admin('search_placeholder')} q={outcome.q} searchLabel={admin('search')} />
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="adjustments-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_lock_no')}</th>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('item')}</th>
                  <th scope="col">{t('warehouse')}</th>
                  <th scope="col">{t('col_layer')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_layer_qty')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_on_hand_at_lock')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_before')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_after')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_unit_now')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_allocated')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_inventory')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_cogs')}
                  </th>
                  <th scope="col">{t('col_via')}</th>
                  <th scope="col">{t('col_journal')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={15}>
                      {t('none_allocation')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="ltr">{t('lock_sequence', { sequence: row.lockSequence })}</bdi>
                      <div className="muted">{day(row.lockDate)}</div>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}#landed-cost`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <ProfileLink code={row.itemCode} kind="item" name={row.itemName} />
                    </td>
                    <td>
                      <ProfileLink code={row.warehouseCode} kind="warehouse">
                        {row.warehouseCode}
                      </ProfileLink>
                    </td>
                    <td>
                      <bdi dir="ltr">
                        {day(row.layerDate)}
                        {row.layerSequence !== null ? ` · ${row.layerSequence}` : ''}
                      </bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {qty(row.layerOriginalQty)} ({qty(row.layerRemainingQty)})
                      </bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{qty(row.onHandQty)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{unit(row.unitCostBefore)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{unit(row.unitCostAfter)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{unit(row.layerUnitCostNow)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.allocatedIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.inventoryIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.cogsIqd)}</bdi>
                    </td>
                    <td>{row.viaWarehouseCode ? t('via_transfer', { warehouse: row.viaWarehouseCode }) : '—'}</td>
                    <td>
                      <ProfileLink code={row.entryNo} kind="journal">
                        {row.entryNo ?? '—'}
                      </ProfileLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
