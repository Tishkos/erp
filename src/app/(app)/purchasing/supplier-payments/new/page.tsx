import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
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
 * The invoice is not on this form. A payment is allocated after it exists —
 * possibly across several invoices, possibly partly — so asking for one here
 * would make the common case the awkward one. The payment's own page does it.
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

  const open = accounts.filter((account) => account.active);
  const today = new Date().toISOString().slice(0, 10);

  const missing = gapsFor([
    { kind: 'suppliers', total: allSuppliers.length, usable: suppliers.length },
    { kind: 'accounts', total: accounts.length, usable: open.length },
  ]).map((gap) => t(`setup.${gap.key}`, gap.count === undefined ? {} : { count: gap.count }));

  return (
    <AdminPage
      back={{ href: '/purchasing/supplier-payments', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/purchasing/supplier-payments" />}
      subtitle={t('supplier_payments.subtitle')}
      title={t('supplier_payments.new')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <Form action={createPayment}>
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
            <label className="field">
              <span className="field__label">{t('supplier_payments.bank_account')}</span>
              <select className="field__input" name="bank_cash_account_id" required>
                {open.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              defaultValue={today}
              label={column('posting_date')}
              name="payment_date"
              required
              requiredLabel={t('required_hint')}
              type="date"
            />
            <Field
              label={t('supplier_payments.amount')}
              name="amount_iqd"
              required
              requiredLabel={t('required_hint')}
            />
            <Field label={t('supplier_payments.reference')} name="reference" />
          </Grid>

          <SubmitRow>
            <Submit label={t('create')} />
          </SubmitRow>
        </Form>
      )}
    </AdminPage>
  );
}
