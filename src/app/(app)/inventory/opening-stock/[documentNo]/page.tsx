import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { AdminPage, Flash, Pill, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { can } from '@domain/permissions';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/phase-gate';
import { printSheet } from '@/server/print/sheet';
import { requireContext, withCurrentUser } from '@/server/session';
import * as opening from '@/server/services/opening-stock';
import { approveOpeningStock } from '../actions';

/**
 * One Opening Stock document — Operations build, block 7.
 *
 * Its lines as the build lists them: Item Name, Item Code, Quantity, Total
 * Price, Average Unit Price, Warehouse Name and Warehouse Code. Approval, by
 * somebody other than the person who entered it, brings the stock in and posts
 * it: Dr each item's inventory account / Cr the opening balance.
 */
export const dynamic = 'force-dynamic';

export default async function OpeningStockRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ documentNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/inventory/opening-stock')) notFound();

  const [{ documentNo }, t, page, column, status, context, outcome] = await Promise.all([
    params,
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'view', opening.PERMISSION_OBJECT)) {
    return <Denied object={page('opening_stock')} />;
  }

  const found = await withCurrentUser((tx) => opening.viewByNo(tx, decodeURIComponent(documentNo)));
  if (!found) notFound();
  const { document, lines } = found;
  const sheet = await printSheet('opening_stock', document.documentNo);

  const mayApprove =
    document.status === 'submitted' &&
    document.createdBy !== context.principal.userId &&
    can(context.principal, 'approve', opening.PERMISSION_OBJECT);

  const average = (quantity: string, total: string) => {
    const q = Number(quantity);
    return q > 0 ? (Number(total) / q).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '';
  };
  const total = lines.reduce((sum, line) => sum + Number(line.totalIqd), 0);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="opening_stock" id={document.documentNo} />}
      back={{ href: '/inventory/opening-stock', label: page('opening_stock') }}
      subtitle={`${document.warehouseCode} · ${document.warehouseName} — ${document.documentDate}`}
      title={document.documentNo}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <Panel flush>
        <div className={s.toolbar}>
          <Pill label={status(document.status)} on={document.status === 'approved'} />
          {document.status === 'submitted' && !mayApprove ? (
            <span className="muted">{t('opening_stock.awaiting')}</span>
          ) : null}
          {mayApprove ? (
            <form action={approveOpeningStock}>
              <input name="id" type="hidden" value={document.id} />
              <input name="document_no" type="hidden" value={document.documentNo} />
              <button className="action action--primary" type="submit">
                {t('opening_stock.approve')}
              </button>
            </form>
          ) : null}
        </div>
        <div className="table-wrap">
          <table className="list">
            <thead>
              <tr>
                <th scope="col">{column('item_name')}</th>
                <th scope="col">{column('item_code')}</th>
                <th scope="col">{column('quantity')}</th>
                <th scope="col">{column('total_price')}</th>
                <th scope="col">{column('average_unit_price')}</th>
                <th scope="col">{column('warehouse_name')}</th>
                <th scope="col">{column('warehouse_code')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <bdi dir="auto">{line.itemName}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{line.itemCode}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{formatQuantity(parseQuantity(line.quantity))}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{Number(line.totalIqd).toLocaleString('en-US')}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{average(line.quantity, line.totalIqd)}</bdi>
                  </td>
                  <td>
                    <bdi dir="auto">{document.warehouseName}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{document.warehouseCode}</bdi>
                  </td>
                </tr>
              ))}
              <tr>
                <th colSpan={3} scope="row">
                  {t('opening_stock.total')}
                </th>
                <td>
                  <bdi dir="ltr">{total.toLocaleString('en-US')}</bdi>
                </td>
                <td colSpan={3} />
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
