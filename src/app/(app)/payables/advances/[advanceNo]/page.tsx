import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Hidden, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { SectionTabs } from '@/components/admin/section-tabs';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as advances from '@/server/services/supplier-advance';
import * as bankCash from '@/server/services/bank-cash-accounts';
import { approveAdvance, payAdvance } from '../actions';
import { businessToday } from '@/server/domain/business-date';

/**
 * One supplier advance — §8.5. The Purchase Invoice's window: the header, the
 * settlements against invoices as its grid, and approve / pay at its foot.
 */
export const dynamic = 'force-dynamic';

export default async function AdvancePage({
  params,
  searchParams,
}: {
  params: Promise<{ advanceNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/advances')) notFound();
  const { advanceNo: raw } = await params;
  const advanceNo = decodeURIComponent(raw);

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.supplier_advances'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', advances.PERMISSION_OBJECT)) {
    return <Denied object={page('supplier_advances')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await advances.viewByNo(tx, advanceNo);
      const payFrom = [
        ...(await bankCash.listOfKind(tx, 'bank')),
        ...(await bankCash.listOfKind(tx, 'cash')),
      ].filter((account) => account.active && account.currency === view.advance.currency);
      return { ...view, payFrom };
    } catch {
      return null;
    }
  });
  if (!found) notFound();
  const { advance } = found;
  const money = (amount: string, currency = 'IQD') => formatMoney(amount, currency, locale as Locale);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const today = businessToday();

  const mayApprove =
    advance.status === 'draft' &&
    can(principal, 'approve', advances.PERMISSION_OBJECT) &&
    advance.createdBy !== principal.userId;
  const mayPay = advance.status === 'approved' && can(principal, 'post', advances.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: t('col_no'), value: <bdi dir="ltr">{advance.advanceNo}</bdi> },
    { label: t('col_status'), value: status(advance.status), status: advance.status },
    { label: t('order'), value: <bdi dir="ltr">{found.orderNo ?? '—'}</bdi> },
    {
      label: t('import'),
      value: found.payableNo ? (
        <Link className={s.sapLink} href={`/payables/${encodeURIComponent(found.payableNo)}`}>
          <bdi dir="ltr">{found.payableNo}</bdi>
        </Link>
      ) : (
        '—'
      ),
    },
    {
      label: t('col_supplier'),
      value: <bdi dir="auto">{found.supplier ? `${found.supplier.name} (${found.supplier.code})` : '—'}</bdi>,
    },
    { label: t('request_date'), value: <bdi dir="ltr">{day(advance.requestDate)}</bdi> },
    { label: t('paid_date'), value: <bdi dir="ltr">{day(advance.paidDate)}</bdi> },
    {
      label: t('amount'),
      value: (
        <bdi dir="ltr">
          {money(advance.amountIqd)}
          {advance.amountTxn && advance.currency !== 'IQD' ? ` · ${money(advance.amountTxn, advance.currency)}` : ''}
        </bdi>
      ),
    },
    { label: t('requested_by'), value: <bdi dir="auto">{found.requestedBy ?? '—'}</bdi> },
    { label: t('approved_by'), value: <bdi dir="auto">{found.approvedBy ?? '—'}</bdi> },
    { label: t('paid_by'), value: <bdi dir="auto">{found.paidBy ?? '—'}</bdi> },
    ...(advance.reason ? [{ label: t('reason'), value: <bdi dir="auto">{advance.reason}</bdi>, wide: true }] : []),
  ];

  return (
    <AdminPage
      back={{ href: '/payables/advances', label: page('supplier_advances') }}
      tabs={<SectionTabs route="/payables/advances" />}
      title={advance.advanceNo}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveAdvance}>
                <Hidden name="id" value={advance.id} />
                <Hidden name="advance_no" value={advance.advanceNo} />
                <Submit label={t('approve')} variant="document" />
              </form>
            ) : null}
            {mayPay ? (
              <NewRecordDialog buttonLabel={t('pay')} closeLabel={admin('close')} title={t('pay')}>
                <Form action={payAdvance}>
                  <Hidden name="id" value={advance.id} />
                  <Hidden name="advance_no" value={advance.advanceNo} />
                  <Grid>
                    <Select
                      label={t('paid_from')}
                      name="bank_cash_account_id"
                      options={found.payFrom.map((account) => ({
                        value: account.id,
                        label: `${account.name} (${account.code}) · ${account.currency}`,
                      }))}
                      required
                    />
                    <Field defaultValue={today} label={t('paid_date')} name="paid_date" required type="date" />
                  </Grid>
                  <SubmitRow>
                    <Submit label={t('pay')} />
                  </SubmitRow>
                </Form>
              </NewRecordDialog>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={admin('history')}
        documentType={t('document_type')}
        fields={fields}
        id="supplier-advance-document"
        linesCount={found.settlements.length}
        linesTitle={t('settlements')}
        number={advance.advanceNo}
        totals={[
          { label: t('amount'), value: money(advance.amountIqd) },
          { label: t('unapplied'), value: money(toDecimalString(found.balance, 4n)) },
        ]}
      >
        <table aria-labelledby="supplier-advance-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{t('invoice')}</th>
              <th scope="col">{t('settlement_date')}</th>
              <th className={s.sapNum} scope="col">
                {t('amount')}
              </th>
              <th scope="col">{t('col_status')}</th>
            </tr>
          </thead>
          <tbody>
            {found.settlements.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={4}>
                  {t('no_settlements')}
                </td>
              </tr>
            ) : null}
            {found.settlements.map((row, index) => (
              <tr key={`${row.invoiceNo}-${index}`}>
                <td>
                  <Link className={s.sapLink} href={`/payables/invoices/${encodeURIComponent(row.invoiceNo)}`}>
                    <bdi dir="ltr">{row.invoiceNo}</bdi>
                  </Link>
                </td>
                <td>
                  <bdi dir="ltr">{day(row.settlementDate)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                </td>
                <td>
                  <span
                    className={`status status--${row.reversedAt ? 'reversed' : 'settled'}`}
                    data-status={row.reversedAt ? 'reversed' : 'settled'}
                  >
                    {row.reversedAt ? status('reversed') : status('settled')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>
      <RecordHistory objectId={advance.id} objectType={advances.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
