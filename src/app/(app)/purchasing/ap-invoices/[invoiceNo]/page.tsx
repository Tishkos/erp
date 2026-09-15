import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';
import * as partners from '@/server/services/partners';
import { postApInvoice, submitApInvoice } from '../actions';

/**
 * One Purchase Invoice — Operations build, block 4.
 *
 *   Inventory Effect  A Purchase Invoice increases stock in the selected
 *                     warehouse.
 *   Journal Entry     Inventory Dr. / Accounts Payable Cr.
 *   Posting           The invoice is not posted until CEO approval.
 *
 * Two buttons and only where they apply: a draft can be sent for approval, and
 * an invoice waiting for approval can be posted by somebody who holds the verb.
 * Neither appears on an invoice that has already posted, because there is
 * nothing left to decide — the stock is in the warehouse and the entry is in
 * the ledger.
 */
export const dynamic = 'force-dynamic';

export default async function ApInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/purchasing/ap-invoices')) notFound();

  const [t, page, column, status, locale, context, outcome, { invoiceNo }] = await Promise.all([
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
  if (!can(principal, 'view', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const document = await ap.viewByNo(tx, decodeURIComponent(invoiceNo));
    if (!document) return null;
    const suppliers = await partners.listActiveInRole(tx, 'supplier');
    return { document, suppliers };
  });

  if (!found) notFound();
  const { invoice, lines } = found.document;
  const supplier = found.suppliers.find((row) => row.id === invoice.supplierId);

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // The sponsor's "Total Price" is not a stored column and should not be: it is
  // quantity x unit price less the discount, and a second copy of it could
  // disagree with the three figures beside it on the same row.
  const lineTotal = (line: { quantity: string; unitPrice: string; discountIqd: string }) =>
    String(Number(line.quantity) * Number(line.unitPrice) - Number(line.discountIqd));
  const maySubmit = invoice.status === 'draft' && can(principal, 'submit', ap.PERMISSION_OBJECT);
  const mayPost = invoice.status === 'submitted' && can(principal, 'post', ap.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        <>
          {maySubmit ? (
            <form action={submitApInvoice}>
              <input name="id" type="hidden" value={invoice.id} />
              <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
              <button className="action action--primary" type="submit">
                {t('ap_invoices.submit')}
              </button>
            </form>
          ) : null}
          {mayPost ? (
            <form action={postApInvoice}>
              <input name="id" type="hidden" value={invoice.id} />
              <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
              <button className="action action--primary" type="submit">
                {t('ap_invoices.approve_and_post')}
              </button>
            </form>
          ) : null}
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{ href: '/purchasing/ap-invoices', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/purchasing/ap-invoices" />}
      subtitle={supplier ? `${supplier.code} · ${supplier.name}` : t('ap_invoices.subtitle')}
      title={invoice.invoiceNo}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <dl className={s.inboxFacts}>
        <div>
          <dt>{column('status')}</dt>
          <dd>
            <span className={`status status--${invoice.status}`} data-status={invoice.status}>
              {status(invoice.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('ap_invoices.supplier_invoice_no')}</dt>
          <dd>
            <bdi dir="ltr">{invoice.supplierInvoiceNo}</bdi>
          </dd>
        </div>
        <div>
          <dt>{column('posting_date')}</dt>
          <dd>
            <bdi dir="ltr">{formatBusinessDate(invoice.invoiceDate, locale as Locale)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{column('due_date')}</dt>
          <dd>
            <bdi dir="ltr">{formatBusinessDate(invoice.dueDate, locale as Locale)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{column('amount')}</dt>
          <dd>
            <bdi dir="ltr">{money(invoice.totalIqd)}</bdi>
          </dd>
        </div>
        {invoice.journalEntryId ? (
          <div>
            <dt>{t('ap_invoices.journal')}</dt>
            <dd>
              <Link className={s.sapLink} href="/finance/journals">
                {t('ap_invoices.posted_note')}
              </Link>
            </dd>
          </div>
        ) : null}
      </dl>

      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('unit_price')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('discount')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('total_price')}
              </th>
              <th scope="col">{column('warehouse_name')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <bdi dir="ltr">{line.itemCode ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description ?? '—'}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{String(Number(line.quantity))}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.unitPrice)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.discountIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(lineTotal(line))}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.warehouseCode ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td colSpan={5}>{t('reports.totals')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(invoice.totalIqd)}</bdi>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <RecordHistory objectId={invoice.id} objectType={ap.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
