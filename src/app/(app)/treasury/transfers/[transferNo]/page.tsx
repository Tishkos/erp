import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, ReasonForm, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { Attachments } from '@/components/admin/attachments';
import { ProfileLink } from '@/components/admin/profile-link';
import { RecordNotesDoor } from '@/components/admin/record-notes-door';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportIcon } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { printSheet } from '@/server/print/sheet';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { isNotFoundError } from '@/server/not-found';
import * as attachmentsService from '@/server/services/attachments';
import * as recordNotes from '@/server/services/record-notes';
import * as treasury from '@/server/services/treasury';
import { approveTransferAction, attachToTransfer, postTransferAction, reverseTransferAction } from '../actions';

/**
 * One Internal Transfer — REQ-ACC-001 Part D-2.
 *
 * The Purchase Invoice's window: the transfer in boxes, the journal it makes
 * as its lines (the destination debited, the source credited, any exchange
 * difference between them), and at its foot what may be done next — approve
 * (by somebody other than whoever raised it), post, reverse. The four doors
 * from the moment the draft exists. Each account and the journal open their
 * own pages.
 */
export const dynamic = 'force-dynamic';

export default async function TransferPage({
  params,
  searchParams,
}: {
  params: Promise<{ transferNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/treasury/transfers')) notFound();
  const { transferNo: raw } = await params;
  const transferNo = decodeURIComponent(raw);

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.internal_transfers'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', treasury.PERMISSION_OBJECT)) {
    return <Denied object={page('bank_transfers')} />;
  }

  const found = await withCurrentUser(async (tx, request) => {
    const ctx = { principal: request.principal, branchCode: request.scope.branchCode };
    let transfer: treasury.TransferRow;
    try {
      transfer = await treasury.transferByNo(tx, ctx, transferNo);
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
    // The dinar value of each leg — what the journal carries. A day with no
    // rate on Currencies & Rates has no value yet, and the lines say so.
    const value = await treasury.valueTransfer(tx, transfer).catch(() => null);
    const attached = await attachmentsService.currentFor(tx, treasury.TRANSFER_OBJECT_TYPE, transfer.id);
    const notes = await recordNotes.listNotes(tx, { object: treasury.TRANSFER_OBJECT_TYPE, recordId: transfer.id });
    return { transfer, value, attached: attached.length, notes };
  });
  if (!found) notFound();
  const { transfer, value, attached, notes } = found;

  const day = (date: string) => formatBusinessDate(date, locale as Locale);
  const money = (amount: string, currency: string) => formatMoney(amount, currency, locale as Locale);
  const iqd = (amount: bigint) => money(toDecimalString(amount < 0n ? -amount : amount, 4n), 'IQD');
  const hidden = { id: transfer.id, transfer_no: transfer.transferNo };
  const crossCurrency = transfer.fromCurrency !== transfer.toCurrency;

  // Who may do what next. Approval is by somebody other than whoever raised
  // it — the Super User alone excepted, as the service says.
  const mine = transfer.createdBy === principal.userId && !principal.isSuperUser;
  const mayApprove = transfer.status === 'draft' && !mine && can(principal, 'approve', treasury.PERMISSION_OBJECT);
  const mayPost = transfer.status === 'approved' && can(principal, 'post', treasury.PERMISSION_OBJECT);
  const mayReverse =
    transfer.status === 'posted' &&
    can(principal, 'post', treasury.PERMISSION_OBJECT) &&
    can(principal, 'reverse_cancel', 'journal_entry');

  // Each account and journal is a link to its profile — the bank loan's
  // account field, through the shared `ProfileLink`.
  const accountLink = (kind: 'bank' | 'cash', code: string, name: string) => (
    <ProfileLink code={code} kind={kind === 'cash' ? 'cash_account' : 'bank_account'} name={name} />
  );
  const journalLink = (entryNo: string | null) => <ProfileLink code={entryNo} kind="journal" />;

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{transfer.transferNo}</bdi> },
    { label: t('col_status'), value: status.has(transfer.status) ? status(transfer.status) : transfer.status, status: transfer.status },
    { label: t('date'), value: <bdi dir="ltr">{day(transfer.transferDate)}</bdi> },
    { label: t('from'), value: accountLink(transfer.fromKind, transfer.fromCode, transfer.fromName) },
    { label: t('to'), value: accountLink(transfer.toKind, transfer.toCode, transfer.toName) },
    { label: t('amount'), value: <bdi dir="ltr">{money(transfer.amount, transfer.fromCurrency)}</bdi> },
    { label: t('received'), value: <bdi dir="ltr">{money(transfer.receivedAmount, transfer.toCurrency)}</bdi> },
    ...(crossCurrency && transfer.fxRate
      ? [{ label: t('rate'), value: <bdi dir="ltr">{transfer.fxRate.replace(/\.?0+$/, '')}</bdi> }]
      : []),
    { label: t('reference'), value: <bdi dir="auto">{transfer.bankReference ?? '—'}</bdi> },
    { label: t('journal'), value: journalLink(transfer.journalEntryNo) },
    ...(transfer.reversalEntryNo ? [{ label: t('reversal_journal'), value: journalLink(transfer.reversalEntryNo) }] : []),
    { label: t('raised_by'), value: <bdi dir="auto">{transfer.createdByName ?? '—'}</bdi> },
    { label: t('approved_by'), value: <bdi dir="auto">{transfer.approvedByName ?? admin('none')}</bdi> },
    { label: t('posted_by'), value: <bdi dir="auto">{transfer.postedByName ?? admin('none')}</bdi> },
    ...(transfer.note ? [{ label: t('purpose'), value: <bdi dir="auto">{transfer.note}</bdi>, wide: true }] : []),
    ...(transfer.reversalReason
      ? [{ label: t('reversal_reason'), value: <bdi dir="auto">{transfer.reversalReason}</bdi>, status: 'reversed', wide: true }]
      : []),
  ];

  /*
   * The lines are the journal the transfer makes: the destination debited,
   * the source credited, each in dinars at the ledger rate of the day, and
   * across currencies what the bank's rate gave beyond or short of that.
   */
  const legs: { account: React.ReactNode; gl: React.ReactNode; entered: string; debit: string; credit: string }[] = [
    {
      account: accountLink(transfer.toKind, transfer.toCode, transfer.toName),
      gl: <ProfileLink code={transfer.toGlCode} kind="gl_account" />,
      entered: money(transfer.receivedAmount, transfer.toCurrency),
      debit: value ? iqd(value.destinationIqd) : '—',
      credit: '',
    },
    {
      account: accountLink(transfer.fromKind, transfer.fromCode, transfer.fromName),
      gl: <ProfileLink code={transfer.fromGlCode} kind="gl_account" />,
      entered: money(transfer.amount, transfer.fromCurrency),
      debit: '',
      credit: value ? iqd(value.sourceIqd) : '—',
    },
    ...(value && value.differenceIqd !== 0n
      ? [
          {
            account: <span>{value.differenceIqd > 0n ? t('exchange_gain') : t('exchange_loss')}</span>,
            gl: '—',
            entered: '',
            debit: value.differenceIqd < 0n ? iqd(value.differenceIqd) : '',
            credit: value.differenceIqd > 0n ? iqd(value.differenceIqd) : '',
          },
        ]
      : []),
  ];

  const sheet = await printSheet('internal_transfer', transfer.transferNo);

  return (
    <AdminPage
      back={{ href: '/treasury/transfers', label: page('bank_transfers') }}
      tabs={<SectionTabs route="/treasury/transfers" />}
      title={transfer.transferNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveTransferAction}>
                <Hidden name="id" value={transfer.id} />
                <Hidden name="transfer_no" value={transfer.transferNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postTransferAction}>
                <Hidden name="id" value={transfer.id} />
                <Hidden name="transfer_no" value={transfer.transferNo} />
                <Submit label={t('post')} variant="document" />
              </form>
            ) : null}
            {/* A posted transfer is never edited: its journal is mirrored. */}
            {mayReverse ? (
              <ReasonForm action={reverseTransferAction} hidden={hidden} label={t('reverse')} reasonLabel={t('reverse_reason')} />
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — from the moment the draft exists. */}
            <ExportIcon exportKey="internal_transfer" id={transfer.transferNo} title={`${t('document_type')} ${transfer.transferNo}`} />
            <AttachmentsButton
              closeLabel={admin('close')}
              count={attached}
              label={admin('attachments.title')}
              title={admin('attachments.title')}
            >
              <Attachments
                action={attachToTransfer}
                hidden={{ transfer_no: transfer.transferNo }}
                mayAttach={can(principal, 'create', 'attachment')}
                objectId={transfer.id}
                objectType={treasury.TRANSFER_OBJECT_TYPE}
              />
            </AttachmentsButton>
            <RecordNotesDoor notes={notes} object={treasury.TRANSFER_OBJECT_TYPE} recordId={transfer.id} />
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={transfer.id} objectType={treasury.TRANSFER_OBJECT_TYPE} />
            </HistoryButton>
          </>
        }
        documentType={t('document_type')}
        fields={fields}
        id="internal-transfer-document"
        linesCount={legs.length}
        linesTitle={t('lines')}
        number={transfer.transferNo}
        totals={[{ label: t('amount'), value: money(transfer.amount, transfer.fromCurrency) }]}
      >
        <table aria-labelledby="internal-transfer-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('account')}</th>
              <th scope="col">{t('gl_account')}</th>
              <th className={s.sapNum} scope="col">
                {t('entered')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('debit')}
              </th>
              <th className={s.sapNum} scope="col">
                {t('credit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, index) => (
              <tr key={index}>
                <td>{leg.account}</td>
                <td className={s.sapAccountCell}>{leg.gl}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{leg.entered}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{leg.debit}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{leg.credit}</bdi>
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
