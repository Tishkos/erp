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
import { formatBusinessDate, formatQuantity as formatLocaleQuantity, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as counts from '@/server/services/stock-count';
import * as departments from '@/server/services/departments';
import * as recordNotes from '@/server/services/record-notes';
import { adjustCount, approveVariance, cancelCount, recordCount, requestRecount } from '../actions';

/**
 * One stock count — §9.6 on the existing engine. Copies the Purchase Invoice
 * page: the document window with its fields, the status chip, the step that
 * comes next as its actions (count, recount or approve, adjust, cancel), the
 * lines with the book quantity, what was found and the variance. The four
 * doors in its title bar from the plan on — printer, paperclip, notes, clock
 * — and the warehouse and the items as links to their own pages.
 *
 * Counting is done on the lines themselves: while the count is planned (or
 * sent back for a recount) each line carries a box for what was found and a
 * note, and one Submit at the foot records them all.
 */
export const dynamic = 'force-dynamic';

export default async function StockCountRecordPage({ params, searchParams }: { params: Promise<{ countNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/stock-count')) notFound();
  const [t, admin, page, column, locale, context, outcome, { countNo: rawNo }] = await Promise.all([
    getTranslations('admin.stock_count'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const countNo = decodeURIComponent(rawNo);
  const { principal } = context;
  if (!can(principal, 'view', counts.PERMISSION_OBJECT)) {
    return <Denied object={page('stock_count')} />;
  }
  const view = await withCurrentUser(async (tx) => {
    const found = await counts.viewByNo(tx, countNo);
    if (!found) return null;
    const ref = { object: counts.PERMISSION_OBJECT, recordId: found.count.id };
    return {
      ...found,
      notes: await recordNotes.listNotes(tx, ref),
      files: await readAttachments(tx, ref.object, ref.recordId),
      // The adjustment posts to the inventory adjustment account, which may ask for a department (§4.2).
      departments: found.count.status === 'pending_approval' ? (await departments.listAll(tx)).filter((d) => d.active) : [],
    };
  });
  if (!view) notFound();
  const { count, lines } = view;
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const when = (value: string | null) => (value ? formatTimestamp(new Date(value).toISOString(), locale as Locale) : '—');
  const qty = (value: string | null) => (value === null ? '—' : formatLocaleQuantity(value, locale as Locale));
  const today = businessToday();

  const mayExecute = can(principal, 'execute', counts.PERMISSION_OBJECT);
  const mayApprove = can(principal, 'approve', counts.PERMISSION_OBJECT);
  const counting = mayExecute && (count.status === 'planned' || count.status === 'recount');
  const mayRecount = mayExecute && count.status === 'counted';
  const mayApproveVariance = mayApprove && count.status === 'counted';
  const mayAdjust = mayExecute && count.status === 'pending_approval';
  const mayCancel = mayExecute && count.status !== 'adjusted' && count.status !== 'cancelled';
  const variances = lines.filter((line) => line.variance !== null && line.variance !== '0' && Number(line.variance) !== 0).length;

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{count.countNo}</bdi> },
    { label: column('status'), value: t(`status.${count.status}`), status: count.status },
    { label: column('warehouse'), value: <ProfileLink code={count.warehouseCode} kind="warehouse" name={count.warehouseName} /> },
    { label: column('branch_code'), value: <bdi dir="ltr">{count.branchCode}</bdi> },
    { label: t('scope'), value: <bdi dir="auto">{`${t(`scope_${count.scope}`)}${count.scopeFilter ? ` · ${count.scopeFilter}` : ''}`}</bdi> },
    { label: t('planned_on'), value: <bdi dir="auto">{`${day(count.plannedOn)} · ${count.plannedByName ?? '—'}`}</bdi> },
    ...(count.countedOn ? [{ label: t('counted_on'), value: <bdi dir="auto">{`${day(count.countedOn)} · ${count.countedByName ?? '—'}`}</bdi> }] : []),
    ...(count.approvedAt
      ? [{ label: t('approved_by'), value: <bdi dir="auto">{`${count.approvedByName ?? '—'} · ${when(count.approvedAt)} · ${count.approvalReason ?? ''}`}</bdi> }]
      : []),
    ...(count.adjustedOn ? [{ label: t('adjusted_on'), value: <bdi dir="ltr">{day(count.adjustedOn)}</bdi> }] : []),
  ];

  const linesTable = (
    <table aria-labelledby="stock-count-lines-heading" className={s.sapTable}>
      <thead>
        <tr>
          <th scope="col">#</th>
          <th scope="col">{column('item_code')}</th>
          <th scope="col">{column('item_name')}</th>
          <th scope="col">{column('batch_number')}</th>
          <th className={s.sapNum} scope="col">
            {t('book_quantity')}
          </th>
          <th className={s.sapNum} scope="col">
            {t('counted_quantity')}
          </th>
          <th className={s.sapNum} scope="col">
            {t('recount_quantity')}
          </th>
          <th className={s.sapNum} scope="col">
            {t('variance')}
          </th>
          <th scope="col">{t('note')}</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.id}>
            <td>{line.lineNo}</td>
            <td>
              <ProfileLink code={line.itemCode} kind="item" />
            </td>
            <td>
              <bdi dir="auto">{line.itemName ?? '—'}</bdi>
            </td>
            <td>
              <bdi dir="ltr">{line.batchNumber ?? line.serialNumber ?? '—'}</bdi>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{`${qty(line.systemQuantity)}${line.uomCode ? ` ${line.uomCode}` : ''}`}</bdi>
            </td>
            <td className={s.sapNum}>
              {counting && count.status === 'planned' ? (
                <input aria-label={`${t('counted_quantity')} ${line.lineNo}`} className={s.sapCellField} defaultValue={line.countedQuantity ?? ''} inputMode="decimal" name={`qty_${line.lineNo}`} />
              ) : (
                <bdi dir="ltr">{qty(line.countedQuantity)}</bdi>
              )}
            </td>
            <td className={s.sapNum}>
              {counting && count.status === 'recount' ? (
                <input aria-label={`${t('recount_quantity')} ${line.lineNo}`} className={s.sapCellField} defaultValue={line.recountQuantity ?? ''} inputMode="decimal" name={`qty_${line.lineNo}`} />
              ) : (
                <bdi dir="ltr">{qty(line.recountQuantity)}</bdi>
              )}
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{qty(line.variance)}</bdi>
            </td>
            <td>
              {counting ? (
                <input aria-label={`${t('note')} ${line.lineNo}`} className={s.sapCellField} defaultValue={line.note ?? ''} name={`note_${line.lineNo}`} />
              ) : (
                <bdi dir="auto">{line.note ?? '—'}</bdi>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <AdminPage back={{ href: '/inventory/stock-count', label: admin('back') }} title={count.countNo} trail={[{ href: '/', label: admin('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayRecount ? (
              <form action={requestRecount}>
                <Hidden name="id" value={count.id} />
                <Hidden name="count_no" value={count.countNo} />
                <input aria-label={admin('reason')} name="reason" placeholder={t('recount_reason')} required type="text" />
                <Submit label={t('request_recount')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayApproveVariance ? (
              <form action={approveVariance}>
                <Hidden name="id" value={count.id} />
                <Hidden name="count_no" value={count.countNo} />
                <input aria-label={admin('reason')} name="reason" placeholder={t('approval_reason')} required type="text" />
                <Submit label={t('approve_variance')} variant="document" />
              </form>
            ) : null}
            {mayAdjust ? (
              <form action={adjustCount}>
                <Hidden name="id" value={count.id} />
                <Hidden name="count_no" value={count.countNo} />
                <input aria-label={t('adjusted_on')} defaultValue={today} name="adjusted_on" required type="date" />
                <select aria-label={t('department')} name="department_code">
                  <option value="">{t('department')}</option>
                  {view.departments.map((d) => (
                    <option key={d.code} value={d.code}>{`${d.code} · ${d.name}`}</option>
                  ))}
                </select>
                <Submit label={t('adjust')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelCount}>
                <Hidden name="id" value={count.id} />
                <Hidden name="count_no" value={count.countNo} />
                <input aria-label={admin('reason')} name="reason" placeholder={t('cancel_reason')} required type="text" />
                <Submit label={t('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the plan on (2026-10-04). */}
            <ExportIcon exportKey="stock_count" id={count.countNo} title={`${page('stock_count')} ${count.countNo}`} />
            <RecordAttachmentsDoor files={view.files} mayAttach={mayExecute && count.status !== 'cancelled'} object={counts.PERMISSION_OBJECT} recordId={count.id} />
            <RecordNotesDoor notes={view.notes} object={counts.PERMISSION_OBJECT} recordId={count.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={count.id} objectType={counts.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('stock_count')}
        fields={fields}
        id="stock-count"
        linesCount={lines.length}
        linesTitle={t('lines')}
        number={count.countNo}
        totals={[{ label: t('variances'), value: String(variances) }]}
      >
        {counting ? (
          <form action={recordCount}>
            <Hidden name="id" value={count.id} />
            <Hidden name="count_no" value={count.countNo} />
            {linesTable}
            <div className={s.sapFootActions}>
              <label>
                {t('counted_on')} <input defaultValue={today} name="counted_on" required type="date" />
              </label>
              <Submit label={count.status === 'recount' ? t('record_recount') : t('record_count')} variant="document" />
            </div>
          </form>
        ) : (
          linesTable
        )}
      </DocumentWindow>
    </AdminPage>
  );
}
