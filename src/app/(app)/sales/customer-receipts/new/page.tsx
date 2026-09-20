import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { PairedPicker } from '@/components/admin/paired-picker';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/bank-cash-accounts';
import * as partners from '@/server/services/partners';
import * as receipts from '@/server/services/customer-receipt';
import { gapsFor } from '@domain/setup-gaps';
import { createReceipt } from '../actions';

/**
 * Recording a Receipt — Operations build, block 6.
 *
 *   Receipts  Customer Name; Customer Code; Date; Bank/Cash Name; Bank/Cash
 *             Code; Amount; Reference; Customer Invoice.
 *
 * The invoice is not on this form. A receipt is allocated after it exists —
 * possibly across several invoices, possibly partly — so asking for one here
 * would make the common case the awkward one. The receipt's own page does it.
 */
export const dynamic = 'force-dynamic';

export default async function NewReceiptPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-receipts')) notFound();

  const [t, page, column, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  if (!can(context.principal, 'create', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('customer_receipts')} />;
  }

  const { customers, allCustomers, accounts } = await withCurrentUser(async (tx) => ({
    customers: await partners.listActiveInRole(tx, 'customer'),
    // The whole list too, so an empty picker can say which of the two things is
    // wrong: nobody has been added, or nobody added is active.
    allCustomers: await partners.listByRole(tx, 'customer'),
    accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))],
  }));

  const open = accounts.filter((account) => account.active);
  const today = new Date().toISOString().slice(0, 10);

  const missing = gapsFor([
    { kind: 'customers', total: allCustomers.length, usable: customers.length },
    { kind: 'accounts', total: accounts.length, usable: open.length },
  ]).map((gap) => t(`setup.${gap.key}`, gap.count === undefined ? {} : { count: gap.count }));

  return (
    <AdminPage
      back={{ href: '/sales/customer-receipts', label: t('back') }}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      tabs={<SectionTabs route="/sales/customer-receipts" />}
      subtitle={t('customer_receipts.subtitle')}
      title={t('customer_receipts.new')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={false} savedLabel="" />

      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <Form action={createReceipt}>
          <Grid>
            <PairedPicker
              codeLabel={column('customer_code')}
              name="customer_id"
              nameLabel={column('customer_name')}
              options={customers.map((customer) => ({
                value: customer.id,
                code: customer.code,
                name: customer.name,
              }))}
              plain
              required
            />
            <PairedPicker
              codeLabel={column('bank_code')}
              name="bank_cash_account_id"
              nameLabel={column('bank_name')}
              options={open.map((account) => ({
                value: account.id,
                code: account.code,
                name: account.name,
              }))}
              plain
              required
            />
            <Field
              defaultValue={today}
              label={column('posting_date')}
              name="receipt_date"
              required
              requiredLabel={t('required_hint')}
              type="date"
            />
            <Field
              label={t('customer_receipts.amount')}
              name="amount_iqd"
              required
              requiredLabel={t('required_hint')}
            />
            <Field label={t('customer_receipts.reference')} name="bank_reference" />
          </Grid>

          <SubmitRow>
            <Submit label={t('create')} />
          </SubmitRow>
        </Form>
      )}
    </AdminPage>
  );
}
