import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  Checkbox,
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
} from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { LoanBankField, LoanScheduleFields } from '@/components/admin/loan-terms-fields';
import { NEW_BANK } from './form';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as loans from '@/server/services/loans';
import { createLoan } from './actions';
import { LOAN_CHIP } from './status';
import { businessToday } from '@/server/domain/business-date';

/**
 * Bank loans — REQ-AP-001 §15.7, §21.10.
 *
 * One register for every lender: loan no · bank · principal · outstanding ·
 * next due · overdue · status, the open loans first. Drawn as Purchase
 * Invoices is: the module's tabs, one register window, the search box and
 * one filter, status chips in the last column.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['open', 'overdue', 'closed', 'all'] as const;

export default async function LoansPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/loans')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.loans'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', loans.PERMISSION_OBJECT)) {
    return <Denied object={page('loans')} />;
  }
  const mayCreate = can(principal, 'create', loans.PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view))
    ? (params.view as (typeof VIEWS)[number])
    : 'open';

  const { result, pickers } = await withCurrentUser(async (tx) => ({
    result: await loans.listForScreen(tx, { view, search: outcome.q, page: outcome.page }),
    pickers: mayCreate ? await loans.pickers(tx) : null,
  }));
  const shown = result.rows;
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', `view=${view}`, `page=${p}`].filter(Boolean).join('&');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const money = (value: string, currency: string) => formatMoney(value, currency, locale as Locale);
  const today = businessToday();

  return (
    <AdminPage
      actions={
        pickers ? (
          <NewRecordDialog
            buttonLabel={t('new')}
            closeLabel={admin('close')}
            openOnLoad={Boolean(outcome.error)}
            title={t('new')}
            wide
          >
            <p className="muted">{t('new_note')}</p>
            <Form action={createLoan}>
              <Grid>
                <LoanBankField
                  banks={pickers.banks.map((bank) => ({
                    value: bank.code,
                    label: bank.swift ? `${bank.name} · ${bank.swift}` : bank.name,
                  }))}
                  labels={{
                    bank: t('bank'),
                    another: t('another_bank'),
                    name: t('bank_name'),
                    nameHint: t('bank_name_hint'),
                    swift: t('bank_swift'),
                  }}
                  newBankValue={NEW_BANK}
                />
                <Select
                  label={t('account')}
                  name="bank_cash_account_id"
                  options={pickers.accounts.map((account) => ({
                    value: account.id,
                    label: `${account.code} · ${account.name} · ${account.currency}`,
                  }))}
                  required
                />
                <Field label={t('principal')} name="principal" required />
                <Field defaultValue="0" label={t('commission_pct')} name="commission_pct" />
                <Field
                  hint={t('commission_amount_hint')}
                 
                  label={t('commission_amount')}
                  name="commission_amount"
                />
                <Select
                  label={t('treatment')}
                  name="commission_treatment"
                  options={pickers.treatments.map((treatment) => ({
                    value: treatment.code,
                    label: locale !== 'en' && t.has(`tr.${treatment.code}`) ? t(`tr.${treatment.code}`) : treatment.name,
                  }))}
                  required
                />
                <Field hint={t('interest_hint')} label={t('interest')} name="interest_pct" />
                <Select
                  defaultValue="by_amount_used"
                  label={t('allocation_method')}
                  name="allocation_method"
                  options={['by_amount_used', 'equal', 'manual'].map((method) => ({
                    value: method,
                    label: t(`method_${method}`),
                  }))}
                />
                <LoanScheduleFields
                  labels={{
                    count: t('instalments'),
                    frequency: t('frequency'),
                    frequencies: ['monthly', 'quarterly', 'custom'].map((frequency) => ({
                      value: frequency,
                      label: t(`freq_${frequency}`),
                    })),
                    first: t('first_due'),
                    nth: (position: number) => t('due_nth', { position: String(position) }),
                    final: t('final_due'),
                    hint: t('rhythm_hint'),
                  }}
                  today={today}
                />
              </Grid>
              <Field id="loan-purpose" label={t('purpose')} name="purpose" wide />
              <Checkbox defaultChecked label={t('capitalised')} name="commission_capitalised" />
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/loans" />}
      subtitle={t('subtitle')}
      title={page('loans')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="loan-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="loan-list-title">
            <span>{page('loans')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>
          <ListToolbar
            clearHref="/payables/loans"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={view}
                label={t('view')}
                name="view"
                options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="loan-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('col_bank')}</th>
                  <th scope="col">{t('col_account')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_principal')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_outstanding')}
                  </th>
                  <th scope="col">{t('col_next_due')}</th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/loans/${encodeURIComponent(row.loanNo)}`}>
                        <bdi dir="ltr">{row.loanNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.bankName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.accountCode}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.principalTxn, row.currency)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.outstandingTxn, row.currency)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.nextDue)}</bdi>
                      {row.nextTotal && row.nextDue ? (
                        <div className="muted">
                          <bdi dir="ltr">{money(row.nextTotal, row.currency)}</bdi>
                        </div>
                      ) : null}
                      {row.overdue ? (
                        <div>
                          <span className="status status--rejected" data-status="rejected">
                            {t('overdue_flag')}
                          </span>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={`status status--${LOAN_CHIP[row.status] ?? 'draft'} ${s.sapRegisterStatus}`}
                        data-status={LOAN_CHIP[row.status] ?? 'draft'}
                      >
                        {t(`status_${row.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination count={result.pages} current={result.page} hrefFor={(p) => `/payables/loans?${query(p)}`} labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
