import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { InvoiceLinesGrid, type LineItem } from '@/components/admin/invoice-lines-grid';
import { PairedPicker } from '@/components/admin/paired-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
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
 * Those fields and no others (by direction, 2026-09-16). The customer is two
 * boxes because the sponsor lists two, both searchable, and either one fills
 * the other — as the item's code and name do on every line.
 *
 * The grid grows as it is typed: one line to start with, and filling it opens
 * the next, the way the Journal Entry's does. It is the same component the
 * Purchase Invoice uses — the Supplier column and the searchable item are the
 * only differences, and they are flags rather than a second file.
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

  const { customers, allCustomers, options, allItems, houses, accounting } = await withCurrentUser(async (tx) => {
    const everyItem = await items.listAll(tx);
    const stock = everyItem.filter((row) => row.isStock && row.active);
    const options: LineItem[] = [];
    for (const row of stock) {
      const linked = await items.suppliersOf(tx, row.id);
      options.push({
        code: row.code,
        name: row.name,
        // The item's own unit, sent with the line rather than assumed to be each.
        uomCode: row.baseUomCode,
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
      accounting: await ar.accountingChoices(tx),
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
      label: column('customer_code'),
      bare: true,
      value: (
        <PairedPicker
          codeLabel={column('customer_code')}
          name="customer_id"
          nameLabel={column('customer_name')}
          options={customers.map((customer) => ({
            value: customer.id,
            code: customer.code,
            name: customer.name,
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
      label: t('ar_invoices.business_line'),
      control: true,
      value: (
        <select aria-label={t('ar_invoices.business_line')} name="business_line_code" defaultValue="">
          <option value="">{t('none')}</option>
          {accounting.businessLines.filter((line) => line.active).map((line) => (
            <option key={line.code} value={line.code}>{line.code} · {line.name}</option>
          ))}
        </select>
      ),
    },
    {
      label: t('ar_invoices.department'),
      control: true,
      value: (
        <select aria-label={t('ar_invoices.department')} name="department_code" defaultValue="">
          <option value="">{t('none')}</option>
          {accounting.departments.filter((row) => row.active).map((row) => (
            <option key={row.code} value={row.code}>{row.code} · {row.name}</option>
          ))}
        </select>
      ),
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
                itemName: column('item_name'),
                quantity: column('quantity'),
                unitPrice: column('unit_price'),
                discount: column('discount'),
                total: column('total_price'),
                supplier: column('supplier'),
                warehouse: column('warehouse'),
                anySupplier: t('ar_invoices.any_supplier'),
                chooseItem: '',
                remove: t('remove_line'),
                documentTotal: t('reports.totals'),
                saving: t('journals.saving'),
              }}
              locale={locale}
              searchItems
              showSupplier
              warehouses={houses.map((house) => ({ code: house.code, name: house.name }))}
            />
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
