import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, Flash, Form, Grid, ReadOnlyField, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { pickOne, pickOutcome } from '@domain/pick';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as coa from '@/server/services/chart-of-accounts';
import * as partners from '@/server/services/partners';
import * as notes from '@/server/services/customer-notes';
import { createNote } from '../actions';
import { IntentSelect } from '@/components/admin/intent-select';

/**
 * Raising a credit or debit note — Receivables, 2026-10-04.
 *
 * Two steps, as the Sales Return's: the customer first, typed, because every
 * other choice on the form is that customer's — the invoice the note corrects
 * (optional: a late-payment charge answers to no one invoice) and, for a
 * debit note, the terms its due date is worked out from. The customers are the
 * Master Data's; nothing here keeps a list of its own.
 */
export const dynamic = 'force-dynamic';

export default async function NewNotePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/credit-notes')) notFound();

  const [t, admin, page, column, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin.customer_notes'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  if (!can(context.principal, 'create', notes.PERMISSION_OBJECT)) {
    return <Denied object={page('customer_credit_memos')} />;
  }

  const kind = params.kind === 'debit' ? 'debit' : 'credit';
  const typed = typeof params.customer === 'string' ? params.customer : '';
  const invoiceAsked = typeof params.invoice === 'string' ? params.invoice : '';

  const { customers, customer, invoices, accounts } = await withCurrentUser(async (tx) => {
    const all = await partners.listActiveInRole(tx, 'customer');
    const picked = pickOne(all, typed, (row) => row.code, (row) => [row.code, row.name]);
    return {
      customers: all,
      customer: picked,
      invoices: picked ? await notes.invoicesFor(tx, picked.id) : [],
      // The other side of the entry: a revenue account that keeps no partner's
      // balance — the same rule the invoice's own revenue picker follows.
      accounts: picked
        ? (await coa.postableAccounts(tx)).filter(
            (account) => account.accountType === 'revenue' && account.controlAccount === null,
          )
        : [],
    };
  });
  const found = pickOutcome(customers, typed, (row) => row.code, (row) => [row.code, row.name]);
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const today = businessToday();

  return (
    <AdminPage
      back={{ href: '/sales/credit-notes', label: admin('back') }}
      trail={[{ href: '/', label: admin('dashboard_label') }]}
      tabs={<SectionTabs route="/sales/credit-notes" />}
      subtitle={t(kind === 'credit' ? 'new_credit_subtitle' : 'new_debit_subtitle')}
      title={t(kind === 'credit' ? 'new_credit' : 'new_debit')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={false} savedLabel="" />

      <form className={s.pickRow} method="get">
        <input name="kind" type="hidden" value={kind} />
        <div className={s.field}>
          <span className={s.label}>{column('customer_name')}</span>
          <span className={s.fieldWithAction}>
            <input
              className={s.input}
              defaultValue={typed}
              list="note-customers"
              name="customer"
              placeholder={t('customer_hint')}
              required
            />
            <Submit label={admin('choose')} tone="secondary" variant="document" />
          </span>
          <datalist id="note-customers">
            {customers.map((row) => (
              <option key={row.id} value={row.code}>
                {row.name}
              </option>
            ))}
          </datalist>
          <span className={s.hint}>
            {found === 'ambiguous'
              ? t('customer_ambiguous')
              : found === 'none'
                ? t('customer_unknown')
                : t('pick_customer')}
          </span>
        </div>
      </form>

      {!customer ? null : (
        <Form action={createNote}>
          <input name="kind" type="hidden" value={kind} />
          <input name="customer_id" type="hidden" value={customer.id} />
          <input name="customer_code" type="hidden" value={customer.code} />
          <Grid>
            <ReadOnlyField label={column('customer_code')} value={customer.code} />
            <ReadOnlyField label={column('customer_name')} value={customer.name} />
            <ReadOnlyField label={t('kind')} value={t(`kind_${kind}`)} />
            <Field
              defaultValue={today}
              label={column('posting_date')}
              name="note_date"
              required
              requiredLabel={admin('required_hint')}
              type="date"
            />
            {kind === 'debit' ? (
              <Field hint={t('due_date_hint')} label={column('due_date')} name="due_date" type="date" />
            ) : null}
            <label className={s.field}>
              <span className={s.label}>{column('invoice_no')}</span>
              <IntentSelect defaultValue={invoiceAsked} name="ar_invoice_id">
                <option value="">{t('no_invoice')}</option>
                {invoices.map((invoice) => (
                  <option key={invoice.id} value={invoice.id}>
                    {`${invoice.invoiceNo} · ${money(invoice.netIqd)} · ${t('outstanding_short', { amount: money(invoice.outstandingIqd) })}`}
                  </option>
                ))}
              </IntentSelect>
              <span className={s.hint}>{t(kind === 'credit' ? 'invoice_hint_credit' : 'invoice_hint_debit')}</span>
            </label>
            <Field
              label={column('amount')}
              min={0}
              name="amount_iqd"
              required
              requiredLabel={admin('required_hint')}
              step="0.01"
              type="number"
            />
            <label className={s.field}>
              <span className={s.label}>{t(kind === 'credit' ? 'account_credit' : 'account_debit')}</span>
              <IntentSelect name="account_id">
                <option value="">{admin('invoices.account_default')}</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {`${account.code} · ${account.name}`}
                  </option>
                ))}
              </IntentSelect>
            </label>
            <Field label={t('reason')} name="reason" required requiredLabel={admin('required_hint')} wide />
            <Field label={t('description')} name="description" type="textarea" wide />
          </Grid>
          <SubmitRow>
            <Submit label={t(kind === 'credit' ? 'raise_credit' : 'raise_debit')} />
          </SubmitRow>
        </Form>
      )}
    </AdminPage>
  );
}
