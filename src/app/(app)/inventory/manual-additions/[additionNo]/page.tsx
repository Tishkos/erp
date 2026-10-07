import Link from 'next/link';
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
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as recordNotes from '@/server/services/record-notes';
import * as additions from '@/server/services/manual-stock-addition';
import {
  approveManualAddition,
  approveManualAdditionDraft,
  cancelManualAddition,
  rejectManualAddition,
  reopenManualAddition,
  submitManualAddition,
} from '../actions';

/**
 * One Manual Stock Addition — copies the Purchase Invoice record: the document
 * window with its fields and status chip, the step that comes next as its
 * actions (edit the draft, send it for approval, approve, reject, return to
 * draft, cancel), the lines; then, stacked underneath in the supplier
 * statement's manner, the FIFO layers the approval created and the journal it
 * posted (debit and credit). The four doors in its title bar from the draft
 * on: printer, paperclip, notes, clock. The warehouse, the items, the branch,
 * the accounts and the journal link to their own pages.
 */
export const dynamic = 'force-dynamic';

export default async function ManualAdditionRecordPage({ params, searchParams }: { params: Promise<{ additionNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/inventory/manual-additions')) notFound();
  const [{ additionNo: rawNo }, t, admin, page, column, status, locale, context, outcome] = await Promise.all([
    params,
    getTranslations('admin.manual_additions'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', additions.PERMISSION_OBJECT)) {
    return <Denied object={page('manual_stock_additions')} />;
  }

  const view = await withCurrentUser(async (tx) => {
    const found = await additions.viewByNo(tx, decodeURIComponent(rawNo));
    if (!found) return null;
    const ref = { object: additions.PERMISSION_OBJECT, recordId: found.document.id };
    return { ...found, notes: await recordNotes.listNotes(tx, ref), files: await readAttachments(tx, ref.object, ref.recordId) };
  });
  if (!view) notFound();
  const { document: doc, lines, layers, journalLines } = view;

  const qty = (value: string) => formatLocaleQuantity(value, locale as Locale);
  // The ledger's own figures — four places kept, trailing zeros dropped — so the lines, the layers and the journal add up where a reader can check them.
  const money = (value: string) => `${qty(value)} IQD`;
  const when = (value: string | null) => (value ? formatTimestamp(value, locale as Locale) : '—');
  const who = (name: string | null, at: string | null) => <bdi dir="auto">{`${name ?? '—'} · ${when(at)}`}</bdi>;

  const own = doc.createdBy === principal.userId || doc.submittedBy === principal.userId;
  const mayEdit = doc.status === 'draft' && can(principal, 'edit_draft', additions.PERMISSION_OBJECT);
  const maySubmit = doc.status === 'draft' && can(principal, 'submit', additions.PERMISSION_OBJECT);
  // A super user's own draft has no Send for approval: one press records both steps (0278, as the purchase invoice).
  const approvesDirectly =
    doc.status === 'draft' && principal.isSuperUser && doc.createdBy === principal.userId && can(principal, 'approve', additions.PERMISSION_OBJECT);
  const mayDecide = doc.status === 'submitted' && can(principal, 'approve', additions.PERMISSION_OBJECT);
  const mayApprove = mayDecide && (!own || principal.isSuperUser);
  const mayReopen = doc.status === 'rejected' && can(principal, 'edit_draft', additions.PERMISSION_OBJECT);
  const mayCancel = (doc.status === 'draft' || doc.status === 'rejected') && can(principal, 'edit_draft', additions.PERMISSION_OBJECT);
  const mayReadJournal = can(principal, 'view', 'journal_entry');
  const statusText = status.has(doc.status) ? status(doc.status) : doc.status;

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{doc.additionNo}</bdi> },
    { label: column('status'), value: statusText, status: doc.status },
    { label: t('warehouse'), value: <ProfileLink code={doc.warehouseCode} kind="warehouse" name={doc.warehouseName} /> },
    { label: column('branch_code'), value: <ProfileLink code={doc.branchCode} kind="branch" /> },
    { label: t('posting_date'), value: <bdi dir="ltr">{formatBusinessDate(doc.postingDate, locale as Locale)}</bdi> },
    {
      label: t('offset_account'),
      value: doc.offsetAccountCode ? (
        <ProfileLink code={doc.offsetAccountCode} kind="gl_account" name={doc.offsetAccountName} />
      ) : (
        t('offset_default')
      ),
    },
    ...(doc.departmentCode
      ? [{ label: t('department'), value: <ProfileLink code={doc.departmentCode} kind="department" name={doc.departmentName} /> }]
      : []),
    { label: t('reason'), wide: true, value: <bdi dir="auto">{doc.reason}</bdi> },
    { label: t('created'), value: who(doc.createdByName, doc.createdAt) },
    ...(doc.submittedAt ? [{ label: t('submitted'), value: who(doc.submittedByName, doc.submittedAt) }] : []),
    ...(doc.approvedAt ? [{ label: t('approved'), value: who(doc.approvedByName, doc.approvedAt) }] : []),
    ...(doc.rejectedAt
      ? [{ label: t('rejected'), wide: true, value: <bdi dir="auto">{`${doc.rejectedByName ?? '—'} · ${when(doc.rejectedAt)} · ${doc.rejectionReason ?? ''}`}</bdi> }]
      : []),
    ...(doc.cancelledAt
      ? [{ label: t('cancelled'), wide: true, value: <bdi dir="auto">{`${doc.cancelledByName ?? '—'} · ${when(doc.cancelledAt)} · ${doc.cancellationReason ?? ''}`}</bdi> }]
      : []),
    {
      label: t('journal'),
      value: doc.journalEntryNo ? (
        mayReadJournal ? <ProfileLink code={doc.journalEntryNo} kind="journal" /> : <bdi dir="ltr">{doc.journalEntryNo}</bdi>
      ) : (
        '—'
      ),
    },
  ];

  const hidden = (
    <>
      <Hidden name="id" value={doc.id} />
      <Hidden name="addition_no" value={doc.additionNo} />
    </>
  );

  const journalTotal = (side: 'debitIqd' | 'creditIqd') =>
    toDecimalString(journalLines.reduce((sum, line) => sum + parseDecimal(line[side], MONEY_SCALE), 0n), MONEY_SCALE);
  const nil = (value: string) => /^0(\.0+)?$/.test(value);

  return (
    <AdminPage back={{ href: '/inventory/manual-additions', label: admin('back') }} title={doc.additionNo} trail={[{ href: '/', label: admin('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      {mayDecide && own && !principal.isSuperUser ? (
        <p className={s.sapNote} role="status">
          {t('own_cannot_approve')}
        </p>
      ) : null}

      <DocumentWindow
        actions={
          <>
            {mayEdit ? (
              <Link className="action" href={`/inventory/manual-additions/new?draft=${encodeURIComponent(doc.additionNo)}`}>
                {t('edit_draft')}
              </Link>
            ) : null}
            {approvesDirectly ? (
              <form action={approveManualAdditionDraft}>
                {hidden}
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : maySubmit ? (
              <form action={submitManualAddition}>
                {hidden}
                <Submit label={t('submit')} variant="document" />
              </form>
            ) : null}
            {mayApprove ? (
              <form action={approveManualAddition}>
                {hidden}
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayDecide ? (
              <form action={rejectManualAddition}>
                {hidden}
                <input aria-label={admin('reason')} name="reason" placeholder={t('reject_reason')} required type="text" />
                <Submit label={t('reject')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayReopen ? (
              <form action={reopenManualAddition}>
                {hidden}
                <Submit label={t('reopen')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelManualAddition}>
                {hidden}
                <input aria-label={admin('reason')} name="reason" placeholder={t('cancel_reason')} required type="text" />
                <Submit label={t('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the draft on (the standing order, 2026-10-03). */}
            <ExportIcon exportKey="manual_stock_addition" id={doc.additionNo} title={`${page('manual_stock_addition')} ${doc.additionNo}`} />
            <RecordAttachmentsDoor
              files={view.files}
              mayAttach={can(principal, 'create', additions.PERMISSION_OBJECT) && doc.status !== 'cancelled'}
              object={additions.PERMISSION_OBJECT}
              recordId={doc.id}
            />
            <RecordNotesDoor notes={view.notes} object={additions.PERMISSION_OBJECT} recordId={doc.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={doc.id} objectType={additions.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('manual_stock_addition')}
        fields={fields}
        id="manual-addition"
        linesCount={lines.length}
        linesTitle={t('lines')}
        number={doc.additionNo}
        totals={[{ label: t('total'), value: money(view.totalIqd) }]}
      >
        <table aria-labelledby="manual-addition-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th scope="col">{t('unit')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('unit_price')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('line_value')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('base_quantity')}
              </th>
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
                  <bdi dir="auto">{line.itemName}</bdi>
                </td>
                <td>
                  <ProfileLink code={line.uomCode} kind="uom" />
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{qty(line.quantity)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.unitCostIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.lineValueIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{line.baseQuantity ? `${qty(line.baseQuantity)} ${line.baseUomCode}` : '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* The FIFO layers the approval created — one a line, in the base unit, at the cost of one base unit. */}
      <section aria-labelledby="manual-addition-layers-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="manual-addition-layers-title">
            <span>{t('layers')}</span>
            <span className={s.sapTitleMeta}>{t('layers_note')}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table aria-labelledby="manual-addition-layers-title" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{column('item_code')}</th>
                  <th scope="col">{column('batch_number')}</th>
                  <th scope="col">{t('layer_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('quantity')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('unit_cost')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('value')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {layers.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('no_layers')}
                    </td>
                  </tr>
                ) : null}
                {layers.map((layer) => {
                  const line = lines.find((candidate) => candidate.lineNo === layer.lineNo);
                  return (
                    <tr key={layer.movementId}>
                      <td>{layer.lineNo}</td>
                      <td>
                        <ProfileLink code={layer.itemCode} kind="item" />
                      </td>
                      <td>
                        <bdi dir="ltr">{layer.batchNumber ?? '—'}</bdi>
                      </td>
                      <td>
                        <bdi dir="ltr">{formatBusinessDate(layer.layerDate, locale as Locale)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{`${qty(layer.quantity)} ${line?.baseUomCode ?? ''}`}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(layer.unitCostIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(layer.valueIqd)}</bdi>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {layers.length > 0 ? (
                <tfoot>
                  <tr>
                    <td colSpan={6}>
                      <strong>{t('total')}</strong>
                    </td>
                    <td className={s.sapNum}>
                      <strong>
                        <bdi dir="ltr">{money(view.postedIqd)}</bdi>
                      </strong>
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </div>
      </section>

      {/* The journal the approval posted — every debit and credit, totalled — for a reader who may read journals. */}
      {mayReadJournal ? (
        <section aria-labelledby="manual-addition-entries-title" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="manual-addition-entries-title">
              <span>{t('entries')}</span>
              <span className={s.sapTitleMeta}>
                {doc.journalEntryNo ? <ProfileLink code={doc.journalEntryNo} kind="journal" /> : t('entries_pending')}
              </span>
            </h2>
            <div className={s.sapTableWrap}>
              <table aria-labelledby="manual-addition-entries-title" className={s.sapTable}>
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
                  {journalLines.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={4}>
                        {t('no_entries')}
                      </td>
                    </tr>
                  ) : null}
                  {journalLines.map((line) => (
                    <tr key={line.lineNo}>
                      <td>{line.lineNo}</td>
                      <td className={s.sapAccountCell}>
                        <ProfileLink code={line.accountCode} dir="auto" kind="gl_account" name={line.accountName} />
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{nil(line.debitIqd) ? '' : money(line.debitIqd)}</bdi>
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{nil(line.creditIqd) ? '' : money(line.creditIqd)}</bdi>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {journalLines.length > 0 ? (
                  <tfoot>
                    <tr>
                      <td colSpan={2}>
                        <strong>{admin('journals.balanced')}</strong>
                      </td>
                      <td className={s.sapNum}>
                        <strong>
                          <bdi dir="ltr">{money(journalTotal('debitIqd'))}</bdi>
                        </strong>
                      </td>
                      <td className={s.sapNum}>
                        <strong>
                          <bdi dir="ltr">{money(journalTotal('creditIqd'))}</bdi>
                        </strong>
                      </td>
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </div>
        </section>
      ) : null}
    </AdminPage>
  );
}
