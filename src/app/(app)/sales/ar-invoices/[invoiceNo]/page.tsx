import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as partners from '@/server/services/partners';
import { approveArInvoice, postArInvoice } from '../actions';

/**
 * One Sales Invoice — Operations build, block 5.
 *
 *   Inventory Effect  A Sales Invoice decreases stock from the selected
 *                     warehouse.
 *   Journal Entry     Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. /
 *                     COGS Dr.
 *   Posting           The invoice is not posted until CEO approval.
 *
 * Two buttons and only where they apply. Neither appears on an invoice that has
 * posted: the stock has left the warehouse at its FIFO cost and the four-part
 * entry is in the ledger.
 *
 * The line's Total Price is read from the invoice rather than recomputed here.
 * The service worked it out when the invoice was raised, discount and all, and
 * a second arithmetic on the screen could disagree with what was billed.
 */
export const dynamic = 'force-dynamic';

export default async function ArInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/ar-invoices')) notFound();

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
  if (!can(principal, 'view', ar.PERMISSION_OBJECT)) {
    return <Denied object={page('ar_invoices')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const document = await ar.viewByNo(tx, decodeURIComponent(invoiceNo));
    if (!document) return null;
    const customers = await partners.listActiveInRole(tx, 'customer');
    return { document, customers };
  });

  if (!found) notFound();
  const { lines, ...invoice } = found.document;
  const customer = found.customers.find((row) => row.id === invoice.customerId);

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // The sponsor's "Total Price", read from the line rather than recomputed. A
  // sale stores its net because the discount and the price were agreed when the
  // invoice was raised; doing the arithmetic again here could print a figure
  // that differs from what the customer was actually billed.
  const lineTotal = (line: { netIqd: string }) => line.netIqd;
  // Two steps, and the sponsor's rule lives in the second: "the invoice is not
  // posted until CEO approval". Approval and posting are separate verbs, so the
  // person who raised it cannot carry it to the ledger alone.
  const mayApprove =
    ['draft', 'submitted'].includes(invoice.status) && can(principal, 'approve', ar.PERMISSION_OBJECT);
  const mayPost = invoice.status === 'approved' && can(principal, 'post', ar.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        <>
          {mayApprove ? (
            <form action={approveArInvoice}>
              <input name="id" type="hidden" value={invoice.id} />
              <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
              <button className="action action--primary" type="submit">
                {t('ar_invoices.approve')}
              </button>
            </form>
          ) : null}
          {mayPost ? (
            <form action={postArInvoice}>
              <input name="id" type="hidden" value={invoice.id} />
              <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
              <button className="action action--primary" type="submit">
                {t('ar_invoices.post')}
              </button>
            </form>
          ) : null}
        </>
      }
      back={{ href: '/sales/ar-invoices', label: t('ar_invoices.title') }}
      tabs={<SectionTabs route="/purchasing/ap-invoices" />}
      subtitle={customer ? `${customer.code} · ${customer.name}` : t('ar_invoices.subtitle')}
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
            <bdi dir="ltr">{money(invoice.netIqd)}</bdi>
          </dd>
        </div>
        {invoice.journalEntryId ? (
          <div>
            <dt>{t('ar_invoices.journal')}</dt>
            <dd>
              <Link className={s.sapLink} href="/finance/journals">
                {t('ar_invoices.posted_note')}
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
                  <bdi dir="ltr">{money(line.discountAmountIqd ?? '0')}</bdi>
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
                <bdi dir="ltr">{money(invoice.netIqd)}</bdi>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </AdminPage>
  );
}
