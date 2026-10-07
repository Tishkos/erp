import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { DueDateText } from '@/components/admin/due-date-text';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as notes from '@/server/services/supplier-notes';
import { applyCreditAction, approveCreditNoteAction, cancelCreditNoteAction, postCreditNoteAction, reverseCreditNoteAction } from '../actions';
import { PurchaseDoors, readDoors } from '../../record-doors';

/**
 * One supplier credit note — REQ-PAY-001 PAY8 (2026-10-04), the Purchase
 * Invoice's window: the supplier, the invoice it credits and the return it
 * came from (if any) as links, the four doors in the title bar from the
 * draft on, Approve (somebody other than its raiser) → Post → Reverse as its
 * actions, and where the credit went as its lines. A posted note with
 * something left to apply offers the supplier's other open invoices, each
 * with its own amount box — the supplier payment's allocation, mirrored.
 */
export const dynamic = 'force-dynamic';

export default async function SupplierCreditNotePage({
  params,
  searchParams,
}: {
  params: Promise<{ memoNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/credit-memos')) notFound();

  const [t, x, page, column, status, locale, context, outcome, { memoNo: rawMemoNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.supplier_notes'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);
  const memoNo = decodeURIComponent(rawMemoNo);

  const { principal } = context;
  if (!can(principal, 'view', notes.PERMISSION_OBJECT)) {
    return <Denied object={page('supplier_credit_memos')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const seen = await notes.viewCreditByNo(tx, memoNo);
    if (!seen) return null;
    return {
      ...seen,
      applicable: seen.memo.status === 'posted' && seen.unappliedIqd > 0n ? await notes.applicableInvoices(tx, seen.memo) : [],
      doors: await readDoors(tx, principal, { object: notes.PERMISSION_OBJECT, recordId: seen.memo.id }),
    };
  });
  if (!found) notFound();
  const { memo, invoice, supplier, returnNo, account, applications, unappliedIqd, applicable, doors } = found;
  const self = `/payables/credit-memos/${encodeURIComponent(memo.memoNo)}`;

  const money = (amount: string | bigint) =>
    formatMoney(typeof amount === 'bigint' ? toDecimalString(amount, MONEY_SCALE) : amount, 'IQD', locale as Locale);
  const live = applications.filter((row) => !row.reversedAt);
  const standalone = memo.goodsReturnId === null;
  const mine = memo.createdBy === principal.userId && !principal.isSuperUser;
  const mayApprove = standalone && memo.status === 'draft' && can(principal, 'approve', notes.PERMISSION_OBJECT) && !mine;
  const mayPost = standalone && memo.status === 'approved' && can(principal, 'post', notes.PERMISSION_OBJECT);
  const mayCancel = standalone && memo.status === 'draft' && can(principal, 'create', notes.PERMISSION_OBJECT);
  const mayReverse = standalone && memo.status === 'posted' && can(principal, 'reverse_cancel', notes.PERMISSION_OBJECT);
  const mayApply = memo.status === 'posted' && unappliedIqd > 0n && can(principal, 'post', notes.PERMISSION_OBJECT);
  const smaller = (a: bigint, b: bigint) => (a < b ? a : b);

  const fields: DocumentField[] = [
    { label: x('col_no'), value: <bdi dir="ltr">{memo.memoNo}</bdi> },
    { label: column('status'), value: status(memo.status), status: memo.status },
    { label: x('col_kind'), value: standalone ? x('kind_credit') : x('kind_credit_memo') },
    { label: column('supplier_code'), value: <ProfileLink code={supplier?.code} kind="supplier">{supplier?.code ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={supplier?.code} dir="auto" kind="supplier">
          {supplier?.name ?? '—'}
        </ProfileLink>
      ),
    },
    { label: x('invoice'), value: <ProfileLink code={invoice?.invoiceNo} kind="purchase_invoice" /> },
    ...(returnNo ? [{ label: x('return'), value: <ProfileLink code={returnNo} kind="goods_return" /> }] : []),
    { label: x('supplier_note_no'), value: <bdi dir="ltr">{memo.supplierMemoNo}</bdi> },
    { label: x('note_date'), value: <bdi dir="ltr">{formatBusinessDate(memo.memoDate, locale as Locale)}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{memo.branchCode}</bdi> },
    { label: x('amount'), value: <bdi dir="ltr">{money(memo.amountIqd)}</bdi> },
    { label: x('applied'), value: <bdi dir="ltr">{money(memo.allocatedAmountIqd)}</bdi> },
    { label: x('unapplied'), value: <bdi dir="ltr">{money(unappliedIqd)}</bdi> },
    {
      label: x('credit_account'),
      value: account ? <ProfileLink code={account.code} dir="auto" kind="gl_account" name={account.name} /> : x('credit_account_default'),
    },
    { label: column('raised_by'), value: <bdi dir="auto">{found.raisedBy ?? '—'}</bdi> },
    { label: x('approved_by'), value: <bdi dir="auto">{found.approvedBy ?? '—'}</bdi> },
    { label: x('posted_by'), value: <bdi dir="auto">{found.postedBy ?? '—'}</bdi> },
    ...(found.entryNo ? [{ label: x('journal'), value: <ProfileLink code={found.entryNo} kind="journal" /> }] : []),
    ...(found.reversalEntryNo ? [{ label: x('reversal_journal'), value: <ProfileLink code={found.reversalEntryNo} kind="journal" /> }] : []),
    { label: x('reason'), value: <bdi dir="auto">{memo.note ?? '—'}</bdi>, wide: true },
    ...(memo.reversalReason ? [{ label: x('reverse_reason'), value: <bdi dir="auto">{memo.reversalReason}</bdi>, wide: true }] : []),
  ];

  return (
    <AdminPage
      back={{ href: '/payables/credit-memos', label: t('back') }}
      tabs={<SectionTabs route="/payables/credit-memos" />}
      title={memo.memoNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveCreditNoteAction}>
                <input name="id" type="hidden" value={memo.id} />
                <input name="memo_no" type="hidden" value={memo.memoNo} />
                <Submit label={x('approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postCreditNoteAction}>
                <input name="id" type="hidden" value={memo.id} />
                <input name="memo_no" type="hidden" value={memo.memoNo} />
                <Submit label={x('post')} variant="document" />
              </form>
            ) : null}
            {mayCancel ? (
              <form action={cancelCreditNoteAction}>
                <input name="id" type="hidden" value={memo.id} />
                <input name="memo_no" type="hidden" value={memo.memoNo} />
                <input aria-label={x('cancel_reason')} name="reason" placeholder={x('cancel_reason')} required type="text" />
                <Submit label={x('cancel')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {mayReverse ? (
              <form action={reverseCreditNoteAction}>
                <input name="id" type="hidden" value={memo.id} />
                <input name="memo_no" type="hidden" value={memo.memoNo} />
                <input aria-label={x('reverse_reason')} name="reason" placeholder={x('reverse_reason')} required type="text" />
                <Submit label={x('reverse')} tone="secondary" variant="document" />
              </form>
            ) : null}
          </>
        }
        documentType={x('record_title')}
        fields={fields}
        id="supplier-credit-note-document"
        linesCount={live.length}
        linesTitle={x('applications')}
        number={memo.memoNo}
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={memo.memoNo}
            exportKey="supplier_credit_note"
            object={notes.PERMISSION_OBJECT}
            recordId={memo.id}
            returnTo={self}
            title={`${x('record_title')} ${memo.memoNo}`}
          />
        }
        totals={[
          { label: x('amount'), value: money(memo.amountIqd) },
          { label: x('applied'), value: money(memo.allocatedAmountIqd) },
          { label: x('unapplied'), value: money(unappliedIqd) },
        ]}
      >
        <table aria-labelledby="supplier-credit-note-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('invoice_no')}</th>
              <th scope="col">{column('date')}</th>
              <th className={s.sapNum} scope="col">
                {x('amount')}
              </th>
            </tr>
          </thead>
          <tbody>
            {live.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={3}>
                  {x('no_applications')}
                </td>
              </tr>
            ) : null}
            {live.map((row) => (
              <tr key={row.id}>
                <td className={s.sapAccountCell}>
                  <ProfileLink code={row.invoiceNo} kind="purchase_invoice" />
                </td>
                <td>
                  <bdi dir="ltr">{formatBusinessDate(row.appliedAt, locale as Locale)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* What is left can go against another of the supplier's open invoices. */}
      {mayApply ? (
        <section aria-labelledby="supplier-credit-note-apply" className={s.sapDoc}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="supplier-credit-note-apply">
              <span>{x('apply_title')}</span>
              <span className={s.sapTitleMeta}>{money(unappliedIqd)}</span>
            </h2>
            <div className={s.sapTableWrap}>
              <table className={s.sapTable}>
                <thead>
                  <tr>
                    <th scope="col">{column('invoice_no')}</th>
                    <th scope="col">{column('due_date')}</th>
                    <th className={s.sapNum} scope="col">
                      {t('supplier_payments.outstanding')}
                    </th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {applicable.length === 0 ? (
                    <tr>
                      <td className={s.sapEmptyRow} colSpan={4}>
                        {x('nothing_owed')}
                      </td>
                    </tr>
                  ) : null}
                  {applicable.map((open) => (
                    <tr key={open.id}>
                      <td className={s.sapAccountCell}>
                        <ProfileLink code={open.invoiceNo} kind="purchase_invoice" />
                      </td>
                      <td>
                        {/* Only once set on purpose — an advance's balance waits for its SWIFT (2026-10-07). */}
                        <DueDateText date={open.dueDate} locale={locale} waiting={t('balance_due.waiting')} />
                      </td>
                      <td className={s.sapNum}>
                        <bdi dir="ltr">{money(open.outstandingIqd)}</bdi>
                      </td>
                      <td>
                        <form action={applyCreditAction} className={s.fieldWithAction}>
                          <input name="id" type="hidden" value={memo.id} />
                          <input name="memo_no" type="hidden" value={memo.memoNo} />
                          <input name="ap_invoice_id" type="hidden" value={open.id} />
                          <input
                            aria-label={`${x('apply')} ${open.invoiceNo}`}
                            className={s.sapCellField}
                            defaultValue={String(Number(toDecimalString(smaller(unappliedIqd, parseDecimal(open.outstandingIqd, MONEY_SCALE)), MONEY_SCALE)))}
                            inputMode="decimal"
                            name="amount_iqd"
                          />
                          <Submit label={x('apply')} tone="secondary" variant="document" />
                        </form>
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
