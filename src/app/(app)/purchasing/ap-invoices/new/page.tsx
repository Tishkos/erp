import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { PairedPicker } from '@/components/admin/paired-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import { gapsFor } from '@domain/setup-gaps';
import { createApInvoice } from '../actions';

/**
 * Raising a Purchase Invoice — Operations build, block 4.
 *
 *   Header  Invoice Number (automatically generated); Posting Date; Due Date;
 *           Supplier Code; Supplier Name (searchable).
 *   Lines   Item Code; Item Name (automatically shown when the Item Code is
 *           selected); Quantity; Unit Price; Discount; Total Price; Warehouse.
 *
 * Those fields and no others (by direction, 2026-09-16). The invoice number is
 * not on the form because the sponsor says it is generated, and it is —
 * allocated when the invoice is saved.
 *
 * The supplier is two boxes rather than one, because the sponsor lists two: a
 * person holding the code types the code, a person holding the name types the
 * name, and either one fills the other.
 *
 * In the Journal Entry's window, like the invoice it becomes, and the grid
 * grows as it is typed: one line to start with, and filling it opens the next.
 */
export const dynamic = 'force-dynamic';

export default async function NewApInvoicePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/purchasing/ap-invoices')) notFound();

  const [t, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }

  const { suppliers, allSuppliers, stockItems, houses } = await withCurrentUser(async (tx) => ({
    suppliers: await partners.listActiveInRole(tx, 'supplier'),
    // The whole list too, so an empty picker can say which of the two things is
    // wrong: nobody has been added, or nobody added is active.
    allSuppliers: await partners.listByRole(tx, 'supplier'),
    stockItems: await items.listAll(tx),
    houses: await warehouses.listActive(tx),
  }));

  const sellable = stockItems.filter((item) => item.isStock && item.active);
  const today = new Date().toISOString().slice(0, 10);

  const missing = gapsFor([
    { kind: 'suppliers', total: allSuppliers.length, usable: suppliers.length },
    { kind: 'items', total: stockItems.length, usable: sellable.length },
    { kind: 'warehouses', total: houses.length, usable: houses.length },
  ]).map((gap) => t(`setup.${gap.key}`, gap.count === undefined ? {} : { count: gap.count }));

  const fields: DocumentField[] = [
    {
      label: column('supplier_code'),
      bare: true,
      value: (
        <PairedPicker
          codeLabel={column('supplier_code')}
          name="supplier_id"
          nameLabel={column('supplier_name')}
          options={suppliers.map((supplier) => ({
            value: supplier.id,
            code: supplier.code,
            name: supplier.name,
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
      value: <input aria-label={column('due_date')} name="due_date" required type="date" />,
    },
  ];

  return (
    <AdminPage
      back={{ href: '/purchasing/ap-invoices', label: t('back') }}
      title={t('ap_invoices.new')}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <form action={createApInvoice}>
          <DocumentWindow
            actions={
              <button className="action action--primary" type="submit">
                {t('create')}
              </button>
            }
            documentType={page('ap_invoice')}
            fields={fields}
            id="ap-invoice-new"
            linesTitle={t('ap_invoices.lines')}
            number=""
          >
            <InvoiceLinesGrid
              currency="IQD"
              headingId="ap-invoice-new-lines-heading"
              items={sellable.map((item) => ({
                code: item.code,
                name: item.name,
                uomCode: item.baseUomCode,
              }))}
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
              warehouses={houses.map((house) => ({ code: house.code, name: house.name }))}
            />
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
