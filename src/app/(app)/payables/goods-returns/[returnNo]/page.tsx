import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { printSheet } from '@/server/print/sheet';
import { requireContext, withCurrentUser } from '@/server/session';
import * as gr from '@/server/services/goods-return';
import { approveGoodsReturn, postGoodsReturn } from '../actions';

/**
 * One Purchase Return — Operations build, block 10.
 *
 *   Header    Supplier Name; Supplier Code; Date; Offset Account (Accounts
 *             Payable or Bank); Original Purchase Invoice Number.
 *   Lines     Item Name; Item Code; Return Quantity; Warehouse.
 *   Journal   Accounts Payable or Bank Dr. / Inventory Cr.
 *
 * Wearing the Journal Entry's window, like every other document here.
 *
 * Approved, then sent. The goods leave at what the invoice paid for them rather
 * than at today's price, and sending them posts the whole journal at once:
 * Accounts Payable (or the bank the refund arrived in) Dr / Inventory Cr.
 */
export const dynamic = 'force-dynamic';

export default async function GoodsReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ returnNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/goods-returns')) notFound();

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
  const sheet = await printSheet('purchase_return', document.returnNo);

  const mayApprove = document.status === 'draft' && can(principal, 'approve', gr.PERMISSION_OBJECT);
  const mayPost = document.status === 'approved' && can(principal, 'post', gr.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{document.returnNo}</bdi> },
    { label: column('status'), value: status(document.status), status: document.status },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(document.returnDate, locale as Locale)}</bdi>,
    },
    { label: column('branch_code'), value: <bdi dir="ltr">{document.branchCode}</bdi> },
    {
      label: t('goods_returns.offset'),
      value:
        document.offsetKind === 'bank'
          ? t('goods_returns.offset_bank')
          : t('goods_returns.offset_payable'),
    },
    {
      label: t('goods_returns.reason'),
      value: <bdi dir="auto">{document.reason}</bdi>,
      wide: true,
    },
  ];

  return (
    <AdminPage
      actions={<ExportMenu exportKey="purchase_return" id={document.returnNo} />}
      back={{ href: '/payables/goods-returns', label: t('back') }}
      title={document.returnNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveGoodsReturn}>
                <input name="id" type="hidden" value={document.id} />
                <input name="return_no" type="hidden" value={document.returnNo} />
                <Submit label={t('goods_returns.approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postGoodsReturn}>
                <input name="id" type="hidden" value={document.id} />
                <input name="return_no" type="hidden" value={document.returnNo} />
                <Submit label={t('goods_returns.ship')} variant="document" />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('goods_returns')}
        fields={fields}
        id="goods-return-document"
        linesCount={lines.length}
        linesTitle={t('goods_returns.lines_title')}
        number={document.returnNo}
      >
        <table aria-labelledby="goods-return-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
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
                  <bdi dir="ltr">{line.lineNo}</bdi>
                </td>
                <td className={s.sapAccountCell}>
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
      </DocumentWindow>

      <RecordHistory objectId={document.id} objectType={gr.PERMISSION_OBJECT} />
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
