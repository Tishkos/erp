import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { PairedPicker } from '@/components/admin/paired-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/bank-cash-accounts';
import * as partners from '@/server/services/partners';
import * as payments from '@/server/services/supplier-payment';
import { gapsFor } from '@domain/setup-gaps';
import { createPayment } from '../actions';

/**
 * Making a Payment — Operations build, block 6.
 *
 *   Payments  Supplier Name; Supplier Code; Date; Bank/Cash Name; Bank/Cash
 *             Code; Amount; Reference; Supplier Invoice.
 *
 * In the Journal Entry's window, like the payment it becomes. It used to be an
 * ordinary settings form, so pressing Create changed the design under the
 * person who pressed it: the boxes they had just filled came back as a
 * document they had never seen (reported 2026-09-29). The same window before
 * and after means the draft is the document, unfinished.
 *
 * The invoice is not on this form. A payment is allocated after it exists —
 * possibly across several invoices, possibly partly — so asking for one here
 * would make the common case the awkward one. The lines section says so and
 * the payment's own page does it.
 *
 * The supplier and the account are each two boxes, because the sponsor lists
 * each twice — a code and a name. Either one fills the other.
 */
export const dynamic = 'force-dynamic';

export default async function NewPaymentPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/purchasing/supplier-payments')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', payments.PERMISSION_OBJECT)) {
    return <Denied object={page('supplier_payments')} />;
  }

  const { suppliers, allSuppliers, accounts } = await withCurrentUser(async (tx) => ({
    suppliers: await partners.listActiveInRole(tx, 'supplier'),
    // The whole list too, so an empty picker can say which of the two things is
    // wrong: nobody has been added, or nobody added is active.
    allSuppliers: await partners.listByRole(tx, 'supplier'),
    accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))],
  }));

  // Active, and with a G/L account still behind it. A bank or cash account
  // whose G/L account was deleted outside the application cannot post, so
  // offering it here would only produce a document that fails on posting;
  // the count above still sees it, so the setup hint says one is unusable.
  const open = accounts.filter((account) => account.active && account.glAccountCode);
  const today = new Date().toISOString().slice(0, 10);

  const missing = gapsFor([
    { kind: 'suppliers', total: allSuppliers.length, usable: suppliers.length },
    { kind: 'accounts', total: accounts.length, usable: open.length },
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
      label: column('bank_code'),
      bare: true,
      value: (
        <PairedPicker
          codeLabel={column('bank_code')}
          name="bank_cash_account_id"
          nameLabel={column('bank_name')}
          options={open.map((account) => ({
            value: account.id,
            code: account.code,
            name: account.name,
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
          name="payment_date"
          required
          type="date"
        />
      ),
    },
    {
      label: t('supplier_payments.amount'),
      control: true,
      value: (
        <input
          aria-label={t('supplier_payments.amount')}
          dir="ltr"
          inputMode="decimal"
          min={0}
          name="amount_iqd"
          required
          step="0.0001"
          type="number"
        />
      ),
    },
    {
      label: t('supplier_payments.reference'),
      control: true,
      value: (
        <input
          aria-label={t('supplier_payments.reference')}
          autoComplete="off"
          dir="auto"
          name="reference"
          type="text"
        />
      ),
    },
  ];

  return (
    <AdminPage
      back={{ href: '/purchasing/supplier-payments', label: t('back') }}
      title={t('supplier_payments.new')}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <form action={createPayment}>
          <DocumentWindow
            actions={<Submit label={t('create')} variant="document" />}
            documentType={page('supplier_payments')}
            fields={fields}
            id="payment-new"
            linesTitle={t('supplier_payments.invoice')}
            number=""
          >
            {/* The same lines table the payment wears, saying why it is empty:
                there is nothing to allocate against until the payment exists. */}
            <table aria-labelledby="payment-new-lines-heading" className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('supplier_payments.outstanding')}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={3}>{t('supplier_payments.allocate_after_create')}</td>
                </tr>
              </tbody>
            </table>
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
