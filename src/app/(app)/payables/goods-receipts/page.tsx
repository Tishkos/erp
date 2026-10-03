import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/goods-receipt';

/**
 * Goods receipts — REQ-AP-001 §21.6: what arrived, against which order,
 * into which warehouse. The documents and their posting existed since the
 * foundation; this is their screen.
 */
export const dynamic = 'force-dynamic';

export default async function GoodsReceiptsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/goods-receipts')) notFound();

  const [t, admin, page, locale, outcome, context] = await Promise.all([
    getTranslations('admin.payables_goods'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);
  // REQ-HARDEN-001 H3 — the document statuses read one shared namespace, not a copy per screen.
  const statusOf = await getTranslations('status_order');

  if (!can(context.principal, 'view', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('goods_receipts')} />;
  }

  const result = await withCurrentUser((tx) => receipts.listForScreen(tx, { page: outcome.page }));
  const rows = result.rows;
  const query = (p: number) => `page=${p}`;

  const day = (value: string | null) =>
    value ? formatBusinessDate(value, locale as Locale) : '—';

  return (
    <AdminPage
      tabs={<SectionTabs route="/payables/goods-receipts" />}
      back={{ href: '/payables', label: t('payables') }}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="goods-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="goods-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: result.total })}</span>
          </h2>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="goods-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('col_order')}</th>
                  <th scope="col">{t('col_supplier')}</th>
                  <th scope="col">{t('col_date')}</th>
                  <th scope="col">{t('col_warehouse')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_lines')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/goods-receipts/${encodeURIComponent(row.receiptNo)}`}
                      >
                        <bdi dir="ltr">{row.receiptNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      {row.orderNo ? (
                        <Link
                          className={s.sapLink}
                          href={`/payables/purchase-orders/${encodeURIComponent(row.orderNo)}`}
                        >
                          <bdi dir="ltr">{row.orderNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.receiptDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.warehouses ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.lineCount}</td>
                    <td>
                      <span
                        className="status"
                        data-status={
                          row.status === 'posted'
                            ? 'approved'
                            : row.status === 'reversed'
                              ? 'cancelled'
                              : row.status
                        }
                      >
                        {statusOf(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination count={result.pages} current={result.page} hrefFor={(p) => `/payables/goods-receipts?${query(p)}`} labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
