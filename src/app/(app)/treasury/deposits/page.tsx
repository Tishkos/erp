import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import { businessToday } from '@/server/domain/business-date';
import * as deposits from '@/server/services/bank-deposits';
import * as bankCash from '@/server/services/bank-cash-accounts';
import * as chart from '@/server/services/chart-of-accounts';
import { depositCash, depositOther } from './actions';

/**
 * Bank deposits — REQ-FIX-001 FIX-1 (D-FX-2).
 *
 * Money put into a bank account by hand: cash taken to the bank (a bank
 * transfer from the cash account) or money from anywhere else (an other
 * receipt). One register over both, drawn as Purchase Invoices is; each is
 * raised from its own dialog, approved by somebody else and posted on its
 * record.
 */
export const dynamic = 'force-dynamic';

export default async function DepositsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/treasury/deposits')) notFound();

  const [t, admin, page, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.bank_deposits'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', deposits.PERMISSION_OBJECT)) {
    return <Denied object={page('bank_deposits')} />;
  }
  const mayCash = can(principal, 'create', deposits.PERMISSION_OBJECT);
  const mayOther = can(principal, 'create', deposits.RECEIPT_PERMISSION_OBJECT);

  const params = await searchParams;
  const view = (deposits.DEPOSIT_VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as deposits.DepositView) : null;

  const { result, banks, cash, credit } = await withCurrentUser(async (tx) => {
    const result = await deposits.listForScreen(tx, { view, search: outcome.q, page: outcome.page });
    const banks = mayCash || mayOther ? (await bankCash.listOfKind(tx, 'bank')).filter((account) => account.active) : [];
    const cash = mayCash ? (await bankCash.listOfKind(tx, 'cash')).filter((account) => account.active) : [];
    // An other receipt cannot credit a control account (§16).
    const credit = mayOther ? (await chart.postableAccounts(tx)).filter((account) => !account.controlAccount) : [];
    return { result, banks, cash, credit };
  });
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', view ? `view=${view}` : '', `page=${p}`].filter(Boolean).join('&');
  const today = businessToday();
  const bankOptions = banks.map((account) => ({ value: account.id, label: `${account.name} (${account.code}) · ${account.currency}` }));

  return (
    <AdminPage
      actions={
        <>
          {mayCash ? (
            <NewRecordDialog buttonLabel={t('new_cash')} closeLabel={admin('close')} openOnLoad={params.deposit === 'cash' && Boolean(outcome.error)} title={t('new_cash')}>
              <p className="muted">{t('new_cash_note')}</p>
              <Form action={depositCash}>
                <Grid>
                  <Select label={t('into')} name="into_account_id" options={bankOptions} required />
                  <Select
                    label={t('from_cash')}
                    name="from_cash_account_id"
                    options={cash.map((account) => ({ value: account.id, label: `${account.name} (${account.code}) · ${account.currency}` }))}
                    required
                  />
                  <Field label={t('amount')} name="amount" required />
                  <Field defaultValue={today} label={t('date')} name="deposit_date" required type="date" />
                  <Field label={t('reference')} name="reference" />
                </Grid>
                <Field label={t('note')} name="note" wide />
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          ) : null}
          {mayOther ? (
            <NewRecordDialog buttonLabel={t('new_other')} closeLabel={admin('close')} openOnLoad={params.deposit === 'other' && Boolean(outcome.error)} title={t('new_other')}>
              <p className="muted">{t('new_other_note')}</p>
              <Form action={depositOther}>
                <Grid>
                  <Select label={t('into')} name="other_into_account_id" options={bankOptions} required />
                  <Select label={t('credit_account')} name="credit_account_id" options={credit.map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }))} required />
                  <Field label={t('payer')} name="payer" required />
                  <Field label={t('amount')} name="other_amount" required />
                  <Field defaultValue={today} label={t('date')} name="other_deposit_date" required type="date" />
                  <Field label={t('reference')} name="other_reference" />
                </Grid>
                <Field label={t('note')} name="other_note" wide />
                <SubmitRow>
                  <Submit label={t('create')} />
                </SubmitRow>
              </Form>
            </NewRecordDialog>
          ) : null}
        </>
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/treasury/deposits" />}
      subtitle={t('subtitle')}
      title={page('bank_deposits')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="deposit-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="deposit-list-title">
            <span>{page('bank_deposits')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/treasury/deposits"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view ?? ''} emptyLabel={t('view_all')} label={t('view')} name="view" options={deposits.DEPOSIT_VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="deposit-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('date')}</th>
                  <th scope="col">{t('into')}</th>
                  <th scope="col">{t('source')}</th>
                  <th scope="col">{t('from')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('amount')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/treasury/deposits/${encodeURIComponent(row.no)}`}>
                        <bdi dir="ltr">{row.no}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.depositDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{`${row.intoName} (${row.intoCode})`}</bdi>
                    </td>
                    <td>{t(`source_${row.source}`)}</td>
                    <td>
                      <bdi dir="auto">{row.payer ? `${row.payer} · ${row.fromCode}` : `${row.fromName} (${row.fromCode})`}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.amount, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status.has(row.status) ? status(row.status) : row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/treasury/deposits?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
