import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import { createApInvoice } from '../actions';
import { LINE_ROWS } from '../lines';

/**
 * Raising a Purchase Invoice — Operations build, block 4.
 *
 *   Header  Invoice Number (automatically generated); Posting Date; Due Date;
 *           Supplier Code; Supplier Name (searchable).
 *   Lines   Item Code; Item Name (automatically shown when the Item Code is
 *           selected); Quantity; Unit Price; Discount; Total Price; Warehouse.
 *
 * The invoice number is not on this form because the sponsor says it is
 * generated, and it is — allocated when the invoice is saved, from the same
 * sequence every other document draws on.
 *
 * "Item Name automatically shown when the Item Code is selected" is met by the
 * picker carrying both: one control, `CODE · Name`, so the name is never a
 * second thing to keep in step with the code. The same is true of the supplier.
 *
 * Eight line rows, and a blank row is dropped rather than refused. A row that
 * names an item and nothing else is somebody halfway through typing, and that
 * is refused with a sentence — posting it as a zero would be worse.
 */
export const dynamic = 'force-dynamic';

export default async function NewApInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/purchasing/ap-invoices')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }

  const { suppliers, stockItems, houses } = await withCurrentUser(async (tx) => ({
    suppliers: await partners.listActiveInRole(tx, 'supplier'),
    stockItems: await items.listAll(tx),
    houses: await warehouses.listActive(tx),
  }));

  const sellable = stockItems.filter((item) => item.isStock && item.active);
  const today = new Date().toISOString().slice(0, 10);

  // What is missing is said once, here, rather than discovered as an error
  // after the invoice has been typed out.
  const missing = [
    suppliers.length === 0 ? t('ap_invoices.no_suppliers') : null,
    sellable.length === 0 ? t('ap_invoices.no_items') : null,
    houses.length === 0 ? t('ap_invoices.no_warehouses') : null,
  ].filter(Boolean);

  return (
    <AdminPage
      back={{ href: '/purchasing/ap-invoices', label: t('ap_invoices.title') }}
      tabs={<SectionTabs route="/purchasing/ap-invoices" />}
      subtitle={t('ap_invoices.subtitle')}
      title={t('ap_invoices.new')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <Form action={createApInvoice}>
          <Grid>
            <label className="field">
              <span className="field__label">{column('supplier_name')}</span>
              <select className="field__input" name="supplier_id" required>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.code} · {supplier.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label={t('ap_invoices.supplier_invoice_no')}
              name="supplier_invoice_no"
              required
              requiredLabel={t('required_hint')}
            />
            <Field
              defaultValue={today}
              label={column('posting_date')}
              name="invoice_date"
              required
              requiredLabel={t('required_hint')}
              type="date"
            />
            <Field
              label={column('due_date')}
              name="due_date"
              required
              requiredLabel={t('required_hint')}
              type="date"
            />
          </Grid>

          <h2 className={s.sapTitle}>
            <span>{t('ap_invoices.lines')}</span>
            <span className={s.sapTitleMeta}>{t('ap_invoices.line_hint')}</span>
          </h2>

          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('item_code')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('quantity')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {column('unit_price')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {column('discount')}
                  </th>
                  <th scope="col">{column('warehouse_name')}</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: LINE_ROWS }, (_, row) => (
                  <tr key={row}>
                    <td>
                      <select
                        aria-label={column('item_code')}
                        className="field__input"
                        defaultValue=""
                        name={`item_code_${row}`}
                      >
                        <option value="" />
                        {sellable.map((item) => (
                          <option key={item.code} value={item.code}>
                            {item.code} · {item.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className={s.sapNum}>
                      <input
                        aria-label={column('quantity')}
                        className="field__input"
                        inputMode="decimal"
                        name={`quantity_${row}`}
                      />
                    </td>
                    <td className={s.sapNum}>
                      <input
                        aria-label={column('unit_price')}
                        className="field__input"
                        inputMode="decimal"
                        name={`unit_price_${row}`}
                      />
                    </td>
                    <td className={s.sapNum}>
                      <input
                        aria-label={column('discount')}
                        className="field__input"
                        inputMode="decimal"
                        name={`discount_${row}`}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={column('warehouse_name')}
                        className="field__input"
                        defaultValue={houses[0]?.code ?? ''}
                        name={`warehouse_code_${row}`}
                      >
                        {houses.map((house) => (
                          <option key={house.code} value={house.code}>
                            {house.code} · {house.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <SubmitRow>
            <Submit label={t('create')} />
          </SubmitRow>
        </Form>
      )}
    </AdminPage>
  );
}
