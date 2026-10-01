import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, ReadOnlyField, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import {
  formatMoney,
  formatQuantity as formatLocaleQuantity,
  type Locale,
} from '@/i18n/config';
import { can } from '@domain/permissions';
import { matching, pickOne, pickOutcome } from '@domain/pick';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/bank-cash-accounts';
import * as sr from '@/server/services/sales-return';
import { createSalesReturn } from '../actions';

/**
 * Raising a Sales Return — Operations build, block 9.
 *
 *   Header  Customer Name; Customer Code; Date; Offset Account (Accounts
 *           Receivable or Bank — one must be selected); Original Sales Invoice
 *           Number.
 *   Lines   Item Name; Item Code; Return Quantity; Item Price from the original
 *           invoice; Warehouse where the returned stock will be allocated.
 *
 * Two steps, and the first one is the invoice. Everything else on the form is
 * read from it: the customer, the lines, what each line originally cost, and
 * how much of it is still available to send back. Asking for those separately
 * would be asking the person to retype what the invoice already says, and
 * inviting a return against an invoice that does not carry the item.
 *
 * The returnable quantity is the sponsor's Quantity Control made visible before
 * the fact rather than enforced after it — a line with nothing left to return
 * says so on the page, and the service refuses it again on the way in.
 */
export const dynamic = 'force-dynamic';

