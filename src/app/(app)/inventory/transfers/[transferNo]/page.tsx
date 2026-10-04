import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
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
import { formatBusinessDate, formatMoney, formatQuantity as formatLocaleQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as recordNotes from '@/server/services/record-notes';
import * as stock from '@/server/services/stock-operations';

/**
 * One transfer — Operations build, block 7, and the record it never had.
 *
 * Drawn as the Purchase Invoice page is: the document window with its fields,
 * the status chip, the layers the transfer carried as its lines, and — stacked
 * under it as the supplier statement stacks its registers — what both
 * warehouses held before and after. The four doors in its title bar from the
 * moment it exists (printer, paperclip, notes, clock), and the item, the two
 * warehouses and the branch as links to their own pages.
 *
 * A transfer is executed when it is saved, so there is nothing to approve and
 * no action on the page: the status says whether the Stock Movement ledger
 * holds what the document says it moved. Every figure is the ledger's and the
 * FIFO layers' own, read as text and shown exactly.
 */
export const dynamic = 'force-dynamic';

export default async function TransferRecordPage({ params, searchParams }: { params: Promise<{ transferNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/transfers')) notFound();

  const [{ transferNo: rawNo }, t, page, column, locale, context, outcome] = await Promise.all([
    params,
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', stock.TRANSFER_OBJECT)) {
    return <Denied object={page('transfer_requests')} />;
  }

  const view = await withCurrentUser(async (tx) => {
    const found = await stock.transferView(tx, decodeURIComponent(rawNo));
    if (!found) return null;
    const ref = { object: stock.TRANSFER_OBJECT, recordId: found.id };
    return { ...found, notes: await recordNotes.listNotes(tx, ref), files: await readAttachments(tx, ref.object, ref.recordId) };
  });
  if (!view) notFound();

  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const qty = (value: string) => formatLocaleQuantity(value, locale as Locale);
  const mayAttach = can(principal, 'create', stock.TRANSFER_OBJECT);

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{view.transferNo}</bdi> },
    {
      label: column('status'),
      value: view.ledgerRecorded ? t('transfers.ledger_recorded') : t('transfers.ledger_missing'),
      status: view.ledgerRecorded ? 'posted' : 'exception',
    },
    { label: column('item_name'), value: <ProfileLink code={view.itemCode} kind="item" name={view.itemName} /> },
    { label: column('from_warehouse'), value: <ProfileLink code={view.fromWarehouseCode} kind="warehouse" name={view.fromWarehouseName} /> },
    { label: column('to_warehouse'), value: <ProfileLink code={view.toWarehouseCode} kind="warehouse" name={view.toWarehouseName} /> },
    { label: column('branch_code'), value: <ProfileLink code={view.branchCode} kind="branch" /> },
    { label: column('date'), value: <bdi dir="ltr">{formatBusinessDate(view.transferDate, locale as Locale)}</bdi> },
    { label: column('quantity'), value: <bdi dir="ltr">{`${qty(view.quantity)} ${view.uomCode}`}</bdi> },
    { label: t('transfers.cost_carried'), value: <bdi dir="ltr">{money(view.costIqd)}</bdi> },
    {
      label: t('created_at'),
      value: <bdi dir="auto">{`${view.createdByName ?? '—'} · ${formatTimestamp(view.createdAt, locale as Locale)}`}</bdi>,
    },
  ];

  return (
    <AdminPage back={{ href: '/inventory/transfers', label: page('transfer_requests') }} title={view.transferNo} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the moment it exists (2026-10-04). */}
            <ExportIcon exportKey="transfer" id={view.transferNo} title={`${page('transfer_requests')} ${view.transferNo}`} />
            <RecordAttachmentsDoor files={view.files} mayAttach={mayAttach} object={stock.TRANSFER_OBJECT} recordId={view.id} />
            <RecordNotesDoor notes={view.notes} object={stock.TRANSFER_OBJECT} recordId={view.id} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={view.id} objectType={stock.TRANSFER_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('transfer_requests')}
        fields={fields}
        id="transfer"
        linesCount={view.layers.length}
        linesTitle={t('transfers.lines')}
        number={view.transferNo}
        totals={[
          { label: column('quantity'), value: `${qty(view.quantity)} ${view.uomCode}` },
          { label: t('transfers.cost_carried'), value: money(view.costIqd) },
        ]}
      >
        <table aria-labelledby="transfer-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th scope="col">{column('batch_number')}</th>
              <th scope="col">{t('transfers.layer_date')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('transfers.unit_cost')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('transfers.value')}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.layers.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={8}>
                  {t('transfers.no_layers')}
                </td>
              </tr>
            ) : null}
            {view.layers.map((layer, index) => (
              <tr key={layer.movementId}>
                <td>{index + 1}</td>
                <td>
                  <ProfileLink code={view.itemCode} kind="item" />
                </td>
                <td>
                  <bdi dir="auto">{view.itemName}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{layer.batchNumber ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{formatBusinessDate(layer.layerDate, locale as Locale)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{`${qty(layer.quantity)} ${view.uomCode}`}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(layer.unitCostIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(layer.valueIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* What the two warehouses held, before and after — the Stock Ledger's own running balance. */}
      <section aria-labelledby="transfer-positions-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="transfer-positions-title">
            <span>{t('transfers.positions')}</span>
            <span className={s.sapTitleMeta}>{t('transfers.positions_note')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="transfer-positions-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('warehouse')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('transfers.before')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('transfers.moved')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('transfers.after')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.positions.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {t('transfers.ledger_missing_hint')}
                    </td>
                  </tr>
                ) : null}
                {view.positions.map((position) => (
                  <tr key={position.warehouseCode}>
                    <td>
                      <ProfileLink code={position.warehouseCode} kind="warehouse" name={position.warehouseName} />
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${qty(position.before)} ${view.uomCode}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${position.moved.startsWith('-') ? '' : '+'}${qty(position.moved)} ${view.uomCode}`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{`${qty(position.after)} ${view.uomCode}`}</bdi>
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
