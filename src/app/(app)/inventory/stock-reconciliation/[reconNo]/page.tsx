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
 * One Item Reconciliation — Operations build, block 7, and the record it never
 * had.
 *
 * Drawn as the Purchase Invoice page is: the document window with its fields,
 * the status chip, the layers it took out (or the one it brought in) as its
 * lines, and — stacked under it as the supplier statement stacks its
 * registers — the warehouse's quantity before and after, and the journal it
 * posted. The four doors in its title bar from the moment it exists (printer,
 * paperclip, notes, clock); the item, the warehouse, the branch and the
 * journal's accounts are links to their own pages.
 *
 * A reconciliation is executed when it is saved, so there is nothing to
 * approve and no action on the page. Every figure is the ledger's, the FIFO
 * layers' and the journal's own, read as text and shown exactly.
 */
export const dynamic = 'force-dynamic';

export default async function ReconciliationRecordPage({ params, searchParams }: { params: Promise<{ reconNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/stock-reconciliation')) notFound();

  const [{ reconNo: rawNo }, t, page, column, statusName, locale, context, outcome] = await Promise.all([
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
  if (!can(principal, 'view', stock.RECONCILIATION_OBJECT)) {
    return <Denied object={page('stock_reconciliation')} />;
  }

  const view = await withCurrentUser(async (tx) => {
    const found = await stock.adjustmentView(tx, decodeURIComponent(rawNo));
    if (!found) return null;
    const ref = { object: stock.RECONCILIATION_OBJECT, recordId: found.id };
    return { ...found, notes: await recordNotes.listNotes(tx, ref), files: await readAttachments(tx, ref.object, ref.recordId) };
  });
  if (!view) notFound();

  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const qty = (value: string) => formatLocaleQuantity(value, locale as Locale);
  const mayAttach = can(principal, 'create', stock.RECONCILIATION_OBJECT);
  const mayReadJournal = can(principal, 'view', 'journal_entry');
  const direction = view.direction === 'in' ? t('reconciliation.in') : t('reconciliation.out');
  const status = !view.ledgerRecorded
    ? { text: t('reconciliation.no_ledger_entry'), chip: 'exception' }
    : view.journalEntryNo
      ? { text: statusName(view.journalStatus === 'reversed' ? 'reversed' : 'posted'), chip: view.journalStatus === 'reversed' ? 'reversed' : 'posted' }
      : { text: t('reconciliation.recorded'), chip: 'posted' };

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{view.adjustmentNo}</bdi> },
    { label: column('status'), value: status.text, status: status.chip },
    { label: column('item_name'), value: <ProfileLink code={view.itemCode} kind="item" name={view.itemName} /> },
    { label: column('warehouse'), value: <ProfileLink code={view.warehouseCode} kind="warehouse" name={view.warehouseName} /> },
    { label: column('branch_code'), value: <ProfileLink code={view.branchCode} kind="branch" /> },
    { label: column('date'), value: <bdi dir="ltr">{formatBusinessDate(view.adjustmentDate, locale as Locale)}</bdi> },
    { label: column('in_out'), value: direction },
    { label: column('adjustment_quantity'), value: <bdi dir="ltr">{`${qty(view.quantity)} ${view.uomCode}`}</bdi> },
    { label: t('reconciliation.value'), value: <bdi dir="ltr">{money(view.costIqd)}</bdi> },
    {
      label: t('reconciliation.journal'),
      value: view.journalEntryNo ? (
        mayReadJournal ? (
          <ProfileLink code={view.journalEntryNo} kind="journal" />
        ) : (
          <bdi dir="ltr">{view.journalEntryNo}</bdi>
        )
      ) : (
        '—'
      ),
    },
    {
      label: t('created_at'),
      value: <bdi dir="auto">{`${view.createdByName ?? '—'} · ${formatTimestamp(view.createdAt, locale as Locale)}`}</bdi>,
    },
  ];

  return (
    <AdminPage back={{ href: '/inventory/stock-reconciliation', label: page('stock_reconciliation') }} title={view.adjustmentNo} trail={[{ href: '/', label: t('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the moment it exists (2026-10-04). */}
            <ExportIcon exportKey="item_reconciliation" id={view.adjustmentNo} title={`${page('stock_reconciliation')} ${view.adjustmentNo}`} />
            <RecordAttachmentsDoor files={view.files} mayAttach={mayAttach} object={stock.RECONCILIATION_OBJECT} recordId={view.id} />
            <RecordNotesDoor notes={view.notes} object={stock.RECONCILIATION_OBJECT} recordId={view.id} />
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={view.id} objectType={stock.RECONCILIATION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('stock_reconciliation')}
        fields={fields}
        id="reconciliation"
        linesCount={view.layers.length}
        linesTitle={view.direction === 'in' ? t('reconciliation.lines_in') : t('reconciliation.lines_out')}
        number={view.adjustmentNo}
        totals={[
          { label: column('adjustment_quantity'), value: `${qty(view.quantity)} ${view.uomCode}` },
          { label: t('reconciliation.value'), value: money(view.costIqd) },
        ]}
      >
        <table aria-labelledby="reconciliation-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th scope="col">{column('batch_number')}</th>
              <th scope="col">{t('reconciliation.layer_date')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reconciliation.unit_cost')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('reconciliation.value')}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.layers.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={8}>
                  {t('reconciliation.no_layers')}
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

      {/* What the warehouse held, before and after — the Stock Ledger's own running balance. */}
      <section aria-labelledby="reconciliation-positions-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="reconciliation-positions-title">
            <span>{t('reconciliation.positions')}</span>
            <span className={s.sapTitleMeta}>{t('reconciliation.positions_note')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="reconciliation-positions-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('warehouse')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('reconciliation.before')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('reconciliation.moved')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('reconciliation.after')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.positions.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {t('reconciliation.no_layers')}
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

      {/* The journal it posted, for a reader who may read journals. */}
      {mayReadJournal && view.journalEntryNo ? (
        <section aria-labelledby="reconciliation-posting-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="reconciliation-posting-title">
              <span>{t('reconciliation.posting')}</span>
              <span className={s.sapTitleMeta}>
                <ProfileLink code={view.journalEntryNo} kind="journal" />
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="reconciliation-posting-title" className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{column('account')}</th>
                    <th className={s.sapNum} scope="col">
                      {column('debit')}
                    </th>
                    <th className={s.sapNum} scope="col">
                      {column('credit')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.journalLines.map((line) => (
                    <tr key={line.lineNo}>
                      <td>{line.lineNo}</td>
                      <td>
                        <ProfileLink code={line.accountCode} kind="gl_account" name={line.accountName} />
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(line.debitIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(line.creditIqd)}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
