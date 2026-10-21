import { getLocale, getTranslations } from 'next-intl/server';
import { admin as s } from '@/components/admin';
import { ProfileLink } from '@/components/admin/profile-link';
import { formatBusinessDate, formatQuantity as groupedQuantity, type Locale } from '@/i18n/config';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { GOODS_ON_THE_WAY_CAP, type GoodsOnTheWayPlace, type GoodsOnTheWayRow } from '@/server/services/payables';

/**
 * The imports' goods that are not stock yet, by where they are (2026-10-21):
 * drawn on the Warehouses Report and on a stage warehouse's own page, from
 * `payables.goodsOnTheWay`. Not stock and no value — the caption says so.
 */
export async function GoodsOnTheWay({
  rows,
  truncated,
  place,
}: {
  rows: readonly GoodsOnTheWayRow[];
  truncated: boolean;
  /** The one place shown (a stage warehouse), or null for every place. */
  place: GoodsOnTheWayPlace | null;
}) {
  const [t, column, placeOf, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('column'),
    getTranslations('admin.payables'),
    getLocale(),
  ]);
  // Exact from the scaled integer, grouped (522,070) only as it is written.
  const units = (quantity: string) => groupedQuantity(formatQuantity(parseQuantity(quantity)), locale as Locale);

  return (
    <div className={s.sapTableWrap} id="on-the-way">
      <table aria-label={t('reports.on_the_way_title')} className={`${s.sapTable} ${s.sapReportTable}`} data-goods-on-the-way>
        <caption className={s.sapTitleMeta}>
          {place ? `${t('reports.on_the_way_title')} — ${placeOf(`journey_now_place_${place}`)}` : t('reports.on_the_way_title')}
          <span className="block text-muted-fg">{t('reports.on_the_way_note')}</span>
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('reports.on_the_way_where')}</th>
            <th scope="col">{t('reports.on_the_way_import')}</th>
            <th scope="col">{t('reports.on_the_way_supplier')}</th>
            <th scope="col">{t('reports.on_the_way_container')}</th>
            <th scope="col">{t('reports.on_the_way_goods')}</th>
            <th className={s.sapNum} scope="col">
              {column('quantity')}
            </th>
            <th scope="col">{column('unit')}</th>
            <th scope="col">{t('reports.on_the_way_eta')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className={s.sapEmptyRow} colSpan={8}>
                {t('reports.on_the_way_none')}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr data-place={row.place} key={`${row.payableNo}:${row.containerId ?? ''}:${index}`}>
                <td>{placeOf(`journey_now_place_${row.place}`)}</td>
                <td>
                  <ProfileLink code={row.payableNo} kind="import" />
                </td>
                <td>
                  <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                    {row.supplierName}
                  </ProfileLink>
                </td>
                <td>
                  {row.containerNo ? (
                    <ProfileLink code={row.containerNo} kind="container" qualifier={row.containerId ? { id: row.containerId } : {}} />
                  ) : (
                    t('reports.on_the_way_no_container')
                  )}
                </td>
                <td>
                  {row.itemCode ? (
                    <ProfileLink code={row.itemCode} dir="auto" kind="item">
                      {row.itemName ?? row.itemCode}
                    </ProfileLink>
                  ) : (
                    <bdi dir="auto">{row.description}</bdi>
                  )}
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{row.quantity ? units(row.quantity) : '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.uomCode ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{row.eta ? formatBusinessDate(row.eta, locale as Locale) : '—'}</bdi>
                  {row.late ? <span className="text-danger"> · {t('reports.on_the_way_late')}</span> : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
        {truncated ? (
          <tfoot>
            <tr>
              <td colSpan={8}>{t('reports.on_the_way_truncated', { count: GOODS_ON_THE_WAY_CAP })}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
