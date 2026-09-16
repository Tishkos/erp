import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { InvoiceLinesGrid, type LineItem } from '@/components/admin/invoice-lines-grid';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SearchablePicker } from '@/components/admin/searchable-picker';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import { gapsFor } from '@domain/setup-gaps';
import { createArInvoice } from '../actions';

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
 *
 * The grid grows as it is typed (by direction, 2026-09-16): one line to start
 * with, and filling it opens the next, the way the Journal Entry's does. It is
 * the same component the Purchase Invoice uses — the Supplier column is the
 * only difference between the two, and it is a flag rather than a second file.
 */
export const dynamic = 'force-dynamic';

export default async function NewArInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/ar-invoices')) notFound();

  const [t, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', ar.PERMISSION_OBJECT)) {
    return <Denied object={page('ar_invoices')} />;
  }

  const { customers, allCustomers, options, allItems, houses } = await withCurrentUser(async (tx) => {
    const everyItem = await items.listAll(tx);
    const stock = everyItem.filter((row) => row.isStock && row.active);
    const options: LineItem[] = [];
    for (const row of stock) {
      const linked = await items.suppliersOf(tx, row.id);
      options.push({
        code: row.code,
        name: row.name,
        // The item's own unit and what is on the shelf: a person selling from
        // stock is entitled to see how much of it there is.
        uomCode: row.baseUomCode,
        onHand: row.onHand,
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

  const fields: DocumentField[] = [
    {
      label: column('customer_name'),
      control: true,
      value: (
        <SearchablePicker
          bare
          label={column('customer_name')}
          name="customer_id"
          options={customers.map((customer) => ({
            value: customer.id,
            label: `${customer.code} · ${customer.name}`,
          }))}
          placeholder={t('search_placeholder')}
          required
        />
      ),
    },
    {
      label: column('posting_date'),
      control: true,
      value: (
        <input
          aria-label={column('posting_date')}
          defaultValue={today}
          name="invoice_date"
          required
          type="date"
        />
      ),
    },
    {
      label: column('due_date'),
      control: true,
      value: <input aria-label={column('due_date')} name="due_date" type="date" />,
    },
    {
      label: t('journals.description'),
      control: true,
      wide: true,
      value: <input aria-label={t('journals.description')} name="note" type="text" />,
    },
  ];

  return (
    <AdminPage
      back={{ href: '/sales/ar-invoices', label: t('back') }}
      title={t('ar_invoices.new')}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <form action={createArInvoice}>
          <DocumentWindow
            actions={
              <button className="action action--primary" type="submit">
                {t('create')}
              </button>
            }
            documentType={page('ar_invoice')}
            fields={fields}
            id="ar-invoice-new"
            linesTitle={t('ar_invoices.lines')}
            number=""
          >
            <InvoiceLinesGrid
              currency="IQD"
              headingId="ar-invoice-new-lines-heading"
              items={options}
              labels={{
                itemCode: column('item_code'),
                quantity: column('quantity'),
                unitPrice: column('unit_price'),
                discount: column('discount'),
                total: column('total_price'),
                supplier: column('supplier'),
                warehouse: column('warehouse_code'),
                anySupplier: t('ar_invoices.any_supplier'),
                chooseItem: t('choose_item'),
                remove: t('remove_line'),
                documentTotal: t('reports.totals'),
                lines: t('ar_invoices.lines'),
                onHand: column('on_hand'),
                saving: t('journals.saving'),
              }}
              locale={locale}
              showSupplier
              warehouses={houses.map((house) => ({ code: house.code, name: house.name }))}
            />
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
