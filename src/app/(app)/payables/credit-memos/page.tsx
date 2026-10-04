import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Field,
  FilterRow,
  Flash,
  Form,
  Grid,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
  matches,
} from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { businessToday } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as coa from '@/server/services/chart-of-accounts';
import * as notes from '@/server/services/supplier-notes';
import { createCreditNoteAction, createDebitNoteAction } from './actions';

/**
 * Supplier Credit / Debit Notes — REQ-PAY-001 PAY8 / PAY9 (2026-10-04), the
 * Purchase Invoices register's shape. One register for the three things a
 * supplier's paperwork can do to what we owe: a credit note (standalone — a
 * price, a rebate, damaged goods not sent back), the credit memo a purchase
 * return produced, and a debit note (an extra charge). Credit notes open on
 * their own record; a debit note is a purchase invoice (D-PAY-2) and opens
 * there. "New credit note" and "New debit note" are the dialogs at the top,
 * the way the register models raise theirs.
 */
export const dynamic = 'force-dynamic';

const KINDS = ['credit', 'credit_memo', 'debit'] as const;

export default async function SupplierNotesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/credit-memos')) notFound();

  const [t, x, page, column, status, locale, context, outcome, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.supplier_notes'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    searchParams,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', notes.PERMISSION_OBJECT) && !can(principal, 'view', 'ap_invoice')) {
    return <Denied object={page('supplier_credit_memos')} />;
  }
  const mayCredit = can(principal, 'create', notes.PERMISSION_OBJECT);
  const mayDebit = can(principal, 'create', 'ap_invoice');
  const kindParam = typeof params.kind === 'string' && (KINDS as readonly string[]).includes(params.kind) ? params.kind : '';
  const today = businessToday();

  const { rows, invoices, accounts } = await withCurrentUser(async (tx) => ({
    rows: await notes.list(tx),
    invoices: mayCredit || mayDebit ? await notes.invoiceChoices(tx) : [],
    accounts: mayCredit || mayDebit ? await coa.postableAccounts(tx) : [],
  }));
  const kindOf = (row: notes.NoteRow) => (row.kind === 'debit' ? 'debit' : row.returnNo ? 'credit_memo' : 'credit');
  const shown = rows.filter((row) => matches({ ...row }, outcome.q)).filter((row) => (kindParam ? kindOf(row) === kindParam : true));
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const invoiceOptions = invoices.map((invoice) => ({
    value: invoice.id,
    label: `${invoice.invoiceNo} · ${invoice.supplierCode} · ${invoice.supplierName} · ${money(invoice.totalIqd)}`,
  }));
  const accountOptions = (eligible: (account: (typeof accounts)[number]) => boolean) =>
    accounts.filter(eligible).map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }));

  return (
    <AdminPage
      actions={
        <>
          {mayCredit ? (
            <NewRecordDialog
              buttonLabel={x('new_credit')}
              closeLabel={t('close')}
              openOnLoad={params.new === 'credit' && Boolean(outcome.error)}
              title={x('new_credit')}
            >
              <p className="muted">{x('new_credit_hint')}</p>
              <Form action={createCreditNoteAction}>
                <Grid>
                  <Select label={x('invoice')} name="ap_invoice_id" options={invoiceOptions} required />
                  <Field hint={x('supplier_note_no_hint')} label={x('supplier_note_no')} name="supplier_memo_no" />
                  <Field defaultValue={today} label={x('note_date')} name="memo_date" required type="date" />
                  <Field label={x('amount')} name="amount_iqd" required />
                  <Select
                    emptyLabel={x('credit_account_default')}
                    label={x('credit_account')}
                    name="credit_account_id"
                    options={accountOptions((account) => account.controlAccount === null)}
                  />
                </Grid>
                <Field label={x('reason')} name="reason" required wide />
                <SubmitRow>
                  <Submit label={x('create')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          ) : null}
          {mayDebit ? (
            <NewRecordDialog
              buttonLabel={x('new_debit')}
              closeLabel={t('close')}
              openOnLoad={params.new === 'debit' && Boolean(outcome.error)}
              title={x('new_debit')}
            >
              <p className="muted">{x('new_debit_hint')}</p>
              <Form action={createDebitNoteAction}>
                <Grid>
                  <Select label={x('invoice')} name="ap_invoice_id" options={invoiceOptions} required />
                  <Field hint={x('supplier_note_no_hint')} label={x('supplier_note_no')} name="supplier_note_no" />
                  <Field defaultValue={today} label={x('note_date')} name="note_date" required type="date" />
                  <Field label={x('amount')} name="amount_iqd" required />
                  <Field hint={x('due_date_hint')} label={x('due_date')} name="due_date" type="date" />
                  <Select
                    emptyLabel={x('expense_account_default')}
                    label={x('expense_account')}
                    name="expense_account_id"
                    options={accountOptions((account) => account.accountType === 'expense' && account.controlAccount === null)}
                  />
                </Grid>
                <Field label={x('reason')} name="reason" required wide />
                <SubmitRow>
                  <Submit label={x('create')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          ) : null}
        </>
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/payables/credit-memos" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="supplier-notes-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="supplier-notes-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/credit-memos"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={kindParam}
                emptyLabel={x('all_kinds')}
                label={x('kind')}
                name="kind"
                options={KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="supplier-notes-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{x('col_no')}</th>
                  <th scope="col">{x('col_kind')}</th>
                  <th scope="col">{x('note_date')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th scope="col">{column('invoice_no')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('applied_or_paid')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td>
                      <ProfileLink code={row.number} kind={row.kind === 'debit' ? 'purchase_invoice' : 'supplier_credit_note'} />
                    </td>
                    <td>{x(`kind_${kindOf(row)}`)}</td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.noteDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} kind="supplier">
                        {row.supplierCode ?? '—'}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName ?? '—'}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.invoiceNo} kind="purchase_invoice" />
                      {row.returnNo ? (
                        <>
                          {' · '}
                          <ProfileLink code={row.returnNo} kind="goods_return" />
                        </>
                      ) : null}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.settledIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