export default async function NewSalesReturnPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/sales-returns')) notFound();

  const [t, page, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  if (!can(context.principal, 'create', sr.PERMISSION_OBJECT)) {
    return <Denied object={page('sales_returns')} />;
  }

  /* Typed, not chosen — the same two steps as the Purchase Return: the customer
     narrows what the invoice box suggests, and the invoice is named by its
     number or by anything that can only be one invoice. */
  const typedPartner = typeof params.partner === 'string' ? params.partner : '';
  const typedInvoice = typeof params.invoice === 'string' ? params.invoice : '';

  const { invoices, suggestions, invoice, lines, accounts } = await withCurrentUser(async (tx) => {
    const all = await sr.returnableInvoices(tx);
    const fields = (row: (typeof all)[number]) => [
      row.invoiceNo,
      row.customerCode,
      row.customerName,
      row.invoiceDate,
    ];
    const narrowed = typedPartner
      ? matching(all, typedPartner, (row) => [row.customerCode, row.customerName])
      : all;
    const picked = pickOne(narrowed, typedInvoice, (row) => row.invoiceNo, fields);
    return {
      invoices: all,
      suggestions: narrowed,
      invoice: picked,
      lines: picked ? await sr.returnableFor(tx, picked.id) : [],
      accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))],
    };
  });

  const outcome_ = pickOutcome(
    suggestions,
    typedInvoice,
    (row) => row.invoiceNo,
    (row) => [row.invoiceNo, row.customerCode, row.customerName, row.invoiceDate],
  );
  const partners = [...new Map(invoices.map((row) => [row.customerCode, row])).values()];
  const today = new Date().toISOString().slice(0, 10);
  const open = lines.filter((line) => Number(line.returnable) > 0);

  return (
    <AdminPage
      back={{ href: '/sales/sales-returns', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/sales/sales-returns" />}
      subtitle={t('sales_returns.subtitle')}
      title={t('sales_returns.new')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {invoices.length === 0 ? (
        <p className={s.sectionHint}>{t('sales_returns.no_invoices')}</p>
      ) : (
        <>
          {/* Two typed boxes, not two drop-downs — see the Purchase Return.
              The customer is optional and only narrows the suggestions. */}
          <form className={s.pickRow} method="get">
            <div className={s.field}>
              <span className={s.label}>{column('customer_name')}</span>
              <input
                className={s.input}
                defaultValue={typedPartner}
                list="sales-return-customers"
                name="partner"
                placeholder={t('sales_returns.partner_hint')}
              />
              <datalist id="sales-return-customers">
                {partners.map((row) => (
                  <option key={row.customerCode ?? row.id} value={row.customerName ?? ''}>
                    {row.customerCode}
                  </option>
                ))}
              </datalist>
              <span className={s.hint}>{t('sales_returns.partner_optional')}</span>
            </div>

            <div className={s.field}>
              <span className={s.label}>{t('sales_returns.invoice')}</span>
              <span className={s.fieldWithAction}>
                <input
                  className={s.input}
                  defaultValue={typedInvoice}
                  list="sales-return-invoices"
                  name="invoice"
                  placeholder={t('sales_returns.invoice_hint')}
                  required
                />
                <Submit label={t('choose')} tone="secondary" variant="document" />
              </span>
              <datalist id="sales-return-invoices">
                {suggestions.map((row) => (
                  <option key={row.id} value={row.invoiceNo}>
                    {`${row.customerCode ?? ''} · ${row.customerName ?? ''} · ${row.invoiceDate}`}
                  </option>
                ))}
              </datalist>
              <span className={s.hint}>
                {outcome_ === 'ambiguous'
                  ? t('sales_returns.invoice_ambiguous')
                  : outcome_ === 'none'
                    ? t('sales_returns.invoice_unknown')
                    : t('sales_returns.pick_invoice')}
              </span>
            </div>
          </form>

          {!invoice ? null : (
            <Form action={createSalesReturn}>
              <input name="ar_invoice_id" type="hidden" value={invoice.id} />

              <Grid>
                {/* The sponsor lists the code and the name as two fields, and
                    both are read from the invoice this return is against. */}
                <ReadOnlyField label={column('customer_code')} value={invoice.customerCode} />
                <ReadOnlyField label={column('customer_name')} value={invoice.customerName} />
                <Field
                  defaultValue={today}
                  label={column('posting_date')}
                  name="requested_on"
                  required
                  requiredLabel={t('required_hint')}
                  type="date"
                />
                <label className={s.field}>
                  <span className={s.label}>{t('sales_returns.offset')}</span>
                  <select className={s.select} name="offset_kind" required>
                    <option value="receivable">{t('sales_returns.offset_receivable')}</option>
                    <option value="bank">{t('sales_returns.offset_bank')}</option>
                  </select>
                </label>
                <label className={s.field}>
                  <span className={s.label}>{t('sales_returns.bank_account')}</span>
                  <select className={s.select} name="offset_bank_account_id">
                    <option value="" />
                    {accounts
                      // Active, and its G/L account still there — one deleted
                      // outside the application leaves an account that cannot post.
                      .filter((account) => account.active && account.glAccountCode)
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} · {account.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Field
                  label={t('sales_returns.reason')}
                  name="reason"
                  required
                  requiredLabel={t('required_hint')}
                  wide
                />
              </Grid>

              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{column('item_code')}</th>
                      <th scope="col">{column('item_name')}</th>
                      <th className={s.sapNum} scope="col">
                        {column('unit_price')}
                      </th>
                      <th scope="col">{column('warehouse')}</th>
                      <th className={s.sapNum} scope="col">
                        {column('invoiced_quantity')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('sales_returns.returnable')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('sales_returns.return_quantity')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={7}>
                          {t('sales_returns.none')}
                        </td>
                      </tr>
                    ) : null}
                    {open.map((line, row) => (
                      <tr key={line.arInvoiceLineId}>
                        <td>
                          <input
                            name={`ar_invoice_line_id_${row}`}
                            type="hidden"
                            value={line.arInvoiceLineId}
                          />
                          <bdi dir="ltr">{line.itemCode}</bdi>
                        </td>
                        {/* Read from the invoice: the name it was sold under,
                            the price it was billed at, and where it came from. */}
                        <td>
                          <bdi dir="auto">{line.itemName}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(line.unitPrice ?? '0')}</bdi>
                        </td>
                        <td>
                          <bdi dir="ltr">{line.warehouseCode ?? '—'}</bdi>
                        </td>
                        {/* What the invoice billed — `invoiced` comes back from the
                            same query as the returnable figure. */}
                        <td className={s.sapNum}>
                          <bdi dir="ltr">
                            {formatLocaleQuantity(line.invoiced ?? '0', locale as Locale)}
                          </bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">
                            {formatLocaleQuantity(line.returnable ?? '0', locale as Locale)}
                          </bdi>
                        </td>
                        <td className={s.sapNum}>
                          <input
                            aria-label={`${t('sales_returns.return_quantity')} ${line.itemCode}`}
                            className={s.sapCellField}
                            inputMode="decimal"
                            // The column comes back as numeric text
                            // ("1.000000"); the ceiling on a box reads as a
                            // quantity, not as six decimal places.
                            max={String(Number(line.returnable ?? '0'))}
                            name={`quantity_${row}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {open.length > 0 ? (
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              ) : null}
            </Form>
          )}
        </>
      )}

      <p className={s.sectionHint}>
        <Link className={s.sapLink} href="/sales/ar-invoices">
          {t('ar_invoices.title')}
        </Link>
      </p>
    </AdminPage>
  );
}
