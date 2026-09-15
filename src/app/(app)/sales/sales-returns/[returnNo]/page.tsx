import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as sr from '@/server/services/sales-return';
import * as warehouses from '@/server/services/warehouses';
import { acceptReturn, receiveReturn, rejectReturn } from '../actions';

/**
 * One Sales Return — Operations build, block 9.
 *
 *   Header    Customer Name; Customer Code; Date; Offset Account (Accounts
 *             Receivable or Bank); Original Sales Invoice Number.
 *   Lines     Item Name; Item Code; Return Quantity; Warehouse.
 *   Journal   Sales Return Dr. / Accounts Receivable or Bank Cr. /
 *             Inventory Dr. / COGS Cr.
 *
 * Wearing the Journal Entry's window, like every other document here.
 *
 * The verbs appear one at a time in Appendix B's order, which is not the
 * obvious one: the goods are received and inspected *before* anybody accepts
 * the return. Accepting first would be agreeing to credit a customer for goods
 * nobody has looked at. Rejecting sits wherever accepting does, because they
 * are the two ends of one decision.
 */
export const dynamic = 'force-dynamic';

export default async function SalesReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ returnNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/sales-returns')) notFound();

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
  if (!can(principal, 'view', sr.PERMISSION_OBJECT)) {
    return <Denied object={page('sales_returns')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const document = await sr.viewByNo(tx, decodeURIComponent(returnNo));
    if (!document) return null;
    return { document, houses: await warehouses.listActive(tx) };
  });

  if (!found) notFound();
  const { lines, ...returnDoc } = found.document;

  const today = new Date().toISOString().slice(0, 10);
  const mayReceive =
    returnDoc.status === 'submitted' && can(principal, 'execute', sr.PERMISSION_OBJECT);
  const mayDecide =
    ['partially_executed', 'executed'].includes(returnDoc.status) &&
    can(principal, 'approve', sr.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{returnDoc.returnNo}</bdi> },
    { label: column('status'), value: status(returnDoc.status), status: returnDoc.status },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(returnDoc.requestedOn, locale as Locale)}</bdi>,
    },
    { label: column('branch_code'), value: <bdi dir="ltr">{returnDoc.branchCode}</bdi> },
    {
      label: t('sales_returns.offset'),
      value:
        returnDoc.offsetKind === 'bank'
          ? t('sales_returns.offset_bank')
          : t('sales_returns.offset_receivable'),
    },
    {
      label: t('sales_returns.reason'),
      value: <bdi dir="auto">{returnDoc.reason}</bdi>,
      wide: true,
    },
  ];

  return (
    <AdminPage
      back={{ href: '/sales/sales-returns', label: t('back') }}
      title={returnDoc.returnNo}
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
            {mayReceive ? (
              <form action={receiveReturn}>
                <input name="id" type="hidden" value={returnDoc.id} />
                <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                <input name="received_on" type="hidden" value={today} />
                <button className="action action--primary" type="submit">
                  {t('sales_returns.receive')}
                </button>
              </form>
            ) : null}
            {mayDecide ? (
              <>
                <form action={acceptReturn}>
                  <input name="id" type="hidden" value={returnDoc.id} />
                  <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                  <input name="warehouse_code" type="hidden" value={found.houses[0]?.code ?? ''} />
                  <button className="action action--primary" type="submit">
                    {t('sales_returns.accept')}
                  </button>
                </form>
                <form action={rejectReturn}>
                  <input name="id" type="hidden" value={returnDoc.id} />
                  <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                  <input name="reason" type="hidden" value={returnDoc.reason} />
                  <button className="action" type="submit">
                    {t('sales_returns.reject')}
                  </button>
                </form>
              </>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('sales_returns')}
        fields={fields}
        id="sales-return-document"
        linesCount={lines.length}
        linesTitle={t('sales_returns.lines_title')}
        number={returnDoc.returnNo}
      >
        <table aria-labelledby="sales-return-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th className={s.sapNum} scope="col">
                {t('sales_returns.return_quantity')}
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
                <td>
                  <bdi dir="auto">{line.description ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">
                    {String(Number(line.acceptedQuantity ?? line.requestedQuantity))}
                  </bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.destinationWarehouseCode ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={returnDoc.id} objectType={sr.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
