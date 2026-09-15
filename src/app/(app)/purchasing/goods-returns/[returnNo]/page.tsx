import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as gr from '@/server/services/goods-return';
import { approveGoodsReturn, postGoodsReturn } from '../actions';

/**
 * One Purchase Return — Operations build, block 10.
 *
 *   Journal   Accounts Payable or Bank Dr. / Inventory Cr.
 *
 * Approved, then sent. The goods leave on the layer they arrived on, so they go
 * back out at what was paid for them rather than at today's price, and the
 * credit the supplier agrees is a separate act afterwards — it is their figure,
 * not the company's, and it sometimes differs.
 */
export const dynamic = 'force-dynamic';

export default async function GoodsReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ returnNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/purchasing/goods-returns')) notFound();

  const [t, page, column, status, locale, context, outcome, { returnNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', gr.PERMISSION_OBJECT)) {
    return <Denied object={page('goods_returns')} />;
  }

  const found = await withCurrentUser((tx) => gr.viewByNo(tx, decodeURIComponent(returnNo)));
  if (!found) notFound();
  const { document, lines } = found;

  const mayApprove =
    document.status === 'draft' && can(principal, 'approve', gr.PERMISSION_OBJECT);
  const mayPost = document.status === 'approved' && can(principal, 'post', gr.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        <>
          {mayApprove ? (
            <form action={approveGoodsReturn}>
              <input name="id" type="hidden" value={document.id} />
              <input name="return_no" type="hidden" value={document.returnNo} />
              <button className="action action--primary" type="submit">
                {t('goods_returns.approve')}
              </button>
            </form>
          ) : null}
          {mayPost ? (
            <form action={postGoodsReturn}>
              <input name="id" type="hidden" value={document.id} />
              <input name="return_no" type="hidden" value={document.returnNo} />
              <button className="action action--primary" type="submit">
                {t('goods_returns.ship')}
              </button>
            </form>
          ) : null}
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{ href: '/purchasing/goods-returns', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/purchasing/goods-returns" />}
      subtitle={t('goods_returns.subtitle')}
      title={document.returnNo}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <dl className={s.inboxFacts}>
        <div>
          <dt>{column('status')}</dt>
          <dd>
            <span className={`status status--${document.status}`} data-status={document.status}>
              {status(document.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{column('posting_date')}</dt>
          <dd>
            <bdi dir="ltr">{formatBusinessDate(document.returnDate, locale as Locale)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('goods_returns.offset')}</dt>
          <dd>
            {document.offsetKind === 'bank'
              ? t('goods_returns.offset_bank')
              : t('goods_returns.offset_payable')}
          </dd>
        </div>
        <div>
          <dt>{t('goods_returns.reason')}</dt>
          <dd>
            <bdi dir="auto">{document.reason}</bdi>
          </dd>
        </div>
      </dl>

      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('item_code')}</th>
              <th className={s.sapNum} scope="col">
                {t('goods_returns.return_quantity')}
              </th>
              <th scope="col">{column('warehouse_code')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <bdi dir="ltr">{line.itemCode}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{String(Number(line.quantity))}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.warehouseCode}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RecordHistory objectId={document.id} objectType={gr.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
