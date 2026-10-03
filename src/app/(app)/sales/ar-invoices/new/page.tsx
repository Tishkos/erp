import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { DueDateField } from '@/components/admin/due-date-field';
import { PairedPicker } from '@/components/admin/paired-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as items from '@/server/services/items';
import * as coa from '@/server/services/chart-of-accounts';
import * as paymentTerms from '@/server/services/payment-terms';
import * as partners from '@/server/services/partners';
import * as posting from '@/server/services/posting';
import * as warehouses from '@/server/services/warehouses';
import { gapsFor } from '@domain/setup-gaps';
import { createArInvoice, invoiceLineAvailability } from '../actions';
import { businessToday } from '@/server/domain/business-date';

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

  const { customers, allCustomers, options, allItems, houses, schedules, accounts, mapped } =
    await withCurrentUser(async (tx) => ({
    customers: await partners.listActiveInRole(tx, 'customer'),
    // The whole list too, so an empty picker can say which of the two things
    // is wrong: nobody has been added, or nobody added is active.
    allCustomers: await partners.listByRole(tx, 'customer'),
    options: await items.invoiceChoices(tx, 'sale'),
    allItems: await items.listAll(tx),
    houses: (await warehouses.listActive(tx)).filter(
      (house) => house.branchCode === context.scope.branchCode,
    ),
    // Where this invoice will post, shown on the form that raises it — by
    // direction, 2026-09-23: the accounts are chosen here, not on a screen of
    // their own. The receivable opens on the configured mapping, so the
    // ordinary case is "leave it alone"; revenue opens on "as configured"
    // (see the field) so each item's own Sales Account still applies.
    schedules: await paymentTerms.allWithSchedules(tx),
    accounts: await coa.postableAccounts(tx),
    mapped: {
      receivable: await posting.mappedAccountFor(
        tx,
        'sales.ar_invoice',
        'customer_receivable',
        context.scope.branchCode,
      ),
    },
  }));

  const today = businessToday();

  // Each customer beside the terms they are on, which is all the due date
  // needs: the partner chosen in the header decides which schedule applies.
  const termsByCode = new Map(schedules.map((terms) => [terms.code, terms]));
  const customerTerms = customers.map((customer) => ({
    partnerId: customer.id,
    terms: (customer.paymentTermsCode ? termsByCode.get(customer.paymentTermsCode) : null) ?? null,
  }));

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
      // Filled from the customer's payment terms the moment the customer is
      // chosen, and editable after — §16's default, not a lock. It had been a
      // bare date box: the terms were applied by the service on save, so the
      // stored date was right while the form showed nothing, and a person
      // reading the screen could not tell the invoice had a due date at all.
      value: (
        <DueDateField
          dateField="invoice_date"
          label={column('due_date')}
          name="due_date"
          partnerField="customer_id"
          required
          terms={customerTerms}
        />
      ),
    },
    {
      label: t('invoices.statement_account_customer'),
      control: true,
      value: (
        <select
          aria-label={t('invoices.statement_account_customer')}
          defaultValue={mapped.receivable ?? ''}
          name="receivable_account_id"
        >
          <option value="">{t('invoices.account_default')}</option>
          {accounts
            .filter((account) => account.controlAccount === 'customer')
            .map((account) => (
              <option key={account.id} value={account.id}>
                {`${account.code} · ${account.name}`}
              </option>
            ))}
        </select>
      ),
    },
    {
      label: t('invoices.revenue_account'),
      control: true,
      value: (
        // Opens on "as configured", not on the mapping: an account chosen
        // here outranks every item's own Sales Account (block 1), so opening
        // on the mapping silently overrode them all. Blank means each line
        // posts to its item's account, then the mapping.
        <select
          aria-label={t('invoices.revenue_account')}
          defaultValue=""
          name="revenue_account_id"
        >
          <option value="">{t('invoices.account_default')}</option>
          {accounts
            .filter(
              (account) => account.accountType === 'revenue' && account.controlAccount === null,
            )
            .map((account) => (
              <option key={account.id} value={account.id}>
                {`${account.code} · ${account.name}`}
              </option>
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
              <Submit label={t('create')} variant="document" />
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
              loadAvailability={invoiceLineAvailability}
              mode="sale"
              widthsKey={`erp.lines.ar.${context.principal.userId}`}
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
                resizeColumn: t('invoices.resize_column'),
                saveFailed: t('invoices.save_failed'),
                checkingStock: t('invoices.checking_stock'),
                stockUnavailable: t('invoices.stock_unavailable'),
                availableStock: t('invoices.available_stock'),
                availabilityHint: t('invoices.availability_hint'),
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
