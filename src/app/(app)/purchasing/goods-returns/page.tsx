import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as gr from '@/server/services/goods-return';

/**
 * Purchase Returns — Operations build, block 10.
 *
 * The register carries the offset each return chose, because that is the
 * difference between the company's debt shrinking and the supplier sending
 * money back, and it is not visible anywhere else in a list.
 */
export const dynamic = 'force-dynamic';

export default async function GoodsReturnsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/purchasing/goods-returns')) notFound();

  const [t, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', gr.PERMISSION_OBJECT)) {
    return <Denied object={page('goods_returns')} />;
  }
  const mayCreate = can(principal, 'create', gr.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => gr.list(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/purchasing/goods-returns/new">
            {t('goods_returns.new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/purchasing/goods-returns" />}
      subtitle={t('goods_returns.subtitle')}
      title={t('goods_returns.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="gr-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="gr-list-title">
            <span>{t('goods_returns.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/purchasing/goods-returns"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="gr-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th scope="col">{t('goods_returns.invoice')}</th>
                  <th scope="col">{t('goods_returns.offset')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('goods_returns.none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/purchasing/goods-returns/${encodeURIComponent(row.returnNo)}`}
                      >
                        <bdi dir="ltr">{row.returnNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.returnDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.supplierCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.invoiceNo ?? '—'}</bdi>
                    </td>
                    <td>
                      {row.offsetKind === 'bank'
                        ? t('goods_returns.offset_bank')
                        : t('goods_returns.offset_payable')}
                    </td>
                    <td>
                      <span
                        className={`status status--${row.status} ${s.sapRegisterStatus}`}
                        data-status={row.status}
                      >
                        {status(row.status)}
                      </span>
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
