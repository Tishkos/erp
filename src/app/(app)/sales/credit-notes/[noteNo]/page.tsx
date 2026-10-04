import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { Attachments } from '@/components/admin/attachments';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { ExportIcon } from '@/components/print/export-menu';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as attachmentsService from '@/server/services/attachments';
import * as notes from '@/server/services/customer-notes';
import { approveNote, attachToNote, cancelNote, postNote, reverseNote } from '../actions';

/**
 * One credit or debit note — Receivables, 2026-10-04 — or one credit memo,
 * which the register lists beside them and which opens here read-only.
 *
 * The Purchase Invoice's record: the document window with its four doors in
 * the title bar (printer, paperclip, clock — a note keeps no notes log), its
 * header fields, the actions row, and as its lines what it has been applied
 * to (a credit) or settled by (a debit). Applying a credit's remainder is
 * Customer Credits & Advances' work, and the row links there.
 */
export const dynamic = 'force-dynamic';

export default async function NotePage({
  params,
  searchParams,
}: {
  params: Promise<{ noteNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/credit-notes')) notFound();

  const [t, admin, page, column, status, locale, context, outcome, { noteNo }] = await Promise.all([
    getTranslations('admin.customer_notes'),
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
  if (!can(principal, 'view', notes.PERMISSION_OBJECT)) {
    return <Denied object={page('customer_credit_memos')} />;
  }

  const number = decodeURIComponent(noteNo);
  const found = await withCurrentUser(async (tx) => {
    const note = await notes.viewByNo(tx, number);
    if (note) {
      return { note, memo: null, attached: await attachmentsService.currentFor(tx, notes.ATTACHMENT_OBJECT, note.id) };
    }
    const memo = await notes.memoByNo(tx, number);
    if (memo) {
      return { note: null, memo, attached: await attachmentsService.currentFor(tx, 'customer_credit_memo', memo.id) };
    }
    return null;
  });
  if (!found) notFound();

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const mayAttach = can(principal, 'create', 'attachment');
  const statusLabel = (value: string) => (status.has(value) ? status(value) : value);

  // ── A credit memo: read-only, worked from its return ───────────────────────
  if (found.memo) {
    const memo = found.memo;
    const remaining = parseDecimal(memo.amountIqd, MONEY_SCALE) - parseDecimal(memo.allocatedIqd, MONEY_SCALE);
    const fields: DocumentField[] = [
      { label: column('document_no'), value: <bdi dir="ltr">{memo.memoNo}</bdi> },
      { label: column('status'), value: statusLabel(memo.status), status: memo.status },
      { label: t('kind'), value: t('register_credit_memo') },
      { label: column('customer_code'), value: <bdi dir="ltr">{memo.customerCode}</bdi> },
      { label: column('customer_name'), value: <bdi dir="auto">{memo.customerName}</bdi> },
      { label: column('posting_date'), value: <bdi dir="ltr">{day(memo.memoDate)}</bdi> },
      {
        label: column('invoice_no'),
        value: memo.invoiceNo ? (
          <Link className={s.sapLink} href={`/sales/ar-invoices/${encodeURIComponent(memo.invoiceNo)}`}>
            <bdi dir="ltr">{memo.invoiceNo}</bdi>
          </Link>
        ) : (
          '—'
        ),
      },
      {
        label: t('sales_return'),
        value: (
          <Link className={s.sapLink} href={`/sales/sales-returns/${encodeURIComponent(memo.returnNo)}`}>
            <bdi dir="ltr">{memo.returnNo}</bdi>
          </Link>
        ),
      },
      {
        label: t('journal_entry'),
        value: memo.journalEntryNo ? (
          <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(memo.journalEntryNo)}`}>
            <bdi dir="ltr">{memo.journalEntryNo}</bdi>
          </Link>
        ) : (
          '—'
        ),
      },
      { label: column('branch_code'), value: <bdi dir="ltr">{memo.branchCode}</bdi> },
      { label: t('memo_note'), value: t('memo_hint'), wide: true },
    ];
    return (
      <AdminPage
        back={{ href: '/sales/credit-notes', label: admin('back') }}
        title={memo.memoNo}
        trail={[{ href: '/', label: admin('dashboard_label') }]}
        variant="sap"
      >
        <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
        <DocumentWindow
          documentType={t('register_credit_memo')}
          fields={fields}
          id="memo-document"
          linesCount={memo.applications.length}
          linesTitle={t('applied_to')}
          number={memo.memoNo}
          titleActions={
            <>
              <ExportIcon exportKey="customer_note" id={memo.memoNo} title={`${t('register_credit_memo')} ${memo.memoNo}`} />
              <AttachmentsButton
                closeLabel={admin('close')}
                count={found.attached.length}
                label={admin('attachments.title')}
                title={admin('attachments.title')}
              >
                <Attachments
                  action={attachToNote}
                  hidden={{ note_no: memo.memoNo }}
                  mayAttach={mayAttach}
                  objectId={memo.id}
                  objectType="customer_credit_memo"
                />
              </AttachmentsButton>
              <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
                <RecordHistory objectId={memo.id} objectType="customer_credit_memo" />
              </HistoryButton>
            </>
          }
          totals={[
            { label: column('amount'), value: money(memo.amountIqd) },
            { label: t('applied'), value: money(memo.allocatedIqd) },
            { label: t('remaining'), value: money(toDecimalString(remaining, MONEY_SCALE)) },
          ]}
        >
          <ApplicationsTable
            column={column}
            day={day}
            empty={t('no_applications')}
            headingId="memo-document-lines-heading"
            money={money}
            rows={memo.applications.map((row) => ({ id: row.id, date: row.appliedOn, document: row.targetNo, kind: row.targetKind, amount: row.amountIqd }))}
            targetLabel={t('applied_to')}
          />
        </DocumentWindow>
      </AdminPage>
    );
  }

  // ── A credit or debit note ─────────────────────────────────────────────────
  const note = found.note!;
  const credit = note.kind === 'credit';
  const outstanding = parseDecimal(note.outstandingIqd, MONEY_SCALE);
  const mayApprove = note.status === 'draft' && can(principal, 'approve', notes.PERMISSION_OBJECT);
  const mayCancel = note.status === 'draft' && can(principal, 'edit_draft', notes.PERMISSION_OBJECT);
  const mayPost = note.status === 'approved' && can(principal, 'post', notes.PERMISSION_OBJECT);
  const mayReverse =
    note.status === 'posted' &&
    parseDecimal(note.allocatedIqd, MONEY_SCALE) === 0n &&
    can(principal, 'reverse_cancel', notes.PERMISSION_OBJECT);
  const mayApplyCredit =
    credit && notes.isOpen(note.status) && outstanding > 0n && can(principal, 'execute', notes.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{note.noteNo}</bdi> },
    { label: column('status'), value: statusLabel(note.status), status: note.status },
    { label: t('kind'), value: t(`kind_${note.kind}`) },
    { label: column('customer_code'), value: <bdi dir="ltr">{note.customerCode}</bdi> },
    { label: column('customer_name'), value: <bdi dir="auto">{note.customerName}</bdi> },
    { label: column('posting_date'), value: <bdi dir="ltr">{day(note.noteDate)}</bdi> },
    { label: column('due_date'), value: <bdi dir="ltr">{credit ? '—' : day(note.dueDate)}</bdi> },
    {
      label: column('invoice_no'),
      value: note.invoiceNo ? (
        <Link className={s.sapLink} href={`/sales/ar-invoices/${encodeURIComponent(note.invoiceNo)}`}>
          <bdi dir="ltr">{note.invoiceNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    {
      label: t(credit ? 'account_credit' : 'account_debit'),
      value: (
        <bdi dir="auto">
          {note.accountCode ? `${note.accountCode} · ${note.accountName ?? ''}` : admin('invoices.account_default')}
        </bdi>
      ),
    },
    {
      label: t('journal_entry'),
      value: note.journalEntryNo ? (
        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(note.journalEntryNo)}`}>
          <bdi dir="ltr">{note.journalEntryNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    { label: t('raised_by'), value: <bdi dir="auto">{note.raisedBy ?? '—'}</bdi> },
    { label: t('approved_by'), value: <bdi dir="auto">{note.approvedByName ?? admin('none')}</bdi> },
    { label: t('posted_by'), value: <bdi dir="auto">{note.postedByName ?? admin('none')}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{note.branchCode}</bdi> },
    { label: t('reason'), value: <bdi dir="auto">{note.reason}</bdi>, wide: true },
    ...(note.description ? [{ label: t('description'), value: <bdi dir="auto">{note.description}</bdi>, wide: true }] : []),
    ...(note.reversalReason
      ? [
          {
            label: t('reversal'),
            value: (
              <bdi dir="auto">
                {note.reversalEntryNo ? `${note.reversalEntryNo} — ` : ''}
                {note.reversalReason}
              </bdi>
            ),
            wide: true,
          },
        ]
      : []),
  ];

  return (
    <AdminPage
      back={{ href: '/sales/credit-notes', label: admin('back') }}
      title={note.noteNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveNote}>
                <input name="id" type="hidden" value={note.id} />
                <input name="note_no" type="hidden" value={note.noteNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postNote}>
                <input name="id" type="hidden" value={note.id} />
                <input name="note_no" type="hidden" value={note.noteNo} />
                <Submit label={t('post')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelNote}>
                <input name="id" type="hidden" value={note.id} />
                <input name="note_no" type="hidden" value={note.noteNo} />
                <input aria-label={admin('reason')} name="reason" placeholder={admin('reason_placeholder')} required type="text" />
                <Submit label={t('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayReverse ? (
              <form action={reverseNote} title={t('reverse_hint')}>
                <input name="id" type="hidden" value={note.id} />
                <input name="note_no" type="hidden" value={note.noteNo} />
                <input aria-label={admin('reason')} name="reason" placeholder={admin('invoices.reverse_reason')} required type="text" />
                <Submit label={t('reverse')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayApplyCredit ? (
              <Link className="action" href={`/sales/customer-credits?credit=${encodeURIComponent(note.noteNo)}#apply`}>
                {t('apply_remaining')}
              </Link>
            ) : null}
          </>
        }
        documentType={t(`kind_${note.kind}`)}
        fields={fields}
        id="note-document"
        linesCount={note.applications.length}
        linesTitle={t(credit ? 'applied_to' : 'settled_by')}
        number={note.noteNo}
        titleActions={
          <>
            {/* Printer, paperclip, clock — the standing order (2026-10-03). */}
            <ExportIcon exportKey="customer_note" id={note.noteNo} title={`${t(`kind_${note.kind}`)} ${note.noteNo}`} />
            <AttachmentsButton
              closeLabel={admin('close')}
              count={found.attached.length}
              label={admin('attachments.title')}
              title={admin('attachments.title')}
            >
              <Attachments
                action={attachToNote}
                hidden={{ note_no: note.noteNo }}
                mayAttach={mayAttach}
                objectId={note.id}
                objectType={notes.ATTACHMENT_OBJECT}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              {/* The note's events are the credit memo object's (it governs
                  notes); its files are filed under its own, so they are named. */}
              <RecordHistory
                objectId={note.id}
                objectType={notes.PERMISSION_OBJECT}
                related={[{ objectType: 'attachment', field: 'parent', value: `${notes.ATTACHMENT_OBJECT}:${note.id}` }]}
              />
            </HistoryButton>
          </>
        }
        totals={[
          { label: column('amount'), value: money(note.amountIqd) },
          { label: t(credit ? 'applied' : 'received'), value: money(note.allocatedIqd) },
          { label: t('remaining'), value: money(note.outstandingIqd) },
        ]}
      >
        <ApplicationsTable
          column={column}
          day={day}
          empty={t('no_applications')}
          headingId="note-document-lines-heading"
          money={money}
          rows={note.applications.map((row) => ({
            id: row.id,
            date: row.appliedOn,
            document: credit ? row.targetNo : row.sourceNo,
            kind: credit ? row.targetKind : row.sourceKind,
            amount: row.amountIqd,
          }))}
          targetLabel={t(credit ? 'applied_to' : 'settled_by')}
        />
      </DocumentWindow>
    </AdminPage>
  );
}

const ROUTE_OF: Readonly<Record<string, string>> = {
  invoice: '/sales/ar-invoices',
  debit_note: '/sales/credit-notes',
  receipt: '/sales/customer-receipts',
  credit_memo: '/sales/credit-notes',
  credit_note: '/sales/credit-notes',
};

/** The note's lines: each application, its date, the other document, the amount. */
function ApplicationsTable({
  rows,
  headingId,
  targetLabel,
  empty,
  column,
  day,
  money,
}: {
  readonly rows: readonly { id: string; date: string; document: string; kind: string; amount: string }[];
  readonly headingId: string;
  readonly targetLabel: string;
  readonly empty: string;
  readonly column: (key: string) => string;
  readonly day: (value: string) => string;
  readonly money: (value: string) => string;
}) {
  return (
    <table aria-labelledby={headingId} className={s.sapTable}>
      <thead>
        <tr>
          <th scope="col">{column('date')}</th>
          <th scope="col">{targetLabel}</th>
          <th className={s.sapNum} scope="col">
            {column('amount')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className={s.sapEmptyRow} colSpan={3}>
              {empty}
            </td>
          </tr>
        ) : null}
        {rows.map((row) => (
          <tr key={row.id}>
            <td>
              <bdi dir="ltr">{day(row.date)}</bdi>
            </td>
            <td className={s.sapAccountCell}>
              <Link className={s.sapLink} href={`${ROUTE_OF[row.kind] ?? '/sales/credit-notes'}/${encodeURIComponent(row.document)}`}>
                <bdi dir="ltr">{row.document}</bdi>
              </Link>
            </td>
            <td className={s.sapNum}>
              <bdi dir="ltr">{money(row.amount)}</bdi>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
