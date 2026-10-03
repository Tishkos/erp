import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Hidden, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { AttachmentsButton, HistoryButton } from '@/components/admin/icon-dialog';
import { Attachments } from '@/components/admin/attachments';
import * as attachmentsService from '@/server/services/attachments';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { isNotFoundError } from '@/server/not-found';
import * as deposits from '@/server/services/bank-deposits';
import { approveDeposit, attachToDeposit, postDeposit } from '../actions';

/**
 * One bank deposit — REQ-FIX-001 FIX-1. The Purchase Invoice's window: the
 * header, the one line the money is, and approve / post at its foot. The
 * history is the document's own (a bank transfer's or an other receipt's).
 */
export const dynamic = 'force-dynamic';

export default async function DepositPage({ params, searchParams }: { params: Promise<{ depositNo: string }>; searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/deposits')) notFound();
  const { depositNo: raw } = await params;
  const depositNo = decodeURIComponent(raw);

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.bank_deposits'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', deposits.PERMISSION_OBJECT)) {
    return <Denied object={page('bank_deposits')} />;
  }

  const deposit = await withCurrentUser(async (tx) => {
    try {
      return await deposits.byNo(tx, depositNo);
    } catch (error) {
      // E1 — a missing record is a 404; anything else reaches the error boundary.
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!deposit) notFound();

  // The legacy cash-to-bank transfer is the only transfer; everything else is
  // a receipt, into the cash or into the bank (2026-10-04).
  const object = deposit.source === 'transfer' ? deposits.PERMISSION_OBJECT : deposits.RECEIPT_PERMISSION_OBJECT;
  // What the paperclip says it holds — the slip, on whichever document the
  // deposit actually is.
  const attached = await withCurrentUser((tx) =>
    attachmentsService.currentFor(tx, deposit.source === 'transfer' ? 'bank_transfer' : 'other_receipt', deposit.id),
  );
  const historyType = deposit.source === 'transfer' ? 'bank_transfer' : 'other_receipt';
  const money = (amount: string) => formatMoney(amount, deposit.currency, locale as Locale);
  const mayApprove = deposit.status === 'draft' && can(principal, 'approve', object) && deposit.createdBy !== principal.userId;
  const mayPost = deposit.status === 'approved' && can(principal, 'post', object);
  const from = deposit.payer ? `${deposit.payer}` : `${deposit.fromName} (${deposit.fromCode})`;

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{deposit.no}</bdi> },
    { label: t('col_status'), value: status.has(deposit.status) ? status(deposit.status) : deposit.status, status: deposit.status },
    { label: t('date'), value: <bdi dir="ltr">{formatBusinessDate(deposit.depositDate, locale as Locale)}</bdi> },
    { label: t('source'), value: t(`source_${deposit.source}`) },
    { label: t('into'), value: <bdi dir="auto">{`${deposit.intoName} (${deposit.intoCode}) · ${deposit.currency}`}</bdi> },
    { label: t('from'), value: <bdi dir="auto">{from}</bdi> },
    ...(deposit.source !== 'transfer' ? [{ label: t('credit_account'), value: <bdi dir="auto">{`${deposit.fromCode} · ${deposit.fromName}`}</bdi> }] : []),
    { label: t('reference'), value: <bdi dir="auto">{deposit.reference ?? '—'}</bdi> },
    {
      label: t('journal'),
      value: deposit.journalEntryNo ? (
        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(deposit.journalEntryNo)}`}>
          <bdi dir="ltr">{deposit.journalEntryNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    ...(deposit.note ? [{ label: t('note'), value: <bdi dir="auto">{deposit.note}</bdi>, wide: true }] : []),
  ];

  return (
    <AdminPage
      back={{ href: '/treasury/deposits', label: page('bank_deposits') }}
      tabs={<SectionTabs route="/treasury/deposits" />}
      title={deposit.no}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveDeposit}>
                <Hidden name="deposit_no" value={deposit.no} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postDeposit}>
                <Hidden name="deposit_no" value={deposit.no} />
                <Submit label={t('post')} variant="document" />
              </form>
            ) : null}
          </>
        }
        titleActions={
          <>
            {/* The slip the bank gave, and what happened to the deposit —
                behind the doors every record wears (2026-10-04). */}
            <AttachmentsButton
              closeLabel={admin('close')}
              count={attached.length}
              label={admin('attachments.title')}
              title={admin('attachments.title')}
            >
              <Attachments
                action={attachToDeposit}
                hidden={{ deposit_no: deposit.no }}
                mayAttach={can(principal, 'create', 'attachment')}
                objectId={deposit.id}
                objectType={historyType}
              />
            </AttachmentsButton>
            <HistoryButton closeLabel={admin('close')} label={admin('history')} title={admin('history')}>
              <RecordHistory objectId={deposit.id} objectType={historyType} />
            </HistoryButton>
          </>
        }
        documentType={t(`document_type_${deposit.source}`)}
        fields={fields}
        id="bank-deposit-document"
        linesCount={1}
        linesTitle={t('lines')}
        number={deposit.no}
        totals={[{ label: t('amount'), value: money(deposit.amount) }]}
      >
        <table aria-labelledby="bank-deposit-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('into')}</th>
              <th scope="col">{t('from')}</th>
              <th className={s.sapNum} scope="col">
                {t('amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <bdi dir="auto">{`${deposit.intoName} (${deposit.intoCode})`}</bdi>
              </td>
              <td>
                <bdi dir="auto">{deposit.source === 'transfer' ? from : `${deposit.fromCode} · ${deposit.fromName}`}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(deposit.amount)}</bdi>
              </td>
            </tr>
          </tbody>
        </table>
      </DocumentWindow>
      <RecordHistory objectId={deposit.id} objectType={historyType} />
    </AdminPage>
  );
}
