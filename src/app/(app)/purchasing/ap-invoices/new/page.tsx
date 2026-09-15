import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SearchablePicker } from '@/components/admin/searchable-picker';
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
import { LINE_ROWS } from '../lines';

/**
 * Raising a Purchase Invoice — Operations build, block 4.
 *
 *   Header  Invoice Number (automatically generated); Posting Date; Due Date;
 *           Supplier Code; Supplier Name (searchable).
 *   Lines   Item Code; Item Name (automatically shown when the Item Code is
 *           selected); Quantity; Unit Price; Discount; Total Price; Warehouse.
 *
 * In the Journal Entry's window, like the invoice it becomes. That is not only
 * for the look: `.sapDoc` styles the controls inside it, so every box fills its
 * column. Outside the window they were unstyled, which is what made the grid
 * read as a row of loose boxes rather than a table.
 *
 * The invoice number is not on the form because the sponsor says it is
 * generated, and it is — allocated when the invoice is saved. "Item Name shown
 * when the Item Code is selected" is met by the picker carrying `CODE · Name`
 * in one control, so the name is never a second thing to keep in step.
 *
 * Eight rows, and a blank one is dropped rather than refused. A row naming an
 * item and nothing else is somebody halfway through typing, and that is refused
 * with a sentence — posting it as a zero would be worse.
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
      label: column('supplier_name'),
      control: true,
      value: (
        <SearchablePicker
          bare
          label={column('supplier_name')}
          name="supplier_id"
          options={suppliers.map((supplier) => ({
            value: supplier.id,
            label: `${supplier.code} · ${supplier.name}`,
          }))}
          placeholder={t('search_placeholder')}
          required
        />
      ),
    },
    {
      label: t('ap_invoices.supplier_invoice_no'),
      control: true,
      value: (
        <input
          aria-label={t('ap_invoices.supplier_invoice_no')}
          name="supplier_invoice_no"
          required
          type="text"
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
    {
      label: t('journals.description'),
      control: true,
      wide: true,
      value: <input aria-label={t('journals.description')} name="note" type="text" />,
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
            linesCount={LINE_ROWS}
            linesTitle={t('ap_invoices.lines')}
            number=""
          >
            <table aria-labelledby="ap-invoice-new-lines-heading" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">#</th>
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
                  <th scope="col">{column('warehouse_code')}</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: LINE_ROWS }, (_, row) => (
                  <tr key={row}>
                    <td>
                      <bdi dir="ltr">{row + 1}</bdi>
                    </td>
                    <td className={s.sapAccountCell}>
                      <select aria-label={column('item_code')} defaultValue="" name={`item_code_${row}`}>
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
                        inputMode="decimal"
                        name={`quantity_${row}`}
                      />
                    </td>
                    <td className={s.sapNum}>
                      <input
                        aria-label={column('unit_price')}
                        inputMode="decimal"
                        name={`unit_price_${row}`}
                      />
                    </td>
                    <td className={s.sapNum}>
                      <input
                        aria-label={column('discount')}
                        inputMode="decimal"
                        name={`discount_${row}`}
                      />
                    </td>
                    <td>
                      <select
                        aria-label={column('warehouse_code')}
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
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
