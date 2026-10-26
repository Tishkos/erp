import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminPage, Flash, Submit, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { PairedPicker } from '@/components/admin/paired-picker';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { IntentDateField } from '@/components/admin/intent-date-field';
import { IntentSelect } from '@/components/admin/intent-select';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as banks from '@/server/services/bank-cash-accounts';
import * as partners from '@/server/services/partners';
import * as paymentMethods from '@/server/services/payment-methods';
import * as payments from '@/server/services/customer-payment';
import { createCustomerPayment } from '../actions';

/**
 * A new Customer Payment (0428) — in the document window it becomes, as the Customer Receipt's new
 * page is: the customer, the account the money leaves, the date, the amount in that account's
 * currency, how it was paid and what it is for. Each customer and each account says its currency,
 * so the one that matches is the one chosen. `?customer=<id>` opens it on that customer.
 */
export const dynamic = 'force-dynamic';

export default async function NewCustomerPaymentPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-payments')) notFound();
  const [t, admin, page, column, context, outcome, query] = await Promise.all([
    getTranslations('admin.money_out'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);
  if (!can(context.principal, 'create', payments.PERMISSION_OBJECT)) return <Denied object={page('customer_payments')} />;

  const { customers, accounts, methods } = await withCurrentUser(async (tx) => ({
    customers: await partners.listActiveInRole(tx, 'customer'),
    accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))].filter((a) => a.active && a.glAccountCode),
    methods: await paymentMethods.listActive(tx),
  }));
  const chosen = typeof query.customer === 'string' ? query.customer : '';
  const missing = [customers.length === 0 ? t('no_customers') : null, accounts.length === 0 ? t('no_accounts') : null].filter(Boolean);

  const fields: DocumentField[] = [
    {
      label: column('customer_code'),
      bare: true,
      value: (
        <PairedPicker
          codeLabel={column('customer_code')}
          defaultValue={chosen}
          name="customer_id"
          nameLabel={column('customer_name')}
          options={customers.map((c) => ({ value: c.id, code: c.code, name: c.currency ? `${c.name} · ${c.currency}` : c.name }))}
          placeholder={admin('search_placeholder')}
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
          options={accounts.map((a) => ({ value: a.id, code: a.code, name: `${a.name} · ${a.currency}` }))}
          placeholder={admin('search_placeholder')}
          required
        />
      ),
    },
    {
      label: column('posting_date'),
      control: true,
      value: <IntentDateField aria-label={column('posting_date')} defaultValue={businessToday()} name="payment_date" required />,
    },
    {
      label: t('amount'),
      control: true,
      value: <input aria-label={t('amount')} dir="ltr" inputMode="decimal" min={0} name="amount" required step="0.0001" type="number" />,
    },
    {
      label: t('payment_method'),
      control: true,
      value: (
        <IntentSelect aria-label={t('payment_method')} defaultValue="" name="payment_method_code">
          <option value="">{t('payment_method_none')}</option>
          {methods.map((method) => (
            <option key={method.code} value={method.code}>{`${method.code} · ${method.name}`}</option>
          ))}
        </IntentSelect>
      ),
    },
    {
      label: t('reference'),
      control: true,
      value: <input aria-label={t('reference')} autoComplete="off" dir="auto" name="reference" type="text" />,
    },
    {
      label: t('purpose'),
      control: true,
      wide: true,
      value: <input aria-label={t('purpose')} dir="auto" name="purpose" placeholder={t('purpose_hint_customer')} required type="text" />,
    },
    {
      label: t('note'),
      control: true,
      wide: true,
      value: <input aria-label={t('note')} dir="auto" name="note" type="text" />,
    },
  ];

  return (
    <AdminPage back={{ href: '/sales/customer-payments', label: admin('back') }} title={t('customer_new')} trail={[{ href: '/', label: admin('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <form action={createCustomerPayment}>
          <DocumentWindow
            actions={<Submit label={admin('create')} variant="document" />}
            documentType={page('customer_payments')}
            fields={fields}
            id="customer-payment-new"
            linesTitle={t('lines_title')}
            number=""
          >
            <p className={s.sectionHint}>{`${t('account_currency_hint')} ${t('draft_note')}`}</p>
          </DocumentWindow>
        </form>
      )}
    </AdminPage>
  );
}
