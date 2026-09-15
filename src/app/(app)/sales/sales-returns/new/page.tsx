import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
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

  const [t, page, column, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  if (!can(context.principal, 'create', sr.PERMISSION_OBJECT)) {
    return <Denied object={page('sales_returns')} />;
  }

  const chosen = typeof params.invoice === 'string' ? params.invoice : '';

  const { invoices, lines, accounts } = await withCurrentUser(async (tx) => ({
    invoices: await sr.returnableInvoices(tx),
    lines: chosen ? await sr.returnableFor(tx, chosen) : [],
    accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))],
  }));

  const invoice = invoices.find((row) => row.id === chosen);
  const today = new Date().toISOString().slice(0, 10);
  const open = lines.filter((line) => Number(line.returnable) > 0);

  return (
    <AdminPage
      back={{ href: '/sales/sales-returns', label: t('sales_returns.title') }}
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
          <form className="list__toolbar" method="get">
            <label className="field">
              <span className="field__label">{t('sales_returns.invoice')}</span>
              <select className="field__input" defaultValue={chosen} name="invoice" required>
                <option value="" />
                {invoices.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.invoiceNo} · {row.customerCode} · {row.customerName}
                  </option>
                ))}
              </select>
            </label>
            <button className="action" type="submit">
              {t('sales_returns.pick_invoice')}
            </button>
          </form>

          {!invoice ? null : (
            <Form action={createSalesReturn}>
              <input name="ar_invoice_id" type="hidden" value={invoice.id} />

              <Grid>
                <label className="field">
                  <span className="field__label">{column('customer_name')}</span>
                  <span className="field__input" aria-readonly>
                    {invoice.customerCode} · {invoice.customerName}
                  </span>
                </label>
                <Field
                  defaultValue={today}
                  label={column('posting_date')}
                  name="requested_on"
                  required
                  requiredLabel={t('required_hint')}
                  type="date"
                />
                <label className="field">
                  <span className="field__label">{t('sales_returns.offset')}</span>
                  <select className="field__input" name="offset_kind" required>
                    <option value="receivable">{t('sales_returns.offset_receivable')}</option>
                    <option value="bank">{t('sales_returns.offset_bank')}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t('sales_returns.bank_account')}</span>
                  <select className="field__input" name="offset_bank_account_id">
                    <option value="" />
                    {accounts
                      .filter((account) => account.active)
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
                        <td className={s.sapEmptyRow} colSpan={3}>
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
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{String(Number(line.returnable))}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <input
                            aria-label={`${t('sales_returns.return_quantity')} ${line.itemCode}`}
                            className="field__input"
                            inputMode="decimal"
                            max={Number(line.returnable)}
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
