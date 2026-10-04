import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { PrintSheet } from '@/components/print/print-sheet';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { printSheet } from '@/server/print/sheet';
import { requireContext, withCurrentUser } from '@/server/session';
import * as gr from '@/server/services/goods-return';
import { approveGoodsReturn, postGoodsReturn } from '../actions';
import { PurchaseDoors, readDoors } from '../../record-doors';

/**
 * One Purchase Return — Operations build, block 10.
 *
 *   Header    Supplier Name; Supplier Code; Date; Offset Account (Accounts
 *             Payable or Bank); Original Purchase Invoice Number.
 *   Lines     Item Name; Item Code; Return Quantity; Warehouse.
 *   Journal   Accounts Payable or Bank Dr. / Inventory Cr.
 *
 * Wearing the Journal Entry's window, like every other document here; the
 * four doors in its title bar from the draft on, and the supplier, the
 * invoice or receipt it answers and the credit memo it produced as links
 * (REQ-PAY-001 PAY3, 2026-10-04).
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

  const found = await withCurrentUser(async (tx) => {
    const seen = await gr.viewByNo(tx, decodeURIComponent(returnNo));
    if (!seen) return null;
    return { ...seen, doors: await readDoors(tx, principal, { object: gr.PERMISSION_OBJECT, recordId: seen.document.id }) };
  });
  if (!found) notFound();
  const { document, lines, supplier, invoiceNo, receiptNo, creditMemo, doors } = found;
  const sheet = await printSheet('purchase_return', document.returnNo);
  const self = `/payables/goods-returns/${encodeURIComponent(document.returnNo)}`;

  const mayApprove = document.status === 'draft' && can(principal, 'approve', gr.PERMISSION_OBJECT);
  const mayPost = document.status === 'approved' && can(principal, 'post', gr.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{document.returnNo}</bdi> },
    { label: column('status'), value: status(document.status), status: document.status },
    { label: column('supplier_code'), value: <ProfileLink code={supplier?.code} kind="supplier">{supplier?.code ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={supplier?.code} dir="auto" kind="supplier">
          {supplier?.legalName ?? '—'}
        </ProfileLink>
      ),
    },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(document.returnDate, locale as Locale)}</bdi>,
    },
    { label: column('branch_code'), value: <bdi dir="ltr">{document.branchCode}</bdi> },
    ...(invoiceNo ? [{ label: t('goods_returns.invoice'), value: <ProfileLink code={invoiceNo} kind="purchase_invoice" /> }] : []),
    ...(receiptNo ? [{ label: t('payables_goods.record_title'), value: <ProfileLink code={receiptNo} kind="goods_receipt" /> }] : []),
    ...(creditMemo
      ? [{ label: t('supplier_notes.record_title'), value: <ProfileLink code={creditMemo.memoNo} kind="supplier_credit_note" /> }]
      : []),
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
        documentType={page('goods_returns')}
        fields={fields}
        id="goods-return-document"
        linesCount={lines.length}
        linesTitle={t('goods_returns.lines_title')}
        number={document.returnNo}
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={document.returnNo}
            exportKey="purchase_return"
            object={gr.PERMISSION_OBJECT}
            recordId={document.id}
            returnTo={self}
            title={`${page('goods_returns')} ${document.returnNo}`}
          />
        }
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
                  <ProfileLink code={line.itemCode} kind="item" />
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{formatQuantity(line.quantity, locale as Locale)}</bdi>
                </td>
                <td>
                  <ProfileLink code={line.warehouseCode} kind="warehouse" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
