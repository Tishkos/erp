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
import * as coa from '@/server/services/chart-of-accounts';
import * as departments from '@/server/services/departments';
import * as paymentMethods from '@/server/services/payment-methods';
import * as payments from '@/server/services/expense-payment';
import { createExpensePayment } from '../actions';

/**
 * A new Expense Payment (0428) — in the document window it becomes: who was paid and for what, the
 * account the money leaves (its currency said beside it), the date, the amount in that currency,
 * the expense account it is charged to (expense accounts first; never a control account), and the
 * department when the account asks for one.
 */
export const dynamic = 'force-dynamic';

export default async function NewExpensePaymentPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/expense-payments')) notFound();
  const [t, admin, page, column, context, outcome] = await Promise.all([
    getTranslations('admin.money_out'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  if (!can(context.principal, 'create', payments.PERMISSION_OBJECT)) return <Denied object={page('expense_payments')} />;

  const { accounts, charged, sections, methods } = await withCurrentUser(async (tx) => ({
    accounts: [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))].filter((a) => a.active && a.glAccountCode),
    // Expense accounts first, then any other leaf that is not a control account.
    charged: (await coa.postableAccounts(tx))
      .filter((a) => !a.controlAccount)
      .sort((a, b) => Number(b.accountType === 'expense') - Number(a.accountType === 'expense') || a.code.localeCompare(b.code)),
    sections: (await departments.listAll(tx)).filter((d) => d.active),
    methods: await paymentMethods.listActive(tx),
  }));
  const missing = [accounts.length === 0 ? t('no_accounts') : null, charged.length === 0 ? t('no_expense_accounts') : null].filter(Boolean);

  const fields: DocumentField[] = [
    {
      label: t('payee'),
      control: true,
      value: <input aria-label={t('payee')} autoComplete="off" dir="auto" name="payee" required type="text" />,
    },
    {
      label: t('expense_account'),
      bare: true,
      value: (
        <PairedPicker
          codeLabel={column('account')}
          name="expense_account_id"
          nameLabel={t('expense_account')}
          options={charged.map((a) => ({ value: a.id, code: a.code, name: a.name }))}
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
      label: t('department'),
      control: true,
      value: (
        <IntentSelect aria-label={t('department')} defaultValue="" name="department_code">
          <option value="">{t('none_chosen')}</option>
          {sections.map((d) => (
            <option key={d.code} value={d.code}>{`${d.code} · ${d.name}`}</option>
          ))}
        </IntentSelect>
      ),
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
      value: <input aria-label={t('purpose')} dir="auto" name="purpose" placeholder={t('purpose_hint_expense')} required type="text" />,
    },
    {
      label: t('note'),
      control: true,
      wide: true,
      value: <input aria-label={t('note')} dir="auto" name="note" type="text" />,
    },
  ];

  return (
    <AdminPage back={{ href: '/treasury/expense-payments', label: admin('back') }} title={t('expense_new')} trail={[{ href: '/', label: admin('dashboard_label') }]} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />
      {missing.length > 0 ? (
        <p className={s.sectionHint}>{missing.join(' ')}</p>
      ) : (
        <form action={createExpensePayment}>
          <DocumentWindow
            actions={<Submit label={admin('create')} variant="document" />}
            documentType={page('expense_payments')}
            fields={fields}
            id="expense-payment-new"
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
