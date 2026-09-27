import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, ReadOnlyField, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/bank-cash-accounts';
import * as gr from '@/server/services/goods-return';
import * as warehouses from '@/server/services/warehouses';
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

  const chosen = typeof params.invoice === 'string' ? params.invoice : '';

  const { invoices, lines, accounts, houses } = await withCurrentUser(async (tx) => ({
    invoices: await gr.returnableInvoices(tx),
    lines: chosen ? await gr.returnableLinesFor(tx, chosen) : [],
    accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))],
    houses: (await warehouses.listActive(tx)).filter(
      (house) => house.branchCode === context.scope.branchCode,
    ),
  }));

  const invoice = invoices.find((row) => row.id === chosen);
  const today = new Date().toISOString().slice(0, 10);
  const open = lines.filter((line) => Number(line.returnable) > 0);

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
          <form className="list__toolbar" method="get">
            <label className={s.field}>
              <span className={s.label}>{t('goods_returns.invoice')}</span>
              <select className={s.select} defaultValue={chosen} name="invoice" required>
                <option value="" />
                {invoices.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.invoiceNo} · {row.supplierCode} · {row.supplierName}
                  </option>
                ))}
              </select>
            </label>
            <button className="action" type="submit">
              {t('goods_returns.pick_invoice')}
            </button>
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
                        <td className={s.sapEmptyRow} colSpan={6}>
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
                          {/* Block 10 — "Warehouse (from which the item will
                              be returned)". Opens on where the invoice booked
                              it; the goods may have been moved since. */}
                          <select
                            aria-label={`${column('warehouse')} ${line.itemCode}`}
                            className={s.sapCellField}
                            defaultValue={line.warehouseCode ?? ''}
                            name={`warehouse_code_${row}`}
                          >
                            {houses.map((house) => (
                              <option key={house.code} value={house.code}>
                                {`${house.code} · ${house.name}`}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className={s.sapNum}>
                          <bdi dir="ltr">{String(Number(line.returnable))}</bdi>
                        </td>
                        <td className={s.sapNum}>
                          <input
                            aria-label={`${t('goods_returns.return_quantity')} ${line.itemCode}`}
                            className={s.sapCellField}
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
        <Link className={s.sapLink} href="/purchasing/ap-invoices">
          {t('ap_invoices.title')}
        </Link>
      </p>
    </AdminPage>
  );
}
