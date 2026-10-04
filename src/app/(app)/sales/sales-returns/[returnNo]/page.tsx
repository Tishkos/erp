import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { Attachments } from '@/components/admin/attachments';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { printSheet } from '@/server/print/sheet';
import { requireContext, withCurrentUser } from '@/server/session';
import * as attachmentsService from '@/server/services/attachments';
import * as sr from '@/server/services/sales-return';
import * as warehouses from '@/server/services/warehouses';
import { acceptReturn, attachToReturn, rejectReturn } from '../actions';

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
    return {
      document,
      houses: (await warehouses.listActive(tx)).filter(
        (house) => house.branchCode === document.branchCode,
      ),
      soldFrom: await sr.soldFromWarehouses(
        tx,
        document.lines.map((line) => line.arInvoiceLineId),
      ),
      // Block 9's header: whose return it is and which invoice it answers.
      parties: await sr.partiesOf(tx, document.id),
      // The paperwork behind the paperclip: how many there are.
      attached: await attachmentsService.currentFor(tx, sr.PERMISSION_OBJECT, document.id),
    };
  });

  if (!found) notFound();
  const { lines, ...returnDoc } = found.document;
  const sheet = await printSheet('sales_return', returnDoc.returnNo);
  const mayAttach = can(principal, 'create', 'attachment');

  const mayDecide =
    ['submitted', 'partially_executed', 'executed'].includes(returnDoc.status) &&
    can(principal, 'approve', sr.PERMISSION_OBJECT) &&
    can(principal, 'execute', sr.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{returnDoc.returnNo}</bdi> },
    { label: column('status'), value: status(returnDoc.status), status: returnDoc.status },
    { label: column('customer_code'), value: <bdi dir="ltr">{found.parties?.customerCode ?? '—'}</bdi> },
    { label: column('customer_name'), value: <bdi dir="auto">{found.parties?.customerName ?? '—'}</bdi> },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(returnDoc.requestedOn, locale as Locale)}</bdi>,
    },
    {
      label: column('invoice_no'),
      value: found.parties?.invoiceNo ? (
        <Link className={s.sapLink} href={`/sales/ar-invoices/${encodeURIComponent(found.parties.invoiceNo)}`}>
          <bdi dir="ltr">{found.parties.invoiceNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
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
            {mayDecide ? (
              <>
                <form action={acceptReturn} id="sales-return-accept">
                  <input name="id" type="hidden" value={returnDoc.id} />
                  <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                  <Submit label={t('sales_returns.accept')} variant="document" />
                </form>
                <form action={rejectReturn}>
                  <input name="id" type="hidden" value={returnDoc.id} />
                  <input name="return_no" type="hidden" value={returnDoc.returnNo} />
                  <input name="reason" type="hidden" value={returnDoc.reason} />
                  <Submit label={t('sales_returns.reject')} tone="secondary" variant="document" />
                </form>
              </>
            ) : null}
          </>
        }
        documentType={page('sales_returns')}
        fields={fields}
        id="sales-return-document"
        linesCount={lines.length}
        linesTitle={t('sales_returns.lines_title')}
        number={returnDoc.returnNo}
        titleActions={
          <>
            {/* Printer, paperclip, clock — the standing order (2026-10-03),
                from the moment the return is raised. */}
            <ExportIcon
              exportKey="sales_return"
              id={returnDoc.returnNo}
              title={`${page('sales_returns')} ${returnDoc.returnNo}`}
            />
            <AttachmentsButton
              closeLabel={t('close')}
              count={found.attached.length}
              label={t('attachments.title')}
              title={t('attachments.title')}
            >
              <Attachments
                action={attachToReturn}
                hidden={{ return_no: returnDoc.returnNo }}
                mayAttach={mayAttach}
                objectId={returnDoc.id}
                objectType={sr.PERMISSION_OBJECT}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={returnDoc.id} objectType={sr.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
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
                  {/* Block 9 — "Warehouse (where the returned stock will be
                      allocated)", chosen per line before the goods are
                      accepted; it opens on the warehouse the line was sold
                      from. */}
                  {mayDecide ? (
                    <select
                      aria-label={`${column('warehouse')} ${line.itemCode}`}
                      defaultValue={found.soldFrom.get(line.arInvoiceLineId) ?? ''}
                      form="sales-return-accept"
                      name={`warehouse_code_${line.id}`}
                      required
                    >
                      {found.houses.map((house) => (
                        <option key={house.code} value={house.code}>
                          {`${house.code} · ${house.name}`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <bdi dir="ltr">{line.destinationWarehouseCode ?? '—'}</bdi>
                  )}
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
