import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { readAttachments } from '@/components/admin/attachments';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { HistoryButton } from '@/components/admin/icon-dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordAttachmentsDoor } from '@/components/admin/record-attachments-door';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { ExportIcon } from '@/components/print/export-menu';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatQuantity as formatLocaleQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '@domain/money';
import { QUANTITY_FACTOR, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as opening from '@/server/services/opening-stock';
import * as recordNotes from '@/server/services/record-notes';
import { approveOpeningStock } from '../actions';

/**
 * One Opening Stock document — Operations build, block 7.
 *
 * Its lines as the build lists them: Item Name, Item Code, Quantity, Total
 * Price, Average Unit Price, Warehouse Name and Warehouse Code. Approval, by
 * somebody other than the person who entered it, brings the stock in and posts
 * it: Dr each item's inventory account / Cr the opening balance.
 *
 * IMPROVEMENT-002: drawn as the Purchase Invoice page is — the document
 * window, the status chip, Approve as its action — with the four doors in
 * its title bar from the draft on (printer, paperclip, notes, clock) and the
 * warehouse and the items as links to their own pages. Money is exact.
 */
export const dynamic = 'force-dynamic';

export default async function OpeningStockRecordPage({ params, searchParams }: { params: Promise<{ documentNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/opening-stock')) notFound();

  const [{ documentNo }, t, page, column, status, locale, context, outcome] = await Promise.all([
    params,
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', opening.PERMISSION_OBJECT)) {
    return <Denied object={page('opening_stock')} />;
  }

  const view = await withCurrentUser(async (tx) => {
    const found = await opening.viewByNo(tx, decodeURIComponent(documentNo));
    if (!found) return null;
    const ref = { object: opening.PERMISSION_OBJECT, recordId: found.document.id };
    return { ...found, notes: await recordNotes.listNotes(tx, ref), files: await readAttachments(tx, ref.object, ref.recordId) };
  });
  if (!view) notFound();
  const { document, lines } = view;
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const total = toDecimalString(lines.reduce((sum, line) => sum + parseDecimal(line.totalIqd, MONEY_SCALE), 0n), MONEY_SCALE);
  const average = (quantity: string, value: string) => {
    const units = parseQuantity(quantity);
    return units > 0n ? toDecimalString(divideHalfUp(parseDecimal(value, MONEY_SCALE) * QUANTITY_FACTOR, units), MONEY_SCALE) : '0';
  };

  const mayApprove = document.status === 'submitted' && document.createdBy !== principal.userId && can(principal, 'approve', opening.PERMISSION_OBJECT);
  const mayAttach = document.status !== 'approved' && can(principal, 'edit_draft', opening.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{document.documentNo}</bdi> },
    { label: column('status'), value: status(document.status), status: document.status },
    { label: column('warehouse'), value: <ProfileLink code={document.warehouseCode} kind="warehouse" name={document.warehouseName} /> },
    { label: column('branch_code'), value: <bdi dir="ltr">{document.branchCode}</bdi> },
    { label: column('date'), value: <bdi dir="ltr">{formatBusinessDate(document.documentDate, locale as Locale)}</bdi> },
    { label: t('opening_stock.total'), value: <bdi dir="ltr">{money(total)}</bdi> },
  ];

  return (
    <AdminPage back={{ href: '/inventory/opening-stock', label: page('opening_stock') }} title={document.documentNo} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {document.status === 'submitted' && !mayApprove ? <span className="muted">{t('opening_stock.awaiting')}</span> : null}
            {mayApprove ? (
              <form action={approveOpeningStock}>
                <Hidden name="id" value={document.id} />
                <Hidden name="document_no" value={document.documentNo} />
                <Submit label={t('opening_stock.approve')} variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the draft on (2026-10-04). */}
            <ExportIcon exportKey="opening_stock" id={document.documentNo} title={`${page('opening_stock')} ${document.documentNo}`} />
            <RecordAttachmentsDoor files={view.files} mayAttach={mayAttach} object={opening.PERMISSION_OBJECT} recordId={document.id} />
            <RecordNotesDoor notes={view.notes} object={opening.PERMISSION_OBJECT} recordId={document.id} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={document.id} objectType={opening.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('opening_stock')}
        fields={fields}
        id="opening-stock"
        linesCount={lines.length}
        linesTitle={t('opening_stock.lines')}
        number={document.documentNo}
        totals={[{ label: t('opening_stock.total'), value: money(total) }]}
      >
        <table aria-labelledby="opening-stock-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('item_name')}</th>
              <th scope="col">{column('item_code')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('total_price')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('average_unit_price')}
              </th>
              <th scope="col">{column('warehouse_name')}</th>
              <th scope="col">{column('warehouse_code')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <ProfileLink code={line.itemCode} dir="auto" kind="item">
                    {line.itemName}
                  </ProfileLink>
                </td>
                <td>
                  <bdi dir="ltr">{line.itemCode}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{formatLocaleQuantity(line.quantity, locale as Locale)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.totalIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(average(line.quantity, line.totalIqd))}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{document.warehouseName}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{document.warehouseCode}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
    </AdminPage>
  );
}
