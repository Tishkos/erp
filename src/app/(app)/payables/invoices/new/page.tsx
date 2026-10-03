import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { DueDateField } from '@/components/admin/due-date-field';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { PairedPicker } from '@/components/admin/paired-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';
import * as items from '@/server/services/items';
import * as coa from '@/server/services/chart-of-accounts';
import * as partners from '@/server/services/partners';
import * as payables from '@/server/services/payables';
import * as posting from '@/server/services/posting';
import * as execution from '@/server/services/project-execution';
import * as paymentTerms from '@/server/services/payment-terms';
import * as warehouses from '@/server/services/warehouses';
import { gapsFor } from '@domain/setup-gaps';
import { createApInvoice, invoiceLineAvailability } from '../actions';
import { businessToday } from '@/server/domain/business-date';

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
  if (!visibleRoute('/payables/invoices')) notFound();

  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.expenses'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }

  const { suppliers, allSuppliers, stockItems, allItems, houses, schedules, accounts, mapped, imports, assignment } =
    await withCurrentUser(async (tx) => ({
      // REQ-PM-001 §8 — the project elements a purchase may be assigned to.
      assignment: await execution.assignmentPickers(tx),
      suppliers: await partners.listActiveInRole(tx, 'supplier'),
      // The whole list too, so an empty picker can say which of the two things is
      // wrong: nobody has been added, or nobody added is active.
      allSuppliers: await partners.listByRole(tx, 'supplier'),
      stockItems: await items.invoiceChoices(tx, 'purchase'),
      allItems: await items.listAll(tx),
      houses: (await warehouses.listActive(tx)).filter(
        (house) => house.branchCode === context.scope.branchCode,
      ),
      // The payment terms travel with the page so the due date can be worked
      // out while the invoice is being typed (§16).
      schedules: await paymentTerms.allWithSchedules(tx),
      // Where this invoice will post, chosen on the form that raises it (by
      // direction, 2026-09-23). The configured mapping opens as the chosen
      // value, so the ordinary case is to leave it alone.
      accounts: await coa.postableAccounts(tx),
      mapped: {
        payable: await posting.mappedAccountFor(
          tx,
          'purchasing.ap_invoice',
          'supplier_payable',
          context.scope.branchCode,
        ),
      },
      // §24.3 — an import already open (migrated from the sheet) takes its
      // supplier invoice here rather than opening a second application.
      imports: await payables.openImportsForInvoice(tx),
    }),
  );

  const sellable = stockItems;
  const today = businessToday();

  // Each supplier beside the terms they are on, which is all the due date
  // needs: the partner chosen in the header decides which schedule applies.
  const termsByCode = new Map(schedules.map((terms) => [terms.code, terms]));
  const supplierTerms = suppliers.map((supplier) => ({
    partnerId: supplier.id,
    terms: (supplier.paymentTermsCode ? termsByCode.get(supplier.paymentTermsCode) : null) ?? null,
  }));

  const missing = gapsFor([
    { kind: 'suppliers', total: allSuppliers.length, usable: suppliers.length },
    { kind: 'items', total: allItems.length, usable: sellable.length },
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
      // Filled from the supplier's payment terms the moment the supplier is
      // chosen, and editable after that — §16's default, not a lock.
      value: (
        <DueDateField
          dateField="invoice_date"
          label={column('due_date')}
          name="due_date"
          partnerField="supplier_id"
          required
          terms={supplierTerms}
        />
      ),
    },
    {
      label: t('invoices.statement_account_supplier'),
      control: true,
      value: (
        <select
          aria-label={t('invoices.statement_account_supplier')}
          defaultValue={mapped.payable ?? ''}
          name="payable_account_id"
        >
          <option value="">{t('invoices.account_default')}</option>
          {accounts
            .filter((account) => account.controlAccount === 'supplier')
            .map((account) => (
              <option key={account.id} value={account.id}>
                {`${account.code} · ${account.name}`}
              </option>
            ))}
        </select>
      ),
    },
    /*
     * D13 (2026-10-01) — the CEO agreed the deal on WeChat, the supplier's
     * PDF reached the accountant, and she enters it here. Ticking Import
     * opens the import application behind this invoice when it is saved:
     * the PD, the SWIFTs, the B/Ls and the containers then attach to it. The
     * terms are kept as the supplier wrote them.
     */
    {
      label: x('is_import'),
      control: true,
      value: (
        <label>
          {/*
           * Ticked to begin with, by direction (2026-10-03): nearly everything
           * this company buys comes from abroad, and the invoice that opens no
           * import application is the exception. Untick it for a local
           * purchase — and then the goods land in the warehouse on posting
           * rather than waiting at sea, which is what it means.
           */}
          <input defaultChecked name="is_import" type="checkbox" value="1" /> {x('is_import_hint')}
        </label>
      ),
    },
    {
      label: x('import_application'),
      control: true,
      value: (
        <select aria-label={x('import_application')} defaultValue="" name="payable_id">
          <option value="">{x('import_application_new')}</option>
          {imports.map((row) => (
            <option key={row.id} value={row.id}>
              {`${row.payableNo} · ${row.reference} · ${row.supplierName}`}
            </option>
          ))}
        </select>
      ),
    },
    {
      label: x('payment_terms_text'),
      control: true,
      value: (
        <input
          aria-label={x('payment_terms_text')}
          name="payment_terms_text"
          placeholder={x('payment_terms_placeholder')}
          type="text"
        />
      ),
    },
    /*
     * REQ-PM-001 §8 — a purchase for a project names its element and cost
     * code here; the order (or the payable) then promises it there, and the
     * posting spends it there. Left blank, nothing is assigned.
     */
    ...(assignment.elements.length > 0
      ? [
          {
            label: x('project_element'),
            control: true,
            value: (
              <select aria-label={x('project_element')} defaultValue="" name="project_element">
                <option value="">{x('project_element_none')}</option>
                {assignment.elements.map((e) => (
                  <option key={`${e.projectCode}|${e.wbsCode}`} value={`${e.projectCode}|${e.wbsCode}`}>
                    {`${e.wbsCode} · ${e.name} (${e.projectName})`}
                  </option>
                ))}
              </select>
            ),
          },
          {
            label: x('project_cost_code'),
            control: true,
            value: (
              <select aria-label={x('project_cost_code')} defaultValue="" name="project_cost_code">
                <option value="" />
                {assignment.codes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {`${c.code} · ${locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn}`}
                  </option>
                ))}
              </select>
            ),
          },
        ]
      : []),
  ];

  return (
    <AdminPage
      back={{ href: '/payables/invoices', label: t('back') }}
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
              <Submit label={t('create')} variant="document" />
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
              items={sellable}
              loadAvailability={invoiceLineAvailability}
              mode="purchase"
              unitColumn
              purchaseSupplierField="supplier_id"
              widthsKey={`erp.lines.ap.${context.principal.userId}`}
              labels={{
                itemCode: column('item_code'),
                itemName: column('item_name'),
                quantity: column('quantity'),
              unit: column('unit'),
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
              warehouses={houses.map((house) => ({ code: house.code, name: house.name }))}
            />
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
