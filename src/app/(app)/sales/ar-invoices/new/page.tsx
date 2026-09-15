import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import { gapsFor } from '@domain/setup-gaps';
import { createArInvoice } from '../actions';
import { LINE_ROWS } from '../lines';
import { SalesLines, type ItemOption } from '../sales-lines';

/**
 * Raising a Sales Invoice — Operations build, block 5.
 *
 *   Lines     Item Code (searchable); Item Name (searchable); Quantity; Unit
 *             Price; Discount; Total Price; Supplier; Warehouse.
 *   Supplier  When an item is selected, the supplier field shows the
 *             supplier(s) linked to that item.
 *   COGS      FIFO. The item cost follows the selected item, supplier and
 *             warehouse stock.
 *
 * The supplier is on the line rather than the header because that is what the
 * cost rule requires: the same panel bought from two suppliers is two pools of
 * stock at two prices, and a sale has to say which it draws from. Leaving it
 * blank is a real answer — the oldest stock of any supplier — and not a gap.
 *
 * Every item's suppliers are sent to the grid up front. It is one small list
 * per item, and the alternative is a round trip each time somebody picks a row.
 */
export const dynamic = 'force-dynamic';

export default async function NewArInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/ar-invoices')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', ar.PERMISSION_OBJECT)) {
    return <Denied object={page('ar_invoices')} />;
  }

  const { customers, allCustomers, options, allItems, houses } = await withCurrentUser(async (tx) => {
    const everyItem = await items.listAll(tx);
    const stock = everyItem.filter((row) => row.isStock && row.active);
    const options: ItemOption[] = [];
    for (const row of stock) {
      const linked = await items.suppliersOf(tx, row.id);
      options.push({
        code: row.code,
        name: row.name,
        suppliers: linked
          .filter((link) => link.active)
          .map((link) => ({ id: link.supplierId, label: `${link.supplierCode} · ${link.supplierName}` })),
      });
    }
    return {
      customers: await partners.listActiveInRole(tx, 'customer'),
      // The whole list too, so an empty picker can say which of the two things
      // is wrong: nobody has been added, or nobody added is active.
      allCustomers: await partners.listByRole(tx, 'customer'),
      options,
      allItems: everyItem,
      houses: await warehouses.listActive(tx),
    };
  });

  const today = new Date().toISOString().slice(0, 10);

  const missing = gapsFor([
    { kind: 'customers', total: allCustomers.length, usable: customers.length },
    { kind: 'items', total: allItems.length, usable: options.length },
    { kind: 'warehouses', total: houses.length, usable: houses.length },
  ]).map((gap) => t(`setup.${gap.key}`, gap.count === undefined ? {} : { count: gap.count }));

  return (
    <AdminPage
      back={{ href: '/sales/ar-invoices', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/sales/ar-invoices" />}
      subtitle={t('ar_invoices.subtitle')}
      title={t('ar_invoices.new')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <Form action={createArInvoice}>
          <Grid>
            <label className="field">
              <span className="field__label">{column('customer_name')}</span>
              <select className="field__input" name="customer_id" required>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.code} · {customer.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              defaultValue={today}
              label={column('posting_date')}
              name="invoice_date"
              required
              requiredLabel={t('required_hint')}
              type="date"
            />
            <Field label={column('due_date')} name="due_date" type="date" />
          </Grid>

          <h2 className={s.sapTitle}>
            <span>{t('ar_invoices.lines')}</span>
            <span className={s.sapTitleMeta}>{t('ar_invoices.line_hint')}</span>
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
                  <th scope="col">{column('supplier')}</th>
                  <th scope="col">{column('warehouse_name')}</th>
                </tr>
              </thead>
              <SalesLines
                items={options}
                labels={{
                  itemCode: column('item_code'),
                  quantity: column('quantity'),
                  unitPrice: column('unit_price'),
                  discount: column('discount'),
                  supplier: column('supplier'),
                  warehouse: column('warehouse_name'),
                  anySupplier: t('ar_invoices.any_supplier'),
                }}
                rows={LINE_ROWS}
                warehouses={houses.map((house) => ({ code: house.code, name: house.name }))}
              />
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
