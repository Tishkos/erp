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
import { formatQuantity as formatScaledQuantity, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/bank-cash-accounts';
import * as gr from '@/server/services/goods-return';
import { createGoodsReturn } from '../actions';

/**
 * Raising a Purchase Return — Operations build, block 10.
 *
 *   Header  Supplier Name; Supplier Code; Date; Offset Account (Accounts
 *           Payable or Bank — one must be selected); Original Purchase Invoice
 *           Number.
 *   Lines   Item Name; Item Code; Return Quantity; Item Price from the original
 *           invoice; Warehouse from which the item will be returned.
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

export default async function NewGoodsReturnPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/purchasing/goods-returns')) notFound();

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
  if (!can(context.principal, 'create', gr.PERMISSION_OBJECT)) {
    return <Denied object={page('goods_returns')} />;
  }

  /* Both boxes are typed rather than chosen from — there will be a year of
     invoices and nobody scrolls to one. The supplier is optional and only
     narrows what the invoice box suggests; the invoice itself is named by its
     number, or by anything that can only be one invoice. */
  const typedPartner = typeof params.partner === 'string' ? params.partner : '';
  const typedInvoice = typeof params.invoice === 'string' ? params.invoice : '';

  const { invoices, suggestions, invoice, lines, accounts } = await withCurrentUser(async (tx) => {
    const all = await gr.returnableInvoices(tx);
    const fields = (row: (typeof all)[number]) => [
      row.invoiceNo,
      row.supplierCode,
      row.supplierName,
      row.invoiceDate,
    ];
    const narrowed = typedPartner
      ? matching(all, typedPartner, (row) => [row.supplierCode, row.supplierName])
      : all;
    const picked = pickOne(narrowed, typedInvoice, (row) => row.invoiceNo, fields);
    return {
      invoices: all,
      suggestions: narrowed,
      invoice: picked,
      lines: picked ? await gr.returnableLinesFor(tx, picked.id) : [],
      accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))],
    };
  });

  const outcome_ = pickOutcome(
    suggestions,
    typedInvoice,
    (row) => row.invoiceNo,
    (row) => [row.invoiceNo, row.supplierCode, row.supplierName, row.invoiceDate],
  );
  const partners = [
    ...new Map(invoices.map((row) => [row.supplierCode, row])).values(),
  ];
  const today = new Date().toISOString().slice(0, 10);
  const open = lines
    .filter((line) => line.returnable > 0n)
    .map((line) => ({ ...line, maxQuantity: formatScaledQuantity(line.returnable) }));

  return (
    <AdminPage
      back={{ href: '/purchasing/goods-returns', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/purchasing/goods-returns" />}
      subtitle={t('goods_returns.subtitle')}
      title={t('goods_returns.new')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {invoices.length === 0 ? (
        <p className={s.sectionHint}>{t('goods_returns.no_invoices')}</p>
      ) : (
        <>
          {/* Two typed boxes, not two drop-downs. The supplier narrows what
              the invoice box suggests and is optional; the invoice is named by
              its number, or by anything that can only be one invoice. Both
              suggest from a `datalist`, which offers without constraining — a
              partial number is still a search. */}
          <form className={s.pickRow} method="get">
            <div className={s.field}>
              <span className={s.label}>{column('supplier_name')}</span>
              <input
                className={s.input}
                defaultValue={typedPartner}
                list="goods-return-suppliers"
                name="partner"
                placeholder={t('goods_returns.partner_hint')}
              />
              <datalist id="goods-return-suppliers">
                {partners.map((row) => (
                  <option key={row.supplierCode ?? row.id} value={row.supplierName ?? ''}>
                    {row.supplierCode}
                  </option>
                ))}
              </datalist>
              <span className={s.hint}>{t('goods_returns.partner_optional')}</span>
            </div>

            <div className={s.field}>
              <span className={s.label}>{t('goods_returns.invoice')}</span>
              <span className={s.fieldWithAction}>
                <input
                  className={s.input}
                  defaultValue={typedInvoice}
                  list="goods-return-invoices"
                  name="invoice"
                  placeholder={t('goods_returns.invoice_hint')}
                  required
                />
                <Submit label={t('choose')} tone="secondary" variant="document" />
              </span>
              <datalist id="goods-return-invoices">
                {suggestions.map((row) => (
                  <option key={row.id} value={row.invoiceNo}>
                    {`${row.supplierCode ?? ''} · ${row.supplierName ?? ''} · ${row.invoiceDate}`}
                  </option>
                ))}
              </datalist>
              <span className={s.hint}>
                {outcome_ === 'ambiguous'
                  ? t('goods_returns.invoice_ambiguous')
                  : outcome_ === 'none'
                    ? t('goods_returns.invoice_unknown')
                    : t('goods_returns.pick_invoice')}
              </span>
            </div>
          </form>

          {!invoice ? null : (
            <Form action={createGoodsReturn}>
              <input name="ap_invoice_id" type="hidden" value={invoice.id} />

              <Grid>
                {/* The sponsor lists the code and the name as two fields, and
                    both are read from the invoice this return is against. */}
                <ReadOnlyField label={column('supplier_code')} value={invoice.supplierCode} />
                <ReadOnlyField label={column('supplier_name')} value={invoice.supplierName} />
                <Field
                  defaultValue={today}
                  label={column('posting_date')}
                  name="return_date"
                  required
                  requiredLabel={t('required_hint')}
                  type="date"
                />
                <label className={s.field}>
                  <span className={s.label}>{t('goods_returns.offset')}</span>
                  <select className={s.select} name="offset_kind" required>
                    <option value="payable">{t('goods_returns.offset_payable')}</option>
                    <option value="bank">{t('goods_returns.offset_bank')}</option>
                  </select>
                </label>
                <label className={s.field}>
                  <span className={s.label}>{t('goods_returns.bank_account')}</span>
                  <select className={s.select} name="offset_bank_account_id">
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
                  label={t('goods_returns.reason')}
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
                        {t('goods_returns.returnable')}
                      </th>
                      <th className={s.sapNum} scope="col">
                        {t('goods_returns.return_quantity')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={7}>
                          {t('goods_returns.none')}
                        </td>
                      </tr>
                    ) : null}
                    {open.map((line, row) => (
                      <tr key={line.id}>
                        <td>
                          <input
                            name={`ap_invoice_line_id_${row}`}
                            type="hidden"
                            value={line.id}
                          />
                          <bdi dir="ltr">{line.itemCode}</bdi>
                        </td>
                        {/* Read from the invoice: the name it was bought
                            under, the price it was billed at, and the
                            warehouse it is going back out of. */}
                        <td>
                          <bdi dir="auto">{line.description}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{money(line.unitPrice)}</bdi>
                        </td>
                        <td>
                          {/* Block 10 — "Warehouse (from which the item will be
                              returned)": the warehouse the invoice booked this
                              line into, and not a choice. A return is measured against the
                              invoice, and the stock it sends back is the stock
                              that invoice brought in — offering every warehouse
                              let a person pick one the goods were never in, and
                              the refusal came from the stock ledger a step later
                              ("only 0 of ITM-000001 on this invoice are in
                              WH-BOARD"). It travels in a hidden field so the
                              action reads it exactly as before. */}
                          <bdi dir="ltr">{line.warehouseCode ?? '—'}</bdi>
                          <input
                            name={`warehouse_code_${row}`}
                            type="hidden"
                            value={line.warehouseCode ?? ''}
                          />
                        </td>
                        {/* What the invoice billed, so the figure the return is
                            measured against is on the row rather than remembered. */}
                        <td className={s.sapNum}>
                          <bdi dir="ltr">
                            {formatLocaleQuantity(
                              formatScaledQuantity(parseQuantity(line.quantity)),
                              locale as Locale,
                            )}
                          </bdi>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">
                            {formatLocaleQuantity(line.maxQuantity, locale as Locale)}
                          </bdi>
                        </td>
                        <td className={s.sapNum}>
                          <input
                            aria-label={`${t('goods_returns.return_quantity')} ${line.itemCode}`}
                            className={s.sapCellField}
                            inputMode="decimal"
                            max={line.maxQuantity}
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
        <Link className={s.sapLink} href="/purchasing/ap-invoices">
          {t('ap_invoices.title')}
        </Link>
      </p>
    </AdminPage>
  );
}
