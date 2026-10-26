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
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { formatBusinessDate, formatMoney, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payments from '@/server/services/customer-payment';
import * as recordNotes from '@/server/services/record-notes';
import { approvePostCustomerPayment, cancelCustomerPayment, postCustomerPayment, reverseCustomerPayment } from '../actions';

/**
 * One Customer Payment (0428) — the Manual Stock Addition's record in its manner: the document
 * window with its fields and status chip, the step that comes next as its actions (Approve and post
 * by somebody other than the writer — a super user alone excepted —, Post, Cancel with a reason,
 * Reverse with a reason), and as its lines how it posts: Dr the customer's receivable / Cr the
 * account the money left. The four doors in its title bar from the draft on.
 */
export const dynamic = 'force-dynamic';

export default async function CustomerPaymentPage({ params, searchParams }: { params: Promise<{ paymentNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-payments')) notFound();
  const [{ paymentNo: rawNo }, t, admin, page, column, status, locale, context, outcome] = await Promise.all([
    params,
    getTranslations('admin.money_out'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', payments.PERMISSION_OBJECT)) return <Denied object={page('customer_payments')} />;

  const view = await withCurrentUser(async (tx) => {
    const row = await payments.viewByNo(tx, decodeURIComponent(rawNo));
    if (!row) return null;
    const ref = { object: payments.PERMISSION_OBJECT, recordId: row.id };
    return { row, notes: await recordNotes.listNotes(tx, ref), files: await readAttachments(tx, ref.object, ref.recordId) };
  });
  if (!view) notFound();
  const { row } = view;

  const money = (value: string, currency: string) => formatMoney(value, currency, locale as Locale);
  const when = (value: Date | string | null) => (value ? formatTimestamp(typeof value === 'string' ? value : value.toISOString(), locale as Locale) : '—');
  const who = (name: string | null, at: Date | string | null) => <bdi dir="auto">{`${name ?? '—'} · ${when(at)}`}</bdi>;
  const accountKind = row.accountType === 'cash' ? 'cash_account' : 'bank_account';
  const own = row.createdBy === principal.userId;
  const mayApprovePost =
    row.status === 'draft' && can(principal, 'approve', payments.PERMISSION_OBJECT) && can(principal, 'post', payments.PERMISSION_OBJECT) && (!own || principal.isSuperUser);
  const mayPost = row.status === 'approved' && can(principal, 'post', payments.PERMISSION_OBJECT);
  const mayCancel = (row.status === 'draft' || row.status === 'approved') && can(principal, 'edit_draft', payments.PERMISSION_OBJECT);
  const mayReverse = row.status === 'posted' && can(principal, 'reverse_cancel', payments.PERMISSION_OBJECT);
  const mayReadJournal = can(principal, 'view', 'journal_entry');
  const journal = (entryNo: string | null) =>
    entryNo ? mayReadJournal ? <ProfileLink code={entryNo} kind="journal" /> : <bdi dir="ltr">{entryNo}</bdi> : '—';

  const fields: DocumentField[] = [
    { label: column('document_no'), value: <bdi dir="ltr">{row.paymentNo}</bdi> },
    { label: column('status'), value: status.has(row.status) ? status(row.status) : row.status, status: row.status },
    { label: column('customer_code'), value: <ProfileLink code={row.customerCode} kind="customer" /> },
    { label: column('customer_name'), value: <ProfileLink code={row.customerCode} dir="auto" kind="customer">{row.customerName}</ProfileLink> },
    { label: column('posting_date'), value: <bdi dir="ltr">{formatBusinessDate(row.paymentDate, locale as Locale)}</bdi> },
    { label: column('bank_code'), value: <ProfileLink code={row.accountCode} kind={accountKind} /> },
    { label: column('bank_name'), value: <ProfileLink code={row.accountCode} dir="auto" kind={accountKind}>{row.accountName}</ProfileLink> },
    { label: t('amount'), value: <bdi dir="ltr">{money(row.amount, row.currency)}</bdi> },
    ...(row.currency === 'IQD' ? [] : [{ label: t('amount_iqd'), value: <bdi dir="ltr">{money(row.amountIqd, 'IQD')}</bdi> }]),
    { label: t('payment_method'), value: <bdi dir="auto">{row.paymentMethodCode ?? t('payment_method_none')}</bdi> },
    { label: t('reference'), value: <bdi dir="auto">{row.reference ?? '—'}</bdi> },
    { label: t('purpose'), wide: true, value: <bdi dir="auto">{row.purpose}</bdi> },
    ...(row.note ? [{ label: t('note'), wide: true, value: <bdi dir="auto">{row.note}</bdi> }] : []),
    { label: t('written_by'), value: who(row.createdByName, row.createdAt) },
    ...(row.approvedAt ? [{ label: t('approved_by'), value: who(row.approvedByName, row.approvedAt) }] : []),
    ...(row.postedAt ? [{ label: t('posted_by'), value: who(row.postedByName, row.postedAt) }] : []),
    { label: t('journal'), value: journal(row.journalEntryNo) },
    ...(row.status === 'reversed'
      ? [
          { label: t('closed_by'), value: who(row.closedByName, row.closedAt) },
          { label: t('reversal_journal'), value: journal(row.reversalEntryNo) },
          { label: t('reason'), wide: true, value: <bdi dir="auto">{row.reversalReason ?? '—'}</bdi> },
        ]
      : []),
    ...(row.status === 'cancelled'
      ? [
          { label: t('closed_by'), value: who(row.closedByName, row.closedAt) },
          { label: t('reason'), wide: true, value: <bdi dir="auto">{row.cancelReason ?? '—'}</bdi> },
        ]
      : []),
  ];

  const hidden = (
    <>
      <Hidden name="id" value={row.id} />
      <Hidden name="payment_no" value={row.paymentNo} />
    </>
  );

  return (
    <AdminPage back={{ href: '/sales/customer-payments', label: admin('back') }} title={row.paymentNo} trail={[{ href: '/', label: admin('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      {row.status === 'draft' && own && !principal.isSuperUser ? (
        <p className={s.sapNote} role="status">
          {t('own_draft')}
        </p>
      ) : null}

      <DocumentWindow
        actions={
          <>
            {mayApprovePost ? (
              <form action={approvePostCustomerPayment}>
                {hidden}
                <Submit label={t('approve_post')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postCustomerPayment}>
                {hidden}
                <Submit label={t('post')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelCustomerPayment}>
                {hidden}
                <input aria-label={t('cancel_reason')} name="reason" placeholder={t('cancel_reason')} required type="text" />
                <Submit label={t('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayReverse ? (
              <form action={reverseCustomerPayment} title={t('reverse_hint')}>
                {hidden}
                <input aria-label={t('reverse_reason')} name="reason" placeholder={t('reverse_reason')} required type="text" />
                <Submit label={t('reverse')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the standing order. */}
            <ExportIcon exportKey="customer_payment" id={row.paymentNo} title={`${page('customer_payments')} ${row.paymentNo}`} />
            <RecordAttachmentsDoor
              files={view.files}
              mayAttach={can(principal, 'create', payments.PERMISSION_OBJECT) && row.status !== 'cancelled'}
              object={payments.PERMISSION_OBJECT}
              recordId={row.id}
            />
            <RecordNotesDoor notes={view.notes} object={payments.PERMISSION_OBJECT} recordId={row.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={row.id} objectType={payments.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('customer_payments')}
        fields={fields}
        id="customer-payment"
        linesCount={2}
        linesTitle={t('lines_title')}
        number={row.paymentNo}
        totals={[{ label: t('amount'), value: money(row.amount, row.currency) }]}
      >
        <table aria-labelledby="customer-payment-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('line_account')}</th>
              <th className={s.sapNum} scope="col">{t('debit')}</th>
              <th className={s.sapNum} scope="col">{t('credit')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <bdi dir="auto">{t('dr_customer', { customer: `${row.customerCode} · ${row.customerName}` })}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(row.amountIqd, 'IQD')}</bdi>
              </td>
              <td className={s.sapNum}>—</td>
            </tr>
            <tr>
              <td>
                <bdi dir="auto">{t('cr_account', { account: `${row.accountCode} · ${row.accountName}` })}</bdi>
              </td>
              <td className={s.sapNum}>—</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{row.currency === 'IQD' ? money(row.amountIqd, 'IQD') : `${money(row.amount, row.currency)} = ${money(row.amountIqd, 'IQD')}`}</bdi>
              </td>
            </tr>
          </tbody>
        </table>
      </DocumentWindow>
    </AdminPage>
  );
}
